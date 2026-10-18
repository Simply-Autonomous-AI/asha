// The one trace ID of a conversation (docs/plans/otel-traces.md). Its own module since docs/plans/portal.md R15:
// it needs node:crypto, and protocol.ts, which the portal's page loads, imports no node: module.

import { createHash } from 'node:crypto';

/**
 * The one trace ID of a conversation, shared by every span in it — the
 * agents' and the daemon's: the first 32 hex characters of
 * sha256("asha.trace\0" + conversation). The only implementation; both
 * sides import it.
 */
export function traceIdFor(conversation: string): string {
  const id = createHash('sha256').update(`asha.trace\0${conversation}`, 'utf8').digest('hex').slice(0, 32);
  // Invalid in W3C trace context; a 2^-128 event, but never sent if it happens.
  if (/^0+$/.test(id)) throw new Error(`traceIdFor(${JSON.stringify(conversation)}) is all zeros`);
  return id;
}
