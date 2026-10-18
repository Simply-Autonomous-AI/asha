// The marker scan (docs/plans/oss-release.md R9, R10; A8): with a temporary markers file of fabricated values, one of
// each kind, each value planted in turn in a file's text, a binary file, a file's name, a commit message, an author's
// name, a committer's email, a tag's message and a tagger's email is found, named by its kind and a location that
// cannot carry it, and no output holds the value; and every refusal — the variable unset, the file missing, its mode
// granting others access, the file inside the scanned folder or the internal repository, a kind with no value — is
// asserted with its message.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_TEXT,
  MarkerScanRefused,
  REQUIRED_KINDS,
  matchLine,
  readMarkers,
  scanMarkers,
  type Marker,
} from '../../tools/oss/markers.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const temp = (): string => mkdtempSync(join(tmpdir(), 'asha-markers-'));

/** A fabricated value of each kind: none is a real one, and none is shaped as R11's guard forbids. */
const VALUES: Readonly<Record<(typeof REQUIRED_KINDS)[number], string>> = {
  login: 'zxqlogin',
  home: '/srv/zxqhome',
  nas: 'nas-zxq.example.invalid',
  'aws-account': '000011112222',
  'private-path': '/opt/zxq-private',
  email: 'Zxq.Person@example.invalid',
  'key-location': 'zxq-keys/credentials.txt',
  name: 'Zed Quixote',
  'other-project': 'ZxqProject',
};

/** A markers file holding `lines`, mode 600 unless `mode` says otherwise, in a new folder outside every repository. */
function markersFile(lines: readonly string[], mode = 0o600): string {
  const file = join(temp(), 'markers.tsv');
  writeFileSync(file, `# fabricated, for the test\n${lines.join('\n')}\n`);
  chmodSync(file, mode);
  return file;
}
const ALL = Object.entries(VALUES).map(([kind, value]) => `${kind}\t${value}`);
const env = (file: string | undefined): NodeJS.ProcessEnv => ({
  ...(file === undefined ? {} : { ASHA_OSS_MARKERS: file }),
});

const git = (cwd: string, args: readonly string[], who = { name: 'T', email: 't@example.invalid' }): void => {
  execFileSync('git', ['-c', `user.name=${who.name}`, '-c', `user.email=${who.email}`, ...args], {
    cwd,
    env: { ...process.env, GIT_COMMITTER_NAME: who.name, GIT_COMMITTER_EMAIL: who.email },
  });
};

describe('the marker scan finds every kind in every place, naming where, never what (oss-release R9, R10; A8)', () => {
  const markers: Marker[] = readMarkers(env(markersFile(ALL)), [ROOT]);

  it('reads one value of each required kind', () => {
    expect(markers.map((m) => m.kind)).toEqual([...REQUIRED_KINDS]);
  });

  it("finds a value in a file's text, in any case, and in a binary file, by file and line", () => {
    const dir = temp();
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'a.md'), `one\nwritten by ${VALUES.name.toUpperCase()}\n`);
    writeFileSync(
      join(dir, 'b.bin'),
      Buffer.concat([Buffer.from([0, 255, 10, 7]), Buffer.from(VALUES.email), Buffer.from([0])]),
    );
    expect(scanMarkers(markers, dir)).toEqual([
      { kind: 'email', where: 'b.bin:2' },
      { kind: 'name', where: 'docs/a.md:2' },
    ]);
  });

  it('allows the one address the release may carry, exactly as written, and finds the name anywhere else (R25a, amended 2026-10-17)', () => {
    // The exception is the pico model's address as the catalogue pins it; the name it holds is never spelled out here.
    const pico = JSON.parse(readFileSync(join(ROOT, 'catalogue', 'pico-v2-q8_0.json'), 'utf8')) as { repo: string };
    expect(ALLOWED_TEXT).toEqual([pico.repo]);
    const address = pico.repo;
    const publisher = address.slice(0, address.indexOf('/'));
    const named: Marker[] = [{ kind: 'other-project', value: publisher }];
    const dir = temp();
    writeFileSync(
      join(dir, 'a.md'),
      `pinned: ${address} at https://huggingface.co/${address}/blob/x
by ${publisher}
${address.toLowerCase()}
`,
    );
    expect(scanMarkers(named, dir)).toEqual([
      { kind: 'other-project', where: 'a.md:2' },
      { kind: 'other-project', where: 'a.md:3' },
    ]);
  });

  it("finds a value in a path, named by the path's sha256", () => {
    const dir = temp();
    mkdirSync(join(dir, `notes-${VALUES.login}`));
    writeFileSync(join(dir, `notes-${VALUES.login}`, 'x.txt'), 'clean\n');
    const path = `notes-${VALUES.login}/x.txt`;
    expect(scanMarkers(markers, dir)).toEqual([
      { kind: 'login', where: `path sha256 ${createHash('sha256').update(path).digest('hex')}` },
    ]);
  });

  it("finds a value in a commit's message, author and committer, and a tag's message and tagger, by id and field", () => {
    const repo = temp();
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'f.txt'), 'clean\n');
    git(repo, ['add', 'f.txt']);
    git(repo, ['commit', '-q', '-m', `from ${VALUES['other-project']}`]);
    writeFileSync(join(repo, 'g.txt'), 'clean\n');
    git(repo, ['add', 'g.txt']);
    git(repo, ['commit', '-q', '-m', 'clean'], { name: VALUES.name, email: VALUES.email });
    git(repo, ['tag', '-a', 'v1', '-m', `see ${VALUES['key-location']}`], { name: 'T', email: VALUES.email });
    const commits = execFileSync('git', ['log', '--format=%H'], { cwd: repo, encoding: 'utf8' }).trim().split('\n');
    const [second, first] = commits as [string, string];
    const tag = execFileSync('git', ['rev-parse', 'v1'], { cwd: repo, encoding: 'utf8' }).trim();
    const found = scanMarkers(markers, repo);
    expect(found).toEqual([
      { kind: 'name', where: `commit ${second} author name` },
      { kind: 'email', where: `commit ${second} author email` },
      { kind: 'name', where: `commit ${second} committer name` },
      { kind: 'email', where: `commit ${second} committer email` },
      { kind: 'other-project', where: `commit ${first} message` },
      { kind: 'key-location', where: `tag ${tag} message` },
      { kind: 'email', where: `tag ${tag} tagger email` },
    ]);
    const printed = found.map(matchLine).join('\n');
    for (const value of Object.values(VALUES)) expect(printed.toLowerCase()).not.toContain(value.toLowerCase());
  });

  it('finds nothing in a clean folder or repository', () => {
    const repo = temp();
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, 'f.txt'), 'clean\n');
    git(repo, ['add', 'f.txt']);
    git(repo, ['commit', '-q', '-m', 'clean']);
    expect(scanMarkers(markers, repo)).toEqual([]);
  });

  it('refuses to run, naming why: no variable, no file, a mode for others, a file inside, a kind with no value', () => {
    const refused = (e: NodeJS.ProcessEnv, forbidden: readonly string[] = [ROOT]): string => {
      try {
        readMarkers(e, forbidden);
      } catch (error) {
        expect(error).toBeInstanceOf(MarkerScanRefused);
        return (error as Error).message;
      }
      throw new Error('read');
    };
    expect(refused(env(undefined))).toBe(
      'ASHA_OSS_MARKERS is not set: it names the markers file, kept outside every repository',
    );
    const gone = join(temp(), 'none.tsv');
    expect(refused(env(gone))).toBe(`the markers file ASHA_OSS_MARKERS names does not exist: ${gone}`);
    expect(refused(env(markersFile(ALL, 0o644)))).toBe(
      "the markers file's mode is 644: it must grant nothing to group or others (chmod 600)",
    );
    const scanned = temp();
    const within = join(scanned, 'markers.tsv');
    writeFileSync(within, `${ALL.join('\n')}\n`);
    chmodSync(within, 0o600);
    expect(refused(env(within), [ROOT, scanned])).toMatch(/^the markers file lies inside .+: keep it outside$/);
    expect(refused(env(markersFile(ALL.filter((l) => !l.startsWith('nas\t')))))).toBe(
      'the markers file gives no value of kind nas',
    );
    expect(refused(env(markersFile([...ALL, 'colour\tblue'])))).toBe(
      "the markers file's line 11 is not <kind><TAB><value> of a known kind",
    );
  });
});
