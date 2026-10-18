// The in-memory cache in front of the store (kept simple because one process
// owns the files). A document is loaded on first
// use and kept; a change is applied to the cached copy at once and saved in
// the background; saves of one file run one after another, in order. `settled`
// lets a reader wait for a scope's pending saves — read-your-writes.

import type { MemoryStore } from './store.js';
import { scopeKey } from './store.js';
import type { Scope, Tier, TierDoc } from './types.js';

export interface MemoryCacheProps {
  readonly store: MemoryStore;
  readonly clock: () => Date;
  /**
   * A background save failed. It is reported here; the document stays cached until a later save of it succeeds, and
   * the next save of the file writes the whole document again.
   */
  readonly onSaveFailed: (scope: Scope, tier: Tier, error: unknown) => void;
  /**
   * Bound on cached documents; the least recently used ones with no save pending, and whose last save did not fail,
   * are dropped past it. A document an update has started on counts as one with a save pending: its change is applied
   * to the cached copy and saved there. One whose last save failed is kept until a later save of it succeeds, so a
   * change reported as unsaved is never then lost to the bound (the owner, 2026-10-11, record memory-cache-failed-save,
   * option (a)); while saves keep failing, the cache may hold more than maxDocs.
   */
  readonly maxDocs: number;
}

interface Entry {
  doc: TierDoc;
  /** The last save queued for this file; saves chain onto it. */
  tail: Promise<void>;
  pending: number;
  /** The last save of this file failed: the cached copy holds changes the file does not. */
  unsaved: boolean;
}

export class MemoryCache {
  private readonly entries = new Map<string, Entry>();
  private readonly loading = new Map<string, Promise<Entry>>();
  /**
   * Per document, updates started but not yet queued for saving (still loading or changing it). settled() waits for
   * them, and the bound never drops their document, so each change lands on the one cached copy and its line of saves.
   */
  private readonly starting = new Map<string, Set<Promise<unknown>>>();

  constructor(private readonly props: MemoryCacheProps) {}

  private key(scope: Scope, tier: Tier): string {
    return `${scopeKey(scope)}/${tier}`;
  }

  private async entry(scope: Scope, tier: Tier): Promise<Entry> {
    const key = this.key(scope, tier);
    const hit = this.entries.get(key);
    if (hit !== undefined) {
      // Most recently used goes last.
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const inflight = this.loading.get(key);
    if (inflight !== undefined) return inflight;
    const load = (async () => {
      const doc = await this.props.store.read(scope, tier, this.props.clock().toISOString());
      const entry: Entry = { doc, tail: Promise.resolve(), pending: 0, unsaved: false };
      this.entries.set(key, entry);
      this.evict();
      return entry;
    })();
    this.loading.set(key, load);
    try {
      return await load;
    } finally {
      this.loading.delete(key);
    }
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.props.maxDocs) return;
      if (entry.pending === 0 && !entry.unsaved && !this.starting.has(key)) this.entries.delete(key);
    }
  }

  async get<D extends TierDoc>(scope: Scope, tier: D['tier']): Promise<D> {
    return (await this.entry(scope, tier)).doc as D;
  }

  /** Changes the document now and saves it in the background. Returns the new document. */
  update<D extends TierDoc>(scope: Scope, tier: D['tier'], change: (doc: D) => D): Promise<D> {
    // Registered before any await, so settled() called right after this also waits for it, and no load can drop the
    // document before the change is applied to it.
    const key = this.key(scope, tier);
    const set = this.starting.get(key) ?? new Set<Promise<unknown>>();
    this.starting.set(key, set);
    const run = this.apply(scope, tier, change);
    set.add(run);
    const done = (): void => {
      set.delete(run);
      if (set.size === 0) this.starting.delete(key);
    };
    run.then(done, done);
    return run;
  }

  private async apply<D extends TierDoc>(scope: Scope, tier: D['tier'], change: (doc: D) => D): Promise<D> {
    const entry = await this.entry(scope, tier);
    const next = { ...change(entry.doc as D), updatedAt: this.props.clock().toISOString() } as D;
    entry.doc = next;
    entry.pending += 1;
    // Each save writes the whole document, so the one that succeeds after a failure leaves nothing unsaved.
    entry.tail = entry.tail
      .then(() => this.props.store.write(scope, entry.doc))
      .then(
        () => {
          entry.unsaved = false;
        },
        (error: unknown) => {
          entry.unsaved = true;
          this.props.onSaveFailed(scope, tier, error);
        },
      )
      .finally(() => {
        entry.pending -= 1;
      });
    return next;
  }

  /** Resolves once every save queued so far for this scope has finished (or failed and been reported). */
  async settled(scope: Scope): Promise<void> {
    const prefix = `${scopeKey(scope)}/`;
    const starting = (): Promise<unknown>[] =>
      [...this.starting].filter(([k]) => k.startsWith(prefix)).flatMap(([, runs]) => [...runs]);
    // First every update still loading or changing its document (it will queue a save), then every queued save.
    for (let runs = starting(); runs.length > 0; runs = starting()) await Promise.allSettled(runs);
    await Promise.all([...this.entries].filter(([k]) => k.startsWith(prefix)).map(([, e]) => e.tail));
  }
}
