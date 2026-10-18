// A conversation's budget (docs/plans/patterns-phase-3.md R15): budgetProblem, what the daemon's server and the CLI
// refuse in a request's `budget` — its rule text, the 400 a client sees, for each wrong shape and value, and nothing for
// a right one — and budgetOfText, the budget the user typed as `posts=` and `tokens=`, each refusal naming its value.

import { describe, expect, it } from 'vitest';

import { BUDGET_POSTS_MAX, BUDGET_TOKENS_MAX, budgetOfText, budgetProblem } from '../../src/shared/protocol.js';

const RULE = 'budget is {"posts": <1–32>, "tokens": <1–1000000>}, each a whole number, at least one of them';

describe("a request's budget (patterns-phase-3 R15)", () => {
  it('is the 32 posts and the million tokens the rule text names', () => {
    expect([BUDGET_POSTS_MAX, BUDGET_TOKENS_MAX]).toEqual([32, 1_000_000]);
  });

  it('refuses, with the rule, anything but an object of posts and tokens', () => {
    for (const value of [
      undefined,
      null,
      'posts',
      3,
      true,
      [],
      [{ posts: 1 }],
      {},
      { posts: 1, other: 2 },
      { other: 1 },
    ])
      expect(budgetProblem(value), JSON.stringify(value)).toBe(RULE);
  });

  it('refuses, with the rule, a posts or tokens that is not a whole number in its range', () => {
    for (const posts of [0, -1, 1.5, BUDGET_POSTS_MAX + 1, '3', Number.NaN, Number.POSITIVE_INFINITY, null])
      expect(budgetProblem({ posts }), `posts ${String(posts)}`).toBe(RULE);
    for (const tokens of [0, 2.5, BUDGET_TOKENS_MAX + 1, '10', null])
      expect(budgetProblem({ tokens }), `tokens ${String(tokens)}`).toBe(RULE);
    expect(budgetProblem({ posts: 1, tokens: 0 })).toBe(RULE);
    expect(budgetProblem({ posts: 0, tokens: 1 })).toBe(RULE);
  });

  it('accepts each alone and both together, at the ends of their ranges', () => {
    for (const value of [
      { posts: 1 },
      { posts: BUDGET_POSTS_MAX },
      { tokens: 1 },
      { tokens: BUDGET_TOKENS_MAX },
      { posts: 2, tokens: 500 },
    ])
      expect(budgetProblem(value), JSON.stringify(value)).toBeUndefined();
  });
});

describe('a budget the user typed (patterns-phase-3 R15)', () => {
  it('is undefined when neither is given, and each number given, alone or both', () => {
    expect(budgetOfText({})).toBeUndefined();
    expect(budgetOfText({ posts: '4' })).toEqual({ posts: 4 });
    expect(budgetOfText({ tokens: '1000000' })).toEqual({ tokens: 1_000_000 });
    expect(budgetOfText({ posts: '32', tokens: '1' })).toEqual({ posts: 32, tokens: 1 });
  });

  it('names the first value that is not a whole number in its range, with no sign or leading zero', () => {
    expect(budgetOfText({ posts: '0' })).toBe('posts= is a whole number from 1 to 32, not 0');
    expect(budgetOfText({ posts: '33' })).toBe('posts= is a whole number from 1 to 32, not 33');
    expect(budgetOfText({ posts: '04' })).toBe('posts= is a whole number from 1 to 32, not 04');
    expect(budgetOfText({ posts: '+4' })).toBe('posts= is a whole number from 1 to 32, not +4');
    expect(budgetOfText({ posts: '1.5' })).toBe('posts= is a whole number from 1 to 32, not 1.5');
    expect(budgetOfText({ tokens: '1000001' })).toBe('tokens= is a whole number from 1 to 1,000,000, not 1000001');
    expect(budgetOfText({ tokens: '12345678' })).toBe('tokens= is a whole number from 1 to 1,000,000, not 12345678');
    expect(budgetOfText({ posts: 'x', tokens: 'y' })).toBe('posts= is a whole number from 1 to 32, not x');
    expect(budgetOfText({ posts: '2', tokens: '' })).toBe('tokens= is a whole number from 1 to 1,000,000, not ');
  });
});
