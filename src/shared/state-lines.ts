// The lines `--status`, `--list-state` and `--reset-state` print (docs/plans/agent-persistence.md R5, R16;
// extension-modules R21), one implementation for the CLI and the portal's page (docs/plans/portal.md R8, R15).
// Browser-safe: it imports only modules that import nothing.

import { EXIT, errorLine, type Out } from './lines.js';
import type {
  HealthResponse,
  StateEraseEvent,
  StateListResponse,
  StateRefusalReason,
  StateRemoved,
  StateSelector,
} from './protocol.js';

/** `--status`'s lines for a running daemon: the daemon, each agent, each enabled metered module's spend. */
export function statusLines(health: HealthResponse, port: number): string[] {
  return [
    `running: pid ${String(health.pid)}, port ${String(port)}, version ${health.version}, build ${health.build}, started ${health.startedAt}`,
    // The cloud modules and hosted models an agent may send data to (extension-modules R21): said only when there are any.
    ...health.agents.map((agent) => {
      const cloud = agent.cloud === undefined || agent.cloud.length === 0 ? '' : ` cloud=${agent.cloud.join(',')}`;
      return `  ${agent.handle}  channel=${agent.channel} recipe=${agent.recipe} image=${agent.image}${cloud}`;
    }),
    ...(health.spend ?? []).map(
      (s) =>
        `  ${s.module} spend ${String(s.day)}/${String(s.dayCap)} today, ${String(s.month)}/${String(s.monthCap)} this month (UTC), USD`,
    ),
  ];
}

/** One `--list-state` line per asset, then per record of unsaved deliveries, then the total (R5). */
export function listLines(listed: StateListResponse): string[] {
  if (listed.assets.length === 0 && listed.pending.length === 0) return ['nothing saved'];
  return [
    ...listed.assets.map(
      (a) =>
        `${a.kind} ${a.identity} ${a.asset} ${String(a.bytes)} ${a.savedAt}${a.full ? ' full' : ''}${a.tainted ? ' tainted' : ''}`,
    ),
    ...listed.pending.map((p) => `agent ${p.identity} pending ${String(p.bytes)} ${p.savedAt}`),
    `total ${String(listed.totalBytes)} in ${String(listed.assets.length + listed.pending.length)} assets`,
  ];
}

/** The listing narrowed to what a selector names, and, for an erase, to saved memory alone. */
export function narrowed(listed: StateListResponse, selector: StateSelector, memoryOnly: boolean): StateListResponse {
  const named = (kind: 'agent' | 'channel', identity: string): boolean => {
    if ('all' in selector) return true;
    if (kind === 'channel') return selector.name === undefined && identity === selector.channel;
    const [channel, team, name] = identity.split('/');
    return (
      channel === selector.channel &&
      (selector.name === undefined || (name === selector.name && team === (selector.team ?? '-')))
    );
  };
  const assets = listed.assets.filter(
    (a) => named(a.kind, a.identity) && (!memoryOnly || (a.kind === 'agent' && a.asset === 'memory')),
  );
  const pending = memoryOnly ? [] : listed.pending.filter((p) => named('agent', p.identity));
  return {
    assets,
    pending,
    totalBytes: assets.reduce((n, a) => n + a.bytes, 0) + pending.reduce((n, p) => n + p.bytes, 0),
  };
}

/** The selector as typed. */
function describe(selector: StateSelector): string {
  if ('all' in selector) return 'all';
  return [
    `channel=${selector.channel}`,
    ...(selector.name === undefined ? [] : [`name=${selector.name}`]),
    ...(selector.team === undefined ? [] : [`team=${selector.team}`]),
  ].join(' ');
}

/** The `✗` line when nothing saved matches the selector. */
export function nothingMatchesLine(selector: StateSelector): string {
  return `✗ nothing saved matches ${describe(selector)}`;
}

/** The lines of a reset's removals (R5). */
export function removedLines(removed: readonly StateRemoved[]): string[] {
  return removed.map((r) => `removed ${r.kind} ${r.identity} ${r.asset} (${String(r.bytes)} bytes)`);
}

/** A 409's refusal, as the `✗` line says it. */
export function refusalLine(reason: StateRefusalReason, detail: string, selector: StateSelector): string {
  return reason === 'nothing_matches' ? nothingMatchesLine(selector) : `✗ ${detail}`;
}

/** The line an erase stream that ended before `erase_done` ends with. */
export const ERASE_CLOSED = '✗ the daemon closed the erase before it finished; see its log\n';

/**
 * R16's erase, printed as it streams: each identity's outcome and the shared assets kept; `handle` returns the exit
 * code at `erase_done` (0 when every identity was erased or held nothing of the user) or at an `error`.
 */
export class ErasePrinter {
  private failed = false;

  constructor(
    private readonly out: Out,
    private readonly user: string,
  ) {}

  handle(event: StateEraseEvent): number | undefined {
    const { out, user } = this;
    switch (event.type) {
      case 'erased':
        out.stdout(
          `erased user ${user} from agent ${event.identity} memory (${String(event.files)} files, ${String(event.bytes)} bytes)\n`,
        );
        if (event.pendingMessages > 0)
          out.stdout(
            `erased user ${user} from agent ${event.identity} pending (${String(event.pendingMessages)} messages)\n`,
          );
        return undefined;
      case 'no_memory':
        out.stdout(`no memory of user ${user} in agent ${event.identity}\n`);
        if (event.pendingMessages > 0)
          out.stdout(
            `erased user ${user} from agent ${event.identity} pending (${String(event.pendingMessages)} messages)\n`,
          );
        return undefined;
      case 'erase_failed':
        this.failed = true;
        out.stderr(`✗ could not erase user ${user} from agent ${event.identity}: ${event.reason}\n`);
        if (event.pendingMessages > 0)
          out.stdout(
            `erased user ${user} from agent ${event.identity} pending (${String(event.pendingMessages)} messages)\n`,
          );
        return undefined;
      case 'kept':
        out.stdout(
          `kept ${event.kind} ${event.identity} ${event.asset}: shared by every user of the channel, not erased\n`,
        );
        return undefined;
      case 'erase_done':
        return this.failed ? EXIT.failed : EXIT.ok;
      case 'error':
        out.stderr(errorLine(event));
        return EXIT.failed;
      default: {
        const unknown: never = event;
        throw new Error(`unknown erase event: ${JSON.stringify(unknown)}`);
      }
    }
  }
}
