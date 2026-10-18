// Agent persistence on the real model and containers (docs/plans/agent-persistence.md A2, A7, A8b, A8c, A9, A10,
// A12, A17): a memory agent whose /memory and /workspace are kept across stops, on a channel whose board is kept —
// teams/suite-remember/ (identity keep/suite-remember/memo) — and the same recipe under another member name,
// teams/suite-remember-other/ (keep/suite-remember-other/other). The scenarios run in order on one home; each
// reads the state on disk, the daemon log and the files inside the container, never the model's word alone.

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeKey } from '../../images/memory/src/memory/index.js';
import { present } from '../../src/shared/assert-present.js';
import {
  agentDir,
  containerFiles,
  containerFor,
  containerOwners,
  daemonLog,
  docker,
  filesContaining,
  generations,
  homeContainers,
  homeVolumes,
  killDaemonAt,
  pointer,
  startDaemon,
  storedFiles,
  waitFor,
} from './persistence-support.js';
import { REPO, agentSuite, eventually, readContainerMemory, type AgentSuite } from './support.js';

const CHANNEL = 'keep';
const TEAM = 'suite-remember';
const IVY = scopeKey({ channel: CHANNEL, user: 'ivy' });
const JACK = scopeKey({ channel: CHANNEL, user: 'jack' });
const IVY_FACT = 'my favourite city is Lisbon';
const JACK_FACT = 'my favourite animal is the otter';
const LAUNCH_MS = 900_000;
const TURN_MS = 180_000;

let suite: AgentSuite;
const memoDir = () => agentDir(suite.home, CHANNEL, TEAM, 'memo');
const launch = (ctx: Parameters<AgentSuite['send']>[0], team = TEAM) =>
  suite.send(ctx, ['--launch', `team=${team}`, `channel=${CHANNEL}`], LAUNCH_MS);
const say = (ctx: Parameters<AgentSuite['send']>[0], user: string, message: string, to = 'memo-1') =>
  suite.send(ctx, [`channel=${CHANNEL}`, `user=${user}`, `to=${to}`, `message=${message}`], TURN_MS);
const stop = async () => {
  expect((await suite.asha(['--stop'], 100_000)).code).toBe(0);
};
const memo = () => containerFor(suite.home, 'memo-1');
/** A user's memory as the agent stored it, once its writes after the reply have landed (bounded). */
const remembered = (key: string, done: (m: Awaited<ReturnType<typeof readContainerMemory>>) => boolean) =>
  eventually(() => readContainerMemory(memo(), key), done, 90_000);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Every file's sha256 in `dir`'s current.json and its current generation, keyed by path (A17's byte-identical check). */
const generationBytes = (dir: string): Record<string, string> =>
  Object.fromEntries(
    [
      join(dir, 'current.json'),
      ...readdirSync(join(dir, `gen-${String(pointer(dir).generation)}`)).map((f) =>
        join(dir, `gen-${String(pointer(dir).generation)}`, f),
      ),
    ].map((f) => [f, sha(readFileSync(f))]),
  );

beforeAll(async () => {
  suite = await agentSuite('persistence', CHANNEL);
});

afterAll(async () => {
  await suite.finish();
});

describe('agent persistence: memo on channel "keep", users ivy and jack', () => {
  it('A2: a fact and a file, kept across --stop; the relaunch holds them byte for byte', async (ctx) => {
    suite.begin(ctx, {
      id: 'kept-across-stop',
      title: 'ivy tells memo a fact and has it write notes.txt; --stop; relaunch',
      agents: ['memo-1'],
      expectation: 'The relaunch recalls Lisbon and holds notes.txt; every file inside equals the stored generation.',
    });
    expect((await launch(ctx)).stdout).toBe('memo-1\n');
    expect((await say(ctx, 'ivy', `Please remember: ${IVY_FACT}.`)).code).toBe(0);
    await remembered(IVY, (m) => m.semantic.some((f) => /lisbon/i.test(f)));
    expect(
      (await say(ctx, 'ivy', 'Please use write_file to write a file named notes.txt whose whole content is: heron'))
        .code,
    ).toBe(0);
    expect((await docker(['exec', memo(), 'cat', '/workspace/notes.txt'])).trim()).toMatch(/heron/i);
    expect((await say(ctx, 'jack', `Please remember: ${JACK_FACT}.`)).code).toBe(0);
    await remembered(JACK, (m) => m.semantic.some((f) => /otter/i.test(f)));
    await stop();

    const relaunch = await launch(ctx);
    expect(relaunch.stdout).toBe('memo-1\n');
    // A7: the resumed line with --verbose (every suite run is verbose), and agent.resumed logged with no content.
    expect(relaunch.stderr).toMatch(/^› memo-1 resumed from state saved \d{4}-\d{2}-\d{2}T[\d:.]+Z$/m);
    const resumed = daemonLog(suite.home).filter((r) => r['event'] === 'agent.resumed');
    expect(resumed).toHaveLength(1);
    expect(JSON.stringify(resumed[0])).not.toMatch(/lisbon|heron|otter/i);
    // R3: every file inside the container is the stored generation's, byte for byte.
    for (const asset of ['memory', 'workspace'] as const) {
      const stored = await storedFiles(memoDir(), asset);
      expect(stored.size, asset).toBeGreaterThan(0);
      const inside = await containerFiles(memo(), `/${asset}`);
      for (const [file, digest] of stored) expect(inside.get(file), file).toBe(digest);
    }
    const recall = await say(ctx, 'ivy', 'What is my favourite city?');
    expect(recall.stdout).toMatch(/lisbon/i);
  });

  it('A9: restored files are owned by 1000 and writable by node', async (ctx) => {
    suite.begin(ctx, {
      id: 'restored-owner',
      title: 'the restored /memory and /workspace: owner and mode',
      agents: ['memo-1'],
      expectation: 'uid:gid 1000:1000 on every entry; node can write each file.',
    });
    for (const path of ['/memory', '/workspace']) {
      const owners = await containerOwners(memo(), path);
      expect(owners.size).toBeGreaterThan(1);
      expect([...owners].filter(([, o]) => o !== '1000:1000')).toEqual([]);
      await docker([
        'exec',
        '-u',
        'node',
        memo(),
        'sh',
        '-c',
        `find ${path} -type f ! -writable | grep . && exit 1 || exit 0`,
      ]);
    }
  });

  it('A2: a second launch of the online identity is refused identity_in_use, before any container starts', async (ctx) => {
    suite.begin(ctx, {
      id: 'identity-in-use',
      title: 'the same team onto the same channel while memo-1 is online',
      agents: ['memo-1'],
      expectation: '✗ identity_in_use naming keep/suite-remember/memo; no new container.',
    });
    const before = (await homeContainers(suite.home)).length;
    const again = await suite.asha(['--launch', `team=${TEAM}`, `channel=${CHANNEL}`], 120_000);
    expect(again.code).toBe(1);
    expect(again.stderr).toMatch(/identity_in_use: .*keep\/suite-remember\/memo/);
    expect(await homeContainers(suite.home)).toHaveLength(before);
  });

  it('A12: the board resumes its ids and a new session, and the relaunched member gets its handle back', async (ctx) => {
    suite.begin(ctx, {
      id: 'board-resumed',
      title: 'ivy asks memo to post a note to the blackboard; --stop; relaunch; again',
      agents: ['memo-1'],
      expectation: 'The second note continues the ids, with session 2.',
    });
    expect(
      (
        await say(
          ctx,
          'ivy',
          'Call blackboard_post exactly once, with the text: first note. Then reply to me with the one word: posted.',
        )
      ).code,
    ).toBe(0);
    await stop();
    const board = () =>
      JSON.parse(
        readFileSync(
          join(
            suite.home,
            'state',
            'channels',
            CHANNEL,
            `gen-${String(pointer(join(suite.home, 'state', 'channels', CHANNEL)).generation)}`,
            'board.json',
          ),
          'utf8',
        ),
      ) as { session: number; entries: { id: number; session: number }[] };
    const saved = board();
    expect(saved.entries.length).toBeGreaterThan(0);
    expect((await launch(ctx)).stdout).toBe('memo-1\n');
    expect(
      (
        await say(
          ctx,
          'ivy',
          'Call blackboard_post exactly once, with the text: second note. Then reply to me with the one word: posted.',
        )
      ).code,
    ).toBe(0);
    const after = await waitFor(
      board,
      (b) => b.entries.length > saved.entries.length,
      60_000,
      'the second note checkpointed',
    );
    const last = present(after.entries.at(-1), "the relaunch's last board entry");
    expect(last.id).toBe(present(saved.entries.at(-1), "the saved board's last entry").id + 1);
    expect(last.session).toBe(saved.session + 1);
  });

  it('A8c: a --stop while a turn runs exits 0 within 90 s; the agent is saved or said unsaved, never killed', async (ctx) => {
    suite.begin(ctx, {
      id: 'real-stop',
      title: 'ivy asks a question; --stop while its turn runs',
      agents: ['memo-1'],
      expectation:
        '--stop exits 0 within 90 s; state.promoted then agent.exited 143, or state.stop_unsaved; no agent.stop_killed.',
    });
    // Counted before the question is sent, so its channel.posted is always in the slice (the completion review, finding 11).
    const posted = daemonLog(suite.home).length;
    const asking = suite.asha(
      [`channel=${CHANNEL}`, 'user=ivy', 'to=memo-1', 'message=Please tell me a short story about a heron.'],
      TURN_MS,
    );
    await waitFor(
      () => daemonLog(suite.home).slice(posted),
      (log) => log.some((r) => r['event'] === 'channel.posted' && r['kind'] === 'input'),
      60_000,
      "the question's channel.posted",
    );
    const t0 = Date.now();
    const stopped = await suite.asha(['--stop'], 100_000);
    const stopMs = Date.now() - t0;
    await asking;
    expect(stopped.code).toBe(0);
    expect(stopped.stderr).not.toContain('still running');
    expect(stopMs).toBeLessThan(90_000);
    const log = daemonLog(suite.home).slice(posted);
    // memo's own records: the board's promotion (identity keep) is not the agent's.
    const at = (e: string) =>
      log.findIndex(
        (r) => r['event'] === e && (r['identity'] === undefined || r['identity'] === `${CHANNEL}/${TEAM}/memo`),
      );
    expect(
      Date.parse(String(present(log[at('daemon.stopped')], 'the daemon.stopped record')['ts'])) -
        Date.parse(String(present(log[at('daemon.stopping')], 'the daemon.stopping record')['ts'])),
    ).toBeLessThan(90_000);
    expect(at('agent.stop_killed')).toBe(-1);
    const saved =
      at('state.promoted') >= 0 &&
      log.some((r, i) => i > at('state.promoted') && r['event'] === 'agent.exited' && r['code'] === 143);
    expect(saved || at('state.stop_unsaved') >= 0).toBe(true);
    suite.prove(ctx, [{ claim: 'the stop took under 90 s', evidence: `${String(stopMs)} ms from --stop to its exit` }]);
  });

  it('A8b: a daemon killed with SIGKILL at the k-th state.promoted restarts holding exactly generation k', async (ctx) => {
    suite.begin(ctx, {
      id: 'crash-at-promote',
      title: 'SIGKILL at a state.promoted; relaunch',
      agents: ['memo-1'],
      expectation: 'The relaunch holds the generation that promotion named, and nothing written after it.',
    });
    expect((await launch(ctx)).stdout).toBe('memo-1\n');
    const since = daemonLog(suite.home).length;
    const asking = suite.asha(
      [
        `channel=${CHANNEL}`,
        'user=ivy',
        'to=memo-1',
        'message=Please use write_file to write crash.txt containing: one',
      ],
      TURN_MS,
    );
    await killDaemonAt(
      suite.home,
      (r, all) =>
        all.indexOf(r) >= since && r['event'] === 'state.promoted' && r['identity'] === `${CHANNEL}/${TEAM}/memo`,
      TURN_MS,
      'a state.promoted of memo after the message',
    );
    await asking;
    const k = Number(
      present(
        daemonLog(suite.home)
          .filter((r) => r['event'] === 'state.promoted' && r['identity'] === `${CHANNEL}/${TEAM}/memo`)
          .at(-1),
        'a state.promoted record of memo',
      )['generation'],
    );
    expect(pointer(memoDir()).generation).toBe(k);
    expect((await launch(ctx)).code).toBe(0);
    const stored = await storedFiles(memoDir(), 'workspace');
    const inside = await containerFiles(memo(), '/workspace');
    expect(new Map([...inside].filter(([f]) => f !== '/workspace/crash.txt' || stored.has(f)))).toEqual(stored);
  });

  it('A2: another member name is another identity: it holds neither the fact nor the file; state only under state/, no volume', async (ctx) => {
    suite.begin(ctx, {
      id: 'other-identity',
      title: '--stop; launch suite-remember-other on the same channel',
      agents: ['other-1'],
      expectation: 'other-1 holds no memory of ivy and no notes.txt.',
    });
    await stop();
    expect(await homeVolumes(suite.home)).toEqual([]);
    expect((await launch(ctx, 'suite-remember-other')).stdout).toBe('other-1\n');
    const other = containerFor(suite.home, 'other-1');
    expect(await readContainerMemory(other, IVY)).toEqual({ session: [], episodic: [], semantic: [], procedural: [] });
    await expect(docker(['exec', other, 'test', '-e', '/workspace/notes.txt'])).rejects.toThrow();
    // The saved state is only under state/: no pointer, generation or tar anywhere else in the home.
    const stray: string[] = [];
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const r = rel === '' ? e.name : `${rel}/${e.name}`;
        if (r === 'state' || r === 'models') continue;
        if (e.isDirectory()) walk(join(dir, e.name), r);
        else if (e.name === 'current.json' || e.name.endsWith('.tar') || /^gen-\d+$/.test(e.name)) stray.push(r);
      }
    };
    walk(suite.home, '');
    expect(stray).toEqual([]);
  });

  it('A10: a corrupted persisted memory file makes the memory agent exit non-zero naming the file, before it joins', async (ctx) => {
    suite.begin(ctx, {
      id: 'corrupt-memory',
      title: "a memory file of other's corrupted, checkpointed; --stop; relaunch",
      agents: [],
      expectation: '✗ agent_start naming the file; the agent never joins.',
    });
    const other = containerFor(suite.home, 'other-1');
    const key = scopeKey({ channel: CHANNEL, user: 'kim' });
    await docker([
      'exec',
      '-u',
      'node',
      other,
      'sh',
      '-c',
      `mkdir -p /memory/${key} && printf '{"schemaVersion":1,' > /memory/${key}/semantic.json`,
    ]);
    // A turn's ack is followed by a checkpoint: the corrupt file is saved with it.
    expect(
      (await suite.send(ctx, [`channel=${CHANNEL}`, 'user=jack', 'to=other-1', 'message=Hello.'], TURN_MS)).code,
    ).toBe(0);
    await stop();
    const failed = await suite.asha(['--launch', 'team=suite-remember-other', `channel=${CHANNEL}`], LAUNCH_MS);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(
      `memory file /memory/${key}/semantic.json is not a memory document: not JSON (SyntaxError at position`,
    );
    expect(
      daemonLog(suite.home).filter((r) => r['event'] === 'agent.online' && r['handle'] === 'other-1'),
    ).toHaveLength(1);
    expect(
      (await suite.asha(['--reset-state', `channel=${CHANNEL}`, 'team=suite-remember-other', 'name=other'], 60_000))
        .code,
    ).toBe(0);
  });

  it('A17: erasing ivy removes her memory and nothing else; the stored tars hold nothing of hers; no container left', async (ctx) => {
    suite.begin(ctx, {
      id: 'erase-user',
      title: '--reset-state channel=keep team=suite-remember name=memo user=ivy',
      agents: ['memo-1'],
      expectation: "ivy's memory gone, jack's byte-identical, the workspace kept.",
    });
    expect((await launch(ctx)).stdout).toBe('memo-1\n');
    const ivyFiles = (await containerFiles(memo(), `/memory/${IVY}`)).size;
    const jackBefore = await containerFiles(memo(), `/memory/${JACK}`);
    const notesBefore = (await containerFiles(memo(), '/workspace')).get('/workspace/notes.txt');
    expect(ivyFiles).toBeGreaterThan(0);
    expect(jackBefore.size).toBeGreaterThan(0);
    await stop();
    const previous = generations(memoDir());
    const erase = await suite.asha(
      ['--reset-state', `channel=${CHANNEL}`, `team=${TEAM}`, 'name=memo', 'user=ivy'],
      120_000,
    );
    expect(erase.code, erase.stderr).toBe(0);
    expect(erase.stdout).toContain(
      `erased user ivy from agent ${CHANNEL}/${TEAM}/memo memory (${String(ivyFiles)} files, `,
    );
    expect(erase.stdout).toContain(
      `kept agent ${CHANNEL}/${TEAM}/memo workspace: shared by every user of the channel, not erased`,
    );
    expect(filesContaining(join(suite.home, 'state'), 'Lisbon')).toEqual([]);
    expect(filesContaining(join(suite.home, 'state'), IVY)).toEqual([]);
    expect(generations(memoDir()).filter((g) => previous.includes(g))).toEqual([]);
    expect(await homeContainers(suite.home)).toEqual([]);

    expect((await launch(ctx)).stdout).toBe('memo-1\n');
    await expect(docker(['exec', memo(), 'test', '-d', `/memory/${IVY}`])).rejects.toThrow();
    expect(await containerFiles(memo(), `/memory/${JACK}`)).toEqual(jackBefore);
    expect((await containerFiles(memo(), '/workspace')).get('/workspace/notes.txt')).toBe(notesBefore);
    expect((await say(ctx, 'ivy', 'What is my favourite city?')).stdout).not.toMatch(/lisbon/i);
    expect((await say(ctx, 'jack', 'What is my favourite animal?')).stdout).toMatch(/otter/i);
  });

  it('A17: an erase whose image exits 1 in erase-user leaves the generation byte-identical and no container (the test-only image)', async (ctx) => {
    suite.begin(ctx, {
      id: 'erase-image-fails',
      title: 'teams/suite-erase-fails: its image fails erase-user on purpose',
      agents: ['doomed-1'],
      expectation:
        '✗ … exit_nonzero, exit 1; current.json and its generation unchanged; docker ps -a of this home empty.',
    });
    await stop();
    expect((await launch(ctx, 'suite-erase-fails')).stdout).toBe('doomed-1\n');
    // One acknowledged turn: its (empty) /memory is checkpointed, so there is saved memory to erase.
    expect((await say(ctx, 'ivy', 'Hello.', 'doomed-1')).stdout).toBe('noted\n');
    await stop();
    const dir = agentDir(suite.home, CHANNEL, 'suite-erase-fails', 'doomed');
    const before = generationBytes(dir);
    const erase = await suite.asha(
      ['--reset-state', `channel=${CHANNEL}`, 'team=suite-erase-fails', 'name=doomed', 'user=ivy'],
      180_000,
    );
    expect(erase.code).toBe(1);
    expect(erase.stderr).toContain(
      `✗ could not erase user ivy from agent ${CHANNEL}/suite-erase-fails/doomed: exit_nonzero`,
    );
    expect(generationBytes(dir)).toEqual(before);
    expect(await homeContainers(suite.home)).toEqual([]);
    // The one-shot ran for real: its stderr is in its own log file, and in no daemon log record.
    const logs = readdirSync(join(suite.home, 'logs', 'agents')).filter((f) => f.startsWith(`asha-erase-${CHANNEL}-`));
    expect(
      logs.some((f) => readFileSync(join(suite.home, 'logs', 'agents', f), 'utf8').includes('fails on purpose')),
    ).toBe(true);
    expect(
      daemonLog(suite.home)
        .filter((r) => r['event'] === 'state.erase_failed')
        .at(-1),
    ).toMatchObject({ reason: 'exit_nonzero', identity: `${CHANNEL}/suite-erase-fails/doomed` });
    expect(JSON.stringify(daemonLog(suite.home))).not.toContain('fails on purpose');
    // memo back online for the next scenario, as the one before left it.
    expect((await launch(ctx)).stdout).toBe('memo-1\n');
  });

  it('A17: a daemon killed with SIGKILL at state.erase_started leaves the generation byte-identical and, after its restart, no container', async (ctx) => {
    suite.begin(ctx, {
      id: 'erase-crash',
      title: 'SIGKILL at state.erase_started; the daemon restarted alone',
      agents: [],
      expectation: 'current.json and its generation unchanged; docker ps -a of this home empty before any launch.',
    });
    expect((await say(ctx, 'ivy', `Please remember: ${IVY_FACT}.`)).code).toBe(0);
    await remembered(IVY, (m) => m.semantic.some((f) => /lisbon/i.test(f)));
    await stop();
    const dir = memoDir();
    const before = generationBytes(dir);
    const since = daemonLog(suite.home).length;
    const erasing = suite.asha(
      ['--reset-state', `channel=${CHANNEL}`, `team=${TEAM}`, 'name=memo', 'user=ivy'],
      120_000,
    );
    await killDaemonAt(
      suite.home,
      (r, all) => all.indexOf(r) >= since && r['event'] === 'state.erase_started',
      120_000,
      'state.erase_started',
    );
    expect((await erasing).code).toBe(1);
    expect(generationBytes(dir)).toEqual(before);
    await startDaemon(join(REPO, 'asha'), suite.home, {
      ...process.env,
      ASHA_MODELS_DIR: process.env['ASHA_MODELS_DIR'] || join(homedir(), '.simplyautonomous', 'harness', 'models'),
    });
    expect(await homeContainers(suite.home)).toEqual([]);
    expect(generationBytes(dir)).toEqual(before);
  });
});
