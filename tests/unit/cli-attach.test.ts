// Which words of an interactive line attach a file, and how the CLI reads one (docs/plans/agent-files.md R1, R2,
// A1, A2): the tokenizer, the candidate rule (the owner's answer to question 3), the forms tried, `~/`, the 10-file
// bound, and the read's refusals — the deny list, links, hard links, FIFOs, sockets, size.

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  expandHome,
  isCandidate,
  lineAttachments,
  lineWords,
  readAttachment,
  triedForms,
  type PathContext,
} from '../../src/cli/attach.js';
import { listenAt } from '../helpers/unix-socket.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** A fixture tree: `tmp/` standing in for /tmp, a fake home, a fake ASHA_HOME, and a working folder. */
async function fixtures() {
  // Resolved once (macOS's tmpdir is under a /var link to /private/var): the attached paths are resolved ones.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'asha-attach-')));
  const tmp = join(base, 'tmp');
  const home = join(base, 'home');
  const cwd = join(base, 'work');
  const ashaHome = join(home, '.simplyautonomous', 'harness');
  for (const d of [tmp, home, cwd, join(cwd, 'sub'), ashaHome, join(tmp, 'dir')]) await mkdir(d, { recursive: true });
  await writeFile(join(tmp, 'a.txt'), 'A\n');
  await writeFile(join(tmp, 'a b.txt'), 'AB\n');
  await writeFile(join(home, 'x'), 'X\n');
  await writeFile(join(cwd, 'package.json'), '{}\n');
  await writeFile(join(cwd, 'notes'), 'n\n');
  await writeFile(join(cwd, 'sub', 'n.txt'), 'sub n\n');
  const context: PathContext = { cwd, home, ashaHome };
  /** The resolved paths a line attaches, and the warnings, in order. */
  const attach = async (line: string) => {
    const result = await lineAttachments(line, context);
    const files = result.flatMap((r) => (r.kind === 'attach' ? [r.file] : []));
    for (const f of files) await f.close();
    return {
      attached: files.map((f) => f.resolved),
      names: files.map((f) => f.name),
      warned: result.flatMap((r) => (r.kind === 'warn' ? [`${r.shown}: ${r.rule}`] : [])),
    };
  };
  return { base, tmp, home, cwd, ashaHome, context, attach };
}

describe('the tokenizer (R1 rules 1–3, A1)', () => {
  it('splits on unescaped spaces and tabs; a backslash makes the next character literal; one at the end is literal', () => {
    expect(lineWords('Summarise /tmp/a\\ b.txt and /tmp/a.txt')).toEqual([
      'Summarise',
      '/tmp/a b.txt',
      'and',
      '/tmp/a.txt',
    ]);
    expect(lineWords('a\tb  c')).toEqual(['a', 'b', 'c']);
    expect(lineWords('ends in \\')).toEqual(['ends', 'in', '\\']);
  });

  it('a quote begins a word and closes before a word end: its characters are literal and the quotes removed', () => {
    expect(lineWords("'/tmp/a b.txt'")).toEqual(['/tmp/a b.txt']);
    expect(lineWords('"/tmp/a b.txt", please')).toEqual(['/tmp/a b.txt,', 'please']);
  });

  it("don't and What's stay ordinary words and swallow nothing; an unclosed quote is literal", () => {
    expect(lineWords("don't open /tmp/a.txt")).toEqual(["don't", 'open', '/tmp/a.txt']);
    expect(lineWords("What's in /tmp/a.txt?")).toEqual(["What's", 'in', '/tmp/a.txt?']);
    expect(lineWords("'tis /tmp/a.txt")).toEqual(["'tis", '/tmp/a.txt']);
    // A quote in a word's middle never opens: else don't would swallow everything up to users' (a quote at a word's end).
    expect(lineWords("don't send /tmp/a.txt to the users' list")).toEqual([
      "don't",
      'send',
      '/tmp/a.txt',
      'to',
      'the',
      "users'",
      'list',
    ]);
  });

  it('a word is a candidate only if it contains / or starts with ~/ (rule 6)', () => {
    expect(['package.json', 'notes', 'hello', '~root'].map(isCandidate)).toEqual([false, false, false, false]);
    expect(['./package.json', 'sub/notes.txt', '~/x', '/tmp/a.txt', '(./package.json).'].map(isCandidate)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('tries the word as it is, then trailing .,;:!?)]}\'" and leading ([{\'" removed; ~/ expands on the form tried', () => {
    expect(triedForms('(see')).toEqual(['(see', 'see']);
    expect(triedForms('/tmp/a.txt).')).toEqual(['/tmp/a.txt).', '/tmp/a.txt']);
    expect(triedForms('/tmp/a.txt')).toEqual(['/tmp/a.txt']);
    expect(expandHome('~/x', '/h')).toBe('/h/x');
    expect(expandHome('~root/x', '/h')).toBe('~root/x');
    expect(expandHome('$HOME/x', '/h')).toBe('$HOME/x');
  });
});

describe('which words attach (R1 rules 4–7, A1)', () => {
  it("Summarise <a\\ b> and <a> attaches both; What's in <a>? attaches it; (see <a>). attaches it; a quoted path attaches", async () => {
    const f = await fixtures();
    expect((await f.attach(`Summarise ${f.tmp}/a\\ b.txt and ${f.tmp}/a.txt`)).attached).toEqual([
      join(f.tmp, 'a b.txt'),
      join(f.tmp, 'a.txt'),
    ]);
    expect((await f.attach(`What's in ${f.tmp}/a.txt?`)).attached).toEqual([join(f.tmp, 'a.txt')]);
    expect((await f.attach(`(see ${f.tmp}/a.txt).`)).attached).toEqual([join(f.tmp, 'a.txt')]);
    expect((await f.attach(`'${f.tmp}/a b.txt'`)).attached).toEqual([join(f.tmp, 'a b.txt')]);
  });

  it("don't and What's attach nothing; a file named twice attaches once; a directory or a missing path stays text, said nothing about", async () => {
    const f = await fixtures();
    expect(await f.attach("don't What's")).toEqual({ attached: [], names: [], warned: [] });
    expect((await f.attach(`don't send ${f.tmp}/a.txt to the users' list`)).attached).toEqual([join(f.tmp, 'a.txt')]);
    expect((await f.attach(`${f.tmp}/a.txt ${f.tmp}/a.txt`)).attached).toEqual([join(f.tmp, 'a.txt')]);
    expect(await f.attach(`${f.tmp}/dir ${f.tmp}/missing.txt and/or`)).toEqual({ attached: [], names: [], warned: [] });
  });

  it('~/x attaches, and so does (~/x); ~root/x, $HOME/x and a glob do not', async () => {
    const f = await fixtures();
    expect((await f.attach('~/x')).attached).toEqual([join(f.home, 'x')]);
    expect((await f.attach('(~/x)')).attached).toEqual([join(f.home, 'x')]);
    expect((await f.attach(`~root/x $HOME/x ${f.tmp}/*.txt`)).attached).toEqual([]);
  });

  it('11 fixture files: the first 10 attach and the 11th says ⚠ more than 10 files', async () => {
    const f = await fixtures();
    for (let i = 0; i < 11; i++) await writeFile(join(f.tmp, `f${String(i)}.txt`), String(i));
    const result = await f.attach(Array.from({ length: 11 }, (_, i) => `${f.tmp}/f${String(i)}.txt`).join(' '));
    expect(result.attached).toEqual(Array.from({ length: 10 }, (_, i) => join(f.tmp, `f${String(i)}.txt`)));
    expect(result.warned).toEqual([`${f.tmp}/f10.txt: more than 10 files`]);
  });

  it('bare names never attach, whatever folder asha runs in; ./name, sub/name and (./name). do', async () => {
    const f = await fixtures();
    expect((await f.attach('update package.json to the new version')).attached).toEqual([]);
    expect((await f.attach('summarise notes')).attached).toEqual([]);
    expect((await f.attach('update ./package.json')).attached).toEqual([join(f.cwd, 'package.json')]);
    expect((await f.attach('see sub/n.txt')).attached).toEqual([join(f.cwd, 'sub', 'n.txt')]);
    expect((await f.attach('(./package.json).')).attached).toEqual([join(f.cwd, 'package.json')]);
  });
});

describe('reading a file to attach (R2, A2)', () => {
  it('reads its size and sha256, and sends exactly its bytes from offset 0 through the same descriptor', async () => {
    const f = await fixtures();
    const read = await readAttachment(join(f.tmp, 'a.txt'), '/tmp/a.txt', f.context);
    if (!read.ok) throw new Error(read.rule);
    expect([read.file.name, read.file.size, read.file.sha256]).toEqual(['a.txt', 2, sha('A\n')]);
    const parts: Buffer[] = [];
    for await (const chunk of read.file.bytes()) parts.push(Buffer.from(chunk));
    await read.file.close();
    expect(Buffer.concat(parts).toString()).toBe('A\n');
  });

  it('refuses every credential the deny list names, after NFC and case folding, by the resolved path', async () => {
    const f = await fixtures();
    const files = [
      '.ssh/id_ed25519',
      '.env',
      '.git-credentials',
      'credentials.toml',
      'x.kdbx',
      'Library/Application Support/Microsoft Edge/Default/Cookies',
      '.ENV',
      'id_ed25519',
    ];
    for (const rel of files) {
      await mkdir(join(f.home, rel, '..'), { recursive: true });
      await writeFile(join(f.home, rel), 'secret');
    }
    await writeFile(join(f.ashaHome, 'daemon.json'), '{}');
    await symlink(join(f.home, '.env'), join(f.home, 'innocent.txt'));
    await link(join(f.home, 'id_ed25519'), join(f.home, 'notes.txt'));
    const rules: Record<string, string> = {};
    for (const rel of [...files, 'innocent.txt', 'notes.txt']) {
      const read = await readAttachment(join(f.home, rel), rel, f.context);
      rules[rel] = read.ok ? 'ATTACHED' : read.rule;
    }
    rules['ASHA_HOME/daemon.json'] = ((r) => (r.ok ? 'ATTACHED' : r.rule))(
      await readAttachment(join(f.ashaHome, 'daemon.json'), 'daemon.json', f.context),
    );
    expect(rules).toEqual({
      '.ssh/id_ed25519': 'on the credential deny list (a path component .ssh)',
      '.env': 'on the credential deny list (a file named .env)',
      '.git-credentials': 'on the credential deny list (a file named .git-credentials)',
      'credentials.toml': 'on the credential deny list (a file named credentials.*)',
      'x.kdbx': 'on the credential deny list (a file named *.kdbx)',
      'Library/Application Support/Microsoft Edge/Default/Cookies':
        'on the credential deny list (the path Library/Application Support/Microsoft Edge)',
      '.ENV': 'on the credential deny list (a file named .env)',
      id_ed25519: 'on the credential deny list (a file named id_ed25519)',
      'innocent.txt': 'on the credential deny list (a file named .env)',
      'notes.txt': 'has more than one name (a hard link)',
      'ASHA_HOME/daemon.json': 'on the credential deny list (anything under ASHA_HOME)',
    });
  });

  it('refuses a missing path, a directory, a FIFO (without blocking), a socket and a 25,000,001-byte file', async () => {
    const f = await fixtures();
    execFileSync('mkfifo', [join(f.tmp, 'fifo')]);
    const server = createServer();
    const socketPath = join(f.tmp, 's.sock');
    await listenAt(server, socketPath);
    await writeFile(join(f.tmp, 'big'), Buffer.alloc(25_000_001));
    const rule = async (p: string) => ((r) => (r.ok ? 'ATTACHED' : r.rule))(await readAttachment(p, p, f.context));
    try {
      expect(await rule(join(f.tmp, 'missing'))).toBe('no such file');
      expect(await rule(join(f.tmp, 'dir'))).toBe('a directory, not a file');
      expect(await rule(join(f.tmp, 'fifo'))).toBe('not a regular file');
      expect(await rule(socketPath)).toBe('not a regular file');
      expect(await rule(join(f.tmp, 'big'))).toBe('over 25,000,000 bytes');
    } finally {
      server.close();
    }
  });

  it('a line naming those as words posts them as text, each with its ⚠ rule; a FIFO never blocks the line', async () => {
    const f = await fixtures();
    execFileSync('mkfifo', [join(f.tmp, 'fifo')]);
    await writeFile(join(f.home, '.env'), 'secret');
    const result = await f.attach(`${f.tmp}/fifo ~/.env ${f.tmp}/a.txt`);
    expect(result.attached).toEqual([join(f.tmp, 'a.txt')]);
    expect(result.warned).toEqual([
      `${f.tmp}/fifo: not a regular file`,
      '~/.env: on the credential deny list (a file named .env)',
    ]);
  });
});
