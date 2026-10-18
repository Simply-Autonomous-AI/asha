// One channel's blackboard (docs/plans/agent-tools.md R10): an append-only list
// of entries the channel's agents read when they choose, waking no one. It
// lives in the daemon's memory for as long as the daemon keeps the channel,
// bounded at 256 entries, each small enough that one read of it alone is at
// most 8 KiB of JSON (so at most 2 MiB in all). An entry's author
// is the poster's handle, which the caller takes from the agent's token —
// never from the request. A team that persists its board (docs/plans/agent-persistence.md
// R14) resumes it: its entries keep their ids and sessions, the ids continue, and
// its session is one more than the saved one's.

import {
  BLACKBOARD_MAX_ENTRIES,
  BLACKBOARD_MAX_READ_BYTES,
  type BlackboardEntry,
  type BlackboardReadResponse,
  type BlackboardRefusal,
} from '../../shared/protocol.js';
import type { Logger } from '../log.js';

export interface BlackboardProps {
  readonly channel: string;
  readonly clock: () => Date;
  readonly logger: Logger;
}

/** What a persisted board saves and resumes from (R14): its session and its entries. */
export interface BoardSnapshot {
  readonly session: number;
  readonly entries: readonly BlackboardEntry[];
}

export type BlackboardPostResult =
  { readonly ok: true; readonly entry: BlackboardEntry } | { readonly ok: false; readonly reason: BlackboardRefusal };

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

export class Blackboard {
  private readonly entries: BlackboardEntry[];
  private readonly session: number;

  constructor(
    private readonly props: BlackboardProps,
    resumed?: BoardSnapshot,
  ) {
    this.entries = resumed === undefined ? [] : [...resumed.entries];
    this.session = resumed === undefined ? 1 : resumed.session + 1;
  }

  /** A board resumed from saved state: the next session, the saved entries (R14). */
  static resumed(props: BlackboardProps, saved: BoardSnapshot): Blackboard {
    return new Blackboard(props, saved);
  }

  /** The entries after `since` (every entry when 0), in order, as many as keep the answer's JSON within 8 KiB; `more` when some were left out. */
  read(since: number): BlackboardReadResponse {
    const after = this.entries.filter((e) => e.id > since);
    const entries: BlackboardEntry[] = [];
    for (const entry of after) {
      // Measured with `more: false`, the longer of the two answers it can end in ("false" is a byte longer).
      if (jsonBytes({ entries: [...entries, entry], more: false }) > BLACKBOARD_MAX_READ_BYTES) break;
      entries.push(entry);
    }
    return { entries, more: entries.length < after.length };
  }

  /** Appends one entry by `author`, or refuses it with nothing stored. */
  post(author: string, text: string): BlackboardPostResult {
    if (text.trim() === '') return { ok: false, reason: 'invalid_arguments' };
    const size = Buffer.byteLength(text, 'utf8');
    const entry: BlackboardEntry = {
      id: (this.entries.at(-1)?.id ?? 0) + 1,
      author,
      ts: this.props.clock().toISOString(),
      text,
      session: this.session,
    };
    // Refused unless a read of this entry alone fits 8 KiB of JSON; text over 8 KiB never does.
    if (size > BLACKBOARD_MAX_READ_BYTES || jsonBytes({ entries: [entry], more: false }) > BLACKBOARD_MAX_READ_BYTES)
      return { ok: false, reason: 'entry_too_large' };
    if (this.full()) return { ok: false, reason: 'blackboard_full' };
    this.entries.push(entry);
    // Never the text: it is the agents' content.
    this.props.logger.info('blackboard.posted', { channel: this.props.channel, author, id: entry.id, size });
    return { ok: true, entry };
  }

  /** At its bound of 256 entries: every later post is refused blackboard_full. */
  full(): boolean {
    return this.entries.length >= BLACKBOARD_MAX_ENTRIES;
  }

  /** What a checkpoint saves (R14). */
  snapshot(): BoardSnapshot {
    return { session: this.session, entries: [...this.entries] };
  }
}
