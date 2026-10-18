// The daemon's side of traces (docs/plans/otel-traces.md): the trace ID and
// traceparent (R2, R2a), the daemon's span records (R4), the trace files — by
// UTC day, capped, kept seven days (R10, A7) — and what the traces route
// accepts and answers (R3, R12).

import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { formatTraceparent, parseTraceparent } from '../../src/shared/protocol.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import {
  DaemonTracer,
  TRACE_FILE_CAP_BYTES,
  TraceFileWriter,
  TraceRequestInvalid,
  nodeTraceFiles,
  parseOtlpTraces,
  receiveSpans,
  traceRecord,
  type TraceFiles,
  type TraceRecord,
} from '../../src/daemon/traces/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { RecordingLogger } from '../helpers/fakes.js';

const T1 = 'db33d0ce51b19461b270c0a65653ccb0';
const R4_KEYS = [
  'traceId',
  'spanId',
  'parentSpanId',
  'name',
  'kind',
  'channel',
  'handle',
  'start',
  'end',
  'status',
  'reason',
];

describe('traceIdFor and traceparent', () => {
  it('is the first 32 hex characters of sha256("asha.trace\\0" + conversation): the R2 test vector', () => {
    expect(traceIdFor('c1')).toBe('db33d0ce51b19461b270c0a65653ccb0');
    expect(traceIdFor('c2')).not.toBe(traceIdFor('c1'));
    expect(traceIdFor('c1')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('formats and parses version-00 sampled traceparents, and nothing else', () => {
    const value = formatTraceparent({ traceId: T1, spanId: '00000000000000aa' });
    expect(value).toBe(`00-${T1}-00000000000000aa-01`);
    expect(parseTraceparent(value)).toEqual({ traceId: T1, spanId: '00000000000000aa' });
    for (const bad of [
      undefined,
      '',
      `01-${T1}-00000000000000aa-01`,
      `00-${T1.toUpperCase()}-00000000000000aa-01`,
      `00-${T1.slice(2)}-00000000000000aa-01`,
      `00-${T1}-000000000000aa-01`,
      `00-${'0'.repeat(32)}-00000000000000aa-01`,
      `00-${T1}-${'0'.repeat(16)}-01`,
      `00-${T1}-00000000000000aa-00`,
      ` 00-${T1}-00000000000000aa-01`,
    ]) {
      expect(parseTraceparent(bad), String(bad)).toBeUndefined();
    }
  });
});

describe('DaemonTracer', () => {
  function tracer() {
    const records: TraceRecord[] = [];
    const times = ['2026-09-27T10:00:00.000Z', '2026-09-27T10:00:01.250Z'];
    let ids = 0;
    const t = new DaemonTracer({
      clock: () => new Date(present(times.shift(), 'times.shift()')),
      newSpanId: () => String(++ids).padStart(16, 'a'),
      record: (r) => records.push(r),
    });
    return { t, records };
  }

  it("writes one record with exactly R4's keys when a span ends, and none before", () => {
    const { t, records } = tracer();
    const span = t.start({
      name: 'asha.delivery',
      traceId: T1,
      parentSpanId: '00000000000000bb',
      channel: 'main',
      handle: 'hewo-1',
    });
    expect(span.traceparent).toBe(`00-${T1}-aaaaaaaaaaaaaaa1-01`);
    expect(records).toEqual([]);
    span.end({ status: 'error', reason: 'expired' });
    expect(records).toEqual([
      {
        traceId: T1,
        spanId: 'aaaaaaaaaaaaaaa1',
        parentSpanId: '00000000000000bb',
        name: 'asha.delivery',
        kind: 'delivery',
        channel: 'main',
        handle: 'hewo-1',
        start: '2026-09-27T10:00:00.000Z',
        end: '2026-09-27T10:00:01.250Z',
        status: 'error',
        reason: 'expired',
      },
    ]);
    expect(Object.keys(present(records[0], 'records[0]'))).toEqual(R4_KEYS);
    expect(() => {
      span.end({ status: 'ok' });
    }).toThrow('ended twice');
  });

  it('gives a parent to every span but asha.conversation, and to that one none', () => {
    const { t } = tracer();
    expect(() =>
      t.start({ name: 'asha.chat', traceId: T1, parentSpanId: null, channel: 'main', handle: 'hewo-1' }),
    ).toThrow('only asha.conversation has no parent span');
    expect(() =>
      t.start({
        name: 'asha.conversation',
        traceId: T1,
        parentSpanId: '00000000000000bb',
        channel: 'main',
        handle: 'asha',
      }),
    ).toThrow('only asha.conversation');
  });

  it('names each kind from the span name', () => {
    const base = {
      traceId: T1,
      spanId: '1'.repeat(16),
      parentSpanId: null,
      channel: 'c',
      handle: 'h',
      start: 's',
      end: 'e',
    };
    const kinds = (
      ['asha.conversation', 'asha.delivery', 'asha.chat', 'asha.embed', 'delivery', 'chat', 'embed', 'post'] as const
    ).map((name) => traceRecord({ ...base, name }, { status: 'ok' }).kind);
    expect(kinds).toEqual([
      'conversation',
      'delivery',
      'model_call',
      'model_call',
      'delivery',
      'model_call',
      'model_call',
      'post',
    ]);
  });
});

/** Real files in a temporary logs directory, with every call counted and appends failable. */
class CountingFiles implements TraceFiles {
  appends = 0;
  failAppend: NodeJS.ErrnoException | undefined;
  readonly removed: string[] = [];
  append(file: string, data: string): void {
    this.appends += 1;
    if (this.failAppend !== undefined) throw this.failAppend;
    nodeTraceFiles.append(file, data);
  }
  size(file: string): number {
    return nodeTraceFiles.size(file);
  }
  list(dir: string): string[] {
    return nodeTraceFiles.list(dir);
  }
  remove(file: string): void {
    this.removed.push(file);
    nodeTraceFiles.remove(file);
  }
}

const record = (spanId: string, over: Partial<TraceRecord> = {}): TraceRecord =>
  traceRecord(
    {
      traceId: T1,
      spanId,
      parentSpanId: 'b'.repeat(16),
      name: 'chat',
      channel: 'main',
      handle: 'hewo-1',
      start: '2026-09-27T10:00:00.000Z',
      end: '2026-09-27T10:00:00.500Z',
      ...over,
    },
    { status: 'ok' },
  );

describe('TraceFileWriter (A7)', () => {
  async function setup(now: string, capBytes = TRACE_FILE_CAP_BYTES) {
    const dir = await mkdtemp(join(tmpdir(), 'asha-traces-'));
    const logger = new RecordingLogger();
    const files = new CountingFiles();
    const clock = { now: new Date(now) };
    // No reserve and no agent budget here: these tests are about the file itself; the next describe is about sharing it.
    const writer = new TraceFileWriter({
      dir,
      clock: () => clock.now,
      logger,
      files,
      capBytes,
      daemonReserveBytes: 0,
      agentDailyBytes: capBytes,
    });
    return { dir, logger, files, clock, writer };
  }

  const lines = async (file: string): Promise<unknown[]> =>
    (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as unknown);

  it('writes to one file per UTC day, named by the date at which it writes, one append per call', async () => {
    const { dir, files, clock, writer } = await setup('2026-09-27T23:59:59.900Z');
    writer.start();
    expect(writer.write([record('1'.repeat(16)), record('2'.repeat(16)), record('3'.repeat(16))], 'daemon')).toEqual({
      ok: true,
    });
    expect(files.appends).toBe(1);
    clock.now = new Date('2026-09-28T00:00:00.100Z');
    expect(writer.write([record('4'.repeat(16))], 'daemon')).toEqual({ ok: true });
    expect(files.appends).toBe(2);
    expect((await readdir(dir)).sort(byCodeUnit)).toEqual(['traces-2026-09-27.jsonl', 'traces-2026-09-28.jsonl']);
    expect(await lines(join(dir, 'traces-2026-09-27.jsonl'))).toEqual([
      record('1'.repeat(16)),
      record('2'.repeat(16)),
      record('3'.repeat(16)),
    ]);
    expect(await lines(join(dir, 'traces-2026-09-28.jsonl'))).toEqual([record('4'.repeat(16))]);
  });

  it('drops a whole append that would take the day past its cap, warns once with capBytes, then once with the count at the next day', async () => {
    const { dir, logger, clock, writer } = await setup('2026-09-27T10:00:00.000Z', 1024);
    writer.start();
    // One record is a 274-byte line: two fit in 1 KiB with room for a third, but not for three more.
    const three = [record('1'.repeat(16)), record('2'.repeat(16)), record('3'.repeat(16))];
    expect(writer.write(three.slice(0, 2), 'daemon')).toEqual({ ok: true });
    const before = await readFile(join(dir, 'traces-2026-09-27.jsonl'), 'utf8');
    expect(Buffer.byteLength(before)).toBeLessThan(1024);
    expect(writer.write(three, 'daemon')).toEqual({ ok: false, reason: 'over_cap', dropped: 3 });
    expect(writer.write([record('4'.repeat(16))], 'daemon')).toEqual({ ok: true });
    expect(writer.write(three, 'daemon')).toEqual({ ok: false, reason: 'over_cap', dropped: 3 });
    expect(await readFile(join(dir, 'traces-2026-09-27.jsonl'), 'utf8')).toBe(
      before + `${JSON.stringify(record('4'.repeat(16)))}\n`,
    );
    expect(logger.entries).toEqual([
      { level: 'warn', event: 'traces.dropped', fields: { date: '2026-09-27', capBytes: 1024 } },
    ]);
    clock.now = new Date('2026-09-28T00:00:00.100Z');
    expect(writer.write([record('5'.repeat(16))], 'daemon')).toEqual({ ok: true });
    expect(logger.entries).toEqual([
      { level: 'warn', event: 'traces.dropped', fields: { date: '2026-09-27', capBytes: 1024 } },
      { level: 'warn', event: 'traces.dropped', fields: { date: '2026-09-27', count: 6 } },
    ]);
  });

  it("reports the day's drop count at a clean stop, and nothing when there were none", async () => {
    const { logger, writer } = await setup('2026-09-27T10:00:00.000Z', 100);
    writer.start();
    expect(writer.write([record('1'.repeat(16))], 'daemon')).toEqual({ ok: false, reason: 'over_cap', dropped: 1 });
    writer.close();
    expect(logger.entries.map((e) => [e.event, e.fields])).toEqual([
      ['traces.dropped', { date: '2026-09-27', capBytes: 100 }],
      ['traces.dropped', { date: '2026-09-27', count: 1 }],
    ]);
    const quiet = await setup('2026-09-27T10:00:00.000Z');
    quiet.writer.start();
    quiet.writer.close();
    expect(quiet.logger.entries).toEqual([]);
  });

  it("deletes files dated more than 7 days back, keeps the 7-day-old one, at startup and at a day's first write", async () => {
    const { dir, files, clock, writer } = await setup('2026-09-27T10:00:00.000Z');
    for (const name of [
      'traces-2026-09-19.jsonl',
      'traces-2026-09-20.jsonl',
      'traces-2026-09-26.jsonl',
      'daemon.jsonl',
      'traces-notes.txt',
    ])
      await writeFile(join(dir, name), 'x\n');
    writer.start();
    expect(files.removed).toEqual([join(dir, 'traces-2026-09-19.jsonl')]);
    expect((await readdir(dir)).sort(byCodeUnit)).toEqual([
      'daemon.jsonl',
      'traces-2026-09-20.jsonl',
      'traces-2026-09-26.jsonl',
      'traces-notes.txt',
    ]);
    // The next day: 09-20 is now 8 days back, and 09-21 (placed now) 7.
    await writeFile(join(dir, 'traces-2026-09-21.jsonl'), 'x\n');
    clock.now = new Date('2026-09-28T00:00:00.100Z');
    writer.write([record('1'.repeat(16))], 'daemon');
    expect(files.removed).toEqual([join(dir, 'traces-2026-09-19.jsonl'), join(dir, 'traces-2026-09-20.jsonl')]);
    expect((await readdir(dir)).sort(byCodeUnit)).toEqual([
      'daemon.jsonl',
      'traces-2026-09-21.jsonl',
      'traces-2026-09-26.jsonl',
      'traces-2026-09-28.jsonl',
      'traces-notes.txt',
    ]);
    // A second write that day does not look again.
    writer.write([record('2'.repeat(16))], 'daemon');
    expect(files.removed).toHaveLength(2);
  });

  it('logs a failed deletion as traces.retention_failed naming the file, and keeps writing', async () => {
    const { dir, logger, files, writer } = await setup('2026-09-27T10:00:00.000Z');
    await writeFile(join(dir, 'traces-2026-09-01.jsonl'), 'x\n');
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    files.remove = () => {
      throw denied;
    };
    writer.start();
    expect(logger.entries).toEqual([
      {
        level: 'error',
        event: 'traces.retention_failed',
        fields: { file: join(dir, 'traces-2026-09-01.jsonl'), error: denied },
      },
    ]);
    expect(writer.write([record('1'.repeat(16))], 'daemon')).toEqual({ ok: true });
  });

  it('logs a failed append as traces.write_failed with the file and the error, and says so', async () => {
    const { dir, logger, files, writer } = await setup('2026-09-27T10:00:00.000Z');
    writer.start();
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    files.failAppend = denied;
    expect(writer.write([record('1'.repeat(16))], 'daemon')).toEqual({ ok: false, reason: 'write_failed' });
    expect(logger.entries).toEqual([
      {
        level: 'error',
        event: 'traces.write_failed',
        fields: { file: join(dir, 'traces-2026-09-27.jsonl'), error: denied },
      },
    ]);
    files.failAppend = undefined;
    expect(writer.write([record('2'.repeat(16))], 'daemon')).toEqual({ ok: true });
  });
});

/** One span as the OpenTelemetry exporter sends it (exporter-trace-otlp-http 0.222.0, captured 2026-09-27). */
function otlpSpan(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    traceId: T1,
    spanId: '8e7c51b38a7d6d80',
    parentSpanId: '00000000000000aa',
    name: 'delivery',
    kind: 1,
    startTimeUnixNano: '1790540844043000000',
    endTimeUnixNano: '1790540844043084917',
    attributes: [],
    droppedAttributesCount: 0,
    events: [],
    droppedEventsCount: 0,
    status: { code: 0 },
    links: [],
    droppedLinksCount: 0,
    flags: 769,
    ...over,
  };
}

const otlp = (...spans: unknown[]) => ({
  resourceSpans: [
    {
      resource: { attributes: [], droppedAttributesCount: 0 },
      scopeSpans: [{ scope: { name: 'asha-agent-sdk' }, spans }],
    },
  ],
});

describe("sharing the day's file (A7, completion review finding 1)", () => {
  // One record is a 274-byte line (see above), so an append of two is 548 bytes.
  // cap 3000, of which 1000 is the daemon's: agents stop at 2000 bytes in all; each agent at 800 (two records, not four).
  async function sharing() {
    const dir = await mkdtemp(join(tmpdir(), 'asha-traces-'));
    const logger = new RecordingLogger();
    const clock = { now: new Date('2026-09-27T10:00:00.000Z') };
    const writer = new TraceFileWriter({
      dir,
      clock: () => clock.now,
      logger,
      files: nodeTraceFiles,
      capBytes: 3000,
      daemonReserveBytes: 1000,
      agentDailyBytes: 800,
    });
    writer.start();
    const scope = (handle: string) => ({ handle, channel: 'main', traces: new Set([T1]) });
    let ids = 0;
    const spans = (n: number) =>
      parseOtlpTraces(
        otlp(...Array.from({ length: n }, () => otlpSpan({ spanId: (++ids).toString(16).padStart(16, '0') }))),
      );
    const send = (handle: string, n: number) => receiveSpans({ spans: spans(n), scope: scope(handle), writer, logger });
    const lines = async () =>
      (await readFile(join(dir, 'traces-2026-09-27.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as TraceRecord);
    return { writer, logger, clock, send, lines };
  }

  it("one agent cannot starve another agent's records, nor the daemon's", async () => {
    const t = await sharing();
    expect(t.send('flood-1', 2)).toEqual({ status: 200, body: {} });
    // Past its budget, however many requests it sends.
    for (let i = 0; i < 50; i++)
      expect(t.send('flood-1', 2)).toEqual({ status: 200, body: { partialSuccess: { rejectedSpans: 2 } } });
    expect(t.send('hewo-1', 2)).toEqual({ status: 200, body: {} });
    expect(t.send('memo-1', 2)).toEqual({ status: 200, body: {} });
    // The agents' share (2000) is now 1644 used: a fourth agent's two records would pass it, though within its budget.
    expect(t.send('late-1', 2)).toEqual({ status: 200, body: { partialSuccess: { rejectedSpans: 2 } } });
    // The daemon's own spans still fit, in the reserve agents cannot use.
    for (let i = 0; i < 4; i++)
      expect(t.writer.write([record(`d${String(i)}`.padStart(16, '0'))], 'daemon')).toEqual({ ok: true });
    const handles = (await t.lines()).map((r) => r.handle);
    expect(handles).toEqual([
      'flood-1',
      'flood-1',
      'hewo-1',
      'hewo-1',
      'memo-1',
      'memo-1',
      'hewo-1',
      'hewo-1',
      'hewo-1',
      'hewo-1',
    ]);
    expect(t.logger.entries).toEqual([
      {
        level: 'warn',
        event: 'traces.agent_over_budget',
        fields: { date: '2026-09-27', agent: 'main/flood-1', budgetBytes: 800 },
      },
      { level: 'warn', event: 'traces.dropped', fields: { date: '2026-09-27', capBytes: 2000 } },
    ]);
  });

  it("reports each agent's drops once more, with the count, at the next day's first write, and starts its budget afresh", async () => {
    const t = await sharing();
    t.send('flood-1', 2);
    for (let i = 0; i < 3; i++) t.send('flood-1', 2);
    t.clock.now = new Date('2026-09-28T00:00:00.100Z');
    expect(t.send('flood-1', 2)).toEqual({ status: 200, body: {} });
    expect(t.logger.entries.map((e) => [e.event, e.fields])).toEqual([
      ['traces.agent_over_budget', { date: '2026-09-27', agent: 'main/flood-1', budgetBytes: 800 }],
      ['traces.agent_over_budget', { date: '2026-09-27', agent: 'main/flood-1', count: 6 }],
    ]);
  });

  it('keeps agents apart by channel as well as handle', async () => {
    const t = await sharing();
    t.send('hewo-1', 2);
    expect(t.send('hewo-1', 2)).toEqual({ status: 200, body: { partialSuccess: { rejectedSpans: 2 } } });
    const other = receiveSpans({
      spans: parseOtlpTraces(otlp(otlpSpan({ spanId: 'e'.repeat(16) }))),
      scope: { handle: 'hewo-1', channel: 'lab', traces: new Set([T1]) },
      writer: t.writer,
      logger: t.logger,
    });
    expect(other).toEqual({ status: 200, body: {} });
  });
});

describe('parseOtlpTraces', () => {
  it('reads each span down to what a record may hold', () => {
    expect(
      parseOtlpTraces(
        otlp(
          otlpSpan(),
          otlpSpan({ spanId: '8e7c51b38a7d6d81', name: 'chat', status: { code: 2, message: 'timeout' } }),
        ),
      ),
    ).toEqual([
      {
        traceId: T1,
        spanId: '8e7c51b38a7d6d80',
        parentSpanId: '00000000000000aa',
        name: 'delivery',
        start: '2026-09-27T20:27:24.043Z',
        end: '2026-09-27T20:27:24.043Z',
        outcome: { status: 'ok' },
      },
      {
        traceId: T1,
        spanId: '8e7c51b38a7d6d81',
        parentSpanId: '00000000000000aa',
        name: 'chat',
        start: '2026-09-27T20:27:24.043Z',
        end: '2026-09-27T20:27:24.043Z',
        outcome: { status: 'error', reason: 'timeout' },
      },
    ]);
    expect(
      present(parseOtlpTraces(otlp(otlpSpan({ status: { code: 1 } })))[0], 'parseOtlpTraces(...)[0]').outcome,
    ).toEqual({
      status: 'ok',
    });
  });

  it.each([
    ['a body that is not an object', 'nope', 'resourceSpans must be an array'],
    ['no resourceSpans', {}, 'resourceSpans must be an array'],
    ['no scopeSpans', { resourceSpans: [{}] }, 'scopeSpans must be an array'],
    ['no spans', { resourceSpans: [{ scopeSpans: [{}] }] }, 'spans must be an array'],
    ['a 30-character traceId', otlp(otlpSpan({ traceId: T1.slice(2) })), 'traceId must be 32'],
    ['an uppercase traceId', otlp(otlpSpan({ traceId: T1.toUpperCase() })), 'traceId must be 32'],
    ['a 15-character spanId', otlp(otlpSpan({ spanId: '8e7c51b38a7d6d8' })), 'spanId must be 16'],
    ['no parentSpanId', otlp(otlpSpan({ parentSpanId: undefined })), 'parentSpanId must be 16'],
    ['an empty parentSpanId', otlp(otlpSpan({ parentSpanId: '' })), 'parentSpanId must be 16'],
    ['the name tool', otlp(otlpSpan({ name: 'tool' })), 'name must be one of delivery, chat, embed, post'],
    ['a daemon span name', otlp(otlpSpan({ name: 'asha.chat' })), 'name must be one of'],
    ['a numeric start time', otlp(otlpSpan({ startTimeUnixNano: 1790540844043000000 })), 'decimal strings'],
    ['a negative end time', otlp(otlpSpan({ endTimeUnixNano: '-1' })), 'decimal strings'],
    ['no status', otlp(otlpSpan({ status: undefined })), 'status.code must be 0, 1 or 2'],
    ['status code 3', otlp(otlpSpan({ status: { code: 3 } })), 'status.code must be 0, 1 or 2'],
    [
      'an error status with free text',
      otlp(otlpSpan({ status: { code: 2, message: 'CANARY-7f3' } })),
      "an error status's message must be one of",
    ],
    [
      'an error status with no message',
      otlp(otlpSpan({ status: { code: 2 } })),
      "an error status's message must be one of",
    ],
  ])('refuses %s, naming what is wrong', (_, body, message) => {
    expect(() => parseOtlpTraces(body)).toThrow(TraceRequestInvalid);
    expect(() => parseOtlpTraces(body)).toThrow(message);
  });

  it('refuses a request that repeats a spanId, naming it', () => {
    expect(() =>
      parseOtlpTraces(
        otlp(
          otlpSpan({ spanId: 'a'.repeat(16) }),
          otlpSpan({ spanId: 'b'.repeat(16) }),
          otlpSpan({ spanId: 'a'.repeat(16) }),
        ),
      ),
    ).toThrow(new TraceRequestInvalid(`spanId ${'a'.repeat(16)} appears more than once`));
  });

  it('refuses a span that ends before it starts, and accepts one that ends as it starts', () => {
    expect(() =>
      parseOtlpTraces(
        otlp(otlpSpan({ startTimeUnixNano: '1790540844043000001', endTimeUnixNano: '1790540844043000000' })),
      ),
    ).toThrow('spans[0]: a span cannot end before it starts');
    expect(
      parseOtlpTraces(
        otlp(otlpSpan({ startTimeUnixNano: '1790540844043000000', endTimeUnixNano: '1790540844043000000' })),
      ),
    ).toHaveLength(1);
  });

  it('refuses the whole request when any one span is invalid', () => {
    expect(() => parseOtlpTraces(otlp(otlpSpan(), otlpSpan({ name: 'tool' })))).toThrow(
      'spans[1]: name must be one of',
    );
  });
});

describe('receiveSpans', () => {
  const scope = { handle: 'hewo-1', channel: 'main', traces: new Set([T1]) };
  const span = (spanId: string, traceId = T1) =>
    present(parseOtlpTraces(otlp(otlpSpan({ spanId, traceId })))[0], 'parseOtlpTraces(...)[0]');

  it("records its own spans under the token's handle and channel, and answers 200 with partialSuccess unset", () => {
    const logger = new RecordingLogger();
    const written: TraceRecord[][] = [];
    const answer = receiveSpans({
      spans: [span('1'.repeat(16)), span('2'.repeat(16))],
      scope,
      writer: { write: (r) => (written.push([...r]), { ok: true }) },
      logger,
    });
    expect(answer).toEqual({ status: 200, body: {} });
    expect(written).toHaveLength(1);
    expect(
      present(written[0], 'written[0]').map((r) => [r.spanId, r.handle, r.channel, r.kind, r.status, r.reason]),
    ).toEqual([
      ['1'.repeat(16), 'hewo-1', 'main', 'delivery', 'ok', null],
      ['2'.repeat(16), 'hewo-1', 'main', 'delivery', 'ok', null],
    ]);
    expect(logger.entries).toEqual([]);
  });

  it('drops and counts spans of a trace not delivered to the agent, warning once per request', () => {
    const logger = new RecordingLogger();
    const written: TraceRecord[][] = [];
    const foreign = traceIdFor('someone-elses');
    const answer = receiveSpans({
      spans: [span('1'.repeat(16)), span('2'.repeat(16), foreign), span('3'.repeat(16), foreign)],
      scope,
      writer: { write: (r) => (written.push([...r]), { ok: true }) },
      logger,
    });
    expect(answer).toEqual({ status: 200, body: { partialSuccess: { rejectedSpans: 2 } } });
    expect(written.map((w) => w.map((r) => r.spanId))).toEqual([['1'.repeat(16)]]);
    expect(logger.entries).toEqual([
      { level: 'warn', event: 'traces.foreign_trace', fields: { handle: 'hewo-1', count: 2 } },
    ]);
  });

  it('writes nothing when every span is foreign', () => {
    const written: unknown[] = [];
    const answer = receiveSpans({
      spans: [span('1'.repeat(16), traceIdFor('x'))],
      scope,
      writer: { write: (r) => (written.push(r), { ok: true }) },
      logger: new RecordingLogger(),
    });
    expect(answer).toEqual({ status: 200, body: { partialSuccess: { rejectedSpans: 1 } } });
    expect(written).toEqual([]);
  });

  it('answers 200 with the dropped spans counted when the append would pass the cap (A7)', () => {
    const answer = receiveSpans({
      spans: [span('1'.repeat(16)), span('2'.repeat(16)), span('3'.repeat(16), traceIdFor('x'))],
      scope,
      writer: { write: () => ({ ok: false, reason: 'over_cap', dropped: 2 }) },
      logger: new RecordingLogger(),
    });
    expect(answer).toEqual({ status: 200, body: { partialSuccess: { rejectedSpans: 3 } } });
  });

  it('answers 503 when the append fails (A7)', () => {
    const answer = receiveSpans({
      spans: [span('1'.repeat(16))],
      scope,
      writer: { write: () => ({ ok: false, reason: 'write_failed' }) },
      logger: new RecordingLogger(),
    });
    expect(answer).toEqual({ status: 503, body: { error: 'the spans could not be written; see the daemon log' } });
  });
});
