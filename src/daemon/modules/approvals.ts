// Pending approval requests (docs/plans/extension-modules.md R12 (a), (b), (e)): one per consequential call that
// reached the module-call route, held in the daemon's memory only, never sent to the module. A request expires 10
// minutes after it is made; its id is then remembered as `expired` for 10 more minutes (at most 64 such ids, the
// oldest dropped first) and is `unknown` after. At most 64 are pending in a daemon. Taking a request for its approval
// removes it at once — before anything is awaited — so it is performed at most once.

import { createHash } from 'node:crypto';

import { present } from '../../shared/assert-present.js';
import { canonicalJson } from '../../shared/jcs.js';
import type { SetTimer } from './host.js';

export const APPROVAL_TTL_MS = 10 * 60_000;
export const MAX_PENDING_APPROVALS = 64;
export const MAX_EXPIRED_IDS = 64;

/** A pending request, as `GET /v1/approvals/<id>` answers it (with `expiresAt` and the tool's `timeoutMs`). */
export interface ApprovalRequest {
  readonly id: string;
  readonly agent: string;
  readonly channel: string;
  readonly user: string;
  readonly module: string;
  readonly tool: string;
  /** The RFC 8785 form of the arguments, as a string. */
  readonly arguments: string;
  readonly sha256: string;
  readonly conversation: string;
  readonly at: string;
  readonly expiresAt: string;
  readonly timeoutMs: number;
}

/** Why an approval route refused an id (404's reason). */
export type ApprovalRefusal = 'unknown' | 'expired' | 'agent_gone';

/**
 * The request's sha256 (R12 (a), (b)): of the RFC 8785 form of {agent, conversation, module, tool, arguments}, the
 * arguments as the JSON value their RFC 8785 string is. The CLI computes it from what it printed, with this function.
 */
export function requestSha256(fields: {
  readonly agent: string;
  readonly conversation: string;
  readonly module: string;
  readonly tool: string;
  readonly arguments: string;
}): string {
  const value = {
    agent: fields.agent,
    conversation: fields.conversation,
    module: fields.module,
    tool: fields.tool,
    arguments: JSON.parse(fields.arguments) as unknown,
  };
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export interface ApprovalsProps {
  readonly setTimer: SetTimer;
  readonly now: () => number;
  /** 16 random lowercase hex characters. */
  readonly newId: () => string;
  /** Whether the agent that asked is still online (its token's record). */
  readonly online: (token: string) => boolean;
}

interface Held {
  readonly request: ApprovalRequest;
  /** The asking agent's token: its record, never sent anywhere. */
  readonly token: string;
  readonly cancel: () => void;
}

export class Approvals {
  private readonly pending = new Map<string, Held>();
  /** Expired ids, oldest first, each with when it is forgotten. */
  private readonly expired = new Map<string, () => void>();

  constructor(private readonly props: ApprovalsProps) {}

  /** Records a request (R12 (a)); `full` when 64 are pending (nothing recorded). */
  request(
    fields: Omit<ApprovalRequest, 'id' | 'sha256' | 'at' | 'expiresAt'>,
    token: string,
  ): { readonly ok: true; readonly request: ApprovalRequest } | { readonly ok: false; readonly full: true } {
    if (this.pending.size >= MAX_PENDING_APPROVALS) return { ok: false, full: true };
    const id = this.props.newId();
    if (!/^[0-9a-f]{16}$/.test(id) || this.pending.has(id) || this.expired.has(id))
      throw new Error(`approval id ${JSON.stringify(id)}: not 16 fresh lowercase hex characters`);
    const now = this.props.now();
    const request: ApprovalRequest = {
      ...fields,
      id,
      sha256: requestSha256(fields),
      at: new Date(now).toISOString(),
      expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString(),
    };
    const cancel = this.props.setTimer(() => {
      this.expire(id);
    }, APPROVAL_TTL_MS);
    this.pending.set(id, { request, token, cancel });
    return { ok: true, request };
  }

  private expire(id: string): void {
    if (!this.pending.delete(id)) return;
    if (this.expired.size >= MAX_EXPIRED_IDS) {
      const [oldest, forget] = present(this.expired.entries().next().value, 'the oldest expired approval id');
      forget();
      this.expired.delete(oldest);
    }
    const cancel = this.props.setTimer(() => this.expired.delete(id), APPROVAL_TTL_MS);
    this.expired.set(id, cancel);
  }

  /** A request, or why its id is refused (R12 (b)): first unknown or expired, then its agent gone. */
  read(
    id: string,
  ):
    | { readonly ok: true; readonly request: ApprovalRequest; readonly token: string }
    | { readonly ok: false; readonly reason: ApprovalRefusal } {
    const held = this.pending.get(id);
    if (held === undefined) return { ok: false, reason: this.expired.has(id) ? 'expired' : 'unknown' };
    if (!this.props.online(held.token)) return { ok: false, reason: 'agent_gone' };
    return { ok: true, request: held.request, token: held.token };
  }

  /** Removes the request for its approval, at once: a second take of the id finds it `unknown`. */
  take(id: string): void {
    const held = this.pending.get(id);
    if (held === undefined) return;
    held.cancel();
    this.pending.delete(id);
  }

  /**
   * The requests of agents a channel's stop ended (docs/plans/portal-demo-stop.md R2): each cancelled and removed, so
   * its id reads `unknown` from here. Another channel's are kept. Resolves with how many were dropped.
   */
  dropFor(tokens: ReadonlySet<string>): number {
    let dropped = 0;
    for (const [id, held] of this.pending) {
      if (!tokens.has(held.token)) continue;
      held.cancel();
      this.pending.delete(id);
      dropped += 1;
    }
    return dropped;
  }

  /** The daemon is stopping (R34): every timer cleared; pending requests end with the daemon. */
  stop(): void {
    for (const held of this.pending.values()) held.cancel();
    for (const forget of this.expired.values()) forget();
    this.pending.clear();
    this.expired.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
