// A channel's file space in real containers (docs/plans/agent-files.md A3, A6, A11, A12): the test-only scripted image
// images/suite-files, which makes no model call, runs one file command per message with the real agent SDK — its
// file tools and reply_with_files — so every byte goes through ./asha, the daemon, docker and the volume for real.
// The fixture teams are teams/suite-files (two agents) and teams/suite-files-kept (board and files persisted).
// Every docker call is bounded and labelled by the daemon with this suite's home; the teardown finds no volume left.

import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { harnessPaths } from '../../src/shared/paths.js';
import { daemonLog, docker, homeContainers, killDaemonAt, startDaemon, waitFor } from './persistence-support.js';
import { REPO, agentSuite, containerOf, homeVolumes, type AgentSuite } from './support.js';

const LAUNCH_MS = 900_000;
const TURN_MS = 300_000;
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

let suite: AgentSuite;
/** This suite's own working folders, one per scenario: files the CLI saves land there, never in the repo. */
let work: string;

beforeAll(async () => {
  suite = await agentSuite('files', 'lab');
  work = mkdtempSync(join(tmpdir(), 'asha-files-work-'));
});

afterAll(async () => {
  await suite.finish();
}, 120_000);

const homeId = () => harnessPaths({ ASHA_HOME: suite.home }).homeId;

/** A fresh working folder for one scenario's runs. */
function folder(name: string): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Launches `team` on `channel` and returns the handles it printed (one per line). */
async function launch(ctx: TestContext, team: string, channel: string): Promise<string[]> {
  const run = await suite.send(ctx, ['--launch', `team=${team}`, `channel=${channel}`], LAUNCH_MS);
  expect(run.code, run.stderr).toBe(0);
  return run.stdout.trim().split('\n');
}

/** Sends one command to `to` as alice, with any files, from `cwd`; the run's exit code, stdout and stderr. */
async function command(
  ctx: TestContext,
  channel: string,
  to: string,
  text: string,
  cwd: string,
  files: readonly string[] = [],
) {
  return suite.send(
    ctx,
    [`channel=${channel}`, `to=${to}`, 'user=alice', ...files.map((f) => `file=${f}`), `message=${text}`],
    TURN_MS,
    { cwd },
  );
}

/** Runs a shell command in a running agent container, as the agent's user; its stdout. */
const inContainer = (container: string, script: string) => docker(['exec', container, 'sh', '-c', script]);

/** Writes `text` to `path` through the agent's write_file and checks its result: the path and the bytes written. */
async function write(
  ctx: TestContext,
  channel: string,
  to: string,
  path: string,
  text: string,
  cwd: string,
): Promise<void> {
  const run = await command(ctx, channel, to, `write ${path} ${text}`, cwd);
  expect({ code: run.code, stdout: run.stdout }).toEqual({
    code: 0,
    stdout: `${JSON.stringify({ path, size: Buffer.byteLength(text) })}\n`,
  });
}

/** The attachments an agent's `attachments` command saw: its reply is their JSON. */
function attachmentsOf(stdout: string): { path: string; size: number; sha256: string }[] {
  return JSON.parse(present(stdout.trim().split('\n')[0], "the attachments reply's first line")) as never;
}

describe('a channel file space in real containers (agent-files)', () => {
  it('A3: the space is shared by the channel, its root and uploads are 1000:1000, uploads land in folders of their own, and it is the one mount', async (ctx) => {
    suite.begin(ctx, {
      id: 'space',
      title: 'two scripted agents on lab, one on other; writes, uploads, mounts and the holder',
      agents: ['a-1', 'b-1'],
      expectation:
        "One agent's /channel write is read by the other; an upload is byte-identical in both lab containers and absent from other's; folders per upload; one mount; the holder never started.",
    });
    const cwd = folder('a3');
    const [aRaw, bRaw] = await launch(ctx, 'suite-files', 'lab');
    const [otherRaw] = await launch(ctx, 'suite-files', 'other');
    const a = present(aRaw, "the first lab agent's handle");
    const b = present(bRaw, "the second lab agent's handle");
    const other = present(otherRaw, "the other channel's agent handle");
    const ca = containerOf(suite.home, 'lab', a);
    const cb = containerOf(suite.home, 'lab', b);
    const co = containerOf(suite.home, 'other', other);

    // No attachment yet: the root is the agents' user, and one agent's write is the other's read.
    expect((await inContainer(ca, 'stat -c %u:%g /channel')).trim()).toBe('1000:1000');
    await write(ctx, 'lab', a, '/channel/n.txt', 'shared by a', cwd);
    const read = await command(ctx, 'lab', b, 'read /channel/n.txt', cwd);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain('shared by a');

    // An upload sent to=a is byte-identical in both lab containers, at the folder path its message names.
    const bytes = randomBytes(4096);
    writeFileSync(join(cwd, 'f.bin'), bytes);
    const first = await command(ctx, 'lab', a, 'attachments', cwd, ['./f.bin']);
    expect(first.code, first.stderr).toBe(0);
    const [attachedRaw] = attachmentsOf(first.stdout);
    const attached = present(attachedRaw, "the first upload's attachment");
    expect(attached).toEqual({
      path: expect.stringMatching(/^\/channel\/upload-[0-9a-f]{16}\/f\.bin$/) as string,
      size: 4096,
      sha256: sha256(bytes),
    });
    for (const c of [ca, cb])
      expect((await inContainer(c, `sha256sum ${attached.path}`)).split(/\s+/)[0]).toBe(sha256(bytes));
    const folderPath = attached.path.slice(0, attached.path.lastIndexOf('/'));
    expect(
      (await inContainer(co, `ls -A /channel; test -e ${folderPath} && echo present || echo absent`))
        .trim()
        .split('\n')
        .at(-1),
    ).toBe('absent');

    // A second upload of the same name lands in a folder of its own; two files of one name in one upload are <name> and <name>-2.
    const again = attachmentsOf((await command(ctx, 'lab', a, 'attachments', cwd, ['./f.bin'])).stdout);
    expect(again).toHaveLength(1);
    const second = present(again[0], "the second upload's attachment");
    expect(second.path).toMatch(/^\/channel\/upload-[0-9a-f]{16}\/f\.bin$/);
    expect(second.path).not.toBe(attached.path);
    mkdirSync(join(cwd, 'x'));
    mkdirSync(join(cwd, 'y'));
    writeFileSync(join(cwd, 'x', 'same.txt'), 'from x\n');
    writeFileSync(join(cwd, 'y', 'same.txt'), 'from y\n');
    const pair = attachmentsOf(
      (await command(ctx, 'lab', a, 'attachments', cwd, ['./x/same.txt', './y/same.txt'])).stdout,
    );
    const pairFirst = present(pair[0], 'the first file of the pair upload');
    const pairFolder = pairFirst.path.slice(0, pairFirst.path.lastIndexOf('/'));
    expect(pair.map((p) => p.path)).toEqual([`${pairFolder}/same.txt`, `${pairFolder}/same-2.txt`]);
    expect(pair.map((p) => p.sha256)).toEqual([sha256('from x\n'), sha256('from y\n')]);

    // The folder and its files are the agents' user's, and another agent can write in the folder.
    expect(
      (await inContainer(cb, `stat -c '%u:%g %n' ${pairFolder} ${pairFolder}/same.txt ${pairFolder}/same-2.txt`))
        .trim()
        .split('\n'),
    ).toEqual([`1000:1000 ${pairFolder}`, `1000:1000 ${pairFolder}/same.txt`, `1000:1000 ${pairFolder}/same-2.txt`]);
    await write(ctx, 'lab', b, `${pairFolder}/from-b.txt`, 'written by b', cwd);
    expect((await inContainer(ca, `cat ${pairFolder}/from-b.txt`)).trim()).toBe('written by b');

    // Each agent has exactly one mount: this run's volume of the channel, at /channel.
    const created = daemonLog(suite.home).filter((r) => r['event'] === 'files.space_created');
    const volumeOf = (channel: string) =>
      String(
        present(
          created.find((r) => r['channel'] === channel),
          `a files.space_created record for ${channel}`,
        )['volume'],
      );
    expect(volumeOf('lab')).toMatch(new RegExp(`^asha-${homeId()}-[0-9a-f]{8}-lab$`));
    for (const [c, channel] of [
      [ca, 'lab'],
      [cb, 'lab'],
      [co, 'other'],
    ] as const) {
      const mounts = JSON.parse(await docker(['inspect', '--format', '{{json .Mounts}}', c])) as {
        Type: string;
        Name: string;
        Destination: string;
      }[];
      expect(mounts.map((m) => ({ type: m.Type, name: m.Name, at: m.Destination }))).toEqual([
        { type: 'volume', name: volumeOf(channel), at: '/channel' },
      ]);
    }

    // The holder: created from the launched agent's exact image, no network, never started.
    const agentImage = (await docker(['inspect', '--format', '{{.Config.Image}}', ca])).trim();
    const holder = JSON.parse(await docker(['inspect', '--format', '{{json .}}', `${volumeOf('lab')}-files`])) as {
      Config: { Image: string };
      HostConfig: { NetworkMode: string };
      State: { Status: string; StartedAt: string };
    };
    expect(holder.Config.Image).toBe(agentImage);
    expect(holder.HostConfig.NetworkMode).toBe('none');
    expect(holder.State.Status).toBe('created');
    expect(holder.State.StartedAt).toBe('0001-01-01T00:00:00Z');
  });

  it("A6: a reply's files are saved under asha-files/<channel>/, never overwriting, never through a link; refused paths save nothing", async (ctx) => {
    suite.begin(ctx, {
      id: 'returns',
      title: 'reply_with_files from the scripted agent: saves, a folder-path attachment returned, refusals',
      agents: ['a-1'],
      expectation:
        'out.txt then out-2.txt saved byte-identical with mode 0644 and no partial; a 1,000,000-byte attachment returned byte-identical; every refused path saves nothing.',
    });
    const a = 'a-1';
    const ca = containerOf(suite.home, 'lab', a);
    const cwd = folder('a6');
    const saved = join(cwd, 'asha-files', 'lab');

    await write(ctx, 'lab', a, '/channel/out.txt', 'the returned text', cwd);
    const want = sha256('the returned text');
    const one = await command(ctx, 'lab', a, 'return /channel/out.txt', cwd);
    expect(one.code, one.stderr).toBe(0);
    expect(one.stdout).toBe(`returned\nfile: asha-files/lab/out.txt (17 bytes, sha256 ${want})\n`);
    expect(sha256(readFileSync(join(saved, 'out.txt')))).toBe(want);
    expect(statSync(join(saved, 'out.txt')).mode & 0o777).toBe(0o644);
    expect(readdirSync(saved)).toEqual(['out.txt']);
    const two = await command(ctx, 'lab', a, 'return /channel/out.txt', cwd);
    expect(two.stdout).toBe(`returned\nfile: asha-files/lab/out-2.txt (17 bytes, sha256 ${want})\n`);
    expect(readdirSync(saved).sort(byCodeUnit)).toEqual(['out-2.txt', 'out.txt']);

    // A link already at the saved name: the file saves beside it, and the link's target is unchanged.
    const linked = folder('a6-link');
    mkdirSync(join(linked, 'asha-files', 'lab'), { recursive: true });
    writeFileSync(join(linked, 'target.txt'), 'the target\n');
    symlinkSync(join(linked, 'target.txt'), join(linked, 'asha-files', 'lab', 'out.txt'));
    const beside = await command(ctx, 'lab', a, 'return /channel/out.txt', linked);
    expect(beside.stdout).toBe(`returned\nfile: asha-files/lab/out-2.txt (17 bytes, sha256 ${want})\n`);
    expect(readFileSync(join(linked, 'target.txt'), 'utf8')).toBe('the target\n');
    expect(lstatSync(join(linked, 'asha-files', 'lab', 'out.txt')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(linked, 'asha-files', 'lab', 'out.txt'))).toBe(join(linked, 'target.txt'));

    // An attachment named by its folder path, a 1,000,000-byte binary file, comes back byte-identical.
    const binary = randomBytes(1_000_000);
    writeFileSync(join(cwd, 'blob.bin'), binary);
    const [blobRaw] = attachmentsOf((await command(ctx, 'lab', a, 'attachments', cwd, ['./blob.bin'])).stdout);
    const blob = present(blobRaw, "the blob upload's attachment");
    expect(blob.path).toMatch(/^\/channel\/upload-[0-9a-f]{16}\/blob\.bin$/);
    const back = await command(ctx, 'lab', a, `return ${blob.path}`, folder('a6-blob'));
    expect(back.stdout).toBe(`returned\nfile: asha-files/lab/blob.bin (1000000 bytes, sha256 ${sha256(binary)})\n`);
    expect(sha256(readFileSync(join(work, 'a6-blob', 'asha-files', 'lab', 'blob.bin')))).toBe(sha256(binary));

    // The refusals: each whole, with file_refused; no file posted, nothing saved, no partial.
    const fake = `upload-${randomBytes(8).toString('hex')}`;
    await inContainer(
      ca,
      [
        'ln -s /etc/hosts /channel/p',
        `ln -s /etc /channel/${fake}`,
        'mkdir -p /channel/other /channel/sub',
        'echo x > /channel/other/x.txt',
        'echo x > /channel/sub/x.txt',
        'ln -s /etc /channel/d',
        'echo hidden > /channel/.hidden',
        'head -c 25000001 /dev/zero > /channel/big.bin',
        'for i in 1 2 3 4 5 6 7 8 9 10 11; do echo $i > /channel/f$i.txt; done',
      ].join(' && '),
    );
    const refused = [
      '/channel/p',
      `/channel/${fake}/hosts`,
      '/channel/other/x.txt',
      '/channel/d/passwd',
      '/channel/sub/x.txt',
      '/channel/.hidden',
      '/workspace/../etc/hosts',
      '/etc/hosts',
      '/channel/big.bin',
      Array.from({ length: 11 }, (_, i) => `/channel/f${String(i + 1)}.txt`).join(' '),
    ];
    const none = folder('a6-refused');
    for (const path of refused) {
      const run = await command(ctx, 'lab', a, `return ${path}`, none);
      expect({ path, code: run.code, stdout: run.stdout }).toEqual({ path, code: 0, stdout: 'refused file_refused\n' });
    }
    expect(existsSync(join(none, 'asha-files'))).toBe(false);
    const refusals = daemonLog(suite.home).filter((r) => r['event'] === 'files.refused');
    expect(refusals.length).toBeGreaterThanOrEqual(refused.length);
    await inContainer(
      ca,
      `rm -rf /channel/p /channel/${fake} /channel/other /channel/sub /channel/d /channel/.hidden /channel/big.bin /channel/f*.txt`,
    );
  });

  it('A11: --stop leaves no container or volume of the home; after a SIGKILL the next start removes the stale volume before any agent starts', async (ctx) => {
    suite.begin(ctx, {
      id: 'reclaim',
      title: '--stop, then a SIGKILL and a restart',
      agents: ['a-1'],
      expectation:
        "No container or volume labelled with the home after --stop; the killed daemon's volume removed at the next start, logged files.stale_space_removed, before any agent starts.",
    });
    expect((await suite.asha(['--stop'], 100_000)).code).toBe(0);
    expect(await homeContainers(suite.home)).toEqual([]);
    expect(homeVolumes(suite.home)).toEqual([]);

    const since = daemonLog(suite.home).length;
    const [aRaw] = await launch(ctx, 'suite-files', 'lab');
    const a = present(aRaw, "the launched agent's handle");
    await write(ctx, 'lab', a, '/channel/left.txt', 'left by a killed daemon', folder('a11'));
    const left = homeVolumes(suite.home);
    expect(left).toHaveLength(1);
    await killDaemonAt(
      suite.home,
      (r, all) => all.indexOf(r) >= since && r['event'] === 'agent.connected',
      10_000,
      'the launched agent connected',
    );
    expect(homeVolumes(suite.home)).toEqual(left);

    const restart = daemonLog(suite.home).length;
    await startDaemon(join(REPO, 'asha'), suite.home, {
      ...process.env,
      ASHA_MODELS_DIR: process.env['ASHA_MODELS_DIR'] || join(homedir(), '.simplyautonomous', 'harness', 'models'),
    });
    const after = await waitFor(
      () => daemonLog(suite.home).slice(restart),
      (log) => log.some((r) => r['event'] === 'files.stale_space_removed'),
      60_000,
      'files.stale_space_removed after the restart',
    );
    expect(after.find((r) => r['event'] === 'files.stale_space_removed')).toMatchObject({ level: 'warn', volumes: 1 });
    expect(homeVolumes(suite.home)).toEqual([]);
    expect(await homeContainers(suite.home)).toEqual([]);
    // Then an agent starts on a space of this run's own.
    await launch(ctx, 'suite-files', 'lab');
    const log = daemonLog(suite.home).slice(restart);
    const removedAt = log.findIndex((r) => r['event'] === 'files.stale_space_removed');
    const firstStart = log.findIndex((r) => r['event'] === 'agent.starting');
    expect(removedAt).toBeGreaterThanOrEqual(0);
    expect(firstStart).toBeGreaterThan(removedAt);
    expect(homeVolumes(suite.home)).not.toEqual(left);
    expect((await suite.asha(['--stop'], 100_000)).code).toBe(0);
    expect(homeVolumes(suite.home)).toEqual([]);
  });

  it('A12: a persisted channel saves its files and file table at the stop and fills the space before its first agent starts', async (ctx) => {
    suite.begin(ctx, {
      id: 'persisted',
      title: 'suite-files-kept on keep: upload, write, stop, relaunch',
      agents: ['keeper-1'],
      expectation:
        "The generation holds board.json, files.tar and files-table.json; after the relaunch the space holds the files before the agent starts, and the table's records are the saved ones.",
    });
    const cwd = folder('a12');
    const [keeperRaw] = await launch(ctx, 'suite-files-kept', 'keep');
    const keeper = present(keeperRaw, "the launched keeper's handle");
    const canary = `canary-${randomBytes(4).toString('hex')}`;
    const kept = randomBytes(2048);
    writeFileSync(join(cwd, 'kept.bin'), kept);
    const [uploadRaw] = attachmentsOf(
      (await command(ctx, 'keep', keeper, `attachments ${canary}`, cwd, ['./kept.bin'])).stdout,
    );
    const upload = present(uploadRaw, "the kept upload's attachment");
    await write(ctx, 'keep', keeper, '/channel/k.txt', 'kept across a restart', cwd);
    expect((await suite.asha(['--stop'], 100_000)).code).toBe(0);

    const dir = join(suite.home, 'state', 'channels', 'keep');
    const generation = () =>
      join(
        dir,
        `gen-${String((JSON.parse(readFileSync(join(dir, 'current.json'), 'utf8')) as { generation: number }).generation)}`,
      );
    expect(readdirSync(generation()).sort(byCodeUnit)).toEqual(['board.json', 'files-table.json', 'files.tar']);
    const table = readFileSync(join(generation(), 'files-table.json'), 'utf8');
    expect(table).not.toContain(canary);
    // The table's records: path, size, sha256, user and time — the upload the posted message named.
    expect(JSON.parse(table)).toEqual([
      {
        path: upload.path,
        size: 2048,
        sha256: sha256(kept),
        user: 'alice',
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) as string,
      },
    ]);

    const since = daemonLog(suite.home).length;
    const [againRaw] = await launch(ctx, 'suite-files-kept', 'keep');
    const again = present(againRaw, "the relaunched keeper's handle");
    const log = daemonLog(suite.home).slice(since);
    const createdAt = log.findIndex((r) => r['event'] === 'files.space_created' && r['channel'] === 'keep');
    const startedAt = log.findIndex((r) => r['event'] === 'agent.starting' && r['channel'] === 'keep');
    expect(createdAt).toBeGreaterThanOrEqual(0);
    expect(startedAt).toBeGreaterThan(createdAt);
    const c = containerOf(suite.home, 'keep', again);
    expect((await inContainer(c, `sha256sum ${upload.path}`)).split(/\s+/)[0]).toBe(sha256(kept));
    expect((await inContainer(c, 'cat /channel/k.txt')).trim()).toBe('kept across a restart');
    expect((await inContainer(c, 'stat -c %u:%g /channel')).trim()).toBe('1000:1000');

    // The restored table is the saved one: the next stop saves exactly its records again.
    expect((await suite.asha(['--stop'], 100_000)).code).toBe(0);
    expect(JSON.parse(readFileSync(join(generation(), 'files-table.json'), 'utf8'))).toEqual(JSON.parse(table));
  });
});
