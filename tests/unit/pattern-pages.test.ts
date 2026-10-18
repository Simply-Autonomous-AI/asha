// The pattern pages (docs/plans/orchestration-patterns.md R3, A1, A13;
// docs/plans/patterns-phase-1.md R6, A5): every docs/patterns/pNN-<slug>.md
// holds exactly one run-command block — the team's launch, the bound, and each
// scenario's message, every one sent as the demos' user — whose team exists; its
// agent-suite file reads its commands from the page and holds no copy of them;
// and it has the sections a pattern page must have, with its diagram and its
// links. That its scenarios and their inputs are the plan's is checked by
// pattern-pages-plan.test.ts, which stays with the plans in the internal
// repository (docs/plans/oss-release.md R2, R12).

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isControl, launchedTeam, messageOf, parseRunBlock, type RunBlock } from '../../evals/patterns/run-block.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { ROOT } from '../helpers/pattern-spec.js';

const SECTIONS = ['use', 'flow', 'run', 'transcript', 'team', 'limits', 'report'];

/** Every problem with one pattern page, each naming the page. */
export /** Messages shorter than this are matched as string literals only (p15's answers, "yes" and "no"). */
const SHORT_MESSAGE = 12;

/** Every team the block names — its launch's, and any a scenario relaunches (patterns-phase-5 R8). */
function namedTeams(block: RunBlock): string[] {
  return [
    ...new Set([block.team, ...[...block.scenarios.values()].flat().flatMap((args) => launchedTeam(args) ?? [])]),
  ];
}

/** Every named team exists. */
function checkTeamsExist(root: string, teams: readonly string[], say: (what: string) => void): void {
  for (const team of teams)
    if (!existsSync(join(root, 'teams', team, 'team.json')))
      say(`its run-command block names team=${team}, and teams/${team}/team.json does not exist`);
}

/** A short message ("yes", "no") is a copy only as a string literal of its own: as a substring it is in any prose. */
function suiteCopiesMessage(suite: string, message: string): boolean {
  return message.length >= SHORT_MESSAGE
    ? suite.includes(message)
    : ['"', "'", '`'].some((q) => suite.includes(`${q}${message}${q}`));
}

/** The suite reads its commands from this page, and holds no copy of them. */
function checkSuite(
  root: string,
  page: string,
  suiteFile: string,
  block: RunBlock,
  teams: readonly string[],
  say: (what: string) => void,
): void {
  if (!existsSync(join(root, suiteFile))) {
    say(`its agent-suite file ${suiteFile} does not exist`);
    return;
  }
  const suite = readFileSync(join(root, suiteFile), 'utf8');
  if (!suite.includes(`readRunBlock('${page}'`))
    say(`${suiteFile} does not read its commands from the page (readRunBlock('${page}', …))`);
  for (const [id, commands] of block.scenarios)
    if (commands.some((args) => !isControl(args) && suiteCopiesMessage(suite, messageOf(args))))
      say(`${suiteFile} holds its own copy of ${id}'s message`);
  for (const team of teams)
    if (suite.includes(`team=${team}`)) say(`${suiteFile} holds its own copy of the launch of team=${team}`);
}

/** Every command of a scenario sends as the demos' user (orchestration-patterns #demos conventions). */
function checkUser(id: string, commands: readonly (readonly string[])[], say: (what: string) => void): void {
  commands.forEach((args, k) => {
    if (!isControl(args) && !args.includes('user=alice'))
      say(`${id}'s command ${String(k + 1)} does not send as user=alice ([demos] conventions)`);
  });
}

/** Its sections, diagram and links. */
function checkSectionsDiagramLinks(
  root: string,
  markdown: string,
  block: RunBlock,
  suiteFile: string,
  prefix: string,
  say: (what: string) => void,
): void {
  for (const id of SECTIONS) if (!new RegExp(`^## .* \\{#${id}\\}$`, 'm').test(markdown)) say(`no section {#${id}}`);
  const flow = /\{#flow\}\n([\s\S]*?)\n## /.exec(markdown)?.[1] ?? '';
  const svg = /!\[[^\]]*\]\(([^)]+\.svg)\)/.exec(flow)?.[1];
  if (svg === undefined) say('no SVG diagram in {#flow}');
  else if (!existsSync(join(root, 'docs/patterns', svg))) say(`its diagram ${svg} does not exist`);
  for (const link of [
    `../../teams/${block.team}/team.json`,
    `../../${suiteFile}`,
    `../testing/agent-tests.html#pattern-${prefix}`,
  ]) {
    if (!markdown.includes(`](${link})`) && !markdown.includes(`href="${link}"`)) say(`no link to ${link}`);
  }
}

/** A built pattern shows a real transcript. */
function checkTranscriptBuilt(root: string, prefix: string, markdown: string, say: (what: string) => void): void {
  const catalogue = readFileSync(join(root, 'docs/patterns/index.md'), 'utf8');
  const row = catalogue.split('\n').find((l) => l.startsWith(`| P${String(Number(prefix.slice(1)))} |`)) ?? '';
  const transcript = /\{#transcript\}\n([\s\S]*?)\n## /.exec(markdown)?.[1] ?? '';
  if (/\bbuilt\b/.test(row.split('|').at(-2) ?? '') && transcript.includes('TODO:'))
    say('the catalogue marks it built, and its transcript is still a TODO');
}

function pageProblems(root: string, slug: string): string[] {
  const page = `docs/patterns/${slug}.md`;
  const problems: string[] = [];
  const say = (what: string) => problems.push(`${page}: ${what}`);
  const markdown = readFileSync(join(root, page), 'utf8');
  let block: RunBlock;
  try {
    block = parseRunBlock(page, markdown);
  } catch (error) {
    return [(error as Error).message];
  }
  const teams = namedTeams(block);
  checkTeamsExist(root, teams, say);
  const suiteFile = `tests/agents/${slug}.test.ts`;
  checkSuite(root, page, suiteFile, block, teams, say);
  const prefix = slug.slice(0, 3);
  for (const [id, commands] of block.scenarios) checkUser(id, commands, say);
  checkSectionsDiagramLinks(root, markdown, block, suiteFile, prefix, say);
  checkTranscriptBuilt(root, prefix, markdown, say);
  return problems;
}

const pages = readdirSync(join(ROOT, 'docs', 'patterns'))
  .filter((f) => /^p\d{2}-[a-z0-9-]+\.md$/.test(f))
  .map((f) => f.slice(0, -3))
  .sort(byCodeUnit);

describe('the pattern pages (orchestration-patterns A1, A13; patterns-phase-1 A5; patterns-phase-2 A5)', () => {
  it('finds the pages of phases 1 and 2, of phase 3 as each is written, of phase 4 (patterns-phase-4 A5) and of phase 5 (patterns-phase-5 A5)', () => {
    expect(pages).toEqual([
      'p01-delegation',
      'p02-router',
      'p03-pipeline',
      'p04-fan-out',
      'p05-orchestrator-workers',
      'p06-plan-execute',
      'p07-hierarchy',
      'p08-critic-loop',
      'p09-debate',
      'p10-voting',
      'p11-blackboard',
      'p12-self-selection',
      'p13-contract-net',
      'p14-watchdog',
      'p15-approval',
      'p16-guardrail',
      'p17-budget',
      'p18-agent-tool',
      'p19-spawning',
      'p20-resume',
      'p21-topics',
      'p22-escalation',
      'p23-consensus',
      'p24-group-chat',
      'p25-restart',
    ]);
  });

  it.each(pages)(
    'docs/patterns/%s.md: one run-command block, its team, its suite reading it, its users, its sections and links',
    (slug) => {
      expect(pageProblems(ROOT, slug)).toEqual([]);
    },
  );

  describe('each check fails naming the page', () => {
    /** A copy of the repo's files the checks read, with one page or suite edited. */
    function copy(): string {
      const root = mkdtempSync(join(tmpdir(), 'asha-pages-'));
      for (const dir of ['docs/patterns', 'teams', 'tests/agents'])
        cpSync(join(ROOT, dir), join(root, dir), { recursive: true, filter: (src) => !src.includes('/results') });
      return root;
    }
    const edit = (root: string, file: string, from: string | RegExp, to: string) => {
      const text = readFileSync(join(root, file), 'utf8');
      const next = text.replace(from, to);
      expect(next, `${file}: nothing to edit`).not.toBe(text);
      writeFileSync(join(root, file), next);
    };
    const PAGE = 'docs/patterns/p01-delegation.md';
    /** The fixture's slug for a fault injected into `file`: its own page's, else p01-delegation's. */
    function slugFor(file: string): string {
      if (file.includes('p22')) return 'p22-escalation';
      if (file.includes('p15')) return 'p15-approval';
      return 'p01-delegation';
    }

    it.each([
      ['the block removed', PAGE, /```asha-run[\s\S]*?```\n/, '', 'holds 0 run-command blocks'],
      ['a team that does not exist', PAGE, 'team=delegation', 'team=nobody', 'teams/nobody/team.json does not exist'],
      [
        'the suite holding its own copy of the message',
        'tests/agents/p01-delegation.test.ts',
        'const block = readRunBlock(',
        "const copy = 'Please ask greeter-1 to say Hello World.';\nconst block = readRunBlock(",
        "holds its own copy of p01-a's message",
      ],
      [
        'the suite holding its own copy of a short message, as a literal',
        'tests/agents/p15-approval.test.ts',
        'const block = readRunBlock(',
        "const copy = 'yes';\nconst block = readRunBlock(",
        "holds its own copy of p15-a's message",
      ],
      [
        'the suite not reading the page',
        'tests/agents/p01-delegation.test.ts',
        "readRunBlock('docs/patterns/p01-delegation.md'",
        "readRunBlock('docs/patterns/p02-router.md'",
        'does not read its commands from the page',
      ],
      [
        'a later command not sent as alice',
        PAGE,
        /(\n# p01-a\n.*\n)```/,
        '$1./asha user=bob conversation=@previous message="Hi."\n```',
        "p01-a's command 2 does not send as user=alice",
      ],
      [
        'a scenario relaunching a team that does not exist (patterns-phase-5 R8)',
        PAGE,
        /(\n# p01-a\n.*\n)```/,
        '$1./asha --stop\n./asha --launch team=nobody\n```',
        'teams/nobody/team.json does not exist',
      ],
      [
        "the suite holding its own copy of a scenario's relaunch",
        'tests/agents/p01-delegation.test.ts',
        'const block = readRunBlock(',
        "const copy = 'team=delegation';\nconst block = readRunBlock(",
        'holds its own copy of the launch of team=delegation',
      ],
      ['a section removed', PAGE, '{#limits}', '{#caveats}', 'no section {#limits}'],
      ['the diagram removed', PAGE, /!\[[^\]]*\]\(p01-delegation\.svg\)/, 'No diagram.', 'no SVG diagram in {#flow}'],
      [
        'the report link removed',
        PAGE,
        '(../testing/agent-tests.html#pattern-p01)',
        '(../testing/agent-tests.html)',
        'no link to ../testing/agent-tests.html#pattern-p01',
      ],
    ])('%s', (_, file, from, to, message) => {
      const root = copy();
      edit(root, file, from, to);
      const slug = slugFor(file);
      const problems = pageProblems(root, slug);
      expect(
        problems.some((p) => p.includes(message) && p.includes(`docs/patterns/${slug}.md`)),
        JSON.stringify(problems),
      ).toBe(true);
    });

    it("a scenario's --stop and --launch team=<team> are held to no message rule: no user=alice, no copy (patterns-phase-5 R8)", () => {
      const root = copy();
      edit(root, PAGE, /(\n# p01-a\n.*\n)```/, '$1./asha --stop\n./asha --launch team=delegation\n```');
      expect(pageProblems(root, 'p01-delegation')).toEqual([]);
    });

    it('a pattern the catalogue marks built, whose transcript is still a TODO', () => {
      const root = copy();
      edit(
        root,
        'docs/patterns/p01-delegation.md',
        /(\{#transcript\}\n)[\s\S]*?(\n## )/,
        '$1\nTODO: the transcript.\n$2',
      );
      expect(pageProblems(root, 'p01-delegation')).toEqual([
        'docs/patterns/p01-delegation.md: the catalogue marks it built, and its transcript is still a TODO',
      ]);
    });
  });
});
