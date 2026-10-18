// The agent's spans (docs/plans/otel-traces.md): one `delivery` span per
// delivery it handles, and one `chat`, `embed` or `post` span per call it
// makes to the harness in that delivery — children of the delivery span, even
// when made after the handler returned (the memory agent's background
// remember), because the current delivery's span is held in an
// AsyncLocalStorage that every call made from the handler inherits.
//
// Spans are exported with the official OpenTelemetry packages over OTLP/HTTP
// JSON to the daemon's /agent/v1/traces. They carry no attributes, events or
// links (R12): an error span's status message is only a TraceReason. An
// export failure never fails or delays a turn past the flush bound; each one
// is one JSON line on stdout (R6), which ends up in the agent's log.

import { AsyncLocalStorage } from 'node:async_hooks';

import { DiagLogLevel, ROOT_CONTEXT, SpanStatusCode, diag, trace, type Span, type Tracer } from '@opentelemetry/api';
import { setGlobalErrorHandler } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, TracerProvider, type SpanExporter } from '@opentelemetry/sdk-trace';

import {
  Routes,
  formatTraceparent,
  parseTraceparent,
  type AgentSpanName,
  type Delivery,
  type TraceReason,
} from '../shared/protocol.js';
import { traceIdFor } from '../shared/trace-id.js';

/** R7: every bound on exporting spans, in ms, and the queue. The flush bound is 2000 ms. */
export const TRACE_LIMITS = {
  exportTimeoutMs: 2_000,
  flushTimeoutMs: 2_000,
  maxExportBatchSize: 256,
  maxQueueSize: 2_048,
} as const;

/** Why exporting spans failed, as the `trace.export_failed` line says it (R6). */
export type ExportFailure = 'unauthorized' | 'rejected' | 'timeout' | 'unavailable' | 'queue_full' | 'sdk_error';

/** A chat, embed or post-with-conversation was made outside any delivery, so it has no trace to belong to. */
export class NoDeliveryContext extends Error {
  constructor(readonly call: AgentSpanName) {
    super(
      `${call} made outside any delivery: every chat, embed and conversation post belongs to the delivery being handled`,
    );
    this.name = 'NoDeliveryContext';
  }
}

/** A delivery whose traceparent is malformed or names another conversation's trace: a harness defect. */
export class DeliveryTraceInvalid extends Error {
  constructor(
    readonly deliveryId: string,
    traceparent: string,
  ) {
    super(
      `delivery ${deliveryId} carries traceparent ${JSON.stringify(traceparent)}, not a span in its conversation's trace`,
    );
    this.name = 'DeliveryTraceInvalid';
  }
}

/** How a call's span ends: ok, or the reason it failed. */
export type CallOutcome = { readonly status: 'ok' } | { readonly status: 'error'; readonly reason: TraceReason };

export interface AgentTelemetryProps {
  /** OTLPTraceExporter to the harness in production (forHarness); an InMemorySpanExporter in tests. */
  readonly exporter: SpanExporter;
  /** Writes one line to the agent's stdout. */
  readonly writeLine: (line: string) => void;
  /** TRACE_LIMITS.maxQueueSize in production; tests lower it to overflow the queue. */
  readonly maxQueueSize: number;
  /** TRACE_LIMITS.maxExportBatchSize in production; at most maxQueueSize. */
  readonly maxExportBatchSize: number;
}

/** The first debug line the batch processor writes when its queue drops a span (sdk-trace 2.11.0). */
const QUEUE_FULL_DEBUG = 'maxQueueSize reached, dropping spans';
/** Its later warning, for the same burst of drops, written only once a span is accepted again. */
const QUEUE_FULL_WARN = /^Dropped \d+ spans because maxQueueSize reached/;
/**
 * The exporter's warning when the daemon answered 200 with `partialSuccess` (otlp-exporter-base 0.222.0,
 * logging-response-handler.js): the daemon refused some of the spans (a foreign trace, the day's cap, the
 * agent's budget). Recorded as `rejected`: the spans were refused, as a non-2xx refuses them.
 */
const PARTIAL_SUCCESS_WARN = 'Received Partial Success response:';
/**
 * The error the exporter makes when its retries on a retryable status (429, 502, 503, 504) run out of time
 * (otlp-exporter-base 0.222.0, otlp-export-delegate.js): an OTLPExporterError with no `code`. A 503 is what
 * the traces route answers when its append fails.
 */
const RETRYABLE_STATUS_MESSAGE = 'Export failed with retryable status';
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * The agent's tracer. Installing it installs the OpenTelemetry global error
 * handler and diag logger, which are process-wide: an agent process has one.
 */
export class AgentTelemetry {
  private readonly provider: TracerProvider;
  private readonly tracer: Tracer;
  private readonly current = new AsyncLocalStorage<Span>();

  constructor(private readonly props: AgentTelemetryProps) {
    // Before the provider exists, so nothing it reports is missed (R6). Scheduled export failures reach the
    // global handler; a rejected forceFlush does not, so flush() records its own.
    setGlobalErrorHandler((error) => {
      this.failed(classifyExportError(error));
    });
    // At DEBUG, not WARN (correcting R6): the batch processor reports its first dropped span only at debug, and the
    // count at warn only once a later span is accepted — never, if the drops come at the end of a turn. The first
    // drop records queue_full; the later warning for the same drops is not recorded again; other debug is ignored.
    diag.setLogger(
      {
        error: () => {
          this.failed('sdk_error');
        },
        warn: (message) => {
          if (QUEUE_FULL_WARN.test(message)) return;
          this.failed(message === PARTIAL_SUCCESS_WARN ? 'rejected' : 'sdk_error');
        },
        info: () => undefined,
        verbose: () => undefined,
        debug: (message) => {
          if (message === QUEUE_FULL_DEBUG) this.failed('queue_full');
        },
      },
      { logLevel: DiagLogLevel.DEBUG, suppressOverrideMessage: true },
    );
    this.provider = new TracerProvider({
      forceFlushTimeoutMillis: TRACE_LIMITS.flushTimeoutMs,
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: props.exporter,
          exportTimeoutMillis: TRACE_LIMITS.exportTimeoutMs,
          maxExportBatchSize: props.maxExportBatchSize,
          maxQueueSize: props.maxQueueSize,
        }),
      ],
    });
    this.tracer = this.provider.getTracer('asha-agent-sdk');
  }

  /** The production telemetry: spans to the harness's traces route, with the agent's token (R9). */
  static forHarness(
    environment: { readonly harnessUrl: string; readonly agentToken: string },
    writeLine: (line: string) => void,
  ): AgentTelemetry {
    return new AgentTelemetry({
      exporter: new OTLPTraceExporter({
        url: new URL(Routes.agentTraces, environment.harnessUrl).toString(),
        headers: { authorization: `Bearer ${environment.agentToken}` },
        timeoutMillis: TRACE_LIMITS.exportTimeoutMs,
      }),
      writeLine,
      maxQueueSize: TRACE_LIMITS.maxQueueSize,
      maxExportBatchSize: TRACE_LIMITS.maxExportBatchSize,
    });
  }

  /**
   * Runs `handle` as the delivery's `delivery` span, a child of the daemon's
   * span that `delivery.traceparent` names. Every call made from it — also
   * after it returns — belongs to this delivery. The span ends when `handle`
   * settles: ok, or error `handler_failed` if it throws (and the error is
   * rethrown).
   */
  async inDelivery(delivery: Delivery, handle: () => Promise<void>): Promise<void> {
    const parent = parseTraceparent(delivery.traceparent);
    if (parent === undefined || parent.traceId !== traceIdFor(delivery.message.conversation)) {
      throw new DeliveryTraceInvalid(delivery.deliveryId, delivery.traceparent);
    }
    const span = this.tracer.startSpan(
      'delivery',
      {},
      trace.setSpanContext(ROOT_CONTEXT, { ...parent, traceFlags: 1, isRemote: true }),
    );
    try {
      await this.current.run(span, handle);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: 'handler_failed' satisfies TraceReason });
      span.end();
      throw error;
    }
    span.end();
  }

  /**
   * Runs one call to the harness as a child span of the current delivery:
   * `send` gets that span's traceparent to put on the request. The span ends
   * with `outcome` of the result, or error `failure(error)` if `send` throws
   * (the error is rethrown). Outside a delivery it throws NoDeliveryContext
   * and `send` is never called.
   */
  async call<T>(
    name: Exclude<AgentSpanName, 'delivery'>,
    send: (traceparent: string) => Promise<T>,
    outcome: (result: T) => CallOutcome,
    failure: (error: unknown) => TraceReason,
  ): Promise<T> {
    const delivery = this.current.getStore();
    if (delivery === undefined) throw new NoDeliveryContext(name);
    const span = this.tracer.startSpan(name, {}, trace.setSpan(ROOT_CONTEXT, delivery));
    const end = (ended: CallOutcome): void => {
      if (ended.status === 'error') span.setStatus({ code: SpanStatusCode.ERROR, message: ended.reason });
      span.end();
    };
    let result: T;
    try {
      result = await send(
        formatTraceparent({ traceId: span.spanContext().traceId, spanId: span.spanContext().spanId }),
      );
    } catch (error) {
      end({ status: 'error', reason: failure(error) });
      throw error;
    }
    end(outcome(result));
    return result;
  }

  /**
   * Exports every ended span, within the flush bound (R7, R11). Never
   * rejects: a failure is recorded as its one stdout line (R6), and the turn
   * goes on.
   */
  async flush(): Promise<void> {
    try {
      await this.provider.forceFlush();
    } catch (errors) {
      // TracerProvider.forceFlush rejects with the array of its processors' errors; there is one processor.
      this.failed(classifyExportError(Array.isArray(errors) ? errors[0] : errors));
    }
  }

  private failed(reason: ExportFailure): void {
    // Only this line, and nothing from the error: no token, no URL, no span content (R6).
    this.props.writeLine(JSON.stringify({ level: 'error', event: 'trace.export_failed', reason }));
  }
}

/** An export error as R6's reason: by HTTP status, a retryable status, network error code, then a timeout's message. */
export function classifyExportError(error: unknown): ExportFailure {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number') return code === 401 ? 'unauthorized' : 'rejected';
  if (
    error instanceof Error &&
    error.name === 'OTLPExporterError' &&
    code === undefined &&
    error.message === RETRYABLE_STATUS_MESSAGE
  )
    return 'rejected';
  if (typeof code === 'string' && UNAVAILABLE_CODES.has(code)) return 'unavailable';
  const message = error instanceof Error ? error.message : String(error);
  // The exporter's "Request timed out", the batch processor's "Timeout", the provider's "…within timeout period…".
  if (/timed out|^Timeout$|timeout period/.test(message)) return 'timeout';
  return 'sdk_error';
}
