// The four file tools against temporary directories standing in for
// /workspace and /channel (docs/plans/agent-tools.md R9; A7, A13): the roots,
// links and special files, the size and space bounds, reads in parts, the
// atomic write, the audit record, and the race between the path check and the
// open. Every call goes through AgentTools, as the model's calls do, so each
// failure's log line is checked too.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AgentTools,
  EXPECTED_ERRNO,
  TurnBudget,
  asToolFailure,
  fileTools,
  ok,
  utf8Boundary,
} from '../../src/agent-sdk/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { RecordingAgentLog } from '../helpers/fakes.js';

const HANDLE = 'hewo-1';

interface Setup {
  readonly workspace: string;
  readonly channel: string | null;
  readonly outside: string;
  readonly log: RecordingAgentLog;
  /** Runs one call as the model would and returns the parsed tool result. */
  call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

async function setup(
  options: {
    channel?: boolean;
    beforeOpen?: (path: string) => Promise<void>;
    afterOpen?: (path: string) => Promise<void>;
    beforeRename?: (path: string) => Promise<void>;
    beforeMkdir?: (path: string) => Promise<void>;
  } = {},
): Promise<Setup> {
  const base = await mkdtemp(join(tmpdir(), 'asha-files-'));
  const workspace = join(base, 'workspace');
  const outside = join(base, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'SECRET');
  let channel: string | null = null;
  if (options.channel === true) {
    channel = join(base, 'channel');
    await mkdir(channel);
  }
  const log = new RecordingAgentLog();
  const tools = new AgentTools({
    selected: ['list_files', 'read_file', 'write_file', 'append_file'],
    available: fileTools({
      workspace,
      channelSpace: channel,
      handle: HANDLE,
      log,
      ...(options.beforeOpen === undefined ? {} : { beforeOpen: options.beforeOpen }),
      ...(options.afterOpen === undefined ? {} : { afterOpen: options.afterOpen }),
      ...(options.beforeRename === undefined ? {} : { beforeRename: options.beforeRename }),
      ...(options.beforeMkdir === undefined ? {} : { beforeMkdir: options.beforeMkdir }),
    }),
    log,
  });
  return {
    workspace,
    channel,
    outside,
    log,
    call: async (name, args) =>
      JSON.parse(await tools.run({ id: 'c', name, arguments: args }, new TurnBudget())) as Record<string, unknown>,
  };
}

const sha = (content: Buffer | string) => createHash('sha256').update(content).digest('hex');
const KiB = 1024;

describe('confinement to /workspace (A7)', () => {
  it('refuses ../etc/passwd, /etc/passwd, /proc/self/environ, a link to /etc and a link to a file inside the workspace, touching nothing', async () => {
    const t = await setup();
    await symlink('/etc', join(t.workspace, 'etc'));
    await writeFile(join(t.workspace, 'real.txt'), 'inside');
    await symlink(join(t.workspace, 'real.txt'), join(t.workspace, 'alias.txt'));

    const results = [];
    for (const path of ['../etc/passwd', '/etc/passwd', '/proc/self/environ', 'etc/passwd', 'alias.txt'])
      results.push(await t.call('read_file', { path }));

    expect(results).toEqual(Array(5).fill({ error: 'path_outside_workspace' }));
    // A write through the link and past the root are refused as well, and nothing appears outside.
    expect(await t.call('write_file', { path: 'etc/evil', content: 'x' })).toEqual({ error: 'path_outside_workspace' });
    expect(await t.call('write_file', { path: '../outside/new.txt', content: 'x' })).toEqual({
      error: 'path_outside_workspace',
    });
    expect(await t.call('append_file', { path: 'alias.txt', content: 'x' })).toEqual({
      error: 'path_outside_workspace',
    });
    expect(await readdir(t.outside)).toEqual(['secret.txt']);
    expect(await readFile(join(t.workspace, 'real.txt'), 'utf8')).toBe('inside');
    expect(
      t.log.entries.every((e) => e.event === 'tool.failed' && e.fields['reason'] === 'path_outside_workspace'),
    ).toBe(true);
    expect(t.log.entries).toHaveLength(8);
  });

  it('accepts /workspace, /workspace/…, relative paths and .. that stays inside', async () => {
    const t = await setup();
    await mkdir(join(t.workspace, 'd'));
    await writeFile(join(t.workspace, 'd', 'f.txt'), 'hi');
    for (const path of ['/workspace/d/f.txt', 'd/f.txt', './d/../d/f.txt', '/workspace/d/../d/f.txt']) {
      expect(await t.call('read_file', { path }), path).toEqual({ content: 'hi', size: 2 });
    }
    expect(await t.call('list_files', { path: '/workspace' })).toEqual({
      entries: [{ name: 'd', type: 'dir', size: 0 }],
    });
    expect(await t.call('read_file', { path: '/workspacex/f.txt' })).toEqual({ error: 'path_outside_workspace' });
  });

  it('returns not_a_file at once for a FIFO, for reading and for appending', async () => {
    const t = await setup();
    execFileSync('mkfifo', [join(t.workspace, 'pipe')]);
    const started = Date.now();
    expect(await t.call('read_file', { path: 'pipe' })).toEqual({ error: 'not_a_file' });
    expect(await t.call('append_file', { path: 'pipe', content: 'x' })).toEqual({ error: 'not_a_file' });
    expect(await t.call('write_file', { path: 'pipe', content: 'x' })).toEqual({ error: 'not_a_file' });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await t.call('read_file', { path: '.' })).toEqual({ error: 'not_a_file' });
  });
});

describe('bounds (A7)', () => {
  it('refuses a 257 KiB write, and an append that takes a 255 KiB file past 256 KiB, leaving the file unchanged', async () => {
    const t = await setup();
    expect(await t.call('write_file', { path: 'big.txt', content: 'x'.repeat(257 * KiB) })).toEqual({
      error: 'file_too_large',
    });
    expect(await readdir(t.workspace)).toEqual([]);
    const original = 'y'.repeat(255 * KiB);
    await writeFile(join(t.workspace, 'near.txt'), original);
    expect(await t.call('append_file', { path: 'near.txt', content: 'z'.repeat(KiB + 1) })).toEqual({
      error: 'file_too_large',
    });
    expect(sha(await readFile(join(t.workspace, 'near.txt')))).toBe(sha(original));
    // Exactly 256 KiB is allowed.
    expect(await t.call('append_file', { path: 'near.txt', content: 'z'.repeat(KiB) })).toEqual({
      path: '/workspace/near.txt',
      size: 256 * KiB,
    });
  });

  it('returns not_found for a missing file or directory, and not_text for bytes that are not UTF-8', async () => {
    const t = await setup();
    expect(await t.call('read_file', { path: 'missing.txt' })).toEqual({ error: 'not_found' });
    expect(await t.call('list_files', { path: 'no/such/dir' })).toEqual({ error: 'not_found' });
    await writeFile(join(t.workspace, 'bin'), Buffer.from([0x66, 0x6f, 0xff, 0xfe, 0x6f]));
    expect(await t.call('read_file', { path: 'bin' })).toEqual({ error: 'not_text' });
  });

  it('refuses a 257th file, and a write that takes /workspace past 16 MiB, as workspace_full, with nothing written', async () => {
    const t = await setup();
    for (let i = 0; i < 256; i++) await writeFile(join(t.workspace, `f${String(i).padStart(3, '0')}`), '');
    expect(await t.call('write_file', { path: 'one-more.txt', content: 'x' })).toEqual({ error: 'workspace_full' });
    // Overwriting one of the 256 is not a new file.
    expect(await t.call('write_file', { path: 'f000', content: 'x' })).toEqual({ path: '/workspace/f000', size: 1 });

    const u = await setup();
    for (let i = 0; i < 64; i++) await writeFile(join(u.workspace, `big${String(i)}`), Buffer.alloc(256 * KiB));
    expect(await u.call('write_file', { path: 'last.txt', content: 'x' })).toEqual({ error: 'workspace_full' });
    expect(await u.call('append_file', { path: 'big0', content: 'x' })).toEqual({ error: 'file_too_large' });
    expect(await readdir(u.workspace)).toHaveLength(64);
  });
});

/** The log record of a call that returned `result`: the tool, the result's JSON size and its sha256. */
const called = (tool: string, result: unknown) => {
  const json = JSON.stringify(result);
  return {
    level: 'info',
    event: 'tool.called',
    fields: { tool, resultBytes: Buffer.byteLength(json), resultSha256: sha(json) },
  };
};

describe('writing, listing and reading (A7)', () => {
  it('writes 1 KiB to a/b/c.txt, appends 1 KiB, lists a/b and reads back the 2 KiB, with one audit record per write', async () => {
    const t = await setup();
    const first = 'a'.repeat(KiB);
    const second = 'b'.repeat(KiB);
    expect(await t.call('write_file', { path: 'a/b/c.txt', content: first })).toEqual({
      path: '/workspace/a/b/c.txt',
      size: KiB,
    });
    expect(await t.call('append_file', { path: 'a/b/c.txt', content: second })).toEqual({
      path: '/workspace/a/b/c.txt',
      size: 2 * KiB,
    });
    expect(await t.call('list_files', { path: 'a/b' })).toEqual({
      entries: [{ name: 'c.txt', type: 'file', size: 2 * KiB }],
    });
    expect(await t.call('read_file', { path: 'a/b/c.txt' })).toEqual({ content: first + second, size: 2 * KiB });
    // Each write's audit record, and every call's record with its result's size and sha256 (never its content).
    expect(t.log.entries).toEqual([
      {
        level: 'info',
        event: 'tool.file_written',
        fields: { handle: HANDLE, path: '/workspace/a/b/c.txt', size: KiB, sha256: sha(first) },
      },
      called('write_file', { path: '/workspace/a/b/c.txt', size: KiB }),
      {
        level: 'info',
        event: 'tool.file_written',
        fields: { handle: HANDLE, path: '/workspace/a/b/c.txt', size: 2 * KiB, sha256: sha(first + second) },
      },
      called('append_file', { path: '/workspace/a/b/c.txt', size: 2 * KiB }),
      called('list_files', { entries: [{ name: 'c.txt', type: 'file', size: 2 * KiB }] }),
      called('read_file', { content: first + second, size: 2 * KiB }),
    ]);
    expect(sha(await readFile(join(t.workspace, 'a', 'b', 'c.txt')))).toBe(sha(first + second));
  });

  it('reads a 20 KiB file in parts whose JSON is at most 8 KiB, each next_offset where the next part starts, none on the last', async () => {
    const t = await setup();
    const content = Array.from({ length: 20 * KiB }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    await writeFile(join(t.workspace, 'long.txt'), content);
    const parts = [await t.call('read_file', { path: 'long.txt' })];
    while (present(parts.at(-1), 'the last read_file part')['next_offset'] !== undefined)
      parts.push(
        await t.call('read_file', {
          path: 'long.txt',
          offset: present(parts.at(-1), 'the last read_file part')['next_offset'],
        }),
      );
    // Three parts; each but the last is the longest whose JSON fits 8 KiB (one more character would not).
    expect(parts).toHaveLength(3);
    let at = 0;
    for (const [i, p] of parts.entries()) {
      const text = p['content'] as string;
      expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(8192);
      at += text.length;
      expect(p['size']).toBe(20 * KiB);
      if (i < 2) {
        expect(p['next_offset']).toBe(at);
        expect(
          Buffer.byteLength(
            JSON.stringify({ ...p, content: content.slice(at - text.length, at + 1), next_offset: at + 1 }),
          ),
        ).toBeGreaterThan(8192);
      } else expect(p['next_offset']).toBeUndefined();
    }
    expect(parts.map((p) => p['content']).join('')).toBe(content);
    // A length below 8 KiB is honoured; above it is capped.
    expect((await t.call('read_file', { path: 'long.txt', length: 10 }))['content']).toBe(content.slice(0, 10));
    expect((await t.call('read_file', { path: 'long.txt', length: 100_000 }))['content']).toBe(
      present(parts[0], 'the first read_file part')['content'],
    );
  });

  it('cuts a part at a UTF-8 character boundary, so the next part starts where it ended', async () => {
    const t = await setup();
    const content = `${'a'.repeat(9)}€tail`; // € is three bytes, straddling byte 10
    await writeFile(join(t.workspace, 'u.txt'), content);
    const first = await t.call('read_file', { path: 'u.txt', length: 10 });
    expect([(first['content'] as string).length, first['next_offset']]).toEqual([9, 9]);
    const second = await t.call('read_file', { path: 'u.txt', offset: 9 });
    expect(second['content']).toBe('€tail');
    expect(utf8Boundary(Buffer.from('a€', 'utf8').subarray(0, 3))).toBe(1);
    expect(utf8Boundary(Buffer.from('a€', 'utf8'))).toBe(4);
    expect(utf8Boundary(Buffer.from('😀', 'utf8').subarray(0, 3))).toBe(0);
  });

  it('lists a long directory in 8 KiB parts, ending at an entry, with next_after for the rest; links and FIFOs are listed, never followed', async () => {
    const t = await setup();
    for (let i = 0; i < 300; i++)
      await writeFile(join(t.workspace, `entry-${String(i).padStart(4, '0')}-${'n'.repeat(20)}`), 'x');
    const pages: Record<string, unknown>[] = [await t.call('list_files', { path: '.' })];
    while (present(pages.at(-1), 'the last list_files page')['next_after'] !== undefined)
      pages.push(
        await t.call('list_files', {
          path: '.',
          after: present(pages.at(-1), 'the last list_files page')['next_after'],
        }),
      );
    // 300 entries of about 57 bytes: three parts, each at most 8 KiB and ending at an entry.
    expect(pages).toHaveLength(3);
    for (const page of pages.slice(0, -1)) {
      const entries = page['entries'] as { name: string }[];
      expect(Buffer.byteLength(JSON.stringify(entries))).toBeLessThanOrEqual(8192);
      expect(page['next_after']).toBe(present(entries.at(-1), 'the last entry of the page').name);
    }
    expect(pages.flatMap((p) => (p['entries'] as { name: string }[]).map((e) => e.name))).toEqual(
      (await readdir(t.workspace)).sort(byCodeUnit),
    );

    const u = await setup();
    await symlink('/etc', join(u.workspace, 'l'));
    execFileSync('mkfifo', [join(u.workspace, 'p')]);
    await mkdir(join(u.workspace, 'd'));
    expect(await u.call('list_files', { path: '.' })).toEqual({
      entries: [
        { name: 'd', type: 'dir', size: 0 },
        { name: 'l', type: 'link', size: 0 },
        { name: 'p', type: 'other', size: 0 },
      ],
    });
    expect(await u.call('list_files', { path: 'l' })).toEqual({ error: 'path_outside_workspace' });
  });

  it('never lets a concurrent reader see a partial file: write_file renames a complete new file into place', async () => {
    const t = await setup();
    const old = 'o'.repeat(200 * KiB);
    const fresh = 'n'.repeat(200 * KiB);
    await writeFile(join(t.workspace, 'swap.txt'), old);
    const state = { writing: true };
    const seen = new Set<string>();
    const reader = (async () => {
      while (state.writing) seen.add(sha(await readFile(join(t.workspace, 'swap.txt'))));
    })();
    for (let i = 0; i < 20; i++)
      expect(await t.call('write_file', { path: 'swap.txt', content: i % 2 === 0 ? fresh : old })).toMatchObject({
        size: 200 * KiB,
      });
    state.writing = false;
    await reader;
    expect([...seen].every((h) => h === sha(old) || h === sha(fresh))).toBe(true);
    expect(seen.size).toBeGreaterThanOrEqual(1);
    // No temporary file is left behind.
    expect(await readdir(t.workspace)).toEqual(['swap.txt']);
  });
});

describe('/channel (A13)', () => {
  it('writes and reads in /channel, with an audit record', async () => {
    const t = await setup({ channel: true });
    expect(await t.call('write_file', { path: '/channel/shared.txt', content: 'for everyone' })).toEqual({
      path: '/channel/shared.txt',
      size: 12,
    });
    expect(await t.call('read_file', { path: '/channel/shared.txt' })).toEqual({ content: 'for everyone', size: 12 });
    expect(await readFile(join(present(t.channel, 'the channel space'), 'shared.txt'), 'utf8')).toBe('for everyone');
    expect(t.log.entries).toEqual([
      {
        level: 'info',
        event: 'tool.file_written',
        fields: { handle: HANDLE, path: '/channel/shared.txt', size: 12, sha256: sha('for everyone') },
      },
      called('write_file', { path: '/channel/shared.txt', size: 12 }),
      called('read_file', { content: 'for everyone', size: 12 }),
    ]);
  });

  it('refuses /channel/../etc/passwd and a link from /channel to /etc', async () => {
    const t = await setup({ channel: true });
    await symlink('/etc', join(present(t.channel, 'the channel space'), 'etc'));
    expect(await t.call('read_file', { path: '/channel/../etc/passwd' })).toEqual({ error: 'path_outside_workspace' });
    expect(await t.call('read_file', { path: '/channel/etc/passwd' })).toEqual({ error: 'path_outside_workspace' });
    // .. that leaves /channel for /workspace leaves its root too.
    expect(await t.call('read_file', { path: '/channel/../workspace/x' })).toEqual({ error: 'path_outside_workspace' });
  });

  it('refuses a read and a write when a directory is swapped for a link between the path check and the open, reading and writing nothing', async () => {
    let swap: (() => Promise<void>) | undefined;
    const t = await setup({ channel: true, beforeOpen: async () => swap?.() });
    await mkdir(join(present(t.channel, 'the channel space'), 'sub'));
    await writeFile(join(present(t.channel, 'the channel space'), 'sub', 'secret.txt'), 'fine');
    // In the window, sub becomes a link to the directory outside, which holds its own secret.txt.
    swap = async () => {
      swap = undefined;
      await rename(
        join(present(t.channel, 'the channel space'), 'sub'),
        join(present(t.channel, 'the channel space'), 'sub-moved'),
      );
      await symlink(t.outside, join(present(t.channel, 'the channel space'), 'sub'));
    };
    const read = await t.call('read_file', { path: '/channel/sub/secret.txt' });
    expect(read).toEqual({ error: 'path_outside_workspace' });
    expect(JSON.stringify(read)).not.toContain('SECRET');

    await rm(join(present(t.channel, 'the channel space'), 'sub'));
    await rename(
      join(present(t.channel, 'the channel space'), 'sub-moved'),
      join(present(t.channel, 'the channel space'), 'sub'),
    );
    swap = async () => {
      swap = undefined;
      await rename(
        join(present(t.channel, 'the channel space'), 'sub'),
        join(present(t.channel, 'the channel space'), 'sub-moved'),
      );
      await symlink(t.outside, join(present(t.channel, 'the channel space'), 'sub'));
    };
    expect(await t.call('write_file', { path: '/channel/sub/new.txt', content: 'x' })).toEqual({
      error: 'path_outside_workspace',
    });
    expect(await readdir(t.outside)).toEqual(['secret.txt']);
  });

  it("refuses a write past the channel space's 1,000 entries as space_full, changing nothing", async () => {
    const t = await setup({ channel: true });
    for (let i = 0; i < 1_000; i++) await writeFile(join(present(t.channel, 'the channel space'), `f${String(i)}`), '');
    expect(await t.call('write_file', { path: '/channel/one-more', content: 'x' })).toEqual({ error: 'space_full' });
    expect(await t.call('append_file', { path: '/channel/one-more', content: 'x' })).toEqual({ error: 'space_full' });
    expect(await readdir(present(t.channel, 'the channel space'))).toHaveLength(1_000);
  });

  it('returns no_channel_space for every /channel path when the SDK is given no channel space', async () => {
    const t = await setup();
    for (const [name, args] of [
      ['read_file', { path: '/channel/x' }],
      ['write_file', { path: '/channel/x', content: 'y' }],
      ['list_files', { path: '/channel' }],
    ] as const) {
      expect(await t.call(name, args)).toEqual({ error: 'no_channel_space' });
    }
  });
});

describe('model-chosen arguments never crash a file tool (completion review finding 2)', () => {
  const tools = ['list_files', 'read_file', 'write_file', 'append_file'] as const;
  const args = (tool: (typeof tools)[number], path: string): Record<string, unknown> =>
    tool === 'write_file' || tool === 'append_file' ? { path, content: 'x' } : { path };

  it.each([
    ['offset 1e20', { offset: 1e20 }],
    ['offset 2^53', { offset: 2 ** 53 }],
    ['offset -1', { offset: -1 }],
    ['offset 1.5', { offset: 1.5 }],
    ['length 0', { length: 0 }],
    ['length 2^53', { length: 2 ** 53 }],
  ])('refuses read_file with %s as invalid_arguments', async (_, extra) => {
    const t = await setup();
    await writeFile(join(t.workspace, 'a.txt'), 'hello');
    expect(await t.call('read_file', { path: 'a.txt', ...extra })).toEqual({ error: 'invalid_arguments' });
  });

  it('reads at the largest safe offset: nothing, with the size, and no crash', async () => {
    const t = await setup();
    await writeFile(join(t.workspace, 'a.txt'), 'hello');
    expect(await t.call('read_file', { path: 'a.txt', offset: Number.MAX_SAFE_INTEGER, length: 8192 })).toEqual({
      content: '',
      size: 5,
    });
  });

  it.each(tools)('%s: a 300-byte name and a path past the system limit are invalid_arguments', async (tool) => {
    const t = await setup();
    expect(await t.call(tool, args(tool, 'n'.repeat(300)))).toEqual({ error: 'invalid_arguments' });
    const deep = Array.from({ length: 20 }, () => 'd'.repeat(250)).join('/');
    expect(await t.call(tool, args(tool, deep))).toEqual({
      error: tool === 'list_files' || tool === 'read_file' ? 'not_found' : 'invalid_arguments',
    });
    expect(t.log.entries.filter((e) => e.event === 'tool.crashed')).toEqual([]);
  });

  it('writes a file whose name is 250 bytes: its temp name has a fixed length', async () => {
    const t = await setup();
    const name = 'w'.repeat(250);
    expect(await t.call('write_file', { path: name, content: 'fits' })).toEqual({
      path: `/workspace/${name}`,
      size: 4,
    });
    expect(await readdir(t.workspace)).toEqual([name]);
  });

  it.each(tools)('%s: a file or directory the agent may not open is not_permitted', async (tool) => {
    const t = await setup();
    await mkdir(join(t.workspace, 'locked'));
    await writeFile(join(t.workspace, 'locked', 'f'), 'x');
    await writeFile(join(t.workspace, 'secret'), 'x');
    await chmod(join(t.workspace, 'secret'), 0o000);
    await chmod(join(t.workspace, 'locked'), 0o000);
    try {
      const results = [await t.call(tool, args(tool, 'locked/f'))];
      if (tool !== 'list_files') results.push(await t.call(tool, args(tool, 'secret')));
      else results.push(await t.call(tool, args(tool, 'locked')));
      // (A write is refused anywhere in the space while a directory in it is unreadable: its bounds cannot be measured.)
      expect(results).toEqual([{ error: 'not_permitted' }, { error: 'not_permitted' }]);
      expect(t.log.entries.filter((e) => e.event === 'tool.crashed')).toEqual([]);
    } finally {
      await chmod(join(t.workspace, 'locked'), 0o755);
    }
  });

  it.each(Object.entries(EXPECTED_ERRNO))(
    'the boundary turns errno %s into %s, and rethrows any other',
    async (code, reason) => {
      const thrown = (c: string) => async () =>
        Promise.reject(Object.assign(new Error(`${c}: simulated`), { code: c }));
      expect(await asToolFailure(thrown(code))).toEqual({ ok: false, reason });
      await expect(asToolFailure(thrown('EIO'))).rejects.toThrow('EIO: simulated');
      await expect(asToolFailure(async () => Promise.reject(new TypeError('not an errno')))).rejects.toThrow(
        'not an errno',
      );
      expect(await asToolFailure(() => Promise.resolve(ok('fine')))).toEqual({ ok: true, value: 'fine' });
    },
  );
});

describe('the device and inode check after the open (completion review finding 3)', () => {
  /** Swaps /channel/sub for a link to the outside directory before the open, and back before the second walk. */
  async function swapping(prepare: (t: Setup) => Promise<void>, onReopen?: (path: string) => Promise<void>) {
    let armed = false;
    const moved = () => join(present(t.channel, 'the channel space'), 'sub-moved');
    const t: Setup = await setup({
      channel: true,
      beforeOpen: async () => {
        if (!armed) return;
        await rename(join(present(t.channel, 'the channel space'), 'sub'), moved());
        await symlink(t.outside, join(present(t.channel, 'the channel space'), 'sub'));
      },
      afterOpen: async (path) => {
        if (!armed) return;
        armed = false;
        await rm(join(present(t.channel, 'the channel space'), 'sub'));
        await rename(moved(), join(present(t.channel, 'the channel space'), 'sub'));
        await onReopen?.(path);
      },
    });
    await mkdir(join(present(t.channel, 'the channel space'), 'sub'));
    await writeFile(join(present(t.channel, 'the channel space'), 'sub', 'secret.txt'), 'fine');
    await prepare(t);
    return { t, arm: () => (armed = true) };
  }

  it('read_file: the file opened through the link is refused, and nothing of it is returned', async () => {
    const { t, arm } = await swapping(() => Promise.resolve());
    arm();
    const read = await t.call('read_file', { path: '/channel/sub/secret.txt' });
    expect(read).toEqual({ error: 'path_outside_workspace' });
  });

  it('append_file: nothing is appended to the file outside', async () => {
    const { t, arm } = await swapping(() => Promise.resolve());
    arm();
    expect(await t.call('append_file', { path: '/channel/sub/secret.txt', content: '+more' })).toEqual({
      error: 'path_outside_workspace',
    });
    expect(await readFile(join(t.outside, 'secret.txt'), 'utf8')).toBe('SECRET');
  });

  it("write_file: a temp file created outside is refused, though a file of the temp's name exists inside by then", async () => {
    let t!: Setup;
    const made = await swapping(
      (u) => {
        t = u;
        return Promise.resolve();
      },
      // Back inside, a file stands at the temp's path, so only the device and inode tell the two apart.
      async (tempPath) =>
        writeFile(
          join(
            present(t.channel, 'the channel space'),
            'sub',
            present(tempPath.split('/').at(-1), 'the temp file name'),
          ),
          '',
        ),
    );
    made.arm();
    expect(await t.call('write_file', { path: '/channel/sub/new.txt', content: 'x' })).toEqual({
      error: 'path_outside_workspace',
    });
    expect(await readdir(join(present(t.channel, 'the channel space'), 'sub'))).toEqual(['secret.txt']);
  });

  it('list_files: the directory opened through the link is refused, and none of its names is returned', async () => {
    const { t, arm } = await swapping(async (u) => {
      await mkdir(join(present(u.channel, 'the channel space'), 'sub', 'inner'));
      await mkdir(join(u.outside, 'inner'));
      await writeFile(join(u.outside, 'inner', 'outside-name.txt'), '');
    });
    arm();
    const listed = await t.call('list_files', { path: '/channel/sub/inner' });
    expect(listed).toEqual({ error: 'path_outside_workspace' });
  });
});

describe('a file tool past its bound stops before its next change (completion review finding 12)', () => {
  it.each(['write_file', 'append_file'] as const)('%s aborted before its open changes nothing', async (tool) => {
    const controller = new AbortController();
    const base = await mkdtemp(join(tmpdir(), 'asha-files-abort-'));
    const log = new RecordingAgentLog();
    const files = fileTools({
      workspace: base,
      channelSpace: null,
      handle: HANDLE,
      log,
      beforeOpen: async () => {
        await Promise.resolve();
        controller.abort();
      },
    });
    const outcome = await present(files.get(tool), 'the file tool').run(
      { path: 'late.txt', content: 'x' },
      controller.signal,
    );
    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
    expect(await readdir(base)).toEqual([]);
    expect(log.entries).toEqual([]);
  });
});

describe('every result is at most 8 KiB of JSON, at its worst case (completion review finding 4)', () => {
  it('read_file of 8 KiB of NULs (six bytes of JSON each) returns a part whose JSON fits, and reads on from where it ended', async () => {
    const t = await setup();
    await writeFile(join(t.workspace, 'nul.txt'), Buffer.alloc(8192));
    const first = await t.call('read_file', { path: 'nul.txt' });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(8192);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeGreaterThan(8192 - 6);
    const parts = [first];
    while (present(parts.at(-1), 'the last read_file part')['next_offset'] !== undefined)
      parts.push(
        await t.call('read_file', {
          path: 'nul.txt',
          offset: present(parts.at(-1), 'the last read_file part')['next_offset'],
        }),
      );
    expect(parts.map((p) => p['content']).join('')).toBe('\0'.repeat(8192));
    for (const p of parts) expect(Buffer.byteLength(JSON.stringify(p))).toBeLessThanOrEqual(8192);
  });

  it('list_files of names that escape to six bytes a character returns parts whose JSON fits', async () => {
    const t = await setup();
    for (let i = 0; i < 60; i++)
      await writeFile(join(t.workspace, `${String(i).padStart(2, '0')}${'\u0001'.repeat(200)}`), '');
    const pages: Record<string, unknown>[] = [await t.call('list_files', { path: '.' })];
    while (present(pages.at(-1), 'the last list_files page')['next_after'] !== undefined)
      pages.push(
        await t.call('list_files', {
          path: '.',
          after: present(pages.at(-1), 'the last list_files page')['next_after'],
        }),
      );
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(8192);
    expect(pages.flatMap((p) => (p['entries'] as unknown[]).length).reduce((a, b) => a + b, 0)).toBe(60);
  });
});

describe('a folder on the path swapped for a link never makes a file outside the root (D20, agent-files R5, A7)', () => {
  /**
   * /channel/a/b/ is a real folder; in the window the hook names, `a` is moved aside and a link to the folder outside
   * the root (which holds its own b/) is put in its place. Nothing may then appear outside: no empty file from the
   * open, no temp file, no renamed file.
   */
  async function swappedAt(hook: 'beforeOpen' | 'beforeRename' | 'beforeMkdir') {
    let armed = false;
    const swap = async (): Promise<void> => {
      if (!armed) return;
      armed = false;
      await rename(
        join(present(t.channel, 'the channel space'), 'a'),
        join(present(t.channel, 'the channel space'), 'a-moved'),
      );
      await symlink(t.outside, join(present(t.channel, 'the channel space'), 'a'));
    };
    const t: Setup = await setup({ channel: true, [hook]: swap });
    await mkdir(join(present(t.channel, 'the channel space'), 'a', 'b'), { recursive: true });
    await mkdir(join(t.outside, 'b'));
    return { t, arm: () => (armed = true) };
  }
  const outsideNames = async (t: Setup) =>
    [...(await readdir(t.outside)), ...(await readdir(join(t.outside, 'b'))).map((n) => `b/${n}`)].sort(byCodeUnit);

  it.each([
    ['write_file', 'beforeOpen'],
    ['append_file', 'beforeOpen'],
    ['write_file', 'beforeRename'],
  ] as const)(
    '%s with the swap %s: refused path_outside_workspace, and no file appears outside',
    async (tool, hook) => {
      const { t, arm } = await swappedAt(hook);
      arm();
      expect(await t.call(tool, { path: '/channel/a/b/new.txt', content: 'x' })).toEqual({
        error: 'path_outside_workspace',
      });
      expect(await outsideNames(t)).toEqual(['b', 'secret.txt']);
    },
  );

  it.each(['write_file', 'append_file'] as const)(
    '%s making its missing folders, with the swap before a folder is made: no folder or file appears outside',
    async (tool) => {
      const { t, arm } = await swappedAt('beforeMkdir');
      arm();
      expect(await t.call(tool, { path: '/channel/a/b/c/d/new.txt', content: 'x' })).toEqual({
        error: 'path_outside_workspace',
      });
      expect(await outsideNames(t)).toEqual(['b', 'secret.txt']);
    },
  );

  it('with no swap, the same writes land inside (the hooks ran and changed nothing)', async () => {
    const { t } = await swappedAt('beforeRename');
    expect(await t.call('write_file', { path: '/channel/a/b/new.txt', content: 'x' })).toEqual({
      path: '/channel/a/b/new.txt',
      size: 1,
    });
    expect(await t.call('append_file', { path: '/channel/a/b/new.txt', content: 'y' })).toEqual({
      path: '/channel/a/b/new.txt',
      size: 2,
    });
    expect(await readFile(join(present(t.channel, 'the channel space'), 'a', 'b', 'new.txt'), 'utf8')).toBe('xy');
    expect(await outsideNames(t)).toEqual(['b', 'secret.txt']);
  });
});

describe('/channel counts every entry toward its 1,000 (agent-files R11, A7)', () => {
  /** Fills /channel with `dirs` folders, `links` links and `files` empty files: dirs + links + files entries. */
  async function filled(dirs: number, links: number, files: number) {
    const t = await setup({ channel: true });
    for (let i = 0; i < dirs; i++) await mkdir(join(present(t.channel, 'the channel space'), `d${String(i)}`));
    for (let i = 0; i < links; i++)
      await symlink('/etc', join(present(t.channel, 'the channel space'), `l${String(i)}`));
    for (let i = 0; i < files; i++) await writeFile(join(present(t.channel, 'the channel space'), `f${String(i)}`), '');
    return t;
  }
  const count = async (dir: string): Promise<number> => {
    let n = 0;
    for (const e of await readdir(dir, { withFileTypes: true }))
      n += 1 + (e.isDirectory() ? await count(join(dir, e.name)) : 0);
    return n;
  };

  it('directories and links count: 996 entries, then a write making 3 new folders and a file (4 entries) fits exactly', async () => {
    const t = await filled(500, 100, 396);
    expect(await t.call('write_file', { path: '/channel/x/y/z/new.txt', content: 'hi' })).toEqual({
      path: '/channel/x/y/z/new.txt',
      size: 2,
    });
    expect(await count(present(t.channel, 'the channel space'))).toBe(1_000);
  });

  it('at 997 entries the same write (4 entries) is space_full, changing nothing; so is an append that would make its file', async () => {
    const t = await filled(500, 100, 397);
    expect(await t.call('write_file', { path: '/channel/x/y/z/new.txt', content: 'hi' })).toEqual({
      error: 'space_full',
    });
    expect(await t.call('append_file', { path: '/channel/x/y/z/new.txt', content: 'hi' })).toEqual({
      error: 'space_full',
    });
    expect(await count(present(t.channel, 'the channel space'))).toBe(997);
  });

  it('at 1,000 entries an overwrite of an existing file adds none, and is allowed', async () => {
    const t = await filled(600, 0, 400);
    expect(await t.call('write_file', { path: '/channel/f0', content: 'new' })).toEqual({
      path: '/channel/f0',
      size: 3,
    });
  });

  it('/workspace still counts regular files only: 255 files and 200 folders, one more file fits', async () => {
    const t = await setup();
    for (let i = 0; i < 200; i++) await mkdir(join(t.workspace, `d${String(i)}`));
    for (let i = 0; i < 255; i++) await writeFile(join(t.workspace, `f${String(i)}`), '');
    expect(await t.call('write_file', { path: 'last.txt', content: 'x' })).toEqual({
      path: '/workspace/last.txt',
      size: 1,
    });
  });
});
