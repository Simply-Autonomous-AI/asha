// The agent suite reads ./asha's stderr back into channel events. These tests
// feed the parser what the CLI's real ConversationTracker prints — not a copy
// of its formats — so a change to the CLI's output breaks here, not silently
// in the agent suite's assertions.

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ConversationTracker } from '../../src/cli/commands.js';
import { present } from '../../src/shared/assert-present.js';
import type { ChannelMessage, ConversationEvent, ConversationMessage } from '../../src/shared/protocol.js';
import { agentSuite, outputs, parseTranscript, requireProgress, requireUser, toAll } from '../agents/support.js';

const msg = (over: Partial<ConversationMessage>): ConversationMessage => ({
  id: 'm1',
  channel: 'duo',
  conversation: 'm1',
  user: 'user-1',
  from: 'user-1',
  to: null,
  kind: 'input',
  text: 'hi',
  at: '2026-09-26T00:00:00.000Z',
  ...over,
});

/** What ./asha prints for these events: the real tracker, writing to strings. */
function printed(events: ConversationEvent[]): { stderr: string; stdout: string } {
  let stderr = '';
  let stdout = '';
  const t = new ConversationTracker(
    { stderr: (s) => (stderr += s), stdout: (s) => (stdout += s), progress: (s) => (stderr += s) },
    { sameBuild: true, deltas: null },
  );
  for (const e of events) t.handle(e);
  return { stderr, stdout };
}

describe("parseTranscript, against the CLI tracker's own output", () => {
  it('reads the status of a team member whose name holds a hyphen (stage-a-1)', () => {
    const { stderr } = printed([
      { type: 'posted', message: msg({ to: 'stage-a-1', text: 'Build the colour list.' }), working: ['stage-a-1'] },
      {
        type: 'message',
        message: msg({ from: 'stage-a-1', kind: 'status', text: 'pass: not mine' }),
        working: ['stage-a-1'],
      },
    ]);
    expect(parseTranscript(stderr, 'duo')).toEqual([
      { type: 'posted', from: 'user-1', to: 'stage-a-1', text: 'Build the colour list.' },
      { type: 'status', from: 'stage-a-1', text: 'pass: not mine' },
    ]);
  });

  it('reads the post of a user who named themselves (user=alice), not only user-<n>', () => {
    const { stderr } = printed([
      {
        type: 'posted',
        message: msg({ user: 'alice', from: 'alice', to: 'lead-1', text: 'Please ask greeter-1 to say Hello World.' }),
        working: ['lead-1'],
      },
    ]);
    expect(parseTranscript(stderr, 'duo')).toEqual([
      { type: 'posted', from: 'alice', to: 'lead-1', text: 'Please ask greeter-1 to say Hello World.' },
    ]);
  });

  it("reads a two-agent hand-off: the user's post, statuses, an addressed internal message and the output", () => {
    const { stderr } = printed([
      {
        type: 'announced',
        message: { ...msg({ from: 'hewo-1', kind: 'status', text: 'Hi' }), conversation: null } as ChannelMessage,
      },
      {
        type: 'posted',
        message: msg({ to: 'hewo-1', text: 'Please ask hewo-2 to say Hello World.' }),
        working: ['hewo-1'],
      },
      { type: 'message', message: msg({ from: 'hewo-1', kind: 'status', text: 'ok' }), working: ['hewo-1'] },
      {
        type: 'message',
        message: msg({ from: 'hewo-1', to: 'hewo-2', kind: 'internal', text: 'Say Hello World' }),
        working: ['hewo-2'],
      },
      {
        type: 'message',
        message: msg({ from: 'hewo-2', to: 'user-1', kind: 'output', text: 'Hello World' }),
        working: [],
      },
    ]);
    const events = parseTranscript(stderr, 'duo');
    expect(events).toEqual([
      { type: 'status', from: 'hewo-1', text: 'Hi' },
      { type: 'posted', from: 'user-1', to: 'hewo-1', text: 'Please ask hewo-2 to say Hello World.' },
      { type: 'status', from: 'hewo-1', text: 'ok' },
      { type: 'internal', from: 'hewo-1', to: 'hewo-2', text: 'Say Hello World' },
      { type: 'output', from: 'hewo-2', to: 'user-1' },
    ]);
    expect(outputs(events)).toEqual([{ from: 'hewo-2', to: 'user-1' }]);
    expect(toAll(events)).toEqual([]);
  });

  it('reads a post to everyone, a message to all agents, a multi-line message and a failure line', () => {
    const { stderr } = printed([
      { type: 'posted', message: msg({ text: 'Hi' }), working: ['hewo-1'] },
      { type: 'message', message: msg({ from: 'hewo-1', kind: 'status', text: 'ok' }), working: ['hewo-1'] },
      { type: 'message', message: msg({ from: 'hewo-1', kind: 'internal', text: 'Hi\nanyone there?' }), working: [] },
    ]);
    const events = parseTranscript(stderr, 'duo');
    expect(events).toEqual([
      { type: 'posted', from: 'user-1', to: null, text: 'Hi' },
      { type: 'status', from: 'hewo-1', text: 'ok' },
      { type: 'internal', from: 'hewo-1', to: null, text: 'Hi\nanyone there?' },
      {
        type: 'failure',
        text: expect.stringMatching(/^the conversation ended with no reply at all/) as unknown as string,
      },
    ]);
    expect(toAll(events)).toEqual([{ type: 'internal', from: 'hewo-1', to: null, text: 'Hi\nanyone there?' }]);
    expect(outputs(events)).toEqual([]);
  });

  it('keeps a line it does not recognise as progress instead of dropping it', () => {
    const { stderr } = printed([{ type: 'phase', phase: 'model', detail: 'qwen3-8b-q4_k_m downloaded' }]);
    expect(parseTranscript(stderr, 'duo')).toEqual([{ type: 'progress', text: 'model: qwen3-8b-q4_k_m downloaded' }]);
  });
});

describe('requireProgress: a recorded run must show its progress (cli-interactive R15, A14)', () => {
  const events: ConversationEvent[] = [
    { type: 'posted', message: msg({ text: 'Hi' }), working: ['hewo-1'] },
    {
      type: 'message',
      message: msg({ id: 'm2', from: 'hewo-1', to: 'user-1', kind: 'output', text: 'Hello.' }),
      working: [],
    },
  ];

  it('fails a run whose stderr has no › line — what the CLI prints without --verbose — naming its arguments', () => {
    let stderr = '';
    // The real tracker with progress off, as runCli wires it without --verbose.
    const t = new ConversationTracker(
      { stderr: (s) => (stderr += s), stdout: () => undefined, progress: () => undefined },
      { sameBuild: true, deltas: null },
    );
    for (const e of events) t.handle(e);
    expect(stderr).toBe('');
    expect(() => {
      requireProgress({ args: ['channel=duo', 'message=Hi'], stderr });
    }).toThrow(
      'asha channel=duo message=Hi printed no progress (no › line on stderr): run it with --verbose\nstderr: ',
    );
    expect(() => {
      requireProgress({ args: ['message=Hi'], stderr: '✗ unknown_handle: no agent "x"\n' });
    }).toThrow('asha message=Hi printed no progress');
  });

  // D32's payoff (completion review, finding 5): the login-name line is printed without --verbose, so it is no proof
  // that progress was on.
  it('does not count the always-printed login-name line as progress', () => {
    const stderr = '› your login name "John.Smith" is sent as user ID "john-smith"\n';
    expect(() => {
      requireProgress({ args: ['message=Hi'], stderr });
    }).toThrow('asha message=Hi printed no progress');
    expect(() => {
      requireProgress({ args: ['--verbose', 'message=Hi'], stderr: `${stderr}› john-smith → main: Hi\n` });
    }).not.toThrow();
  });

  it('passes a run with progress, as the CLI prints it with --verbose', () => {
    expect(() => {
      requireProgress({ args: ['--verbose', 'message=Hi'], stderr: printed(events).stderr });
    }).not.toThrow();
  });
});

describe('a message send names its user (cli-interactive R16, A15)', () => {
  it('requireUser refuses a message without user=, and lets a launch or a named message through', () => {
    expect(() => {
      requireUser(['channel=duo', 'message=Hi']);
    }).toThrow('send(): a message needs user=');
    expect(() => {
      requireUser(['--launch', 'recipe=hello-world']);
    }).not.toThrow();
    expect(() => {
      requireUser(['user=sam', 'message=Hi']);
    }).not.toThrow();
  });

  it("the suite's send refuses it before anything is spawned", async (ctx) => {
    const suite = await agentSuite('unit-send', 'duo');
    try {
      suite.begin(ctx, { id: 'unit-send', title: 'refused', agents: [], expectation: 'refused before running' });
      // A timeout of 1 ms: had ./asha been spawned, the run would fail as killed, not with this message.
      await expect(suite.send(ctx, ['channel=duo', 'message=Hi'], 1)).rejects.toThrow('send(): a message needs user=');
      // Nothing ran: the suite's fresh home is still empty.
      expect(await readdir(suite.home)).toEqual([]);
    } finally {
      await rm(suite.home, { recursive: true, force: true });
    }
  });

  it('parseTranscript reads a posted line of a named user, as the CLI prints it', () => {
    const { stderr } = printed([
      { type: 'posted', message: msg({ user: 'sam', from: 'sam', text: 'Hi' }), working: ['hewo-1'] },
      {
        type: 'message',
        message: msg({ id: 'm2', user: 'sam', from: 'hewo-1', to: 'sam', kind: 'output', text: 'Hello.' }),
        working: [],
      },
    ]);
    expect(parseTranscript(stderr, 'duo')).toEqual([
      { type: 'posted', from: 'sam', to: null, text: 'Hi' },
      { type: 'output', from: 'hewo-1', to: 'sam' },
    ]);
  });
});

describe('modelCalls: the latency record in every agent-suite results file (agent-tools completion review, finding 6)', () => {
  it('keeps exactly the model calls of a daemon log, in order, with their durations', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { modelCalls } = await import('../agents/support.js');
    const home = await mkdtemp(join(tmpdir(), 'asha-calls-'));
    await mkdir(join(home, 'logs'));
    const lines = [
      { ts: 't1', level: 'info', event: 'agent.online', handle: 'hewo-1' },
      {
        ts: 't2',
        level: 'info',
        event: 'model.chat',
        handle: 'hewo-1',
        channel: 'c',
        model: 'm',
        ms: 812,
        promptTokens: 2069,
        cachedTokens: 1984,
      },
      {
        ts: 't3',
        level: 'error',
        event: 'model.chat_failed',
        handle: 'memo-6',
        channel: 'c',
        model: 'm',
        ms: 55855,
        reason: 'unavailable',
      },
      { ts: 't4', level: 'info', event: 'model.embed', handle: 'memo-1', channel: 'c', model: 'e', texts: 1, ms: 40 },
      { ts: 't5', level: 'info', event: 'model_server.ready', model: 'm' },
    ];
    await writeFile(join(home, 'logs', 'daemon.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(modelCalls(home)).toEqual([
      {
        at: 't2',
        event: 'model.chat',
        channel: 'c',
        handle: 'hewo-1',
        model: 'm',
        ms: 812,
        promptTokens: 2069,
        cachedTokens: 1984,
      },
      { at: 't3', event: 'model.chat_failed', channel: 'c', handle: 'memo-6', model: 'm', ms: 55855 },
      { at: 't4', event: 'model.embed', channel: 'c', handle: 'memo-1', model: 'e', ms: 40 },
    ]);
    expect(() => modelCalls(join(home, 'nowhere'))).toThrow('ENOENT');
  });

  it('refuses a model.chat record without both prompt token counts (prompt-prefix R10, A6)', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { modelCalls } = await import('../agents/support.js');
    for (const [fields, missing] of [
      [{ promptTokens: 2069 }, 'cachedTokens'],
      [{ cachedTokens: 3 }, 'promptTokens'],
      [{ promptTokens: -1, cachedTokens: 0 }, 'promptTokens'],
    ] as const) {
      const home = await mkdtemp(join(tmpdir(), 'asha-calls-'));
      await mkdir(join(home, 'logs'));
      await writeFile(
        join(home, 'logs', 'daemon.jsonl'),
        `${JSON.stringify({ ts: 't2', level: 'info', event: 'model.chat', handle: 'memo-2', channel: 'c', model: 'm', ms: 5, ...fields })}\n`,
      );
      expect(() => modelCalls(home), JSON.stringify(fields)).toThrow(`model.chat at t2 (memo-2) has no ${missing}`);
    }
  });
});

describe("memory-crowd's cache-hit count (prompt-prefix R13)", () => {
  it("takes each handle's first model.chat on the channel since the message, and counts those at least 90 % cached", async () => {
    const { cacheHits, firstChatCalls } = await import('../agents/support.js');
    const call = (at: string, handle: string, cachedTokens: number, over: Record<string, unknown> = {}) =>
      ({
        at,
        event: 'model.chat',
        channel: 'crowd',
        handle,
        model: 'q',
        ms: 1,
        promptTokens: 2000,
        cachedTokens,
        ...over,
      }) as const;
    const calls = [
      call('2026-09-28T10:00:00.000Z', 'memo-1', 2000), // before the message: not its turn
      call('2026-09-28T10:00:05.000Z', 'memo-1', 0),
      call('2026-09-28T10:00:06.000Z', 'memo-1', 1990), // memo-1's second call: not its first
      call('2026-09-28T10:00:07.000Z', 'memo-2', 1800), // exactly 90 %
      call('2026-09-28T10:00:08.000Z', 'memo-3', 1799),
      call('2026-09-28T10:00:09.000Z', 'memo-4', 1990, { channel: 'other' }),
      call('2026-09-28T10:00:10.000Z', 'memo-4', 1990, { event: 'model.embed' }),
    ];
    const firsts = firstChatCalls(calls, 'crowd', ['memo-1', 'memo-2', 'memo-3', 'memo-4'], '2026-09-28T10:00:01.000Z');
    expect(firsts.map((c) => [c.handle, c.cachedTokens])).toEqual([
      ['memo-1', 0],
      ['memo-2', 1800],
      ['memo-3', 1799],
    ]);
    expect(cacheHits(firsts).map((c) => c.handle)).toEqual(['memo-2']);
  });
});

describe("the agent suite's stop-time check: what a stop, or an agent, lost (stopTimeErrors)", () => {
  async function home(agentLines: readonly string[], daemonRecords: readonly Record<string, unknown>[] = []) {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'asha-stoptime-'));
    await mkdir(join(dir, 'logs', 'agents'), { recursive: true });
    await writeFile(join(dir, 'logs', 'daemon.jsonl'), daemonRecords.map((r) => JSON.stringify(r)).join('\n') + '\n');
    await writeFile(join(dir, 'logs', 'agents', 'asha-x-memo-1.log'), agentLines.join('\n') + '\n');
    return dir;
  }

  it.each([
    'agent.drain_incomplete',
    'agent.background_failed',
    'memory.write_failed',
    'memory.save_failed',
    'memory.file_malformed',
    'memory.records_dropped',
  ])("names an agent log's %s, with its file", async (event) => {
    const { stopTimeErrors } = await import('../agents/support.js');
    const dir = await home([
      'joining the channel as memo',
      JSON.stringify({ level: 'error', event, scope: 'ab12' }),
      JSON.stringify({ level: 'info', event: 'memory.saved' }),
    ]);

    const found = stopTimeErrors(dir);

    expect(found).toHaveLength(1);
    expect(found[0]).toContain('asha-x-memo-1.log');
    expect(found[0]).toContain(`"event":"${event}"`);
  });

  it('names an error in the daemon log after its stop began, and nothing before it or after a start', async () => {
    const { stopTimeErrors } = await import('../agents/support.js');
    const dir = await home(
      [],
      [
        { level: 'error', event: 'model.chat_failed' },
        { level: 'info', event: 'daemon.stopping' },
        { level: 'error', event: 'agent.stop_killed' },
        { level: 'info', event: 'daemon.started' },
        { level: 'error', event: 'model.chat_failed' },
      ],
    );

    expect(stopTimeErrors(dir).map((line) => present(/"event":"([^"]+)"/.exec(line), 'the event match')[1])).toEqual([
      'agent.stop_killed',
    ]);
  });
});

describe("the agent suite's margin check, through finishSuite (prompt-prefix R14, A9)", () => {
  const HOME_KEY = (home: string) => `${home}/model-server.key`;
  const OWNER_KEY = '/Users/someone/.simplyautonomous/harness/model-server.key';

  async function fixture(records: readonly Record<string, unknown>[]) {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const home = await mkdtemp(join(tmpdir(), 'asha-margin-'));
    await mkdir(join(home, 'logs', 'agents'), { recursive: true });
    await writeFile(join(home, 'logs', 'daemon.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const resultsDir = join(home, 'results');
    const stops: number[] = [];
    const { finishSuite } = await import('../agents/support.js');
    const finish = (volumesLeft: readonly string[] = []) =>
      finishSuite({
        volumesLeft: () => volumesLeft,
        name: 'crowd-fixture',
        home,
        commit: 'abc1234',
        dirty: false,
        startedAt: 't0',
        scenarios: [],
        stop: () => {
          stops.push(1);
          return Promise.resolve({ code: 0, stdout: '', stderr: '' });
        },
        resultsDir,
        llamaServers: () => [
          // This suite's own server names its home in --api-key-file: never listed.
          {
            pid: 101,
            command: `/opt/homebrew/bin/llama-server --model /m/own.gguf --api-key-file ${HOME_KEY(home)} --port 0`,
          },
          {
            pid: 777,
            command: `/opt/homebrew/bin/llama-server --model /m/q.gguf --alias q --api-key-file ${OWNER_KEY} --port 0`,
          },
          { pid: 778, command: 'llama-server --model /m/e.gguf --api-key=0123abcd --embeddings' },
          // A Hugging Face token on the command line (llama-server's --hf-token / -hft): never printed.
          { pid: 779, command: 'llama-server -hf org/m --hf-token hf_SECRET1 --port 1' },
          { pid: 780, command: 'llama-server -hf org/m -hft=hf_SECRET2 --port 2' },
        ],
      });
    return { home, resultsDir, stops, finish };
  }
  const chat = (handle: string, ms: number, event = 'model.chat') => ({
    ts: `at-${handle}`,
    level: event === 'model.chat' ? 'info' : 'error',
    event,
    handle,
    channel: 'crowd',
    model: 'q',
    ms,
    ...(event === 'model.chat' ? { promptTokens: 2085, cachedTokens: 1990 } : {}),
  });

  it('fails a model.chat at 45,001 ms, naming the suite, the handle and the duration, and lists the other llama-servers without their key paths or tokens', async () => {
    const { readFile } = await import('node:fs/promises');
    const f = await fixture([chat('memo-1', 12_000), chat('memo-3', 45_001)]);
    const error = await f.finish().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toBe(
      [
        'crowd-fixture: 1 model call(s) took more than 45,000 ms, 75 % of the 60,000 ms chat bound:',
        '  memo-3 model.chat 45,001 ms at at-memo-3',
        "Other llama-server processes running (not this suite's daemon's; stop them and re-run):",
        '  pid 777: /opt/homebrew/bin/llama-server --model /m/q.gguf --alias q --api-key-file <key file> --port 0',
        '  pid 778: llama-server --model /m/e.gguf --api-key <key> --embeddings',
        '  pid 779: llama-server -hf org/m --hf-token <token> --port 1',
        '  pid 780: llama-server -hf org/m -hft <token> --port 2',
      ].join('\n'),
    );
    expect(error?.message).not.toContain(OWNER_KEY);
    expect(error?.message).not.toContain('0123abcd');
    expect(error?.message).not.toMatch(/hf_SECRET/);
    // The results file is written first, so the evidence of a failed margin is kept.
    const written = JSON.parse(await readFile(join(f.resultsDir, 'crowd-fixture.json'), 'utf8')) as {
      modelCalls: unknown[];
    };
    expect(written.modelCalls).toHaveLength(2);
    expect(f.stops).toEqual([1]);
  });

  it("fails when a volume labelled with the suite's home is left after its stop, naming it (agent-files R10a)", async () => {
    const f = await fixture([chat('memo-1', 12_000)]);
    const error = await f.finish(['asha-abcd1234-0123abcd-lab']).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error?.message).toContain('asha-abcd1234-0123abcd-lab');
    await expect(f.finish([])).resolves.toBeUndefined();
  });

  it('passes a model.chat at exactly 45,000 ms, and an embedding slower than that (only chat calls have the chat bound)', async () => {
    const f = await fixture([chat('memo-1', 45_000), { ...chat('memo-2', 50_000, 'model.embed'), texts: 1 }]);
    await expect(f.finish()).resolves.toBeUndefined();
  });

  it('fails a model.chat_failed at 60,002 ms', async () => {
    const f = await fixture([chat('memo-6', 60_002, 'model.chat_failed')]);
    await expect(f.finish()).rejects.toThrow(
      /^crowd-fixture: 1 model call\(s\) took more than 45,000 ms[\s\S]*\n {2}memo-6 model.chat_failed 60,002 ms at at-memo-6\n/,
    );
  });

  it('says so when no other llama-server is running', async () => {
    const { marginFailure } = await import('../agents/support.js');
    expect(
      marginFailure('s', [{ at: 'a', event: 'model.chat', channel: 'c', handle: 'h-1', model: 'q', ms: 50_000 }], []),
    ).toBe(
      's: 1 model call(s) took more than 45,000 ms, 75 % of the 60,000 ms chat bound:\n  h-1 model.chat 50,000 ms at a\nNo other llama-server was running when the suite finished.',
    );
  });
});
