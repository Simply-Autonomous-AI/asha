// The memory module's public surface: recall (the read components) and
// remember (the async write components) for all four tiers, each scoped to one
// user on one channel. The agent graph calls recall before the model and
// remember after it has answered (docs/architecture/memory.html).

import type { ModelClient } from '../../../../src/agent-sdk/index.js';
import { present } from '../../../../src/shared/assert-present.js';
import { assemble, type Budget, type Recalled } from './assemble.js';
import type { MemoryCache } from './cache.js';
import { extractFacts, extractProcedures } from './extract.js';
import { cosine, search } from './relevance.js';
import { currentSession, episodeText, slide } from './session.js';
import type { Embedder, Memory, Scope, SearchableDoc, SessionDoc, Turn } from './types.js';

export { assemble } from './assemble.js';
export { MemoryCache } from './cache.js';
export { MemoryFileInvalid, MemoryStore, scopeKey } from './store.js';
export { EmbeddingFailed, harnessEmbedder } from './harness-embedder.js';
export type { Embedder, Scope, Turn } from './types.js';

export interface MemoryPolicy {
  /** Session: turns this far apart (at most) belong to one session. */
  readonly sessionIdleMs: number;
  /** Session: how many of the current session's latest turns are replayed. */
  readonly sessionWindow: number;
  /** How many memories each searchable tier may recall. */
  readonly topK: { readonly episodes: number; readonly facts: number; readonly procedures: number };
  /** Hard cutoff on cosine similarity; below it nothing is recalled. */
  readonly minScore: number;
  /** A new fact or procedure this similar to an existing one is a duplicate and is not saved. */
  readonly duplicateScore: number;
  /** Caps: past these, the oldest memories of a tier are dropped. */
  readonly caps: { readonly episodes: number; readonly facts: number; readonly procedures: number };
  readonly budget: Budget;
}

export const DEFAULT_POLICY: MemoryPolicy = {
  sessionIdleMs: 30 * 60_000,
  sessionWindow: 8,
  topK: { episodes: 4, facts: 6, procedures: 4 },
  minScore: 0.3,
  duplicateScore: 0.95,
  caps: { episodes: 500, facts: 200, procedures: 100 },
  budget: { chars: 4800, shares: { episodes: 0.35, facts: 0.35, procedures: 0.3 }, perItem: 480 },
};

export interface AgentMemoryProps {
  readonly cache: MemoryCache;
  readonly embedder: Embedder;
  readonly model: ModelClient;
  readonly clock: () => Date;
  readonly policy: MemoryPolicy;
  readonly newId: () => string;
  /**
   * A background write failed; it is reported here (never swallowed) and the turn's memory is incomplete. Each tier's
   * step fails on its own: it is reported on its own, once for each that failed, with its own error, and the write
   * carries on. A session whose document cannot be loaded or updated is reported, and the turn is still an episode; an
   * episodic document that cannot be loaded, or an episode that cannot be embedded, is reported, and the turn's facts
   * and procedures are still extracted; a fact or procedure tier whose document cannot be loaded, or whose extraction or
   * save fails, is reported, and the other tier is still saved. A malformed tier file is not reported here: the store
   * reports it (MemoryStoreProps.onMalformed) and overwrites it with the tier's empty document.
   */
  readonly onWriteFailed: (scope: Scope, error: unknown) => void;
}

/** What recall found, ready for the model. */
export interface Recall extends Recalled {
  /** The current session's latest turns, oldest first, to replay as chat turns. */
  readonly history: readonly Turn[];
  /** The `# Memory` section for the agent's per-agent block, at the start of the incoming message ('' when nothing was recalled; docs/plans/prompt-prefix.md R7). */
  readonly context: string;
}

const scopeId = (scope: Scope): string => `${scope.channel}\u0000${scope.user}`;

export class AgentMemory {
  /** Per scope, the last remember() queued; the next one chains onto it and recall waits for it. */
  private readonly writing = new Map<string, Promise<void>>();

  constructor(private readonly props: AgentMemoryProps) {}

  /** The read components of every tier, for one incoming message. Waits for this user's pending writes first. */
  async recall(scope: Scope, text: string): Promise<Recall> {
    await this.settled(scope);
    const { cache, policy } = this.props;
    const now = this.props.clock();
    const [session, episodic, semantic, procedural, [query]] = await Promise.all([
      cache.get<SessionDoc>(scope, 'session'),
      cache.get<SearchableDoc>(scope, 'episodic'),
      cache.get<SearchableDoc>(scope, 'semantic'),
      cache.get<SearchableDoc>(scope, 'procedural'),
      this.props.embedder.embed([text], 'query'),
    ]);
    const history = currentSession(session.turns, now, policy.sessionIdleMs).slice(-policy.sessionWindow);
    const shown = new Set(history.map((t) => t.id));
    const queryVector = present(query, "the incoming message's query embedding");
    const recalled: Recalled = {
      // An episode that is also in the replayed history would say the same thing twice.
      episodes: search(
        episodic.records.filter((r) => !shown.has(r.id)),
        queryVector,
        policy.topK.episodes,
        policy.minScore,
      ),
      facts: search(semantic.records, queryVector, policy.topK.facts, policy.minScore),
      procedures: search(procedural.records, queryVector, policy.topK.procedures, policy.minScore),
    };
    return { ...recalled, history, context: assemble(recalled, policy.budget) };
  }

  /**
   * The async write components of every tier, for one answered turn. Queued
   * behind this user's earlier writes and not awaited by the agent: it returns
   * the promise so callers (and tests) can, and failures go to onWriteFailed:
   * each tier's from inside the write, which then carries on (write), and, once,
   * a write that cannot go on at all, such as one for a scope with no user.
   */
  remember(scope: Scope, turn: Turn): Promise<void> {
    const key = scopeId(scope);
    const run = (this.writing.get(key) ?? Promise.resolve())
      .then(() => this.write(scope, turn))
      .catch((error: unknown) => {
        this.props.onWriteFailed(scope, error);
      });
    this.writing.set(key, run);
    return run;
  }

  /** Resolves once this user's queued writes have finished and their files are saved (or failed and been reported). */
  async settled(scope: Scope): Promise<void> {
    await this.writing.get(scopeId(scope));
    await this.props.cache.settled(scope);
  }

  private async write(scope: Scope, turn: Turn): Promise<void> {
    const { cache, policy, model } = this.props;
    // Session: add the turn, keep the window; what slides out becomes episodic. A turn the session already holds is
    // not added again, as the episodic tier skips one it holds, so recall never replays an exchange twice. A session
    // whose document cannot be loaded or updated costs only the session tier: it is reported once, with its own error,
    // and the write carries on with no overflow known, so the turn itself is the only episode (the owner, 2026-10-11,
    // record memory-unreadable-session-episodic, option (a)).
    let slid: Turn[] = [];
    const overflow = await cache
      .update<SessionDoc>(scope, 'session', (doc) => {
        const held = doc.turns.some((t) => t.id === turn.id);
        const next = slide(
          held ? doc.turns : [...doc.turns, turn],
          new Date(turn.ts),
          policy.sessionIdleMs,
          policy.sessionWindow,
        );
        slid = next.overflow;
        return { ...doc, turns: next.keep };
      })
      .then(
        () => slid,
        (error: unknown): Turn[] => {
          this.props.onWriteFailed(scope, error);
          return [];
        },
      );
    // Every turn is also an episode from the start, so a later session finds it; the history filter
    // in recall keeps it from showing twice while it is still in the window. A failure in the episodic tier costs only
    // that tier: it is reported once, with its own error, and the turn's facts and procedures are still extracted and
    // saved below (addEpisodes).
    const episodes = [turn, ...overflow].filter((t, i, all) => all.findIndex((u) => u.id === t.id) === i);
    await this.addEpisodes(scope, episodes).catch((error: unknown) => {
      this.props.onWriteFailed(scope, error);
    });
    // Semantic and procedural: each tier on its own. Its document is loaded, its items are extracted by the model
    // (shown what the tier already knows), then de-duplicated, embedded and saved, and every step settles per tier: a
    // failure costs only its own tier, is reported once with its own error, and the other tier's items are still
    // saved. That holds for a failed extraction or save (the owner, 2026-10-11, record
    // memory-extraction-partial-failure, option (a)), and for a document that cannot be loaded, which is what the
    // tier's extraction is shown and its save adds to (docs/architecture/memory.md, Failures: a turn's two
    // extractions, and their saves, are independent); a tier whose document could not be loaded asks the model
    // nothing. Both documents are loaded before either extraction starts, so the two requests reach the model in one
    // order, facts first. The failures are reported before the saves, so a save that then throws cannot hide them.
    const [semantic, procedural] = await Promise.allSettled([
      cache.get<SearchableDoc>(scope, 'semantic'),
      cache.get<SearchableDoc>(scope, 'procedural'),
    ]);
    const [facts, procedures] = await Promise.allSettled([
      extractFor(semantic, extractFacts, model, turn, scope.user),
      extractFor(procedural, extractProcedures, model, turn, scope.user),
    ]);
    for (const extracted of [facts, procedures])
      if (extracted.status === 'rejected') this.props.onWriteFailed(scope, extracted.reason);
    // Each tier's outcome depends only on its own reply (record memory-extraction-partial-failure, option (a)): a tier
    // whose save fails is reported with its own error, and the other tier is still saved.
    const saves: ReadonlyArray<readonly ['semantic' | 'procedural', PromiseSettledResult<string[]>, number]> = [
      ['semantic', facts, policy.caps.facts],
      ['procedural', procedures, policy.caps.procedures],
    ];
    for (const [tier, extracted, cap] of saves) {
      if (extracted.status !== 'fulfilled') continue;
      await this.addDistinct(scope, tier, extracted.value, turn.ts, cap).catch((error: unknown) => {
        this.props.onWriteFailed(scope, error);
      });
    }
  }

  /**
   * The episodic tier's part of a write: the episodes it does not hold yet, embedded and added. It fails, for write() to
   * report, when the tier's document cannot be loaded (the owner, 2026-10-11, record memory-unreadable-session-episodic,
   * option (a)) or the episodes cannot be embedded (record memory-episode-failure-extraction, option (a)); either way it
   * costs only this tier, and a turn not stored as an episode becomes one once it slides out of the session window.
   */
  private async addEpisodes(scope: Scope, episodes: readonly Turn[]): Promise<void> {
    const { cache, embedder, policy } = this.props;
    const episodic = await cache.get<SearchableDoc>(scope, 'episodic');
    const known = new Set(episodic.records.map((r) => r.id));
    const fresh = episodes.filter((t) => !known.has(t.id));
    if (fresh.length === 0) return;
    const texts = fresh.map((t) => episodeText(t, scope.user));
    const vectors = await embedder.embed(texts, 'document');
    const added: Memory[] = fresh.map((t, i) => ({
      id: t.id,
      ts: t.ts,
      text: present(texts[i], `the episode text at index ${String(i)}`),
      embedding: present(vectors[i], `the episode embedding at index ${String(i)}`),
    }));
    await cache.update<SearchableDoc>(scope, 'episodic', (doc) => ({
      ...doc,
      records: capped([...doc.records, ...added], policy.caps.episodes),
    }));
  }

  /** Adds the texts that are neither identical to nor as similar as `duplicateScore` to anything already in the tier. */
  private async addDistinct(
    scope: Scope,
    tier: 'semantic' | 'procedural',
    texts: readonly string[],
    ts: string,
    cap: number,
  ): Promise<void> {
    if (texts.length === 0) return;
    const { cache, embedder, policy } = this.props;
    const vectors = await embedder.embed(texts, 'document');
    await cache.update<SearchableDoc>(scope, tier, (doc) => {
      const records = [...doc.records];
      texts.forEach((text, i) => {
        const normal = normalise(text);
        const vector = present(vectors[i], `the added text's embedding at index ${String(i)}`);
        const duplicate = records.some(
          (r) => normalise(r.text) === normal || cosine(r.embedding, vector) >= policy.duplicateScore,
        );
        if (!duplicate) records.push({ id: this.props.newId(), ts, text, embedding: vector });
      });
      return { ...doc, records: capped(records, cap) };
    });
  }
}

/**
 * A text as the de-duplication rule compares it: case, punctuation and Unicode form set aside, and every letter,
 * combining mark and digit of any script kept. The marks matter: Devanagari, for one, writes vowels with them, so
 * dropping them would make "बेटा" (son) and "बेटी" (daughter) one word.
 */
const normalise = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();

/**
 * A searchable tier's extraction, shown the texts its document already holds. A tier whose document could not be
 * loaded fails with the load's own error, and the model is asked nothing for it.
 */
async function extractFor(
  loaded: PromiseSettledResult<SearchableDoc>,
  extract: (model: ModelClient, known: readonly string[], turn: Turn, user: string) => Promise<string[]>,
  model: ModelClient,
  turn: Turn,
  user: string,
): Promise<string[]> {
  if (loaded.status === 'rejected') throw loaded.reason;
  return extract(
    model,
    loaded.value.records.map((r) => r.text),
    turn,
    user,
  );
}

/** Keeps the newest `cap` memories. */
function capped(records: readonly Memory[], cap: number): Memory[] {
  return [...records].sort((a, b) => a.ts.localeCompare(b.ts)).slice(-cap);
}
