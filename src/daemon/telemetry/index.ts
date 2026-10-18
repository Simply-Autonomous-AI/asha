// Each online agent's telemetry for the portal (docs/plans/portal.md R10): counted in memory from the daemon's own
// spans as they are written to the trace file — never an agent's spans, which an agent writes and could inflate —
// per (channel, handle), from the agent's first recorded span; an agent's entry is dropped when it leaves its
// channel. No file is read. The tap costs one map update per daemon span written, with no I/O and no await.

import type { AgentTelemetry, TelemetryResponse, WatchEvent } from '../../shared/protocol.js';
import { byKey } from '../../shared/order.js';
import type { DaemonSpanName, TraceFileWriter, TraceRecord } from '../traces/index.js';

const DAEMON_SPANS: ReadonlySet<string> = new Set<DaemonSpanName>([
  'asha.conversation',
  'asha.delivery',
  'asha.call',
  'asha.chat',
  'asha.embed',
]);
const MODEL_CALLS: ReadonlySet<string> = new Set<DaemonSpanName>(['asha.chat', 'asha.embed']);

interface Entry {
  deliveries: number;
  modelCalls: number;
  lastModelCallMs: number | null;
  lastError: { readonly span: string; readonly reason: string; readonly at: string } | null;
}

export interface TelemetryProps {
  /** Whether `handle` is an agent online on `channel` now. */
  readonly isMember: (channel: string, handle: string) => boolean;
  /** Subscribes to everything on a channel (`Channel.watchAll`); called once per channel, the first time it has an entry. */
  readonly watchChannel: (channel: string, watcher: (event: WatchEvent) => void) => void;
}

/** One online agent, as the supervisor lists it for the telemetry answer. */
export interface TelemetryAgent {
  readonly handle: string;
  readonly recipe: string;
  /** The team it was launched with; null for a recipe launched alone (portal-scene-chat R7). */
  readonly team: string | null;
  readonly model: string;
}

export class Telemetry {
  /** Entries by channel, then handle. */
  private readonly channels = new Map<string, Map<string, Entry>>();

  constructor(private readonly props: TelemetryProps) {}

  /** A daemon span the trace file has just written (`WriteOutcome` ok): counted for its agent when it is online. */
  record(record: TraceRecord): void {
    if (!DAEMON_SPANS.has(record.name)) return;
    if (!this.props.isMember(record.channel, record.handle)) return;
    let entries = this.channels.get(record.channel);
    if (entries === undefined) {
      entries = new Map();
      this.channels.set(record.channel, entries);
      const kept = entries;
      // An agent's entry goes when it leaves its channel: one subscription per channel, for the daemon's life.
      this.props.watchChannel(record.channel, (event) => {
        if (event.type === 'agent_left') kept.delete(event.agent);
      });
    }
    let entry = entries.get(record.handle);
    if (entry === undefined) {
      entry = { deliveries: 0, modelCalls: 0, lastModelCallMs: null, lastError: null };
      entries.set(record.handle, entry);
    }
    if (record.name === 'asha.delivery') entry.deliveries += 1;
    if (MODEL_CALLS.has(record.name)) {
      entry.modelCalls += 1;
      entry.lastModelCallMs = Date.parse(record.end) - Date.parse(record.start);
    }
    if (record.status === 'error') {
      // traceRecord gives every error span its reason: one without is a harness defect.
      if (record.reason === null) throw new Error(`span ${record.name} ${record.spanId} ended in error with no reason`);
      entry.lastError = { span: record.name, reason: record.reason, at: record.end };
    }
  }

  /** The answer for a channel: one entry per online agent, sorted by handle, with its calls in flight now. */
  answer(
    channel: string,
    online: readonly TelemetryAgent[],
    inFlight: readonly { readonly channel: string; readonly handle: string }[],
  ): TelemetryResponse {
    const entries = this.channels.get(channel);
    const agents: AgentTelemetry[] = [...online].sort(byKey('handle')).map((agent) => {
      const entry = entries?.get(agent.handle);
      return {
        handle: agent.handle,
        recipe: agent.recipe,
        team: agent.team,
        model: agent.model,
        deliveries: entry?.deliveries ?? 0,
        modelCalls: entry?.modelCalls ?? 0,
        lastModelCallMs: entry?.lastModelCallMs ?? null,
        modelCallsInFlight: inFlight.filter((c) => c.channel === channel && c.handle === agent.handle).length,
        lastError: entry?.lastError ?? null,
      };
    });
    return { channel, agents };
  }

  /** How many agents have entries, across channels (for tests: an agent that left has none). */
  size(): number {
    let n = 0;
    for (const entries of this.channels.values()) n += entries.size;
    return n;
  }
}

/**
 * The daemon tracer's record (R10's tap): each daemon span written to the trace file, and counted only when it was
 * written (`WriteOutcome` ok); a dropped or failed write is logged by the writer and not counted.
 */
export function recordAndCount(
  traces: Pick<TraceFileWriter, 'write'>,
  telemetry: Telemetry,
): (record: TraceRecord) => void {
  return (record) => {
    if (traces.write([record], 'daemon').ok) telemetry.record(record);
  };
}
