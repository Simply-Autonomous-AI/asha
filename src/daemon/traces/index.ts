// Traces: one trace per conversation (docs/plans/otel-traces.md). The daemon
// records two kinds of span in the same form — its own (asha.conversation,
// asha.delivery, asha.call, asha.chat, asha.embed) and the ones agents send over
// OTLP/HTTP JSON (delivery, chat, embed, post) — as one JSON line each in
// logs/traces-YYYY-MM-DD.jsonl. A record carries exactly the fields of
// TraceRecord and nothing an agent could put text in: no attributes, events,
// links, resource or scope (R4, R12).
//
// Writes are synchronous, like the daemon log's, so a span's record is on
// disk before the channel event that follows it (R5: asha.conversation is
// written before the status that reports its empty working set).
//
// Query one conversation's trace:
//   grep '"traceId":"<traceIdFor(conversation)>"' logs/traces-*.jsonl

import { appendFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  AGENT_SPAN_NAMES,
  TRACE_REASONS,
  formatTraceparent,
  type AgentSpanName,
  type TraceReason,
} from '../../shared/protocol.js';
import { present } from '../../shared/assert-present.js';
import type { Logger } from '../log.js';

export type DaemonSpanName = 'asha.conversation' | 'asha.delivery' | 'asha.call' | 'asha.chat' | 'asha.embed';
type SpanName = AgentSpanName | DaemonSpanName;
type SpanKind = 'conversation' | 'delivery' | 'call' | 'model_call' | 'post';

const KIND: Readonly<Record<SpanName, SpanKind>> = {
  'asha.conversation': 'conversation',
  'asha.delivery': 'delivery',
  /** A call, from its consult until its gather is delivered or it closes (docs/plans/agent-calls.md R12). */
  'asha.call': 'call',
  'asha.chat': 'model_call',
  'asha.embed': 'model_call',
  delivery: 'delivery',
  chat: 'model_call',
  embed: 'model_call',
  post: 'post',
};

/** How a span ended. */
export type SpanOutcome = { readonly status: 'ok' } | { readonly status: 'error'; readonly reason: TraceReason };

/** One line of a trace file, exactly (R4). */
export interface TraceRecord {
  readonly traceId: string;
  readonly spanId: string;
  /** Null only for asha.conversation, the root of a conversation's trace. */
  readonly parentSpanId: string | null;
  readonly name: SpanName;
  readonly kind: SpanKind;
  readonly channel: string;
  readonly handle: string;
  /** ISO-8601 UTC with milliseconds. */
  readonly start: string;
  readonly end: string;
  readonly status: 'ok' | 'error';
  readonly reason: TraceReason | null;
}

/** Builds a record with its keys in R4's order, so every line reads the same. */
export function traceRecord(span: Omit<TraceRecord, 'kind' | 'status' | 'reason'>, outcome: SpanOutcome): TraceRecord {
  return {
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    name: span.name,
    kind: KIND[span.name],
    channel: span.channel,
    handle: span.handle,
    start: span.start,
    end: span.end,
    status: outcome.status,
    reason: outcome.status === 'ok' ? null : outcome.reason,
  };
}

// ------------------------------------------------------------ daemon spans

/** A daemon span that has started and not ended. */
export interface OpenSpan {
  readonly name: DaemonSpanName;
  readonly traceId: string;
  readonly spanId: string;
  readonly channel: string;
  readonly handle: string;
  /** ISO-8601 UTC. */
  readonly start: string;
  /** This span as a W3C `traceparent`, for its children in other processes. */
  readonly traceparent: string;
  /** Ends the span and writes its record. A span ends once; a second end is a harness defect and throws. */
  end(outcome: SpanOutcome): void;
}

export interface StartSpanProps {
  readonly name: DaemonSpanName;
  readonly traceId: string;
  /** Null for asha.conversation only. */
  readonly parentSpanId: string | null;
  readonly channel: string;
  readonly handle: string;
}

/** Starts the daemon's spans; each one's record goes to `record` when it ends. */
export interface Tracer {
  start(props: StartSpanProps): OpenSpan;
}

export interface DaemonTracerProps {
  readonly clock: () => Date;
  /** 16 lowercase hex characters, never all zeros: randomBytes(8) in production. */
  readonly newSpanId: () => string;
  readonly record: (record: TraceRecord) => void;
}

export class DaemonTracer implements Tracer {
  constructor(private readonly props: DaemonTracerProps) {}

  start(props: StartSpanProps): OpenSpan {
    if ((props.parentSpanId === null) !== (props.name === 'asha.conversation')) {
      throw new Error(`${props.name}: only asha.conversation has no parent span`);
    }
    const spanId = this.props.newSpanId();
    const start = this.props.clock().toISOString();
    let ended = false;
    return {
      name: props.name,
      traceId: props.traceId,
      spanId,
      channel: props.channel,
      handle: props.handle,
      start,
      traceparent: formatTraceparent({ traceId: props.traceId, spanId }),
      end: (outcome) => {
        if (ended) throw new Error(`span ${props.name} ${spanId} ended twice`);
        ended = true;
        this.props.record(traceRecord({ ...props, spanId, start, end: this.props.clock().toISOString() }, outcome));
      },
    };
  }
}

// ------------------------------------------------------------ trace files

/** The file system the trace writer uses: synchronous, injected so tests can count and fail calls. */
export interface TraceFiles {
  append(file: string, data: string): void;
  /** Bytes in the file; 0 when it does not exist. */
  size(file: string): number;
  list(dir: string): string[];
  remove(file: string): void;
}

export const nodeTraceFiles: TraceFiles = {
  append: (file, data) => {
    appendFileSync(file, data);
  },
  size: (file) => {
    try {
      return statSync(file).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  },
  list: (dir) => readdirSync(dir),
  remove: (file) => {
    rmSync(file);
  },
};

/** 64 MiB: the most one day's trace file may hold (R10). */
export const TRACE_FILE_CAP_BYTES = 64 * 1024 * 1024;
/**
 * 16 MiB of each day's file only the daemon's own spans may use: agents' spans stop at
 * TRACE_FILE_CAP_BYTES - this (48 MiB), so no agent can crowd out asha.conversation, asha.delivery
 * and the model-call spans. About 58,000 daemon records (~290 bytes each), some 10,000 conversations.
 */
export const TRACE_DAEMON_RESERVE_BYTES = 16 * 1024 * 1024;
/**
 * 4 MiB: the most one agent's spans may add to one day's file. A hello-world conversation's agent
 * spans are about 1.1 KB and a memory agent's about 3 KB, so 1,400–3,800 conversations an agent a
 * day; twelve agents at their budget fill the agents' 48 MiB, so one agent cannot starve another.
 */
export const TRACE_AGENT_DAILY_BYTES = 4 * 1024 * 1024;
/** Files dated more than this many days before today are deleted, so at most eight exist. */
const TRACE_RETENTION_DAYS = 7;

const FILE_PATTERN = /^traces-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Whose records an append holds: the daemon's own span, or one agent's (by `<channel>/<handle>`). */
export type TraceSource = 'daemon' | { readonly agent: string };

export type WriteOutcome =
  | { readonly ok: true }
  /** The append would have taken the day's file over its cap (for an agent's, the cap less the daemon's reserve): nothing was written. */
  | { readonly ok: false; readonly reason: 'over_cap'; readonly dropped: number }
  /** The append would have taken its agent over its daily budget: nothing was written. */
  | { readonly ok: false; readonly reason: 'over_budget'; readonly dropped: number }
  /** The append failed; traces.write_failed is logged. */
  | { readonly ok: false; readonly reason: 'write_failed' };

export interface TraceFileWriterProps {
  /** `logs/` in ASHA_HOME. */
  readonly dir: string;
  readonly clock: () => Date;
  readonly logger: Logger;
  readonly files: TraceFiles;
  /** TRACE_FILE_CAP_BYTES in production; tests lower it. */
  readonly capBytes: number;
  /** TRACE_DAEMON_RESERVE_BYTES in production: the part of the cap agents' spans may not use. */
  readonly daemonReserveBytes: number;
  /** TRACE_AGENT_DAILY_BYTES in production: what one agent's spans may add to a day's file. */
  readonly agentDailyBytes: number;
}

/**
 * Appends records to the current UTC day's file, one append per call. Keeps a
 * day's file under its cap by dropping whole appends (counted, and logged
 * once as the day's first drop and once with the day's count); agents' appends
 * stop short of the cap by the daemon's reserve, and each agent's within its
 * daily budget (logged the same way, per agent). Deletes files older than the
 * retention at start and at each day's first write.
 */
export class TraceFileWriter {
  /** The UTC date of the last write (or of start). */
  private date: string | undefined;
  /** The current day's file size, once known. */
  private size: number | undefined;
  private dropped = 0;
  /** Per agent, this day: bytes written and records dropped over its budget. */
  private readonly agents = new Map<string, { written: number; dropped: number }>();

  constructor(private readonly props: TraceFileWriterProps) {}

  /** At daemon startup: retention for today. */
  start(): void {
    this.rollTo(utcDate(this.props.clock()));
  }

  write(records: readonly TraceRecord[], source: TraceSource): WriteOutcome {
    this.rollTo(utcDate(this.props.clock()));
    const date = present(this.date, 'trace writer date');
    const file = join(this.props.dir, `traces-${date}.jsonl`);
    const data = records.map((r) => `${JSON.stringify(r)}\n`).join('');
    const bytes = Buffer.byteLength(data, 'utf8');
    const agentKey = source === 'daemon' ? undefined : source.agent;
    const agent = agentKey === undefined ? undefined : this.agentDay(agentKey);
    if (agent !== undefined && agent.written + bytes > this.props.agentDailyBytes) {
      if (agent.dropped === 0)
        this.props.logger.warn('traces.agent_over_budget', {
          date,
          agent: agentKey,
          budgetBytes: this.props.agentDailyBytes,
        });
      agent.dropped += records.length;
      return { ok: false, reason: 'over_budget', dropped: records.length };
    }
    const limit = source === 'daemon' ? this.props.capBytes : this.props.capBytes - this.props.daemonReserveBytes;
    try {
      this.size ??= this.props.files.size(file);
      if (this.size + bytes > limit) {
        if (this.dropped === 0) this.props.logger.warn('traces.dropped', { date, capBytes: limit });
        this.dropped += records.length;
        return { ok: false, reason: 'over_cap', dropped: records.length };
      }
      this.props.files.append(file, data);
      this.size += bytes;
      if (agent !== undefined) agent.written += bytes;
      return { ok: true };
    } catch (error) {
      // A partial append leaves the size unknown: read it again next time.
      this.size = undefined;
      this.props.logger.error('traces.write_failed', { file, error });
      return { ok: false, reason: 'write_failed' };
    }
  }

  /** At a clean daemon stop: the day's drop count, if any. */
  close(): void {
    this.reportDrops();
  }

  private agentDay(agent: string): { written: number; dropped: number } {
    let day = this.agents.get(agent);
    if (day === undefined) {
      day = { written: 0, dropped: 0 };
      this.agents.set(agent, day);
    }
    return day;
  }

  private rollTo(date: string): void {
    if (date === this.date) return;
    this.reportDrops();
    this.date = date;
    this.size = undefined;
    this.retain(date);
  }

  private reportDrops(): void {
    for (const [agent, day] of this.agents) {
      if (day.dropped > 0)
        this.props.logger.warn('traces.agent_over_budget', { date: this.date, agent, count: day.dropped });
    }
    this.agents.clear();
    if (this.dropped === 0) return;
    this.props.logger.warn('traces.dropped', { date: this.date, count: this.dropped });
    this.dropped = 0;
  }

  private retain(today: string): void {
    const oldest = new Date(`${today}T00:00:00.000Z`);
    oldest.setUTCDate(oldest.getUTCDate() - TRACE_RETENTION_DAYS);
    const keepFrom = utcDate(oldest);
    let names: string[];
    try {
      names = this.props.files.list(this.props.dir);
    } catch (error) {
      this.props.logger.error('traces.retention_failed', { file: this.props.dir, error });
      return;
    }
    for (const name of names) {
      const fileDate = FILE_PATTERN.exec(name)?.[1];
      if (fileDate === undefined || fileDate >= keepFrom) continue;
      const file = join(this.props.dir, name);
      try {
        this.props.files.remove(file);
      } catch (error) {
        this.props.logger.error('traces.retention_failed', { file, error });
      }
    }
  }
}

function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// ------------------------------------------------------------ received spans

/** An OTLP request the traces route cannot trust; nothing from it is recorded (R3). */
export class TraceRequestInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TraceRequestInvalid';
  }
}

/** One span an agent sent, reduced to what a record may hold. */
export interface ReceivedSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string;
  readonly name: AgentSpanName;
  readonly start: string;
  readonly end: string;
  readonly outcome: SpanOutcome;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;
const NANOS = /^\d{1,20}$/;

/**
 * Validates an OTLP/HTTP JSON export body (`resourceSpans[].scopeSpans[].spans[]`)
 * and returns its spans, dropping everything else it carries. Any span that
 * breaks R3's rules fails the whole request.
 */
export function parseOtlpTraces(body: unknown): ReceivedSpan[] {
  const resourceSpans = field(body, 'resourceSpans');
  if (!Array.isArray(resourceSpans)) throw new TraceRequestInvalid('resourceSpans must be an array');
  const spans: ReceivedSpan[] = [];
  for (const [r, resource] of resourceSpans.entries()) {
    const scopeSpans = field(resource, 'scopeSpans');
    if (!Array.isArray(scopeSpans))
      throw new TraceRequestInvalid(`resourceSpans[${r.toString()}].scopeSpans must be an array`);
    for (const [s, scope] of scopeSpans.entries()) {
      const list = field(scope, 'spans');
      if (!Array.isArray(list))
        throw new TraceRequestInvalid(
          `resourceSpans[${r.toString()}].scopeSpans[${s.toString()}].spans must be an array`,
        );
      for (const [i, span] of list.entries())
        spans.push(
          parseSpan(span, `resourceSpans[${r.toString()}].scopeSpans[${s.toString()}].spans[${i.toString()}]`),
        );
    }
  }
  // A span is recorded once: a request that repeats a spanId is not what an exporter sends.
  const seen = new Set<string>();
  for (const span of spans) {
    if (seen.has(span.spanId)) throw new TraceRequestInvalid(`spanId ${span.spanId} appears more than once`);
    seen.add(span.spanId);
  }
  return spans;
}

function parseSpan(span: unknown, at: string): ReceivedSpan {
  const bad = (what: string): TraceRequestInvalid => new TraceRequestInvalid(`${at}: ${what}`);
  const traceId = field(span, 'traceId');
  if (typeof traceId !== 'string' || !HEX32.test(traceId)) throw bad('traceId must be 32 lowercase hex characters');
  const spanId = field(span, 'spanId');
  if (typeof spanId !== 'string' || !HEX16.test(spanId)) throw bad('spanId must be 16 lowercase hex characters');
  // Every agent span has a parent: the daemon's asha.delivery, or the agent's own delivery.
  const parentSpanId = field(span, 'parentSpanId');
  if (typeof parentSpanId !== 'string' || !HEX16.test(parentSpanId))
    throw bad('parentSpanId must be 16 lowercase hex characters');
  const name = field(span, 'name');
  if (typeof name !== 'string' || !(AGENT_SPAN_NAMES as readonly string[]).includes(name))
    throw bad(`name must be one of ${AGENT_SPAN_NAMES.join(', ')}`);
  const startNanos = field(span, 'startTimeUnixNano');
  const endNanos = field(span, 'endTimeUnixNano');
  const start = nanosToIso(startNanos);
  const end = nanosToIso(endNanos);
  if (start === undefined || end === undefined)
    throw bad('startTimeUnixNano and endTimeUnixNano must be decimal strings');
  if (BigInt(startNanos as string) > BigInt(endNanos as string)) throw bad('a span cannot end before it starts');
  const status = field(span, 'status');
  const code = field(status, 'code');
  if (code !== 0 && code !== 1 && code !== 2) throw bad('status.code must be 0, 1 or 2');
  let outcome: SpanOutcome = { status: 'ok' };
  if (code === 2) {
    const message = field(status, 'message');
    if (typeof message !== 'string' || !(TRACE_REASONS as readonly string[]).includes(message)) {
      throw bad(`an error status's message must be one of ${TRACE_REASONS.join(', ')}`);
    }
    outcome = { status: 'error', reason: message as TraceReason };
  }
  return { traceId, spanId, parentSpanId, name: name as AgentSpanName, start, end, outcome };
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function nanosToIso(value: unknown): string | undefined {
  if (typeof value !== 'string' || !NANOS.test(value)) return undefined;
  // At most 20 digits, so at most 1e14 ms: well inside what a Date holds.
  return new Date(Number(BigInt(value) / 1_000_000n)).toISOString();
}

export interface ReceiveSpansProps {
  /** The request's spans, already valid (parseOtlpTraces). */
  readonly spans: readonly ReceivedSpan[];
  /** From the agent's token: whose spans they are, and the traces it may send. */
  readonly scope: { readonly handle: string; readonly channel: string; readonly traces: ReadonlySet<string> };
  /** The writer: each request's records are charged to its agent, `<channel>/<handle>`. */
  readonly writer: Pick<TraceFileWriter, 'write'>;
  readonly logger: Logger;
}

/**
 * What the traces route answers a valid request (R3, R10): 200, unless the
 * append fails (503). Spans whose trace is no conversation delivered to the
 * agent are dropped and counted (one warn per request); so are the spans of
 * an append that would pass the day's cap. A fully accepted request leaves
 * OTLP's partialSuccess unset.
 */
export function receiveSpans(props: ReceiveSpansProps): { readonly status: 200 | 503; readonly body: unknown } {
  const { scope } = props;
  const own = props.spans.filter((span) => scope.traces.has(span.traceId));
  const foreign = props.spans.length - own.length;
  if (foreign > 0) props.logger.warn('traces.foreign_trace', { handle: scope.handle, count: foreign });
  let rejected = foreign;
  if (own.length > 0) {
    const outcome = props.writer.write(
      own.map((span) =>
        traceRecord(
          {
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId,
            name: span.name,
            channel: scope.channel,
            handle: scope.handle,
            start: span.start,
            end: span.end,
          },
          span.outcome,
        ),
      ),
      { agent: `${scope.channel}/${scope.handle}` },
    );
    if (!outcome.ok && outcome.reason === 'write_failed')
      return { status: 503, body: { error: 'the spans could not be written; see the daemon log' } };
    if (!outcome.ok) rejected += outcome.dropped;
  }
  return { status: 200, body: rejected === 0 ? {} : { partialSuccess: { rejectedSpans: rejected } } };
}
