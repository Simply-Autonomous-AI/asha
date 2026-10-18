// The run-command block of a pattern page (docs/plans/orchestration-patterns.md A1; docs/plans/patterns-phase-3.md R9,
// A5): how a command line splits, what the block parses to — a scenario of one command or of several, run in order,
// a later one naming `conversation=@previous` — and that every page as it stood at 66f3887 still parses to the
// commands it gave then (tests/unit/fixtures/run-blocks-66f3887.json, recorded with the parser of that commit).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  PREVIOUS_CONVERSATION,
  RunBlockInvalid,
  isControl,
  launchedTeam,
  parseRunBlock,
  readRunBlock,
  scenarioCommand,
  scenarioCommands,
  splitCommand,
  withPrevious,
} from '../../evals/patterns/run-block.js';
import { present } from '../../src/shared/assert-present.js';
import { ROOT } from '../helpers/pattern-spec.js';

describe('the run-command block (orchestration-patterns A1)', () => {
  it('splits a command as a shell would: a double-quoted part whole, \\" a quote in it', () => {
    expect(splitCommand(`to=lead-1 user=alice message="Please translate 'thank you' into French."`)).toEqual([
      'to=lead-1',
      'user=alice',
      "message=Please translate 'thank you' into French.",
    ]);
    expect(splitCommand('message="say \\"hi\\""  channel=x')).toEqual(['message=say "hi"', 'channel=x']);
  });

  it.each([
    'message=$HOME',
    'a; rm -rf x',
    "it's",
    'x | y',
    'message="open',
    'conversation=<id> message=yes',
    'conversation=$PREV message=yes',
  ])('refuses %j: what a shell would read otherwise', (line) => {
    expect(() => splitCommand(line)).toThrow();
  });

  it('keeps conversation=@previous as one plain argument (R9): @ is nothing to a shell', () => {
    expect(splitCommand('user=alice conversation=@previous message="yes"')).toEqual([
      'user=alice',
      PREVIOUS_CONVERSATION,
      'message=yes',
    ]);
  });

  it('reads the launch, the team, the bound and each scenario in order', () => {
    const block = parseRunBlock(
      'p.md',
      '# P\n\n```asha-run\n./asha --launch team=duo\n# bound: 12000 ms\n# p01-a\n./asha to=a-1 user=alice message="Hi there."\n# p01-b\n./asha user=alice message="Bye."\n```\n',
    );
    expect({ ...block, scenarios: [...block.scenarios] }).toEqual({
      page: 'p.md',
      launch: ['--launch', 'team=duo'],
      team: 'duo',
      boundMs: 12000,
      scenarios: [
        ['p01-a', [['to=a-1', 'user=alice', 'message=Hi there.']]],
        ['p01-b', [['user=alice', 'message=Bye.']]],
      ],
    });
  });

  it('reads a scenario of two commands as both, in order, conversation=@previous kept for the suite to fill (R9)', () => {
    const block = parseRunBlock(
      'p.md',
      '```asha-run\n./asha --launch team=approval\n# bound: 45000 ms\n# p15-a\n./asha to=clerk-1 user=alice message="Post it."\n./asha user=alice conversation=@previous message="yes"\n# p15-b\n./asha to=clerk-1 user=alice message="Post it."\n./asha user=alice conversation=@previous message="no"\n```\n',
    );
    expect([...block.scenarios]).toEqual([
      [
        'p15-a',
        [
          ['to=clerk-1', 'user=alice', 'message=Post it.'],
          ['user=alice', PREVIOUS_CONVERSATION, 'message=yes'],
        ],
      ],
      [
        'p15-b',
        [
          ['to=clerk-1', 'user=alice', 'message=Post it.'],
          ['user=alice', PREVIOUS_CONVERSATION, 'message=no'],
        ],
      ],
    ]);
    expect(scenarioCommands(block, 'p15-a')).toHaveLength(2);
    expect(() => scenarioCommand(block, 'p15-a')).toThrow(
      'p.md: scenario p15-a has 2 commands; scenarioCommands gives them all',
    );
  });

  it("fills conversation=@previous with the previous command's conversation, and leaves a command without it unchanged", () => {
    expect(withPrevious(['user=alice', PREVIOUS_CONVERSATION, 'message=yes'], '0123abcd')).toEqual([
      'user=alice',
      'conversation=0123abcd',
      'message=yes',
    ]);
    expect(withPrevious(['to=clerk-1', 'message=x'], undefined)).toEqual(['to=clerk-1', 'message=x']);
    expect(() => withPrevious(['user=alice', PREVIOUS_CONVERSATION, 'message=yes'], undefined)).toThrow(
      "there is no previous command's conversation",
    );
  });

  it.each([
    [
      'two blocks',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p01-a\n./asha message=x\n```\n```asha-run\n./asha --launch team=b\n```\n',
      'holds 2 run-command blocks',
    ],
    [
      'no bound',
      '```asha-run\n./asha --launch team=a\n# p01-a\n./asha message=x\n```\n',
      'its second line must be "# bound: <ms> ms"',
    ],
    [
      'a bound over the cap',
      '```asha-run\n./asha --launch team=a\n# bound: 45001 ms\n# p01-a\n./asha message=x\n```\n',
      'at most 45000',
    ],
    [
      'a launch of a recipe',
      '```asha-run\n./asha --launch recipe=a\n# bound: 1 ms\n# p01-a\n./asha message=x\n```\n',
      'its first line must be "./asha --launch team=<team>"',
    ],
    [
      'a scenario twice',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p01-a\n./asha message=x\n# p01-a\n./asha message=y\n```\n',
      'scenario p01-a appears twice',
    ],
    ['no scenario', '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n```\n', 'names no scenario'],
    [
      'a command that is not asha',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p01-a\nrm -rf /\n```\n',
      'must start with "./asha "',
    ],
    [
      'a command before any scenario',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n./asha message=x\n# p01-a\n./asha message=y\n```\n',
      'each scenario is a "# pNN-x" line',
    ],
    [
      'a scenario with no command',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p01-a\n# p01-b\n./asha message=y\n```\n',
      'scenario p01-a has no command',
    ],
    [
      'a last scenario with no command',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p01-a\n./asha message=y\n# p01-b\n```\n',
      'scenario p01-b has no command',
    ],
    [
      'a scenario whose first command names the previous conversation',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p01-a\n./asha user=alice conversation=@previous message=y\n```\n',
      'first command names conversation=@previous',
    ],
    [
      'a later command that is neither a message nor a control command',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p01-a\n./asha message=y\n./asha --watch\n```\n',
      'scenario p01-a\'s command must be a message, "./asha --stop" or "./asha --launch team=<team>", not: ./asha --watch',
    ],
    [
      'a --server in a scenario (patterns-phase-5 R8)',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p20-a\n./asha message=y\n./asha --server\n```\n',
      'not: ./asha --server',
    ],
    [
      'a --stop with an argument',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p20-a\n./asha message=y\n./asha --stop now\n```\n',
      'not: ./asha --stop now',
    ],
    [
      'a scenario launch of a recipe',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p20-a\n./asha --launch recipe=x\n```\n',
      'not: ./asha --launch recipe=x',
    ],
    [
      'a scenario launch with another argument',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p20-a\n./asha --launch team=a channel=b\n```\n',
      'not: ./asha --launch team=a channel=b',
    ],
    [
      'a later command a shell would read otherwise',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p01-a\n./asha message=y\n./asha conversation=$X message=y\n```\n',
      '"$" outside double quotes',
    ],
  ])('refuses %s, naming the page', (_, markdown, message) => {
    expect(() => parseRunBlock('docs/patterns/p.md', markdown)).toThrow(RunBlockInvalid);
    expect(() => parseRunBlock('docs/patterns/p.md', markdown)).toThrow(`docs/patterns/p.md: `);
    expect(() => parseRunBlock('docs/patterns/p.md', markdown)).toThrow(message);
  });

  it("reads a scenario's --stop and --launch team=<team>, first or later, as control commands (patterns-phase-5 R8)", () => {
    const block = parseRunBlock(
      'p.md',
      '```asha-run\n./asha --launch team=a\n# bound: 1 ms\n# p20-a\n./asha to=s-1 user=alice message="x y"\n./asha --stop\n./asha --launch team=a\n# p20-b\n./asha --stop\n./asha --launch team=b\n./asha to=t-1 user=alice message=z\n```\n',
    );
    expect([...block.scenarios]).toEqual([
      ['p20-a', [['to=s-1', 'user=alice', 'message=x y'], ['--stop'], ['--launch', 'team=a']]],
      ['p20-b', [['--stop'], ['--launch', 'team=b'], ['to=t-1', 'user=alice', 'message=z']]],
    ]);
    expect(
      present(block.scenarios.get('p20-b'), "block.scenarios.get('p20-b')").map((args) => [
        isControl(args),
        launchedTeam(args) ?? null,
      ]),
    ).toEqual([
      [true, null],
      [true, 'b'],
      [false, null],
    ]);
  });

  it('reads a page from the repo root it is given', () => {
    expect(readRunBlock('docs/patterns/p01-delegation.md', ROOT).team).toBe('delegation');
  });

  describe('every page as it stood at 66f3887 parses to the commands it gave then (R9)', () => {
    const recorded = JSON.parse(readFileSync(join(ROOT, 'tests/unit/fixtures/run-blocks-66f3887.json'), 'utf8')) as {
      readonly pages: Readonly<
        Record<
          string,
          {
            readonly block: string;
            readonly launch: string[];
            readonly team: string;
            readonly boundMs: number;
            readonly scenarios: [string, string[]][];
          }
        >
      >;
    };
    const pages = Object.keys(recorded.pages);

    it('holds the seventeen pages of phases 1 and 2', () => {
      expect(pages).toHaveLength(17);
    });

    it.each(pages)('%s', (page) => {
      const then = present(recorded.pages[page], `recorded.pages[${page}]`);
      const block = parseRunBlock(page, then.block);
      expect({
        launch: block.launch,
        team: block.team,
        boundMs: block.boundMs,
        scenarios: [...block.scenarios],
      }).toEqual({
        launch: then.launch,
        team: then.team,
        boundMs: then.boundMs,
        // One command per scenario then; the same one now, as the only command of its scenario.
        scenarios: then.scenarios.map(([id, args]) => [id, [args]]),
      });
    });
  });
});
