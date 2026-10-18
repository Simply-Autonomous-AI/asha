// Traces with real agents (docs/plans/otel-traces.md): one hello-world
// conversation in its container is one trace, linked parent to child across
// the daemon and the agent (A3); both agent images build with no network
// (A6); and staging the OpenTelemetry runtime files keeps a warm launch
// within the owner's 2 s target (A10).

import { execFile, type ExecFileException } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { stageAgentImage } from '../../src/daemon/images/index.js';
import { present } from '../../src/shared/assert-present.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const CHANNEL = 'traces';
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('traces', CHANNEL);
});

afterAll(async () => {
  await suite.finish();
});

/** Every record of the daemon log, in order. */
function daemonLog(): Record<string, unknown>[] {
  return readFileSync(join(suite.home, 'logs', 'daemon.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Every record in every trace file of the suite's home. */
function traceRecords(): Record<string, unknown>[] {
  const dir = join(suite.home, 'logs');
  return readdirSync(dir)
    .filter((n) => /^traces-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
    .flatMap((n) =>
      readFileSync(join(dir, n), 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l !== ''),
    )
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** `execFile`'s callback error as `docker()`'s exit code: 0 for none, its numeric code, or -1 when not numeric. */
function execCode(error: ExecFileException | null): number {
  if (error === null) return 0;
  return typeof error.code === 'number' ? error.code : -1;
}

function docker(args: readonly string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(
      'docker',
      [...args],
      {
        env: { ...process.env, DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock` },
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          code: execCode(error),
          out: `${stdout}${stderr}`,
        });
      },
    ),
  );
}

describe('traces with a real agent', () => {
  it("records a hello-world conversation as one trace: conversation → delivery → the agent's delivery → chat → asha.chat, and its posts (A3)", async (ctx) => {
    suite.begin(ctx, {
      id: 'one-trace',
      title: 'A hello-world conversation, read back from the trace file',
      agents: [],
      expectation:
        'hewo-1 replies; every span of the conversation carries traceIdFor(conversation), linked parent to child, all ok.',
    });
    const run = await suite.send(
      ctx,
      ['user=tess', 'recipe=hello-world', `channel=${CHANNEL}`, 'message=Please say: Hello World.'],
      600_000,
    );
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toBe('Hello World.\n');

    // Read at once: ./asha returned when the stream reported nobody working, so every record must be on disk.
    const conversation = String(
      present(
        daemonLog()
          .filter((r) => r['event'] === 'conversation.started' && r['channel'] === CHANNEL)
          .at(-1),
        `a conversation.started record on ${CHANNEL}`,
      )['conversation'],
    );
    const trace = traceIdFor(conversation);
    const records = traceRecords().filter((r) => r['traceId'] === trace);
    const named = (name: string) => records.filter((r) => r['name'] === name);
    for (const name of ['asha.conversation', 'asha.delivery', 'delivery', 'asha.chat'])
      expect(named(name), name).toHaveLength(1);
    const [rootRaw, daemonDeliveryRaw, agentDeliveryRaw, gatewayRaw] = [
      'asha.conversation',
      'asha.delivery',
      'delivery',
      'asha.chat',
    ].map((n) => named(n)[0]);
    const root = present(rootRaw, 'the asha.conversation span');
    const daemonDelivery = present(daemonDeliveryRaw, 'the asha.delivery span');
    const agentDelivery = present(agentDeliveryRaw, 'the delivery span');
    const gateway = present(gatewayRaw, 'the asha.chat span');
    expect(root['parentSpanId']).toBeNull();
    expect(daemonDelivery['parentSpanId']).toBe(root['spanId']);
    expect(agentDelivery['parentSpanId']).toBe(daemonDelivery['spanId']);
    const chats = named('chat');
    expect(chats.length).toBeGreaterThanOrEqual(1);
    expect(chats.every((c) => c['parentSpanId'] === agentDelivery['spanId'])).toBe(true);
    expect(chats.map((c) => c['spanId'])).toContain(gateway['parentSpanId']);
    // Its "ok" status and its reply.
    expect(named('post').map((p) => p['parentSpanId'])).toEqual([agentDelivery['spanId'], agentDelivery['spanId']]);
    expect(records.filter((r) => r['status'] !== 'ok')).toEqual([]);
    expect(new Set(records.map((r) => String(r['channel'])))).toEqual(new Set([CHANNEL]));
    expect(records.filter((r) => r['handle'] !== 'hewo-1' && r['name'] !== 'asha.conversation')).toEqual([]);
    // Every parent named is a span of this trace, recorded.
    const ids = new Set(records.map((r) => r['spanId']));
    expect(records.filter((r) => r['parentSpanId'] !== null && !ids.has(r['parentSpanId']))).toEqual([]);

    // No export failed: the agent's log has no trace.export_failed line.
    const agentLogs = readdirSync(join(suite.home, 'logs', 'agents')).map((f) =>
      readFileSync(join(suite.home, 'logs', 'agents', f), 'utf8'),
    );
    expect(
      agentLogs
        .join('')
        .split('\n')
        .filter((l) => l.includes('trace.export_failed')),
    ).toEqual([]);
  });

  it('refuses spans posted to the real daemon without an agent token (A6)', async () => {
    const { port, credential } = JSON.parse(readFileSync(join(suite.home, 'daemon.json'), 'utf8')) as {
      port: number;
      credential: string;
    };
    const body = JSON.stringify({ resourceSpans: [] });
    const bare = await fetch(`http://127.0.0.1:${String(port)}/agent/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    const withCredential = await fetch(`http://127.0.0.1:${String(port)}/agent/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    expect([bare.status, withCredential.status]).toEqual([401, 401]);
  });

  it.each(['hello-world', 'memory'])(
    'builds the %s image from its staged context with no network (A6)',
    async (name) => {
      const base = 'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';
      const inspected = await docker(['image', 'inspect', '--format', '{{.Id}}', base], 60_000);
      expect(inspected.code, inspected.out).toBe(0);
      const staged = await stageAgentImage({
        root: REPO,
        image: {
          name,
          dir: join(REPO, 'images', name),
          repository: 'unused',
          manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
        },
        stagingParent: join(suite.home, 'staging'),
      });
      const tag = `asha-a6-${name}-${String(process.pid)}`;
      try {
        const built = await docker(['build', '--network=none', '--tag', tag, staged.spec.contextDir], 300_000);
        expect(built.code, built.out).toBe(0);
        // The OpenTelemetry packages load inside the image, from its own node_modules.
        const loaded = await docker(
          [
            'run',
            '--rm',
            '--network=none',
            '--entrypoint',
            'node',
            tag,
            '--input-type=module',
            '-e',
            "import('@opentelemetry/sdk-trace').then((m) => console.log(typeof m.TracerProvider))",
          ],
          60_000,
        );
        expect(loaded, loaded.out).toEqual({ code: 0, out: 'function\n' });
      } finally {
        await staged.cleanup();
        await docker(['image', 'rm', '--force', tag], 60_000);
      }
    },
  );

  it('launches hello-world warm eleven times: staging at most 250 ms and each launch within 2 s (A10)', async (ctx) => {
    suite.begin(ctx, {
      id: 'warm-launch',
      title: 'Eleven warm launches of hello-world',
      agents: ['hewo-1'],
      expectation:
        'Each launch stages the image context (the OpenTelemetry runtime files included) in at most 250 ms and returns within 2 s.',
    });
    // The image is current after the conversation above; one more launch makes sure of it.
    const first = await suite.send(ctx, ['--launch', 'recipe=hello-world', `channel=${CHANNEL}`], 600_000);
    expect(first.code, first.stderr).toBe(0);
    const launches: number[] = [];
    for (let i = 0; i < 11; i++) {
      const run = await suite.send(ctx, ['--launch', 'recipe=hello-world', `channel=${CHANNEL}`], 60_000);
      expect(run.code, run.stderr).toBe(0);
      expect(run.stderr).not.toContain('built');
      launches.push(run.ms);
    }
    const staged = daemonLog()
      .filter((r) => r['event'] === 'image.staged' && r['image'] === 'hello-world')
      .slice(-11);
    const staging = staged.map((r) => Number(r['ms']));
    // The host's 1-minute load average at each staging: a slow run on a busy machine is attributable (the 01f037a failure).
    const load = staged.map((r) => present((r['loadavg'] as number[])[0], "a staging record's loadavg[0]").toFixed(2));
    expect(staging).toHaveLength(11);
    await ctx.annotate(
      `staging ms: ${staging.join(', ')}; launch ms: ${launches.join(', ')}; 1-min loadavg at staging: ${load.join(', ')}`,
    );
    expect(
      staging.filter((ms) => ms > 250),
      `staging ms: ${staging.join(', ')}; 1-min loadavg at staging: ${load.join(', ')}`,
    ).toEqual([]);
    expect(
      launches.filter((ms) => ms > 2_000),
      `launch ms: ${launches.join(', ')}`,
    ).toEqual([]);
  });
});
