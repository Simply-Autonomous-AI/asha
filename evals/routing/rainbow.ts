// The rainbow supervisor's gather turn, measured without containers
// (docs/plans/collaborating-agents.md R7, A11): the supervisor of teams/rainbow/,
// with its recipe's prompt and full-text guidance, given the gather of its one
// call to the nine fact members — every answer `answered`, in request order —
// in nine fixed orders, each fact member first once. Expected in every order:
// one reply to the user whose text holds 4, 7, 1, 9, 3, 6, 2 in that order and
// neither 5 nor 8. Run with `node dist/evals/routing/run.js --rainbow <model>`.

import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import type { CallMark } from '../../src/shared/protocol.js';
import type { RoutingCase } from './cases.js';

/** The team whose supervisor the set measures. */
export const RAINBOW_TEAM = 'rainbow';
/** The member whose gather turn is measured, and its handle on a fresh channel. */
export const RAINBOW_SUPERVISOR = 'supervisor';
export const RAINBOW_SUPERVISOR_HANDLE = 'supervisor-1';

/** Each fact member's colour and number, in the rainbow's order and then the two colours outside it (the scenario's table). */
export const RAINBOW_FACTS: readonly (readonly [colour: string, n: number])[] = [
  ['red', 4],
  ['orange', 7],
  ['yellow', 1],
  ['green', 9],
  ['blue', 3],
  ['indigo', 6],
  ['violet', 2],
  ['pink', 5],
  ['brown', 8],
];

/** The user's request to supervisor-1, word for word (collaborating-agents, scenarios). */
export const RAINBOW_REQUEST = 'Which sequence of the numbers lists their colours in rainbow order?';

/** The numbers whose colours are in the rainbow, in the rainbow's order: the expected result. */
const RAINBOW_SEQUENCE: readonly number[] = [4, 7, 1, 9, 3, 6, 2];

/**
 * The expected reply: 4, 7, 1, 9, 3, 6, 2 in that order, each a whole number, and neither 5 nor 8 anywhere. The one
 * definition the routing set and the agent suite's checker (tests/agents/patterns/rainbow.ts) both use.
 */
const wordBoundary = (n: number): string => `\\b${String(n)}\\b`;
export const RAINBOW_REPLY = new RegExp(
  `^(?![\\s\\S]*\\b[58]\\b)[\\s\\S]*${RAINBOW_SEQUENCE.map(wordBoundary).join('[\\s\\S]*')}`,
);

/** The fact member's handle on a fresh channel. */
export const factHandle = (colour: string): string => `fact-${colour}-1`;

/** The question the gather records the supervisor as having asked each member: what it asked in every probed first turn (rainbow-probe, 3a6bfbe). */
const RAINBOW_QUESTION = 'What number and colour do you know?';

/** A fact member's answer as the gather carries it. */
const factAnswer = (colour: string, n: number): string => `The number ${String(n)} stands for the colour ${colour}.`;

/** The fact members' description, as list_agents reports it (teams/rainbow/fact-*.json). */
const FACT_DESCRIPTION = 'Knows one number and the colour it stands for.';

/**
 * The nine orders: each fact member first once, the other eight after it in handle order. Blue's is the handle order
 * itself, the order the supervisor asked in on every recorded run, so the order the gather really arrives in is one
 * of them; none keeps the rainbow's order. (Corrected 2026-09-29, the completion review's finding 3: the first set
 * rotated the rainbow's order, which kept the seven in rainbow order in three cases and left out the real order.)
 */
function rainbowOrders(): (readonly [string, number])[][] {
  const byHandle = [...RAINBOW_FACTS].sort(([a], [b]) => factHandle(a).localeCompare(factHandle(b)));
  return RAINBOW_FACTS.map((first) => [first, ...byHandle.filter((f) => f !== first)]);
}

/** The gather of one call to the nine, in `order`, every answer `answered`. */
function rainbowGather(order: readonly (readonly [string, number])[]): CallMark {
  return {
    id: 'call-1',
    role: 'gather',
    context: { from: 'user-1', text: RAINBOW_REQUEST },
    requests: order.map(([colour]) => ({ to: factHandle(colour), text: RAINBOW_QUESTION })),
    answers: order.map(([colour, n]) => ({
      from: factHandle(colour),
      outcome: 'answered',
      text: factAnswer(colour, n),
    })),
  };
}

/** A11's cases: one per order, named for the fact member answering first. */
export const RAINBOW_CASES: readonly RoutingCase[] = rainbowOrders().map((order) => {
  const [firstColour] = present(order[0], "the order's first entry");
  return {
    id: `rainbow-gather-${firstColour}-first`,
    checks: `Given the gather of the nine fact members' answers, ${factHandle(firstColour)} first, the supervisor replies to the user with 4, 7, 1, 9, 3, 6, 2 in that order and neither 5 nor 8.`,
    handle: RAINBOW_SUPERVISOR_HANDLE,
    // The roster is the channel's, whatever order the call asked in.
    others: RAINBOW_FACTS.map(([colour]) => factHandle(colour)).sort(byCodeUnit),
    describe: Object.fromEntries(
      RAINBOW_FACTS.map(([colour]) => [
        factHandle(colour),
        { recipe: `fact-${colour}`, description: FACT_DESCRIPTION },
      ]),
    ),
    from: 'asha',
    to: RAINBOW_SUPERVISOR_HANDLE,
    call: rainbowGather(order),
    text: `Answers to ${RAINBOW_SUPERVISOR_HANDLE}'s call: 9 answered.`,
    expect: { tool: 'reply', to: ['user'], text: RAINBOW_REPLY },
  };
});
