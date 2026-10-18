// Recall by meaning: cosine similarity between the incoming message and each
// memory, over vectors held in memory, with a hard cutoff. Nothing below
// `minScore` is recalled — no fallback to "the most recent" (relevance-gated
// recall; docs/architecture/memory.html).

import { present } from '../../../../src/shared/assert-present.js';
import type { Memory } from './types.js';

export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length)
    throw new Error(`cosine of vectors of different sizes: ${String(a.length)} and ${String(b.length)}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    const ai = present(a[i], `a[${String(i)}]`);
    const bi = present(b[i], `b[${String(i)}]`);
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface Scored {
  readonly memory: Memory;
  readonly score: number;
}

/** The best `k` memories scoring at least `minScore`, best first; ties go to the newer. */
export function search(memories: readonly Memory[], query: readonly number[], k: number, minScore: number): Scored[] {
  return memories
    .map((memory) => ({ memory, score: cosine(memory.embedding, query) }))
    .filter((s) => s.score >= minScore)
    .sort((a, b) => b.score - a.score || b.memory.ts.localeCompare(a.memory.ts))
    .slice(0, k);
}
