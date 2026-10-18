// The shapes memory is made of. One document per (scope, tier), rewritten
// whole (docs/architecture/memory.html).

/**
 * Whose memory: a user on a channel. User IDs are unique only within a
 * channel, so a scope is always both. It comes from the harness-set `user`
 * on each message and is passed as a parameter to every call — never stored
 * on an object.
 */
export interface Scope {
  readonly channel: string;
  readonly user: string;
}

export type Tier = 'session' | 'episodic' | 'semantic' | 'procedural';
export const TIERS: readonly Tier[] = ['session', 'episodic', 'semantic', 'procedural'];

/** One exchange: what came in and what the agent answered. The session tier holds these. */
export interface Turn {
  readonly id: string;
  /** ISO-8601, when the agent answered. */
  readonly ts: string;
  readonly conversation: string;
  /** Who wrote the incoming message: the user, or an agent that passed on the user's task. */
  readonly from: string;
  readonly input: string;
  readonly response: string;
}

/** A searchable memory: an episode (a past turn), a fact, or a procedure. */
export interface Memory {
  readonly id: string;
  readonly ts: string;
  readonly text: string;
  readonly embedding: readonly number[];
}

export interface SessionDoc {
  readonly schemaVersion: 1;
  readonly tier: 'session';
  readonly updatedAt: string;
  readonly turns: readonly Turn[];
}

export interface SearchableDoc {
  readonly schemaVersion: 1;
  readonly tier: Exclude<Tier, 'session'>;
  readonly updatedAt: string;
  readonly records: readonly Memory[];
}

export type TierDoc = SessionDoc | SearchableDoc;

/** Turns text into vectors. Query and document embeddings differ for instruction-tuned embedders. */
export interface Embedder {
  embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<number[][]>;
}
