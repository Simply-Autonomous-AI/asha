// The session tier. In asha each `./asha message=…` is its own conversation,
// usually one turn, so a session is time-bounded (docs/architecture/memory.html): a user's
// turns with this agent that follow each other with gaps no longer than
// `idleMs`. The session tier shows the last `window` turns of the current
// session; every other turn belongs in the episodic tier.

import { present } from '../../../../src/shared/assert-present.js';
import type { Turn } from './types.js';

/** The turns of the session that is current at `now`, oldest first. */
export function currentSession(turns: readonly Turn[], now: Date, idleMs: number): Turn[] {
  const sorted = [...turns].sort((a, b) => a.ts.localeCompare(b.ts));
  const session: Turn[] = [];
  let after = now.getTime();
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const turn = present(sorted[i], `sorted[${String(i)}]`);
    const at = Date.parse(turn.ts);
    if (after - at > idleMs) break;
    session.unshift(turn);
    after = at;
  }
  return session;
}

/**
 * Splits turns (including the one just added) into what the session tier
 * keeps — the last `window` turns of the current session — and what moves to
 * the episodic tier: everything else.
 */
export function slide(
  turns: readonly Turn[],
  now: Date,
  idleMs: number,
  window: number,
): { keep: Turn[]; overflow: Turn[] } {
  const keep = currentSession(turns, now, idleMs).slice(-window);
  const kept = new Set(keep.map((t) => t.id));
  return { keep, overflow: turns.filter((t) => !kept.has(t.id)).sort((a, b) => a.ts.localeCompare(b.ts)) };
}

/**
 * Who wrote a turn's input, as every frame of a remembered turn names them — its episode, its replay and its
 * extraction: the user, or the agent that passed on the user's task (the owner, 2026-10-12, record
 * memory-delegated-task-replay, option (a)).
 */
export function writerOf(turn: Turn, user: string): string {
  return turn.from === user ? 'The user' : `Agent ${turn.from}, for the user,`;
}

/** How a turn reads as an episode, in the agent's own voice. */
export function episodeText(turn: Turn, user: string): string {
  return `${writerOf(turn, user)} wrote: ${turn.input}\nI answered: ${turn.response}`;
}
