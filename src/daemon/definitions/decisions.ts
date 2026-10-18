// A recipe's `decisions` (docs/plans/decider-tool.md R10): the questions its agent may put to the decision model
// through the `decide` tool, each a choice among named options or a set of yes/no checks, with the threshold the code
// decides by. The model supplies only a decision's name and the text; the question, the options and the thresholds
// are the recipe's ("the model classifies, the code decides"). Validated here, once, where the recipe enters.

/** A decision's name, an option's name and a check's name: a lower-case identifier of at most 32 characters (R10). */
const DECISION_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** The answer R11 reserves for a choice below its `minConfidence`: no option may take it. */
const UNSURE = 'unsure';

/** R10's bounds. */
const DECISIONS_MAX = 8;
const QUESTION_MAX_CHARS = 300;
const MEANING_MAX_CHARS = 200;
/** The model's 24 option slots (`num_slots`, probe P2): a choice of more is answered over slots that do not exist. */
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 24;
const CHECKS_MAX = 8;

/** One of N: the top option, or `unsure` when its confidence is below `minConfidence`. */
interface ChoiceDecision {
  readonly kind: 'choice';
  readonly question: string;
  /** Option name to its meaning, in the recipe's order. */
  readonly options: Readonly<Record<string, string>>;
  readonly minConfidence: number;
}

/** One yes/no question of a set of checks, with what yes and no mean. */
interface Check {
  readonly question: string;
  readonly yes: string;
  readonly no: string;
}

/** Yes only when every check's P(yes) is at least `yesAt`; the others are named as missing, in the recipe's order. */
interface ChecksDecision {
  readonly kind: 'checks';
  readonly checks: Readonly<Record<string, Check>>;
  readonly yesAt: number;
}

export type Decision = ChoiceDecision | ChecksDecision;

/** Parses `decisions`; every failure is `fail(<problem naming the field>)`. */
export function parseDecisions(raw: unknown, fail: (problem: string) => Error): Readonly<Record<string, Decision>> {
  const entries = namedEntries(raw, 'decisions', 1, DECISIONS_MAX, 'decisions', fail);
  const out: Record<string, Decision> = {};
  for (const [name, value] of entries) {
    const where = `decisions.${name}`;
    const o = object(value, where, fail);
    if (o['kind'] === 'choice') {
      closed(o, where, ['kind', 'question', 'options', 'minConfidence'], fail);
      const options: Record<string, string> = {};
      for (const [option, meaning] of namedEntries(
        o['options'],
        `${where}.options`,
        OPTIONS_MIN,
        OPTIONS_MAX,
        'options',
        fail,
      )) {
        if (option === UNSURE)
          throw fail(`${where}.options names "${UNSURE}", the answer reserved for a choice below its minConfidence`);
        options[option] = text(meaning, `${where}.options.${option}`, MEANING_MAX_CHARS, fail);
      }
      out[name] = {
        kind: 'choice',
        question: text(o['question'], `${where}.question`, QUESTION_MAX_CHARS, fail),
        options,
        minConfidence: unit(o['minConfidence'], `${where}.minConfidence`, fail),
      };
    } else if (o['kind'] === 'checks') {
      closed(o, where, ['kind', 'checks', 'yesAt'], fail);
      const checks: Record<string, Check> = {};
      for (const [check, value] of namedEntries(o['checks'], `${where}.checks`, 1, CHECKS_MAX, 'checks', fail)) {
        const at = `${where}.checks.${check}`;
        const c = object(value, at, fail);
        closed(c, at, ['question', 'yes', 'no'], fail);
        checks[check] = {
          question: text(c['question'], `${at}.question`, QUESTION_MAX_CHARS, fail),
          yes: text(c['yes'], `${at}.yes`, QUESTION_MAX_CHARS, fail),
          no: text(c['no'], `${at}.no`, QUESTION_MAX_CHARS, fail),
        };
      }
      out[name] = { kind: 'checks', checks, yesAt: unit(o['yesAt'], `${where}.yesAt`, fail) };
    } else {
      throw fail(`${where}.kind must be "choice" or "checks"`);
    }
  }
  return out;
}

function object(raw: unknown, where: string, fail: (problem: string) => Error): Readonly<Record<string, unknown>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail(`${where} must be an object`);
  return raw as Record<string, unknown>;
}

/** An object of `min`–`max` entries, each name matching DECISION_NAME. */
function namedEntries(
  raw: unknown,
  where: string,
  min: number,
  max: number,
  what: string,
  fail: (problem: string) => Error,
): [string, unknown][] {
  const entries = Object.entries(object(raw, where, fail));
  if (entries.length < min || entries.length > max)
    throw fail(`${where} must hold ${String(min)} to ${String(max)} ${what}, not ${String(entries.length)}`);
  for (const [name] of entries)
    if (!DECISION_NAME.test(name)) throw fail(`${where}.${name}: the name must match ${String(DECISION_NAME)}`);
  return entries;
}

/** Exactly these keys, each present. */
function closed(
  o: Readonly<Record<string, unknown>>,
  where: string,
  keys: readonly string[],
  fail: (problem: string) => Error,
): void {
  for (const key of Object.keys(o)) if (!keys.includes(key)) throw fail(`unknown field ${where}.${key}`);
  for (const key of keys) if (!(key in o)) throw fail(`missing field ${where}.${key}`);
}

/** A string of 1 to `max` characters (code points). */
function text(raw: unknown, where: string, max: number, fail: (problem: string) => Error): string {
  if (typeof raw !== 'string' || raw.length === 0 || Array.from(raw).length > max)
    throw fail(`${where} must be a string of 1 to ${String(max)} characters`);
  return raw;
}

/** A number in [0, 1]. */
function unit(raw: unknown, where: string, fail: (problem: string) => Error): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1)
    throw fail(`${where} must be a number from 0 to 1`);
  return raw;
}
