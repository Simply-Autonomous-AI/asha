// The decision model's contract (docs/plans/decider-tool.md R12): what the daemon asks of it, whichever adapter it is
// handed — StrandsDecider, which runs strands-decider on the host, or a test's fake. Chosen only in
// productionDependencies (src/daemon/compose.ts).

import type { ToolFailureReason } from '../../shared/tools.js';

/** One question of a request, as strands-decider 0.1.0's `POST /v1/systemone` takes it (probe P6). */
export type StrandsQuestion =
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | {
      readonly type: 'noul';
      readonly instructions: string;
      readonly criteria: { readonly true: string; readonly false: string };
    };

/** A request: the text (`state`) and the questions asked of it, by name. */
export interface StrandsRequest {
  readonly state: string;
  readonly questions: Readonly<Record<string, StrandsQuestion>>;
}

/** One answer: a choice's top option and its confidence, or a yes/no's P(yes) (`noul`). */
export type StrandsAnswer =
  | { readonly type: 'choice'; readonly choice: string; readonly confidence: number }
  | { readonly type: 'noul'; readonly noul: number };

/** A 200's body, as far as the daemon reads it. */
export interface StrandsResponse {
  readonly answers: Readonly<Record<string, StrandsAnswer>>;
  /** The tokens of the prompt the model read: 4,096 or more, the model's window, means the text was cut (R8). */
  readonly inputTokens: number;
}

/** The reasons a decision can fail with (R8, R9, R11), each one of TOOL_FAILURE_REASONS. */
export type DeciderFailure = Extract<
  ToolFailureReason,
  'decider_busy' | 'decider_unavailable' | 'timeout' | 'input_too_large'
>;

/** What one call came to: the model's answers, or why there are none. */
export type DeciderOutcome =
  { readonly ok: true; readonly response: StrandsResponse } | { readonly ok: false; readonly reason: DeciderFailure };

/**
 * The decision model, run for the agents whose recipes select `decide` (R6–R9). `acquire` and `release` bracket each
 * such agent: the first acquire starts it, without waiting for it to be ready; the last release stops it. `decide`
 * queues one request (one at a time ever reaches the model, R8) and answers within its bound. `stopAll` is the daemon's
 * stop (R7).
 */
export interface Decider {
  /** An agent selecting `decide` is launching (R6): the first starts the decision model, unawaited. */
  acquire(): Promise<void>;
  /** That agent has gone, or its launch was rolled back (R6): the last stops the decision model. */
  release(): Promise<void>;
  /** One decision, answered within R8's 30,000 ms of its arrival. Never throws for an expected failure. */
  decide(request: StrandsRequest): Promise<DeciderOutcome>;
  /** Stops the decision model and answers every queued call `decider_unavailable` (R7); a second call awaits the first. */
  stopAll(): Promise<void>;
}

/** The decision model could not be installed, started, or used as the host is: names what and why. */
export class DeciderFailed extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeciderFailed';
  }
}

/**
 * A recipe selecting `decide` was launched while a part of the decision model is missing (R15a): refused before
 * anything starts, its message naming each missing path and the command that installs them. `classify` maps it to
 * `prerequisite`.
 */
export class DeciderNotInstalled extends Error {
  constructor(
    readonly recipeFile: string,
    readonly recipe: string,
    readonly missing: readonly string[],
  ) {
    super(
      `${recipeFile}: recipe ${recipe} selects decide, and the decision model is not installed (missing: ${missing.join(', ')}): run asha --install-decider`,
    );
    this.name = 'DeciderNotInstalled';
  }
}
