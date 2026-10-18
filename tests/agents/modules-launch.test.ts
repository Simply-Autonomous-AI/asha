// A module through ./asha on the built tree (docs/plans/extension-modules.md R1, R38; A1, A38 (c)). The fixture module
// is installed with ./asha --install-module from a temporary directory outside the repo (R1), before the daemon starts.
// A1: a granted agent on the real model calls its tool and the result reaches the model; the repo stays clean and no
// npm runs (an `npm` first on PATH for this whole file records any run). A38 (c): in one agent-suite run, 10 warm
// one-agent launches of a test recipe granting the module, each its channel's first, and 10 of the same recipe
// granting none; the granting launches' median at most 1,000 ms, and their slowest at most 1,500 ms, above the others'
// median.

import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { toolModuleManifest, writeModuleDir } from '../helpers/modules.js';
import { RESULTS_PATHS } from '../../evals/patterns/selection.js';
import { present } from '../../src/shared/assert-present.js';
import { agentSuite, REPO, type AgentSuite } from './support.js';

let suite: AgentSuite;
const median = (xs: readonly number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 === 1
    ? present(s[(s.length - 1) / 2], 'median: the middle element')
    : (present(s[s.length / 2 - 1], 'median: the lower middle element') +
        present(s[s.length / 2], 'median: the upper middle element')) /
        2;
};

/** Where the `npm` shim writes each run's arguments; it must stay absent (A1). */
let npmRan: string;

beforeAll(async () => {
  // An `npm` first on PATH, for ./asha and the daemon it starts (both inherit this environment): any run is recorded.
  const shims = await mkdtemp(join(tmpdir(), 'asha-agents-npm-shim-'));
  npmRan = join(shims, 'npm-ran.txt');
  await writeFile(join(shims, 'npm'), `#!/bin/sh\necho "$*" >> '${npmRan}'\nexit 1\n`);
  await chmod(join(shims, 'npm'), 0o755);
  process.env['PATH'] = `${shims}:${process.env['PATH'] ?? ''}`;
  // The shim is the npm this file's processes find, and it records (the guard can fail).
  execFileSync('sh', ['-c', 'npm --version || true'], { env: process.env });
  expect((await readFile(npmRan, 'utf8')).trim()).toBe('--version');
  await writeFile(npmRan, '');
  suite = await agentSuite('modules-launch', 'mlaunch');
  const files = {
    'index.mjs': "export async function call() { return { ok: true, result: 'meaning' }; }\n",
    'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}\n',
  };
  const dir = await writeModuleDir(
    toolModuleManifest({ id: 'suite_lookup' }, files),
    files,
    await mkdtemp(tmpdir() + '/asha-agents-module-'),
  );
  const installed = await suite.asha(['--install-module', `path=${dir}`, '--yes'], 600_000);
  expect(installed.code, installed.stderr).toBe(0);
}, 900_000);

afterAll(async () => {
  await suite.finish();
}, 120_000);

it('an agent granted the installed module calls its tool, and its result reaches the model; the repo is clean and no npm ran (A1)', async (context) => {
  suite.begin(context, {
    id: 'module-call',
    title: 'A granted module tool, called on the real model',
    agents: [],
    expectation: 'the reply carries the tool\'s result "meaning"; module.call ok; git status clean; no npm run',
  });
  const launched = await suite.send(context, ['--launch', 'recipe=suite-modules-grant', 'channel=a1'], 600_000);
  expect(launched.code, launched.stderr).toBe(0);
  const run = await suite.send(
    context,
    [
      'channel=a1',
      'user=ivy',
      'message=Call the suite_lookup__lookup tool with the word "life", then reply with exactly the result it returned.',
    ],
    300_000,
  );
  expect(run.code, run.stderr).toBe(0);
  const log = (await readFile(join(suite.home, 'logs', 'daemon.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  expect(log.filter((r) => r['event'] === 'module.call').map((r) => [r['module'], r['tool'], r['outcome']])).toEqual([
    ['suite_lookup', 'lookup', 'ok'],
  ]);
  expect(run.stdout).toContain('meaning');
  expect(
    execFileSync('git', ['status', '--porcelain', '--', '.', ...RESULTS_PATHS.map((path) => `:!${path}`)], {
      cwd: REPO,
      encoding: 'utf8',
    }),
  ).toBe('');
  expect(await readFile(npmRan, 'utf8')).toBe('');
}, 1_200_000);

it('a granting launch adds at most 1,000 ms at the median and 1,500 ms at the slowest', async (context) => {
  suite.begin(context, {
    id: 'launch-cost',
    title: 'The cost a granting launch adds',
    agents: [],
    expectation: 'granting median ≤ plain median + 1,000 ms; slowest ≤ plain median + 1,500 ms',
  });
  // Warm: the model served and both images current.
  for (const recipe of ['suite-modules-plain', 'suite-modules-grant']) {
    const warm = await suite.asha(['--launch', `recipe=${recipe}`, `channel=warm-${recipe}`], 600_000);
    suite.record(context, warm);
    expect(warm.code, warm.stderr).toBe(0);
  }
  const plain: number[] = [];
  const grant: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    for (const [recipe, into] of [
      ['suite-modules-plain', plain],
      ['suite-modules-grant', grant],
    ] as const) {
      const launched = await suite.asha(
        ['--launch', `recipe=${recipe}`, `channel=c${String(i)}-${recipe.slice(-5)}`],
        120_000,
      );
      suite.record(context, launched);
      expect(launched.code, launched.stderr).toBe(0);
      into.push(launched.ms);
    }
  }
  const base = median(plain);
  // The figures, in the run's log whatever the outcome (§13).
  process.stderr.write(`A38 (c) launch ms: granting ${JSON.stringify(grant)}, plain ${JSON.stringify(plain)}\n`);
  expect({
    plain,
    grant,
    medianAdded: median(grant) - base <= 1_000,
    slowestAdded: Math.max(...grant) - base <= 1_500,
  }).toMatchObject({ medianAdded: true, slowestAdded: true });
}, 1_200_000);
