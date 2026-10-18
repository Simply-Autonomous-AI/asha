// Agent tools on the real models (docs/plans/agent-tools.md A3, A9, A10, A12,
// A14, A17): real hello-world agents in their containers — one on Pico-V2
// (hello-world), one on Qwen3 8B (hello-router) — using the common file tools
// through ./asha, the daemon and the pinned models. Nothing is faked. Ministral
// 3 8B, the second model here until 2026-10-14, is used for nothing (the owner,
// 2026-10-14).

import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { agentSuite, containerOf, outputs, type AgentSuite } from './support.js';

const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;
const PICO = 'pico-v2-q8_0';
const QWEN = 'qwen3-8b-q4_k_m';
/** Both recipes' bound on one delivery (recipes/hello-world.json, recipes/hello-router.json). */
const MESSAGE_TIMEOUT_MS = 60_000;
/** The most model calls one turn can make (R3): 6 tool rounds, 2 answered list_agents rounds, 2 corrections, the final one. */
const MAX_CALLS_PER_TURN = 11;

function run(command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { env: { ...process.env, DOCKER_HOST }, timeout: 60_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error(`${command} ${args.join(' ')} exceeded 60 s\n${stderr}`));
          return;
        }
        if (error && typeof error.code !== 'number') {
          const execError: Error = present(error, 'the exec error');
          reject(execError);
          return;
        }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

let suite: AgentSuite;

type LogRecord = Record<string, unknown>;
const daemonLog = (): LogRecord[] =>
  readFileSync(join(suite.home, 'logs', 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as LogRecord);

/** The JSON records of one agent's log (the harness appends its stdout and stderr there); plain lines are skipped. */
function agentRecords(container: string): LogRecord[] {
  return readFileSync(join(suite.home, 'logs', 'agents', `${container}.log`), 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.startsWith('{')) return [];
      try {
        return [JSON.parse(line) as LogRecord];
      } catch {
        return []; // a plain line that happens to start with a brace: not a record
      }
    });
}

/** The model calls the daemon served for one agent on one channel. */
const chatsOf = (channel: string, handle: string) =>
  daemonLog().filter((r) => r['event'] === 'model.chat' && r['channel'] === channel && r['handle'] === handle);

beforeAll(async () => {
  suite = await agentSuite('agent-tools', 'tools');
});

afterAll(async () => {
  await suite.finish();
});

describe('agent tools on the real models', () => {
  it('two agents on one channel, on Pico-V2 and Qwen3 8B, each write a line, read it back and reply with it, each on its own server (A9, A10)', async (ctx) => {
    suite.begin(ctx, {
      id: 'two-models',
      title: 'A Pico-V2 agent and a Qwen3 8B agent write and read a file each',
      agents: ['hewo-1 (pico-v2)', 'hewo-2 (qwen3-8b)'],
      expectation:
        "Each agent calls write_file, then read_file, and replies with exactly the line it read; each model call is served by its own model's llama-server.",
    });
    expect((await suite.send(ctx, ['--launch', 'recipe=hello-world', 'channel=pair'], 900_000)).code).toBe(0);
    expect((await suite.send(ctx, ['--launch', 'recipe=hello-router', 'channel=pair'], 900_000)).code).toBe(0);
    const ask = (to: string, line: string) =>
      suite.send(
        ctx,
        [
          'user=tom',
          'channel=pair',
          `to=${to}`,
          `message=Use write_file to write the line '${line}' to notes.txt, then read it back with read_file, and reply with exactly what you read.`,
        ],
        300_000,
      );

    const pico = await ask('hewo-1', 'blue fox 41');
    const qwen = await ask('hewo-2', 'red owl 42');

    expect([pico.code, pico.stdout.trim()], pico.stderr).toEqual([0, 'blue fox 41']);
    expect([qwen.code, qwen.stdout.trim()], qwen.stderr).toEqual([0, 'red owl 42']);
    expect(outputs(pico.events).map((o) => o.from)).toEqual(['hewo-1']);
    expect(outputs(qwen.events).map((o) => o.from)).toEqual(['hewo-2']);
    for (const [handle, model, line] of [
      ['hewo-1', PICO, 'blue fox 41'],
      ['hewo-2', QWEN, 'red owl 42'],
    ] as const) {
      const chats = chatsOf('pair', handle);
      // write_file, then read_file, then the reply — whether the model makes the write and the read in one response
      // (as Ministral 3 did, the model here until 2026-10-14) or in two (Qwen3) — each later call with the tool results in context,
      // accepted by the chat template. Corrected 2026-09-29 from "at least three calls", which stood in for this and
      // failed a turn that did all of it in two (docs/plans/agent-tools.md, correction 9).
      const called = chats.map((c) => c['toolCalls'] as string[]);
      expect(
        called.flat().filter((name) => name !== 'list_agents'),
        handle,
      ).toEqual(['write_file', 'read_file', 'reply']);
      expect(called.at(-1), handle).toEqual(['reply']);
      expect(new Set(chats.map((c) => c['model'])), handle).toEqual(new Set([model]));
      const written = agentRecords(containerOf(suite.home, 'pair', handle)).filter(
        (r) => r['event'] === 'tool.file_written',
      );
      expect(
        written.map((w) => [w['handle'], w['path']]),
        handle,
      ).toEqual([[handle, '/workspace/notes.txt']]);
      // The line, with or without a newline the model added.
      const firstWrite = present(written[0], `a tool.file_written record for ${handle}`);
      expect([Buffer.byteLength(line), Buffer.byteLength(line) + 1], handle).toContain(firstWrite['size']);
      expect(firstWrite['sha256'], handle).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(daemonLog().filter((r) => r['event'] === 'model.chat_failed')).toEqual([]);
    // Each llama-server's own log holds exactly the calls the daemon sent it: one processed task per call — each chat,
    // and the one prompt-store completion after the recipe's first answered call there (D44; its /tokenize is no task).
    // A store request still going has logged neither outcome, and fails the count rather than being left out.
    for (const model of [PICO, QWEN]) {
      const served = readFileSync(join(suite.home, 'logs', `model-server-${model}.log`), 'utf8')
        .split('\n')
        .filter((l) => l.includes('launch_slot_') && l.includes('processing task')).length;
      const sent = daemonLog().filter(
        (r) =>
          ['model.chat', 'model.prompt_stored', 'model.prompt_store_failed'].includes(String(r['event'])) &&
          r['model'] === model,
      );
      expect(
        sent.filter((r) => r['event'] !== 'model.chat').map((r) => r['event']),
        model,
      ).toEqual(['model.prompt_stored']);
      expect(served, model).toBe(sent.length);
    }
  });

  it.for([
    ['pico-v2', 'hello-world', 'six-p'],
    ['qwen3-8b', 'hello-router', 'six-q'],
  ] as const)(
    "on %s, a turn of up to six tool rounds ends within the recipe's message bound, and 11 calls fit in it (A3)",
    async ([, recipe, channel], ctx) => {
      suite.begin(ctx, {
        id: `six-rounds-${channel}`,
        title: `Six tool steps, one at a time (${recipe})`,
        agents: [],
        expectation: `The agent writes and reads three files, one tool call per step, and replies with the three words; the turn ends within ${String(MESSAGE_TIMEOUT_MS)} ms, and 11 of its slowest model calls would too.`,
      });
      const started = Date.now();
      const result = await suite.send(
        ctx,
        [
          'user=tom',
          `recipe=${recipe}`,
          `channel=${channel}`,
          "message=Do these six steps one at a time, one tool call per step, waiting for each result before the next: 1. write_file a.txt with 'one'. 2. read_file a.txt. 3. write_file b.txt with 'two'. 4. read_file b.txt. 5. write_file c.txt with 'three'. 6. read_file c.txt. Then reply with the three words you read, separated by spaces.",
        ],
        900_000,
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.toLowerCase()).toMatch(/one\W+two\W+three/);
      const chats = chatsOf(channel, 'hewo-1');
      // Six tool rounds, one step each, then the reply: seven calls, three files written.
      expect(chats).toHaveLength(7);
      expect(
        agentRecords(containerOf(suite.home, channel, 'hewo-1'))
          .filter((r) => r['event'] === 'tool.file_written')
          .map((r) => r['path']),
      ).toEqual(['/workspace/a.txt', '/workspace/b.txt', '/workspace/c.txt']);
      const slowest = Math.max(...chats.map((c) => Number(c['ms'])));
      expect(slowest * MAX_CALLS_PER_TURN).toBeLessThan(MESSAGE_TIMEOUT_MS);
      expect(Date.now() - started).toBeLessThan(900_000);
      await ctx.annotate(
        `${String(chats.length)} model calls, slowest ${String(slowest)} ms: 11 calls ≤ ${String(slowest * MAX_CALLS_PER_TURN)} ms of the ${String(MESSAGE_TIMEOUT_MS)} ms bound`,
      );
    },
  );

  it('writes, lists and reads back a file in /workspace; /proc/self/environ is refused, and the token appears in no reply or log line (A14)', async (ctx) => {
    suite.begin(ctx, {
      id: 'workspace',
      title: 'A hello-world agent works in /workspace, and cannot read its environment',
      agents: [],
      expectation:
        'The agent writes pets.txt, lists /workspace and reads the file back, replying with its content; asked to read /proc/self/environ it gets path_outside_workspace, and its token appears nowhere.',
    });
    const first = await suite.send(
      ctx,
      [
        'user=tom',
        'recipe=hello-world',
        'channel=ws',
        "message=Use write_file to write 'green cat 7' to /workspace/pets.txt, then list_files on /workspace, then read_file pets.txt, and reply with exactly the content you read.",
      ],
      900_000,
    );
    expect([first.code, first.stdout.trim()], first.stderr).toEqual([0, 'green cat 7']);
    const container = containerOf(suite.home, 'ws', 'hewo-1');
    const listed = await run('docker', ['exec', container, 'ls', '-la', '/workspace']);
    expect(listed.stdout).toContain('pets.txt');

    // The agent may reply with the error or pass on it (exit 1, "No agent could answer this"): either way the read is refused.
    const second = await suite.send(
      ctx,
      [
        'user=tom',
        'channel=ws',
        'to=hewo-1',
        'message=Use read_file to read /proc/self/environ, and reply with exactly what the tool returned.',
      ],
      300_000,
    );
    expect([0, 1], second.stderr).toContain(second.code);
    const failures = agentRecords(container).filter((r) => r['event'] === 'tool.failed');
    expect(failures).toContainEqual(
      expect.objectContaining({ level: 'warn', tool: 'read_file', reason: 'path_outside_workspace' }),
    );

    const env = await run('docker', ['inspect', '--format', '{{json .Config.Env}}', container]);
    const agentToken = present(
      (JSON.parse(env.stdout) as string[]).find((v) => v.startsWith('ASHA_AGENT_TOKEN=')),
      "the container's ASHA_AGENT_TOKEN environment entry",
    ).slice('ASHA_AGENT_TOKEN='.length);
    expect(agentToken).toMatch(/^[0-9a-f]{64}$/);
    for (const [what, text] of [
      ['the first run', first.stdout + first.stderr],
      ['the second run', second.stdout + second.stderr],
      ['the agent log', readFileSync(join(suite.home, 'logs', 'agents', `${container}.log`), 'utf8')],
      ['the daemon log', readFileSync(join(suite.home, 'logs', 'daemon.jsonl'), 'utf8')],
    ] as const) {
      expect(text.includes(agentToken), `${what} holds the agent token`).toBe(false);
    }
  });

  it("a failed tool call is found by the documented query: one tool.failed line with the agent's tool and reason (A17)", async (ctx) => {
    suite.begin(ctx, {
      id: 'findable',
      title: 'A tool call that fails is found by one query over the agent logs',
      agents: [],
      expectation:
        'The agent reads a file that does not exist; the query over logs/agents/*.log returns its one tool.failed line: read_file, not_found.',
    });
    const asked = await suite.send(
      ctx,
      [
        'user=tom',
        'recipe=hello-world',
        'channel=findable',
        'message=Use read_file to read missing-report.txt, and reply with exactly what the tool returned.',
      ],
      900_000,
    );
    expect(asked.code, asked.stderr).toBe(0);
    const container = containerOf(suite.home, 'findable', 'hewo-1');
    // The query exactly as docs/architecture/index.md#logs documents it, over this one agent's log.
    const query = await run('sh', [
      '-c',
      `jq -cR 'fromjson? | select(.event=="tool.failed" or .event=="tool.crashed")' "$1"/logs/agents/${container}.log`,
      'sh',
      suite.home,
    ]);
    expect(query.code, query.stderr).toBe(0);
    const lines = query.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as LogRecord);
    expect(lines.map((l) => [l['level'], l['event'], l['tool'], l['reason']])).toEqual([
      ['warn', 'tool.failed', 'read_file', 'not_found'],
    ]);
    expect(Object.keys(present(lines[0], "the query's one record")).sort(byCodeUnit)).toEqual([
      'event',
      'level',
      'reason',
      'tool',
      'ts',
    ]);
  });

  it('every agent container holds no harness variable but ASHA_URL and ASHA_AGENT_TOKEN (A12)', async (ctx) => {
    suite.begin(ctx, {
      id: 'environment',
      title: 'The variables the harness sets on each agent container',
      agents: [],
      expectation:
        "For every container this suite started, its Config.Env less its image's Config.Env is exactly ASHA_URL and ASHA_AGENT_TOKEN.",
    });
    const containers = daemonLog()
      .filter((r) => r['event'] === 'agent.starting')
      .map((r) => String(r['container']));
    expect(containers.length).toBeGreaterThanOrEqual(5);
    expect(
      readdirSync(join(suite.home, 'logs', 'agents'))
        .map((f) => f.replace(/\.log$/, ''))
        .sort(byCodeUnit),
    ).toEqual([...containers].sort(byCodeUnit));
    for (const container of containers) {
      const inspected = await run('docker', [
        'inspect',
        '--format',
        '{{json .Config.Env}} {{.Config.Image}}',
        container,
      ]);
      expect(inspected.code, inspected.stderr).toBe(0);
      const [envJsonRaw, imageRaw] = inspected.stdout.trim().split(' ');
      const envJson = present(envJsonRaw, "the inspected container's Config.Env");
      const image = present(imageRaw, "the inspected container's Config.Image");
      const imageEnv = JSON.parse(
        (await run('docker', ['image', 'inspect', '--format', '{{json .Config.Env}}', image])).stdout,
      ) as string[];
      const names = (JSON.parse(envJson) as string[])
        .filter((v) => !imageEnv.includes(v))
        .map((v) => present(v.split('=')[0], "an env entry's name"));
      expect(names.toSorted(byCodeUnit), container).toEqual(['ASHA_AGENT_TOKEN', 'ASHA_URL']);
    }
  });
});
