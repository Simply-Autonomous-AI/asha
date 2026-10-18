// A command plugin's call (docs/plans/extension-modules.md R30–R33; A28's host-side cases, A29, A30's harness-side
// cases): src/daemon/modules/plugins.ts with a fake runtime and fake file spaces, real files on disk for the named
// roots, and the call's bound on an injected clock. What colima itself does — `docker inspect`'s mounts and limits,
// a real copy's ownership — is the agent suite's (tests/agents/modules.test.ts).

import { link, mkdir, mkdtemp, readdir, readFile, rename, symlink, chmod, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildArguments,
  PluginRunner,
  resolvePluginPath,
  writeRefusal,
  type AllowedRoot,
  type InstalledModule,
} from '../../src/daemon/modules/index.js';
import { MAX_CAPTURE_BYTES, MAX_READ_FILES } from '../../src/daemon/modules/plugins.js';
import { MAX_RESULT_JSON_BYTES } from '../../src/daemon/modules/cut.js';
import { tarDirectory, tarFile } from '../../src/daemon/state/tar.js';
import { present } from '../../src/shared/assert-present.js';
import { parseModuleManifest, type CommandDeclaration } from '../../src/shared/modules.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { FakeRuntime, type FakePlugin } from '../helpers/daemon-fakes.js';
import { RecordingLogger } from '../helpers/fakes.js';
import { fixtureSecret, pluginManifest, TestTimers } from '../helpers/modules.js';

const SECRET = fixtureSecret('PIPELINE_KEY');

const COMMANDS = [
  {
    name: 'copy',
    description: 'Copy a file.',
    classes: ['egress'],
    timeoutMs: 30_000,
    prefix: ['copy'],
    arguments: {
      src: { type: 'path', mode: 'read', description: 'From' },
      dst: { type: 'path', mode: 'write', description: 'To' },
    },
    required: ['src'],
  },
  {
    name: 'scan',
    description: 'Read a folder.',
    classes: ['egress'],
    timeoutMs: 30_000,
    prefix: ['scan'],
    arguments: { dir: { type: 'path', mode: 'read', recursive: true, description: 'The folder' } },
  },
  {
    name: 'say',
    description: 'Say something.',
    classes: ['egress'],
    timeoutMs: 30_000,
    prefix: ['say'],
    fixed: ['--region', 'us-east-1'],
    arguments: {
      text: { type: 'string', pattern: '^[^-][^\\n]*$', option: '--text', description: 'What' },
      target: { type: 'remote', pattern: '^s3://asha-demo-[a-z0-9-]+/.+$', option: '--to', description: 'Where' },
    },
    required: [],
  },
];

const PLUGIN: InstalledModule = {
  manifest: parseModuleManifest({ ...pluginManifest(), commands: COMMANDS }, 'module.json', 'fixture_cli'),
  dir: '/modules/fixture_cli',
};
const command = (name: string): CommandDeclaration =>
  present(
    (PLUGIN.manifest as { readonly commands: readonly CommandDeclaration[] }).commands.find((c) => c.name === name),
    `command ${name}`,
  );

/** The entries of a tar: name, type and uid, pax headers skipped. */
function entries(tar: Buffer): { name: string; type: string; uid: number; size: number }[] {
  const out: { name: string; type: string; uid: number; size: number }[] = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const h = tar.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const str = (o: number, n: number) => {
      const raw = h.subarray(o, o + n).toString('utf8');
      const nul = raw.indexOf('\0');
      return nul === -1 ? raw : raw.slice(0, nul);
    };
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = String.fromCharCode(present(h[156], 'h[156]'));
    const prefix = str(345, 155);
    if (type !== 'x' && type !== 'g')
      out.push({
        name: (prefix === '' ? str(0, 100) : `${prefix}/${str(0, 100)}`).replace(/\/$/, ''),
        type,
        uid: parseInt(str(108, 8).trim(), 8),
        size,
      });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A ustar header of type `type` (a link: '1' or '2'), made from a directory header, its checksum recomputed. */
function linkEntry(name: string, type: '1' | '2', target: string): Buffer {
  const h = Buffer.from(tarDirectory(name, 0));
  h.write(name.padEnd(100, '\0').slice(0, 100), 0, 'utf8');
  h[156] = type.charCodeAt(0);
  h.write(target, 157, 'utf8');
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return h;
}

const END = Buffer.alloc(1024);

interface World {
  readonly home: string;
  readonly ashaHome: string;
  readonly project: string;
  readonly rw: string;
  readonly roots: AllowedRoot[];
  readonly runtime: FakeRuntime;
  readonly logger: RecordingLogger;
  readonly timers: TestTimers;
  readonly space: Map<string, Buffer>;
  readonly written: Buffer[];
  hook: () => Promise<void>;
  runner: PluginRunner;
  run: (
    name: string,
    args: unknown,
    over?: { consequential?: boolean; abandon?: AbortSignal },
  ) => ReturnType<PluginRunner['call']>;
}

const worlds: string[] = [];
afterEach(async () => {
  // Restore any 0000 directory so the temporary tree can be removed by the OS's cleaner.
  for (const dir of worlds.splice(0)) await chmod(dir, 0o755).catch(() => undefined);
});

async function world(): Promise<World> {
  const home = await mkdtemp(join(tmpdir(), 'asha-plugin-'));
  const ashaHome = join(home, 'asha-home');
  const project = join(home, 'project');
  const rw = join(home, 'rw');
  await mkdir(join(ashaHome, 'staging'), { recursive: true });
  await mkdir(project);
  await mkdir(rw);
  const runtime = new FakeRuntime('127.0.0.1');
  const logger = new RecordingLogger();
  const timers = new TestTimers();
  const space = new Map<string, Buffer>();
  const written: Buffer[] = [];
  const w: World = {
    home,
    ashaHome,
    project,
    rw,
    roots: [
      { name: 'project', host: project, mode: 'read' },
      { name: 'rw', host: rw, mode: 'read-write' },
    ],
    runtime,
    logger,
    timers,
    space,
    written,
    hook: () => Promise.resolve(),
    runner: undefined as unknown as PluginRunner,
    run: undefined as unknown as World['run'],
  };
  let n = 0;
  w.runner = new PluginRunner({
    runtime,
    slot: () =>
      Promise.resolve({
        network: 'asha-m-h1-fixture_cli-main',
        image: 'asha-plugin-fixture_cli:t',
        secrets: { PIPELINE_KEY: SECRET },
      }),
    files: {
      // The space as docker cp gives it: a tar of the named path, its top entry the path's last component.
      readForPlugin: async (_channel, rel, onChunk) => {
        const tar = space.get(rel);
        if (tar === undefined) return { ok: false, detail: `Could not find the file /space/${rel}` };
        for (let i = 0; i < tar.length; i += 4096) if ((await onChunk(tar.subarray(i, i + 4096))) === 'stop') break;
        return { ok: true };
      },
      writeFromPlugin: async (_channel, _adds, archive) => {
        const parts: Buffer[] = [];
        for await (const chunk of archive()) parts.push(Buffer.from(chunk));
        written.push(Buffer.concat(parts));
        return { ok: true };
      },
    },
    storedSecrets: () => Promise.resolve([SECRET]),
    logger,
    ashaHome,
    stagingDir: join(ashaHome, 'staging'),
    newId: () => `${String(n++).padStart(12, '0')}abcdabcdabcdabcdabcd`,
    now: () => 1_000_000,
    setTimer: timers.setTimer,
    afterChecks: () => w.hook(),
  });
  w.run = (name, args, over = {}) =>
    w.runner.call({
      agent: 'ops-1',
      channel: 'main',
      plugin: PLUGIN,
      command: command(name),
      arguments: args,
      roots: w.roots,
      consequential: over.consequential ?? false,
      abandon: over.abandon ?? new AbortController().signal,
    });
  return w;
}

/** The plugin's run prints `stdout` and exits `code`. */
function prints(plugin: FakePlugin, stdout: string | Buffer, code = 0, stderr = ''): void {
  const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  plugin.run = () =>
    Promise.resolve({
      kind: 'exited',
      code,
      stdout: out.subarray(0, MAX_CAPTURE_BYTES),
      stderr: Buffer.from(stderr),
      stdoutBytes: out.length,
      stderrBytes: Buffer.byteLength(stderr),
    });
}

describe('buildArguments (R31, A29)', () => {
  it('refuses an unknown field, a value beginning with "-", and the local-file forms, naming the field', () => {
    expect(buildArguments(command('say'), { text: 'hi', profile: 'x' })).toEqual({
      ok: false,
      field: 'profile',
      problem: 'is not an argument this command declares',
    });
    expect(buildArguments(command('say'), { text: '--profile=x' })).toEqual({
      ok: false,
      field: 'text',
      problem: 'a value may not begin with "-"',
    });
    for (const value of ['file:///etc/passwd', 'fileb://x', '@x', 'FILE:///etc/passwd']) {
      expect(buildArguments(command('say'), { text: value })).toEqual({
        ok: false,
        field: 'text',
        problem: 'a value beginning with file://, fileb:// or @ (a form that reads a local file) is refused',
      });
    }
    expect(buildArguments(command('say'), { target: 's3://other-bucket/x' })).toEqual({
      ok: false,
      field: 'target',
      problem: 'must match ^s3://asha-demo-[a-z0-9-]+/.+$',
    });
  });

  it('gives a path argument as it was checked, its .. and trailing slash gone, and refuses an inherited key as undeclared (B-22, B-17)', () => {
    expect(buildArguments(command('copy'), { src: '/roots/a/../project/./x.txt/' })).toEqual({
      ok: true,
      argv: ['copy', '/roots/project/x.txt'],
      paths: [{ name: 'src', value: '/roots/a/../project/./x.txt/', mode: 'read', recursive: false }],
    });
    expect(buildArguments(command('copy'), JSON.parse('{"src":"/channel/x","constructor":"y"}'))).toEqual({
      ok: false,
      field: 'constructor',
      problem: 'is not an argument this command declares',
    });
  });

  it('builds the prefix, the fixed options, then each value after its option, as one array; shell text is one literal argument', () => {
    expect(buildArguments(command('say'), { target: 's3://asha-demo-x/k', text: '; rm -rf / $(id)' })).toEqual({
      ok: true,
      argv: ['say', '--region', 'us-east-1', '--text', '; rm -rf / $(id)', '--to', 's3://asha-demo-x/k'],
      paths: [],
    });
  });

  it('passes the array to the container exactly, with no shell (the fake runtime records it)', async () => {
    const w = await world();
    w.runtime.onPlugin = (p) => {
      prints(p, 'ok');
    };
    const outcome = await w.run('say', { text: '; rm -rf / $(id)' });
    expect(outcome.ok).toBe(true);
    expect(w.runtime.plugins.map((p) => [p.spec.entrypoint, p.spec.args])).toEqual([
      ['fixture-cli', ['say', '--region', 'us-east-1', '--text', '; rm -rf / $(id)']],
    ]);
  });

  it('answers an argument refused by R31 invalid_arguments, creating no container', async () => {
    const w = await world();
    expect(await w.run('say', { text: '--profile=x' })).toEqual({
      ok: false,
      reason: 'invalid_arguments',
      detail: 'argument text a value may not begin with "-"',
    });
    expect(w.runtime.plugins).toEqual([]);
  });
});

const DETAILS: Record<string, string> = {
  'a path climbing out of its root': 'argument src: /etc/hosts is outside the allowed roots (/channel, /roots/<name>)',
  'a symbolic link in a root': '/roots/project/home-link: a symbolic link at home-link',
  'a hard link to a credentials file outside the root': '/roots/project/linked.txt is a hard-linked file (2 links)',
  '.AWS/Credentials (case)':
    'argument src: /roots/project/.AWS/Credentials matches the credential deny list (a path component .aws)',
  '.ENV (case)': 'argument src: /roots/project/.ENV matches the credential deny list (a file named .env)',
  '.env': 'argument src: /roots/project/.env matches the credential deny list (a file named .env)',
  'sub/id_rsa': 'argument src: /roots/project/sub/id_rsa matches the credential deny list (a file named id_rsa)',
  'a file holding a stored secret': '/roots/project/notes.txt holds a value of the secret store',
  'a path outside every root': 'argument src: /etc/hosts is outside the allowed roots (/channel, /roots/<name>)',
  'a root the recipe does not name':
    'argument src: /roots/other/x is in no allowed root (its recipe names no root "other")',
};

describe('paths (R30, R32, A28)', () => {
  it("copies a root's file and a channel file in as one tar owned 1000:1000, with an empty directory for the write path", async () => {
    const w = await world();
    await writeFile(join(w.project, 'ok.txt'), 'project text');
    await writeFile(join(w.project, 'id_map.csv'), 'a,b');
    w.space.set('ok.txt', Buffer.concat([tarFile('ok.txt', Buffer.from('channel text'), 0), END]));
    w.runtime.onPlugin = (p) => {
      prints(p, 'copied');
      p.outputs.set('/channel/out', Buffer.concat([tarDirectory('out', 0), END]));
    };
    expect((await w.run('copy', { src: '/roots/project/ok.txt', dst: '/channel/out' })).ok).toBe(true);
    expect((await w.run('copy', { src: '/channel/ok.txt' })).ok).toBe(true);
    expect((await w.run('copy', { src: '/roots/project/id_map.csv' })).ok).toBe(true);
    const [first, second, third] = w.runtime.plugins.map((p) => entries(present(p.copiedIn[0], 'p.copiedIn[0]')));
    expect(first).toEqual([
      { name: 'roots', type: '5', uid: 1000, size: 0 },
      { name: 'roots/project', type: '5', uid: 1000, size: 0 },
      { name: 'roots/project/ok.txt', type: '0', uid: 1000, size: 12 },
      { name: 'channel', type: '5', uid: 1000, size: 0 },
      { name: 'channel/out', type: '5', uid: 1000, size: 0 },
    ]);
    expect(second).toEqual([
      { name: 'channel', type: '5', uid: 1000, size: 0 },
      { name: 'channel/ok.txt', type: '0', uid: 1000, size: 12 },
    ]);
    expect(present(third, 'third').map((e) => e.name)).toContain('roots/project/id_map.csv');
    // Each call in its own container, removed after it.
    expect(new Set(w.runtime.plugins.map((p) => p.spec.name)).size).toBe(3);
    expect(w.runtime.plugins.every((p) => p.removed)).toBe(true);
  });

  const refusals: [string, (w: World) => Promise<unknown>, string][] = [
    ['a path climbing out of its root', () => Promise.resolve(undefined), '/roots/project/../../etc/hosts'],
    [
      'a symbolic link in a root',
      async (w) => symlink(w.home, join(w.project, 'home-link')),
      '/roots/project/home-link',
    ],
    [
      'a hard link to a credentials file outside the root',
      async (w) => {
        await writeFile(join(w.home, 'credentials-outside'), 'x');
        await link(join(w.home, 'credentials-outside'), join(w.project, 'linked.txt'));
      },
      '/roots/project/linked.txt',
    ],
    [
      '.AWS/Credentials (case)',
      async (w) => mkdir(join(w.project, '.AWS')).then(() => writeFile(join(w.project, '.AWS', 'Credentials'), 'x')),
      '/roots/project/.AWS/Credentials',
    ],
    ['.ENV (case)', async (w) => writeFile(join(w.project, '.ENV'), 'x'), '/roots/project/.ENV'],
    ['.env', async (w) => writeFile(join(w.project, '.env'), 'x'), '/roots/project/.env'],
    [
      'sub/id_rsa',
      async (w) => mkdir(join(w.project, 'sub')).then(() => writeFile(join(w.project, 'sub', 'id_rsa'), 'x')),
      '/roots/project/sub/id_rsa',
    ],
    [
      'a file holding a stored secret',
      async (w) => writeFile(join(w.project, 'notes.txt'), `the key is ${SECRET}\n`),
      '/roots/project/notes.txt',
    ],
    ['a path outside every root', () => Promise.resolve(undefined), '/etc/hosts'],
    ['a root the recipe does not name', () => Promise.resolve(undefined), '/roots/other/x'],
  ];
  for (const [what, prepare, src] of refusals) {
    it(`refuses ${what} before any container exists, naming the argument and never the secret`, async () => {
      const w = await world();
      await prepare(w);
      const outcome = await w.run('copy', { src });
      expect(outcome.ok).toBe(false);
      expect((outcome as { reason: string }).reason).toBe('path_refused');
      expect((outcome as { detail: string }).detail).toBe(DETAILS[what]);
      expect((outcome as { detail: string }).detail).not.toContain(SECRET);
      expect(w.runtime.plugins).toEqual([]);
      expect(JSON.stringify(w.logger.entries)).not.toContain(SECRET);
      expect(present(w.logger.entries.at(-1), 'the last logger entry').event).toBe('plugin.failed');
    });
  }

  it('refuses a recursive read holding one .pem, and a channel file holding a stored secret', async () => {
    const w = await world();
    await mkdir(join(w.project, 'certs'));
    await writeFile(join(w.project, 'certs', 'a.txt'), 'x');
    await writeFile(join(w.project, 'certs', 'server.pem'), 'x');
    expect(await w.run('scan', { dir: '/roots/project/certs' })).toEqual({
      ok: false,
      reason: 'path_refused',
      detail: '/roots/project/certs/server.pem matches the credential deny list (a file named *.pem)',
    });
    w.space.set('leak.txt', Buffer.concat([tarFile('leak.txt', Buffer.from(`k=${SECRET}`), 0), END]));
    expect(await w.run('copy', { src: '/channel/leak.txt' })).toEqual({
      ok: false,
      reason: 'path_refused',
      detail: '/channel/leak.txt: holds a value of the secret store',
    });
    expect(w.runtime.plugins).toEqual([]);
  });

  it('refuses a directory given to a path that is not read recursively', async () => {
    const w = await world();
    await mkdir(join(w.project, 'dir'));
    expect(await w.run('copy', { src: '/roots/project/dir' })).toEqual({
      ok: false,
      reason: 'path_refused',
      detail: '/roots/project/dir is a directory, and argument src is not read recursively',
    });
  });

  it('refuses a file swapped for a symbolic link between the check and the copy (injected hook)', async () => {
    const w = await world();
    await writeFile(join(w.project, 'ok.txt'), 'fine');
    await writeFile(join(w.home, 'elsewhere.txt'), 'not yours');
    w.hook = async () => {
      await rename(join(w.project, 'ok.txt'), join(w.project, 'moved.txt'));
      await symlink(join(w.home, 'elsewhere.txt'), join(w.project, 'ok.txt'));
    };
    const outcome = await w.run('copy', { src: '/roots/project/ok.txt' });
    expect(outcome).toEqual({
      ok: false,
      reason: 'path_refused',
      detail: '/roots/project/ok.txt: it became a symbolic link after it was checked',
    });
    // The container was made, then removed; nothing of the other file was copied.
    expect(w.runtime.plugins.map((p) => [p.removed, p.copiedIn.join('').includes('not yours')])).toEqual([
      [true, false],
    ]);
  });

  it('refuses a write to a read root, and into .git or a shell start-up file of a read-write root', async () => {
    const w = await world();
    await writeFile(join(w.project, 'ok.txt'), 'x');
    expect(await w.run('copy', { src: '/roots/project/ok.txt', dst: '/roots/project/out' })).toEqual({
      ok: false,
      reason: 'path_refused',
      detail: 'argument dst: /roots/project/out is a write into root project, which is read-only',
    });
    expect(await w.run('copy', { src: '/roots/project/ok.txt', dst: '/roots/rw/.git/hooks/pre-commit' })).toEqual({
      ok: false,
      reason: 'path_refused',
      detail:
        'argument dst: /roots/rw/.git/hooks/pre-commit: a write into a .git directory, which runs code later as the user',
    });
    expect(await w.run('copy', { src: '/roots/project/ok.txt', dst: '/roots/rw/.zshrc' })).toEqual({
      ok: false,
      reason: 'path_refused',
      detail: 'argument dst: /roots/rw/.zshrc: a write to the shell start-up file .zshrc',
    });
    expect(w.runtime.plugins).toEqual([]);
  });

  it('refuses a read set over 10,000 files, and over 1 GiB, input_too_large before any container', async () => {
    const w = await world();
    await mkdir(join(w.project, 'many'));
    await Promise.all(
      Array.from({ length: MAX_READ_FILES + 1 }, (_, i) => writeFile(join(w.project, 'many', `f${String(i)}.txt`), '')),
    );
    expect(await w.run('scan', { dir: '/roots/project/many' })).toEqual({
      ok: false,
      reason: 'input_too_large',
      detail: 'the read set is over 10000 files or 1073741824 bytes',
    });
    await writeFile(join(w.project, 'big.bin'), '');
    await truncate(join(w.project, 'big.bin'), 1024 * 1024 * 1024 + 1);
    expect(await w.run('copy', { src: '/roots/project/big.bin' })).toEqual({
      ok: false,
      reason: 'input_too_large',
      detail: 'the read set is over 10000 files or 1073741824 bytes',
    });
    expect(w.runtime.plugins).toEqual([]);
  }, 60_000);

  it("ends path_refused naming the path when the host refuses to read a root's folder (a 0000 directory)", async () => {
    const w = await world();
    await mkdir(join(w.project, 'locked'));
    await writeFile(join(w.project, 'locked', 'a.txt'), 'x');
    await chmod(join(w.project, 'locked'), 0o000);
    worlds.push(join(w.project, 'locked'));
    const outcome = await w.run('scan', { dir: '/roots/project/locked' });
    expect(outcome).toEqual({
      ok: false,
      reason: 'path_refused',
      detail: '/roots/project/locked: the host refused to read it (EACCES)',
    });
    expect(present(w.logger.entries.at(-1), 'the last logger entry').fields).toMatchObject({
      outcome: 'path_refused',
      pathsIn: ['/roots/project/locked'],
    });
  });
});

describe('writing back (R30, R32, A28)', () => {
  it("writes a named root's files only once the whole tar is read, and the channel's through the file spaces", async () => {
    const w = await world();
    await writeFile(join(w.project, 'ok.txt'), 'x');
    w.runtime.onPlugin = (p) => {
      prints(p, 'done');
      p.outputs.set(
        '/roots/rw/out',
        Buffer.concat([tarDirectory('out', 0), tarFile('out/a.txt', Buffer.from('A'), 0), END]),
      );
      p.outputs.set(
        '/channel/res',
        Buffer.concat([tarDirectory('res', 0), tarFile('res/b.txt', Buffer.from('B'), 0), END]),
      );
    };
    expect((await w.run('copy', { src: '/roots/project/ok.txt', dst: '/roots/rw/out' })).ok).toBe(true);
    expect(await readFile(join(w.rw, 'out', 'a.txt'), 'utf8')).toBe('A');
    expect(await readdir(join(w.rw, 'out'))).toEqual(['a.txt']);
    expect((await w.run('copy', { src: '/roots/project/ok.txt', dst: '/channel/res' })).ok).toBe(true);
    expect(entries(present(w.written[0], 'w.written[0]')).map((e) => e.name)).toEqual([
      'channel/res',
      'channel/res/b.txt',
    ]);
  });

  it('refuses a symbolic link the command planted under its write path, writing nothing back', async () => {
    const w = await world();
    await writeFile(join(w.project, 'ok.txt'), 'x');
    w.runtime.onPlugin = (p) => {
      prints(p, 'done');
      p.outputs.set(
        '/roots/rw/out',
        Buffer.concat([
          tarDirectory('out', 0),
          tarFile('out/a.txt', Buffer.from('A'), 0),
          linkEntry('out/evil', '2', '/Users'),
          END,
        ]),
      );
    };
    expect(await w.run('copy', { src: '/roots/project/ok.txt', dst: '/roots/rw/out' })).toEqual({
      ok: false,
      reason: 'path_refused',
      detail: 'out/evil: a symbolic link is not a directory or a regular file',
    });
    expect(await readdir(w.rw)).toEqual(['out']);
    expect(await readdir(join(w.rw, 'out'))).toEqual([]);
  });

  it('refuses output_too_large a write-back over 10,000 entries, and one over 1 GiB, nothing renamed in and no temporary file left', async () => {
    const w = await world();
    await writeFile(join(w.project, 'ok.txt'), 'x');
    const many = Buffer.concat([
      tarDirectory('out', 0),
      ...Array.from({ length: 10_001 }, (_, i) => tarFile(`out/f${String(i)}`, Buffer.alloc(0), 0)),
      END,
    ]);
    const huge = Buffer.concat([tarDirectory('big', 0), tarFile('big/x', Buffer.alloc(0), 0).fill(0, 0, 0)]);
    // A header claiming 1 GiB + 1 byte: refused at the header, before any of its data.
    const claim = Buffer.from(tarFile('big/y', Buffer.alloc(0), 0).subarray(0, 512));
    claim.write((1024 * 1024 * 1024 + 1).toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    claim.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of claim) sum += b;
    claim.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    w.runtime.onPlugin = (p) => {
      prints(p, 'done');
      p.outputs.set('/roots/rw/out', many);
      p.outputs.set('/roots/rw/big', Buffer.concat([huge, claim]));
    };
    expect(await w.run('copy', { src: '/roots/project/ok.txt', dst: '/roots/rw/out' })).toEqual({
      ok: false,
      reason: 'output_too_large',
      detail: '/roots/rw/out: the command wrote more than 10000 entries or 1073741824 bytes',
    });
    expect(await w.run('copy', { src: '/roots/project/ok.txt', dst: '/roots/rw/big' })).toEqual({
      ok: false,
      reason: 'output_too_large',
      detail: '/roots/rw/big: the command wrote more than 10000 entries or 1073741824 bytes',
    });
    const left = async (dir: string): Promise<string[]> =>
      (await readdir(dir, { recursive: true })).filter((n) => !n.endsWith('/')).map(String);
    expect((await left(w.rw)).filter((n) => /\.tmp$|f\d+$|x$/.test(n))).toEqual([]);
  }, 60_000);
  it('refuses space_full a write-back into the channel past what a space holds, before staging past it (review of 2026-10-02, B-9)', async () => {
    const w = await world();
    await writeFile(join(w.project, 'ok.txt'), 'x');
    // A header claiming 256,000,001 bytes: refused at the header, before any of its data is staged.
    const claim = Buffer.from(tarFile('out/y', Buffer.alloc(0), 0).subarray(0, 512));
    claim.write((256_000_001).toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    claim.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of claim) sum += b;
    claim.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    w.runtime.onPlugin = (p) => {
      prints(p, 'done');
      p.outputs.set('/channel/out', Buffer.concat([tarDirectory('out', 0), claim]));
    };
    expect(await w.run('copy', { src: '/roots/project/ok.txt', dst: '/channel/out' })).toEqual({
      ok: false,
      reason: 'space_full',
      detail: '/channel/out: the command wrote more than a file space holds (1000 entries, 256000000 bytes)',
    });
    expect(w.space.has('out/y')).toBe(false);
  });
});

describe('bounds (R30, A28)', () => {
  it("ends timeout at the command's timeoutMs when the copy in stalls, the container removed, nothing written back", async () => {
    const w = await world();
    await writeFile(join(w.project, 'ok.txt'), 'x');
    let copying!: () => void;
    const copyStarted = new Promise<void>((resolve) => (copying = resolve));
    w.runtime.onPlugin = (p) => {
      p.onCopyIn = (_input, signal) =>
        new Promise((resolve) => {
          copying();
          signal.addEventListener(
            'abort',
            () => {
              resolve({ kind: 'timeout' });
            },
            { once: true },
          );
        });
    };
    const outcome = w.run('copy', { src: '/roots/project/ok.txt', dst: '/roots/rw/out' });
    await copyStarted;
    expect(w.timers.fire(30_000)).toBe(1);
    expect(await outcome).toEqual({
      ok: false,
      reason: 'timeout',
      detail: 'the copy into the container passed its bound',
    });
    const plugin0 = present(w.runtime.plugins[0], 'w.runtime.plugins[0]');
    expect(plugin0.removed).toBe(true);
    expect(plugin0.copiedOut).toEqual([]);
    expect(await readdir(w.rw)).toEqual([]);
    expect(w.timers.pending()).toBe(0);
  });

  it('ends a consequential call unknown_outcome when its bound passes after the command started', async () => {
    const w = await world();
    let running!: () => void;
    const started = new Promise<void>((resolve) => (running = resolve));
    w.runtime.onPlugin = (p) => {
      // Never exits on its own: killed when the call's bound aborts it.
      p.run = (_container, signal) =>
        new Promise((resolve) => {
          running();
          signal.addEventListener(
            'abort',
            () => {
              resolve({ kind: 'timeout' });
            },
            { once: true },
          );
        });
    };
    const outcome = w.run('say', { text: 'go' }, { consequential: true });
    await started;
    expect(w.timers.fire(30_000)).toBe(1);
    expect(await outcome).toEqual({
      ok: false,
      reason: 'unknown_outcome',
      detail: 'the command passed its bound of 30000 ms',
    });
    expect(present(w.runtime.plugins[0], 'w.runtime.plugins[0]').removed).toBe(true);
  });
});

describe('credentials and output (R33, A30)', () => {
  it("sets the secret and the manifest's env on that command's container alone, redacts the secret and a trailing half of it, and logs no secret", async () => {
    const w = await world();
    const half = SECRET.slice(0, Math.floor(SECRET.length / 2));
    w.runtime.onPlugin = (p) => {
      prints(p, `env PIPELINE_KEY=${SECRET}\nend ${half}`, 0, `warn ${SECRET}`);
    };
    const outcome = await w.run('say', { text: 'hi' });
    expect(outcome).toEqual({
      ok: true,
      result: { exit_code: 0, stdout: 'env PIPELINE_KEY=[redacted]\nend [redacted]', stderr: 'warn [redacted]' },
    });
    expect(present(w.runtime.plugins[0], 'w.runtime.plugins[0]').spec.env).toEqual({
      CLI_CONFIG_FILE: '/dev/null',
      PIPELINE_KEY: SECRET,
    });
    const record = present(
      w.logger.entries.find((e) => e.event === 'plugin.call'),
      "the logger entry for 'plugin.call'",
    );
    expect(Object.keys(record.fields).sort(byCodeUnit)).toEqual([
      'agent',
      'argumentsSha256',
      'command',
      'durationMs',
      'exitCode',
      'outcome',
      'pathsBack',
      'pathsIn',
      'plugin',
    ]);
    expect(JSON.stringify(w.logger.entries)).not.toContain(half);
  });

  it('redacts a half-secret that is the last bytes at the 256 KiB capture limit', async () => {
    const w = await world();
    const half = SECRET.slice(0, Math.floor(SECRET.length / 2));
    const filler = 'y'.repeat(MAX_CAPTURE_BYTES - half.length);
    w.runtime.onPlugin = (p) => {
      prints(p, Buffer.from(`${filler}${half}${SECRET.slice(half.length)}more`));
    };
    const outcome = await w.run('say', { text: 'hi' });
    const stdout = (outcome as { result: { stdout: string } }).result.stdout;
    expect(stdout).not.toContain(half);
    expect(JSON.stringify(outcome)).not.toContain(SECRET.slice(0, 4) + SECRET.slice(4, half.length));
  });

  it('cuts a 40 KiB output to a result whose JSON is at most 8,192 bytes, with a marker naming the bytes cut', async () => {
    const w = await world();
    w.runtime.onPlugin = (p) => {
      prints(p, 'z'.repeat(40 * 1024));
    };
    const outcome = (await w.run('say', { text: 'hi' })) as { ok: true; result: { stdout: string; exit_code: number } };
    expect(Buffer.byteLength(JSON.stringify(outcome.result))).toBeLessThanOrEqual(MAX_RESULT_JSON_BYTES);
    expect(outcome.result.stdout).toMatch(/ \[\d+ bytes cut\]$/);
    const cutMatch = present(
      /\[(\d+) bytes cut\]$/.exec(outcome.result.stdout),
      'the cut marker in outcome.result.stdout',
    );
    const cut = Number(present(cutMatch[1], 'the cut marker capture group'));
    expect(outcome.result.stdout.length - ` [${String(cut)} bytes cut]`.length + cut).toBe(40 * 1024);
  });

  it('returns a non-zero exit as data: {exit_code: 3, stdout, stderr}', async () => {
    const w = await world();
    w.runtime.onPlugin = (p) => {
      prints(p, 'partial', 3, 'failed: no such pipeline');
    };
    expect(await w.run('say', { text: 'hi' })).toEqual({
      ok: true,
      result: { exit_code: 3, stdout: 'partial', stderr: 'failed: no such pipeline' },
    });
  });
});

describe('a copy into the container that stops early (review of 2026-10-02, H5)', () => {
  it('ends the channel read, releasing the space, when docker cp exits after taking two chunks of a large file', async () => {
    const w = await world();
    w.space.set('big.bin', Buffer.concat([tarFile('big.bin', Buffer.alloc(2 * 1024 * 1024, 7), 0), END]));
    let readsStarted = 0;
    let readsEnded = 0;
    const files = (
      w.runner as unknown as { props: { files: { readForPlugin: (...a: unknown[]) => Promise<unknown> } } }
    ).props.files;
    const original = files.readForPlugin.bind(files);
    files.readForPlugin = async (...a: unknown[]) => {
      readsStarted += 1;
      try {
        return await original(...a);
      } finally {
        readsEnded += 1;
      }
    };
    const runtime = w.runtime;
    const make = runtime.pluginContainer.bind(runtime);
    runtime.pluginContainer = (spec) => {
      const c = make(spec);
      return {
        ...c,
        copyIn: async (archive) => {
          const it = archive[Symbol.asyncIterator]();
          await it.next();
          await it.next();
          return { kind: 'exited', code: 1, stderr: 'docker cp: no space left' };
        },
      };
    };
    const outcome = await w.run('copy', { src: '/channel/big.bin' });
    expect(outcome).toEqual({
      ok: false,
      reason: 'module_unavailable',
      detail: 'the copy into the container failed: docker cp: no space left',
    });
    // Two reads of the space: the check's, and the copy's, which the copy's early end must end too.
    for (let i = 0; i < 1_000 && readsEnded < readsStarted; i += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect([readsStarted, readsEnded]).toEqual([2, 2]);
  });
});

describe('the write rules on the host side (review of 2026-10-02, B-23)', () => {
  it('refuses a write into a read-write root that is itself a .git folder, by its host path', () => {
    const roots: AllowedRoot[] = [{ name: 'hooks', host: '/Users/u/repo/.git', mode: 'read-write' }];
    expect(
      resolvePluginPath(
        { name: 'dst', value: '/roots/hooks/hooks/pre-commit', mode: 'write', recursive: false },
        roots,
        '/Users/u/.asha',
      ),
    ).toEqual({
      problem: '/roots/hooks/hooks/pre-commit: a write into a .git directory, which runs code later as the user',
    });
    expect(
      resolvePluginPath(
        { name: 'src', value: '/roots/hooks/config', mode: 'read', recursive: false },
        roots,
        '/Users/u/.asha',
      ),
    ).toMatchObject({ kind: 'root', container: '/roots/hooks/config' });
  });

  it('refuses a write to each login and logout start-up file', () => {
    for (const name of ['.zlogin', '.zlogout', '.bash_login', '.bash_logout', '.login'])
      expect(writeRefusal(`/roots/rw/${name}`)).toBe(`a write to the shell start-up file ${name}`);
  });

  it('refuses path_refused a file the command put in place of the root folder itself, writing nothing beside the root', async () => {
    const w = await world();
    await writeFile(join(w.project, 'ok.txt'), 'x');
    w.runtime.onPlugin = (p) => {
      prints(p, 'done');
      p.outputs.set('/roots/rw', Buffer.concat([tarFile('rw', Buffer.from('replaced'), 0), END]));
    };
    const outcome = await w.run('copy', { src: '/roots/project/ok.txt', dst: '/roots/rw' });
    expect(outcome).toMatchObject({ ok: false, reason: 'path_refused' });
    expect((outcome as { detail: string }).detail).toContain('a file in place of the root folder itself');
    expect((await readdir(join(w.rw, '..'))).filter((n) => n.startsWith('.asha-plugin-'))).toEqual([]);
  });
});
