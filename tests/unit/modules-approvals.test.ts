// Approval requests and the audit (docs/plans/extension-modules.md R12 (a), (b), (e), R14; A12, A14, A32):
// src/daemon/modules/approvals.ts and audit.ts, on an injected clock and an injected opening of the file.

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  APPROVAL_TTL_MS,
  Approvals,
  AUDIT_FIELDS,
  AuditLog,
  MAX_EXPIRED_IDS,
  MAX_PENDING_APPROVALS,
  requestSha256,
  type AppendOpen,
} from '../../src/daemon/modules/index.js';
import { canonicalJson } from '../../src/shared/jcs.js';
import { createHash } from 'node:crypto';
import { present } from '../../src/shared/assert-present.js';
import { TestTimers } from '../helpers/modules.js';

const FIELDS = {
  agent: 'payer-1',
  channel: 'main',
  user: 'olga',
  module: 'ledger',
  tool: 'transfer',
  arguments: '{"amount_cents":1200,"to":"acct-1"}',
  conversation: 'c'.repeat(32),
  timeoutMs: 30_000,
};

function approvals(online: (token: string) => boolean = () => true) {
  const timers = new TestTimers();
  let n = 0;
  const clock = { t: Date.parse('2026-10-01T12:00:00Z') };
  const a = new Approvals({
    setTimer: timers.setTimer,
    now: () => clock.t,
    newId: () => (n++).toString(16).padStart(16, '0'),
    online,
  });
  return { a, timers, clock };
}

describe('requestSha256 (R12 (a))', () => {
  it('is the sha256 of the RFC 8785 form of {agent, conversation, module, tool, arguments}, the arguments as JSON', () => {
    const expected = createHash('sha256')
      .update(
        canonicalJson({
          agent: 'payer-1',
          conversation: FIELDS.conversation,
          module: 'ledger',
          tool: 'transfer',
          arguments: { to: 'acct-1', amount_cents: 1200 },
        }),
      )
      .digest('hex');
    expect(requestSha256(FIELDS)).toBe(expected);
    // Key order in the arguments' string does not change it; a value does.
    expect(requestSha256({ ...FIELDS, arguments: '{"to":"acct-1","amount_cents":1200}' })).toBe(expected);
    expect(requestSha256({ ...FIELDS, arguments: '{"amount_cents":1201,"to":"acct-1"}' })).not.toBe(expected);
    expect(requestSha256({ ...FIELDS, agent: 'payer-2' })).not.toBe(expected);
  });
});

describe('Approvals (R12)', () => {
  it('records a request with a 16-hex id, its sha256, and an expiry 10 minutes on; read gives it back with the token', () => {
    const { a } = approvals();
    const made = a.request(FIELDS, 'tok-1');
    expect(made).toEqual({
      ok: true,
      request: {
        ...FIELDS,
        id: '0000000000000000',
        sha256: requestSha256(FIELDS),
        at: '2026-10-01T12:00:00.000Z',
        expiresAt: '2026-10-01T12:10:00.000Z',
      },
    });
    expect(a.read('0000000000000000')).toEqual({
      ok: true,
      request: (made as { request: unknown }).request,
      token: 'tok-1',
    });
  });

  // docs/plans/portal-demo-stop.md R2: a channel's stop drops its agents' requests and keeps another channel's.
  it('dropFor removes the requests of the given agents, at once and with their timers, and keeps the rest', () => {
    const { a, timers } = approvals();
    const stopped = a.request(FIELDS, 'token-of-stopped');
    const kept = a.request({ ...FIELDS, channel: 'other' }, 'token-of-other');
    if (!stopped.ok || !kept.ok) throw new Error('setup: a request was refused');

    expect(a.dropFor(new Set(['token-of-stopped']))).toBe(1);

    expect(a.read(stopped.request.id)).toEqual({ ok: false, reason: 'unknown' });
    expect(a.read(kept.request.id)).toMatchObject({ ok: true, token: 'token-of-other' });
    expect(a.pendingCount).toBe(1);
    expect(timers.pending()).toBe(1);
    expect(a.dropFor(new Set(['no-such-token']))).toBe(0);
  });

  it('refuses the 65th pending request, recording nothing', () => {
    const { a } = approvals();
    for (let i = 0; i < MAX_PENDING_APPROVALS; i += 1) expect(a.request(FIELDS, 't').ok).toBe(true);
    expect(a.request(FIELDS, 't')).toEqual({ ok: false, full: true });
    expect(a.pendingCount).toBe(64);
  });

  it('expires a request at 10 minutes, then knows it as expired for 10 more, then as unknown', () => {
    const { a, timers } = approvals();
    a.request(FIELDS, 't');
    expect(a.read('nope')).toEqual({ ok: false, reason: 'unknown' });
    expect(timers.fire(APPROVAL_TTL_MS)).toBe(1);
    expect(a.read('0000000000000000')).toEqual({ ok: false, reason: 'expired' });
    expect(timers.fire(APPROVAL_TTL_MS)).toBe(1);
    expect(a.read('0000000000000000')).toEqual({ ok: false, reason: 'unknown' });
    expect(timers.pending()).toBe(0);
  });

  it('keeps at most 64 expired ids: with 65 expired, the oldest is unknown', () => {
    const { a, timers } = approvals();
    for (let i = 0; i <= MAX_EXPIRED_IDS; i += 1) {
      a.request(FIELDS, 't');
      // Expire each in turn, so the first is the oldest.
      const expiry = present(timers.live.at(-1), 'timers.live.at(-1)');
      expiry.cancelled = true;
      expiry.callback();
    }
    expect(a.read('0000000000000000')).toEqual({ ok: false, reason: 'unknown' });
    expect(a.read('0000000000000001')).toEqual({ ok: false, reason: 'expired' });
    expect(a.read(MAX_EXPIRED_IDS.toString(16).padStart(16, '0'))).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses an id whose agent has left as agent_gone', () => {
    const online = new Set(['tok-1']);
    const { a } = approvals((t) => online.has(t));
    a.request(FIELDS, 'tok-1');
    online.delete('tok-1');
    expect(a.read('0000000000000000')).toEqual({ ok: false, reason: 'agent_gone' });
  });

  it('take removes the request at once, cancelling its expiry: a second read is unknown', () => {
    const { a, timers } = approvals();
    a.request(FIELDS, 't');
    a.take('0000000000000000');
    expect(a.read('0000000000000000')).toEqual({ ok: false, reason: 'unknown' });
    expect(timers.pending()).toBe(0);
    a.take('0000000000000000');
  });

  it('stop clears every timer: pending requests and remembered expired ids (A32)', () => {
    const { a, timers } = approvals();
    a.request(FIELDS, 't');
    a.request(FIELDS, 't');
    const timer = present(timers.live[0], 'timers.live[0]');
    timer.cancelled = true;
    timer.callback();
    expect(timers.pending()).toBe(2);
    a.stop();
    expect(timers.pending()).toBe(0);
    expect(a.pendingCount).toBe(0);
  });

  it('refuses an id that is not 16 fresh lowercase hex characters (a defect in the id source)', () => {
    const timers = new TestTimers();
    const a = new Approvals({ setTimer: timers.setTimer, now: () => 0, newId: () => 'ABC', online: () => true });
    expect(() => a.request(FIELDS, 't')).toThrow('approval id "ABC": not 16 fresh lowercase hex characters');
  });
});

describe('AuditLog (R14)', () => {
  const line = (outcome: string) => ({
    time: '2026-10-01T12:00:00.000Z',
    agent: 'payer-1',
    conversation: 'c'.repeat(32),
    module: 'ledger',
    tool: 'transfer',
    argumentsSha256: 'a'.repeat(64),
    approval: '0000000000000000',
    idempotencyKey: 'k'.repeat(32),
    outcome,
  });

  it("opens the file only to append, 0600, and writes one synced line per call with exactly R14's keys in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-audit-'));
    const file = join(dir, 'audit', 'consequential.jsonl');
    const opens: [string, string, number][] = [];
    const open: AppendOpen = async (path, flags, mode) => {
      opens.push([path, flags, mode]);
      const fs = await import('node:fs/promises');
      return fs.open(path, flags, mode);
    };
    const audit = new AuditLog({ file, open });
    await audit.append(line('sending'));
    await audit.append(line('ok'));
    const first = await readFile(file, 'utf8');
    await audit.append({ ...line('sending'), approval: '0000000000000001' });
    await audit.append({ ...line('unknown_outcome'), approval: '0000000000000001' });
    const after = await readFile(file, 'utf8');
    // The first two lines are byte-identical after the second call: appended to, never rewritten.
    expect(after.startsWith(first)).toBe(true);
    const lines = after
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l['outcome'])).toEqual(['sending', 'ok', 'sending', 'unknown_outcome']);
    for (const l of lines) expect(Object.keys(l)).toEqual([...AUDIT_FIELDS]);
    expect(opens).toEqual([0, 1, 2, 3].map(() => [file, 'a', 0o600]));
    expect((await (await import('node:fs/promises')).stat(file)).mode & 0o777).toBe(0o600);
  });

  it("writes only R14's fields, whatever else the caller passes", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-audit-'));
    const file = join(dir, 'consequential.jsonl');
    const audit = new AuditLog({ file, open: (p, f, m) => import('node:fs/promises').then((fs) => fs.open(p, f, m)) });
    await audit.append({ ...line('ok'), arguments: '{"canary":"CANARY-ARG"}' } as never);
    expect(await readFile(file, 'utf8')).not.toContain('CANARY-ARG');
  });

  it('passes a failed write to its caller, and the next append still runs', async () => {
    let fail = true;
    const dir = await mkdtemp(join(tmpdir(), 'asha-audit-'));
    const file = join(dir, 'consequential.jsonl');
    const audit = new AuditLog({
      file,
      open: async (p, f, m) => {
        if (fail) throw new Error('disk full');
        return (await import('node:fs/promises')).open(p, f, m);
      },
    });
    await expect(audit.append(line('sending'))).rejects.toThrow('disk full');
    fail = false;
    await audit.append(line('sending'));
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});

describe("settledWithin (the stop's wait for approved calls, R12 (e))", () => {
  it('resolves 0 at once with nothing to wait for, 0 when all settle (a rejection counts), and the count left at the bound', async () => {
    const { settledWithin } = await import('../../src/daemon/modules/index.js');
    const timers = new TestTimers();
    expect(await settledWithin([], 1_000, timers.setTimer)).toBe(0);
    expect(await settledWithin([Promise.resolve(1), Promise.reject(new Error('x'))], 1_000, timers.setTimer)).toBe(0);
    expect(timers.pending()).toBe(0);
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => (finish = resolve));
    const waiting = settledWithin([Promise.resolve(), slow, new Promise(() => undefined)], 1_000, timers.setTimer);
    await new Promise((resolve) => setImmediate(resolve));
    finish();
    await new Promise((resolve) => setImmediate(resolve));
    expect(timers.fire(1_000)).toBe(1);
    expect(await waiting).toBe(1);
  });
});

describe("the stop's order (R12 (e); the model servers beside the reclaim, A38 (d))", () => {
  it("starts the model servers' stop beside the reclaim, waits for approved calls after the reclaim for APPROVED_SETTLE_MS, then the traces and the lock", async () => {
    const { stopDaemon, APPROVED_SETTLE_MS } = await import('../../src/daemon/compose.js');
    const { RecordingLogger } = await import('../helpers/fakes.js');
    const order: string[] = [];
    await stopDaemon({
      logger: new RecordingLogger(),
      beginStopping: () => {
        order.push('stopping');
        return Promise.resolve();
      },
      supervisor: {
        stopAll: () => {
          order.push('agents');
          return Promise.resolve();
        },
        approvedSettled: (ms) => {
          order.push(`approved ${String(ms)}`);
          return Promise.resolve();
        },
      },
      closeServer: () => {
        order.push('server');
        return Promise.resolve();
      },
      runtime: { reclaim: () => (order.push('reclaim'), Promise.resolve({ volumes: 0 })) },
      modelServer: {
        stopAll: () => {
          order.push('model servers');
          return Promise.resolve();
        },
      },
      closeTraces: () => {
        order.push('traces');
      },
      release: () => {
        order.push('lock');
        return Promise.resolve();
      },
      removeDaemonFile: () => {
        order.push('daemon file');
        return Promise.resolve();
      },
    });
    expect(APPROVED_SETTLE_MS).toBe(1_000);
    // daemon.json removed last, after the lock (debt-paydown R14, A12).
    expect(order).toEqual([
      'stopping',
      'agents',
      'server',
      'model servers',
      'reclaim',
      'approved 1000',
      'traces',
      'lock',
      'daemon file',
    ]);
  });

  it('ends at the later of the model servers (10 s) and the reclaim with the approved wait (1 s + 1 s), not their sum', async () => {
    const { stopDaemon } = await import('../../src/daemon/compose.js');
    const { RecordingLogger } = await import('../helpers/fakes.js');
    vi.useFakeTimers({ now: 0 });
    try {
      const done: [string, number][] = [];
      const stopped = stopDaemon({
        logger: new RecordingLogger(),
        beginStopping: () => Promise.resolve(),
        removeDaemonFile: () => Promise.resolve(),
        supervisor: {
          stopAll: () => Promise.resolve(),
          approvedSettled: () =>
            new Promise((resolve) =>
              setTimeout(() => {
                resolve();
              }, 1_000),
            ),
        },
        closeServer: () => Promise.resolve(),
        runtime: {
          reclaim: () =>
            new Promise((resolve) =>
              setTimeout(() => {
                resolve({ volumes: 0 });
              }, 1_000),
            ),
        },
        modelServer: {
          stopAll: () =>
            new Promise((resolve) =>
              setTimeout(() => {
                done.push(['model servers', Date.now()]);
                resolve();
              }, 10_000),
            ),
        },
        closeTraces: () => {
          done.push(['traces', Date.now()]);
        },
        release: () => {
          done.push(['lock', Date.now()]);
          return Promise.resolve();
        },
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await stopped;
      expect(done).toEqual([
        ['model servers', 10_000],
        ['traces', 10_000],
        ['lock', 10_000],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a model-server stop failing while the reclaim runs is no unhandled rejection: the reclaim and the approved wait finish, then the stop fails with it, the lock kept as before', async () => {
    const { stopDaemon } = await import('../../src/daemon/compose.js');
    const { RecordingLogger } = await import('../helpers/fakes.js');
    const order: string[] = [];
    const failure = new Error('llama-server would not stop');
    let reclaimed!: () => void;
    const stopped = stopDaemon({
      logger: new RecordingLogger(),
      beginStopping: () => Promise.resolve(),
      removeDaemonFile: () => Promise.resolve(),
      supervisor: {
        stopAll: () => Promise.resolve(),
        approvedSettled: () => {
          order.push('approved');
          return Promise.resolve();
        },
      },
      closeServer: () => Promise.resolve(),
      runtime: {
        reclaim: () =>
          new Promise((resolve) => {
            reclaimed = () => {
              order.push('reclaim');
              resolve({ volumes: 0 });
            };
          }),
      },
      modelServer: { stopAll: async () => Promise.reject(failure) },
      closeTraces: () => {
        order.push('traces');
      },
      release: () => {
        order.push('lock');
        return Promise.resolve();
      },
    });
    // The rejection is settled now, long before the reclaim ends.
    await new Promise((resolve) => setImmediate(resolve));
    reclaimed();
    await expect(stopped).rejects.toBe(failure);
    expect(order).toEqual(['reclaim', 'approved']);
  });

  it("a failing approved wait does not drop the model servers' failure: it is logged and thrown first; with the servers stopped, the wait's own failure is thrown", async () => {
    const { stopDaemon } = await import('../../src/daemon/compose.js');
    const { RecordingLogger } = await import('../helpers/fakes.js');
    const servers = new Error('llama-server would not stop');
    const settle = new Error('the audit log could not be written');
    const run = (modelFails: boolean) => {
      const logger = new RecordingLogger();
      const stopped = stopDaemon({
        logger,
        beginStopping: () => Promise.resolve(),
        removeDaemonFile: () => Promise.resolve(),
        supervisor: { stopAll: () => Promise.resolve(), approvedSettled: async () => Promise.reject(settle) },
        closeServer: () => Promise.resolve(),
        runtime: { reclaim: () => Promise.resolve({ volumes: 0 }) },
        modelServer: { stopAll: async () => (modelFails ? Promise.reject(servers) : undefined) },
        closeTraces: () => undefined,
        release: () => Promise.resolve(),
      });
      return { logger, stopped };
    };
    const both = run(true);
    await expect(both.stopped).rejects.toBe(servers);
    expect(both.logger.entries.filter((e) => e.level === 'error').map((e) => [e.event, e.fields['error']])).toEqual([
      ['daemon.model_servers_stop_failed', servers],
    ]);
    const one = run(false);
    await expect(one.stopped).rejects.toBe(settle);
  });
});
