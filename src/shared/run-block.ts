// A pattern page's run-command block (docs/plans/orchestration-patterns.md R3, A1), parsed — moved here from
// evals/patterns/run-block.ts by docs/plans/portal-scene-chat.md R16, so the daemon's demo route reads a page with the
// agent suite's own parser; it imports only ./assert-present.js, itself dependency-free. The block is the one fenced
// block marked `asha-run` in docs/patterns/pNN-<slug>.md,
// holding the commands a reader types to run the demo — the team's launch,
// the pattern's bound on a request (patterns-phase-1 R4), then each scenario's
// commands under a `# <scenario id>` line: one message, or several run in
// order, a later one naming `conversation=@previous`, which the suite replaces
// with the conversation id of the scenario's previous command
// (docs/plans/patterns-phase-3.md R9). A scenario may also stop the daemon,
// `./asha --stop`, or launch a team, `./asha --launch team=<team>` — a
// relaunch after a stop (docs/plans/patterns-phase-5.md R8). The pattern's agent-suite file runs
// exactly these commands, read from the page, never a copy of them; the page's
// reader and the suite therefore run the same thing.
//
//   ```asha-run
//   ./asha --launch team=delegation
//   # bound: 45000 ms
//   # p01-a
//   ./asha to=lead-1 user=alice message="Please ask greeter-1 to say Hello World."
//   ```

import { present } from './assert-present.js';

/** The fence's info string that marks a run-command block. */
const RUN_BLOCK_INFO = 'asha-run';

/** Whether a scenario's command is a control command — `--stop` or `--launch team=<team>` — rather than a message (patterns-phase-5 R8). */
export function isControl(args: readonly string[]): boolean {
  return args[0] === '--stop' || args[0] === '--launch';
}

/** The team a scenario's `--launch team=<team>` names, or undefined for any other command. */
export function launchedTeam(args: readonly string[]): string | undefined {
  return args.length === 2 && args[0] === '--launch'
    ? /^team=([a-z0-9][a-z0-9._-]*)$/.exec(present(args[1], 'args[1]'))?.[1]
    : undefined;
}

/** The argument a later command of a scenario names its conversation by; the suite puts the previous command's conversation id in its place (R9). */
export const PREVIOUS_CONVERSATION = 'conversation=@previous';

export interface RunBlock {
  /** The page, relative to the repo root. */
  readonly page: string;
  /** `./asha --launch team=<team>`'s arguments, without `./asha`. */
  readonly launch: readonly string[];
  /** The team the launch names. */
  readonly team: string;
  /** The pattern's bound on a request, in ms: its `# bound: <ms> ms` line (patterns-phase-1 R4). */
  readonly boundMs: number;
  /** Each scenario's commands' arguments, without `./asha`, in order: one or more per scenario, scenarios in the page's order (R9). */
  readonly scenarios: ReadonlyMap<string, readonly (readonly string[])[]>;
}

/** The page's block is missing, doubled or malformed; names the page and why. */
export class RunBlockInvalid extends Error {
  constructor(
    readonly page: string,
    readonly problem: string,
  ) {
    super(`${page}: ${problem}`);
    this.name = 'RunBlockInvalid';
  }
}

/**
 * One character of `splitCommand`'s input while inside a quoted part: `\"` becomes `"` and consumes the next
 * character too (`extra`); a bare `"` closes the quoted part; anything else is kept as is. Extracted out of
 * `splitCommand`, whose cognitive complexity this nested if/else-if was the largest part of
 * (sonarjs/cognitive-complexity).
 */
function advanceQuoted(line: string, i: number, current: string): { current: string; quoted: boolean; extra: number } {
  const c = present(line[i], 'line[i]');
  if (c === '\\' && line[i + 1] === '"') return { current: current + '"', quoted: true, extra: 1 };
  if (c === '"') return { current, quoted: false, extra: 0 };
  return { current: current + c, quoted: true, extra: 0 };
}

/**
 * Splits one command line into arguments as a POSIX shell would for these simple commands: words separated by
 * spaces, a double-quoted part kept whole (`message="a b"` is one argument, `message=a b`), `\"` a quote inside it.
 * Anything a shell would treat specially outside quotes (`$`, a backtick, `'`, `\`, `;`, `|`, `&`, `<`, `>`) is refused.
 */
export function splitCommand(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    if (quoted) {
      const next = advanceQuoted(line, i, current);
      current = next.current;
      quoted = next.quoted;
      i += next.extra;
      continue;
    }
    const c = present(line[i], 'line[i]');
    if (c === '"') {
      quoted = true;
      started = true;
    } else if (c === ' ') {
      if (started) args.push(current);
      current = '';
      started = false;
    } else if (/[$`'\\;|&<>]/.test(c)) {
      throw new Error(`"${c}" outside double quotes in: ${line}`);
    } else {
      current += c;
      started = true;
    }
  }
  if (quoted) throw new Error(`an unclosed double quote in: ${line}`);
  if (started) args.push(current);
  return args;
}

/** One current scenario, built up while `parseScenarios` walks the lines after the launch and the bound. */
interface CurrentScenario {
  readonly id: string;
  readonly commands: string[][];
}

/**
 * One line of a scenario's body (not a `# pNN-x` line): its command, added to `current` — or a failure naming the
 * page and the scenario. Extracted out of `parseRunBlock`'s loop, the largest part of its cognitive complexity
 * (sonarjs/cognitive-complexity).
 */
function addScenarioCommand(
  page: string,
  current: CurrentScenario | undefined,
  line: string,
  command: (l: string) => string[],
): CurrentScenario {
  if (current === undefined)
    throw new RunBlockInvalid(
      page,
      `after the launch, each scenario is a "# pNN-x" line and then its commands; found: ${line}`,
    );
  const args = command(line);
  // A scenario's command is a message, or one of two control commands, exactly in their forms (patterns-phase-5 R8).
  if (args[0]?.startsWith('--')) {
    const control = (args.length === 1 && args[0] === '--stop') || launchedTeam(args) !== undefined;
    if (!control)
      throw new RunBlockInvalid(
        page,
        `scenario ${current.id}'s command must be a message, "./asha --stop" or "./asha --launch team=<team>", not: ${line}`,
      );
  }
  // A scenario's first command starts its conversation: there is no previous one to name (R9).
  if (current.commands.length === 0 && args.includes(PREVIOUS_CONVERSATION))
    throw new RunBlockInvalid(
      page,
      `scenario ${current.id}'s first command names ${PREVIOUS_CONVERSATION}, and no command comes before it`,
    );
  current.commands.push(args);
  return current;
}

/** The lines after the launch and the bound (R9): each scenario's commands, by its `# pNN-x` id, in the page's order. */
function parseScenarios(
  page: string,
  rest: readonly string[],
  command: (line: string) => string[],
): Map<string, string[][]> {
  const scenarios = new Map<string, string[][]>();
  let current: CurrentScenario | undefined;
  for (const line of rest) {
    const id = /^# (p\d{2}-[a-z])$/.exec(line)?.[1];
    if (id !== undefined) {
      if (current !== undefined && current.commands.length === 0)
        throw new RunBlockInvalid(page, `scenario ${current.id} has no command`);
      if (scenarios.has(id)) throw new RunBlockInvalid(page, `scenario ${id} appears twice`);
      current = { id, commands: [] };
      scenarios.set(id, current.commands);
      continue;
    }
    current = addScenarioCommand(page, current, line, command);
  }
  if (current !== undefined && current.commands.length === 0)
    throw new RunBlockInvalid(page, `scenario ${current.id} has no command`);
  if (scenarios.size === 0) throw new RunBlockInvalid(page, 'its run-command block names no scenario');
  return scenarios;
}

export function parseRunBlock(page: string, markdown: string): RunBlock {
  const blocks = [...markdown.matchAll(/^```asha-run\n([\s\S]*?)^```$/gm)];
  if (blocks.length !== 1)
    throw new RunBlockInvalid(
      page,
      `holds ${String(blocks.length)} run-command blocks (\`\`\`${RUN_BLOCK_INFO}); a pattern page holds exactly one`,
    );
  const block = present(blocks[0], 'the run-command block match');
  const body = present(block[1], "the run-command block's captured body");
  const lines = body.split('\n').filter((l) => l.trim() !== '');
  const command = (line: string): string[] => {
    if (!line.startsWith('./asha '))
      throw new RunBlockInvalid(page, `a command line must start with "./asha ": ${line}`);
    try {
      return splitCommand(line.slice('./asha '.length));
    } catch (error) {
      throw new RunBlockInvalid(page, (error as Error).message);
    }
  };
  const [first, bound, ...rest] = lines;
  if (first === undefined) throw new RunBlockInvalid(page, 'its run-command block is empty');
  const launch = command(first);
  const team = launchedTeam(launch);
  if (team === undefined)
    throw new RunBlockInvalid(page, `its first line must be "./asha --launch team=<team>", not: ${first}`);
  const boundMs = Number(/^# bound: ([1-9]\d*) ms$/.exec(bound ?? '')?.[1] ?? Number.NaN);
  if (!Number.isInteger(boundMs) || boundMs > 45_000)
    throw new RunBlockInvalid(
      page,
      `its second line must be "# bound: <ms> ms", at most 45000 (orchestration-patterns R8), not: ${bound ?? '(none)'}`,
    );
  const scenarios = parseScenarios(page, rest, command);
  return { page, launch, team, boundMs, scenarios };
}

/** A one-command scenario's command, or a failure naming the page and the scenario (none, or several commands: scenarioCommands). */
export function scenarioCommand(block: RunBlock, id: string): readonly string[] {
  const commands = scenarioCommands(block, id);
  if (commands.length !== 1)
    throw new RunBlockInvalid(
      block.page,
      `scenario ${id} has ${String(commands.length)} commands; scenarioCommands gives them all`,
    );
  return present(commands[0], 'commands[0]');
}

/** Every command of a scenario, in order, or a failure naming the page and the scenario. */
export function scenarioCommands(block: RunBlock, id: string): readonly (readonly string[])[] {
  const commands = block.scenarios.get(id);
  if (commands === undefined) throw new RunBlockInvalid(block.page, `has no scenario ${id} in its run-command block`);
  return commands;
}

/** A command with `conversation=@previous` given the previous command's conversation id (R9); a command without it, unchanged. */
export function withPrevious(args: readonly string[], conversation: string | undefined): string[] {
  if (!args.includes(PREVIOUS_CONVERSATION)) return [...args];
  if (conversation === undefined)
    throw new Error(
      `${args.join(' ')} names ${PREVIOUS_CONVERSATION}, and there is no previous command's conversation`,
    );
  return args.map((a) => (a === PREVIOUS_CONVERSATION ? `conversation=${conversation}` : a));
}

/** The `message=` text of a scenario's command: the user's input. */
export function messageOf(args: readonly string[]): string {
  const message = args.find((a) => a.startsWith('message='));
  if (message === undefined) throw new Error(`no message= in: ${args.join(' ')}`);
  return message.slice('message='.length);
}
