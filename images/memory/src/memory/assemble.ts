// Puts recalled memory into the model's context. Each searchable tier gets a
// reserved share of the budget, so one tier can never crowd out another
// (a greedy budget can starve a tier).
// Session turns are not here: they are replayed as real chat turns.

import type { Scored } from './relevance.js';

export interface Recalled {
  readonly episodes: readonly Scored[];
  readonly facts: readonly Scored[];
  readonly procedures: readonly Scored[];
}

export interface Budget {
  /** Characters for all recalled memory (about 4 per token). */
  readonly chars: number;
  /** Each searchable tier's reserved share of `chars`; they must sum to at most 1. */
  readonly shares: { readonly episodes: number; readonly facts: number; readonly procedures: number };
  /** No single memory is longer than this; a longer one is cut, and marked. */
  readonly perItem: number;
}

function section(title: string, items: readonly Scored[], budget: number, perItem: number): string {
  const lines: string[] = [];
  let used = 0;
  for (const { memory } of items) {
    const text = memory.text.length > perItem ? `${memory.text.slice(0, perItem - 1)}…` : memory.text;
    const line = `- [${memory.ts.slice(0, 16).replace('T', ' ')}] ${text.replace(/\n/g, ' / ')}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length;
  }
  return lines.length === 0 ? '' : `## ${title}\n${lines.join('\n')}`;
}

/** The memory section for the agent's per-agent block, at the start of the incoming message (docs/plans/prompt-prefix.md R7); empty when nothing was recalled. */
export function assemble(recalled: Recalled, budget: Budget): string {
  const { shares } = budget;
  if (shares.episodes + shares.facts + shares.procedures > 1)
    throw new Error('memory budget shares add up to more than 1');
  const parts = [
    section('What you know about this user', recalled.facts, budget.chars * shares.facts, budget.perItem),
    section('Procedures that worked before', recalled.procedures, budget.chars * shares.procedures, budget.perItem),
    section('Earlier conversations with this user', recalled.episodes, budget.chars * shares.episodes, budget.perItem),
  ].filter((p) => p !== '');
  return parts.length === 0
    ? ''
    : [
        '# Memory',
        'What you remember about the user you are talking to. Use it when it helps; never mention these notes.',
        ...parts,
      ].join('\n\n');
}
