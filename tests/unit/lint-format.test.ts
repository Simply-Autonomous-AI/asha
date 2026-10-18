// The linter and the formatter are guards too (PRINCIPLES §3), so their configuration is pinned here
// (docs/plans/lint-format.md R1–R5, A6). The real eslint.config.mjs is compared rule by rule with the bare presets it
// declares: any rule switched off, set to warn or given looser options fails, naming the rule, unless it is one of the
// exemptions listed below, each of which the config states a reason for. Canaries prove the type-aware, SonarJS and
// inline-comment checks fire through the real config, and that Prettier reads the repo's settings.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import { ESLint, type Linter } from 'eslint';
import sonarjs from 'eslint-plugin-sonarjs';
import prettier from 'prettier';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** What `calculateConfigForFile` returns, as far as these tests read it. */
interface ResolvedConfig {
  rules: Record<string, Linter.RuleEntry>;
  linterOptions: {
    noInlineConfig?: boolean;
    reportUnusedDisableDirectives?: number;
    reportUnusedInlineConfigs?: number;
  };
}

const PARSER_OPTIONS = { project: ['./tsconfig.json', './tsconfig.portal.json'], tsconfigRootDir: ROOT };

/** The presets eslint.config.mjs declares, alone: what every file must match but for its exemptions. */
const PRESETS: Linter.Config[] = [
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  sonarjs.configs.recommended,
  { languageOptions: { parserOptions: PARSER_OPTIONS } },
  { files: ['**/*.{js,mjs,cjs}'], ...tseslint.configs.disableTypeChecked },
];

const EVERYWHERE = ['sonarjs/no-hardcoded-ip', 'sonarjs/no-os-command-from-path'];
const TODO_MARKER_FILES = ['tools/docs/render.mts', 'tests/unit/docs-plans.test.ts'];

/** The rules eslint.config.mjs switches off for a file beyond the presets, sorted. */
function exemptions(file: string): string[] {
  return [
    ...EVERYWHERE,
    ...(file.startsWith('tests/') ? ['sonarjs/publicly-writable-directories'] : []),
    ...(TODO_MARKER_FILES.includes(file) ? ['sonarjs/todo-tag'] : []),
  ].sort(byCodeUnit);
}

function byCodeUnit(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** A code file in each folder neither tool may read, whether or not one exists there now. */
const UNTRACKED = [
  'node_modules/x/index.js',
  'dist/src/x.js',
  'build/release/x.mjs',
  'coverage/x.js',
  '.tmp/x.ts',
  '.vitest/x.js',
  '.playwright-mcp/x.js',
  '.claude/worktrees/agent-x/src/x.ts',
  '.qa/code-review/20261012T000000Z/round-1/review/evidence/x.mjs',
  'evals/probes/x-2026-10-12/x.mjs',
  'tests/fixtures/probes/x-2026-10-12/x.mjs',
];

const CODE = /\.(ts|mts|cts|js|mjs|cjs)$/;
/** The dated probes, and the copies of them the shipped tests read (tests/fixtures/README.md): kept byte for byte. */
const RECORDS = ['evals/probes/', 'tests/fixtures/probes/'];
const isRecord = (f: string): boolean => RECORDS.some((r) => f.startsWith(r));

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');
}

/** Every tracked file npm run lint reads: TypeScript and JavaScript but the dated probes and their copies. */
function linted(): string[] {
  return trackedFiles().filter((f) => CODE.test(f) && !isRecord(f));
}

async function resolvedConfig(eslint: ESLint, file: string): Promise<ResolvedConfig> {
  return (await eslint.calculateConfigForFile(join(ROOT, file))) as ResolvedConfig;
}

/** A rule's entry as severity 0, 1 or 2 followed by its options, so 'error' and ['error'] compare equal. */
function normalised(entry: Linter.RuleEntry | undefined): unknown[] {
  if (entry === undefined) return [0];
  const [level, ...options]: [Linter.RuleSeverity | Linter.StringSeverity, ...unknown[]] = Array.isArray(entry)
    ? entry
    : [entry];
  const severity = { off: 0, warn: 1, error: 2 } as const;
  return [typeof level === 'string' ? severity[level] : level, ...options];
}

describe('npm run lint and npm run format:check', () => {
  it('run exactly these commands, so any finding and any unformatted file fails', () => {
    const scripts = (
      JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    ).scripts;
    expect({
      lint: scripts['lint'],
      'lint:unused': scripts['lint:unused'],
      'lint:fix': scripts['lint:fix'],
      format: scripts['format'],
      'format:check': scripts['format:check'],
    }).toEqual({
      lint: 'eslint --max-warnings 0 .',
      'lint:unused': 'knip',
      'lint:fix': 'eslint --max-warnings 0 --fix .',
      format: 'prettier --write .',
      'format:check': 'prettier --check .',
    });
  });
});

describe('knip, the unused-code check (lint:unused)', () => {
  /** knip, the repository's pinned copy, over a small project of its own: its exit status and its compact report. */
  const knip = (dir: string): { readonly status: number | null; readonly out: string } => {
    const run = spawnSync(join(ROOT, 'node_modules', '.bin', 'knip'), ['--reporter', 'compact', '--no-progress'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 60_000,
    });
    return { status: run.status, out: `${run.stdout}${run.stderr}`.trim() };
  };

  // Its first run loads the TypeScript compiler: about 1 s alone, more beside the rest of the tier.
  it('fails on an export nothing imports, naming it, and passes once that export is used', { timeout: 60_000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'asha-knip-'));
    mkdirSync(join(dir, 'src'));
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'k', private: true, type: 'module', main: 'src/index.ts' }),
    );
    // Its imports name `.js` as this repository's do, which a NodeNext tsconfig maps to the `.ts` file.
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext' } }),
    );
    writeFileSync(join(dir, 'src', 'index.ts'), "import { used } from './lib.js';\nconsole.log(used);\n");
    writeFileSync(join(dir, 'src', 'lib.ts'), 'export const used = 1;\nexport const unused = 2;\n');
    const dead = knip(dir);
    expect([dead.status, dead.out]).toEqual([1, 'Unused exports (1)\nsrc/lib.ts: unused']);
    writeFileSync(
      join(dir, 'src', 'index.ts'),
      "import { unused, used } from './lib.js';\nconsole.log(used, unused);\n",
    );
    expect(knip(dir)).toEqual({ status: 0, out: '' });
  });
});

describe('eslint.config.mjs', () => {
  const eslint = new ESLint({ cwd: ROOT });
  const bare = new ESLint({ cwd: ROOT, overrideConfigFile: true, baseConfig: PRESETS });

  it('every linted file has every preset rule at its preset severity and options, but its exemptions, which are off', async () => {
    const wrong: string[] = [];
    for (const file of linted()) {
      const actual = (await resolvedConfig(eslint, file)).rules;
      const preset = (await resolvedConfig(bare, file)).rules;
      const differing = [...new Set([...Object.keys(actual), ...Object.keys(preset)])]
        .filter((rule) => JSON.stringify(normalised(actual[rule])) !== JSON.stringify(normalised(preset[rule])))
        .sort(byCodeUnit);
      const notOff = differing.filter((rule) => normalised(actual[rule])[0] !== 0);
      if (JSON.stringify(differing) !== JSON.stringify(exemptions(file)) || notOff.length > 0)
        wrong.push(`${file}: differs from the presets on [${differing.join(', ')}], not off: [${notOff.join(', ')}]`);
    }
    expect(wrong).toEqual([]);
  });

  it('every linted file has no rule at warn, and an inline comment can exempt nothing in it', async () => {
    const wrong: string[] = [];
    for (const file of linted()) {
      const config = await resolvedConfig(eslint, file);
      const warn = Object.keys(config.rules).filter((rule) => normalised(config.rules[rule])[0] === 1);
      if (warn.length > 0) wrong.push(`${file}: at warn: ${warn.join(', ')}`);
      const { noInlineConfig, reportUnusedDisableDirectives, reportUnusedInlineConfigs } = config.linterOptions;
      if (noInlineConfig !== true || reportUnusedDisableDirectives !== 2 || reportUnusedInlineConfigs !== 2)
        wrong.push(`${file}: linterOptions ${JSON.stringify(config.linterOptions)}`);
    }
    expect(wrong).toEqual([]);
  });

  it('the exemptions differ by file as expected: one file of each kind', () => {
    expect(
      Object.fromEntries(
        ['src/shared/abort.ts', 'tools/demos/register.mjs', 'tests/unit/tsconfig.test.ts', ...TODO_MARKER_FILES].map(
          (f) => [f, exemptions(f)],
        ),
      ),
    ).toEqual({
      'src/shared/abort.ts': EVERYWHERE,
      'tools/demos/register.mjs': EVERYWHERE,
      'tests/unit/tsconfig.test.ts': [...EVERYWHERE, 'sonarjs/publicly-writable-directories'],
      'tools/docs/render.mts': [...EVERYWHERE, 'sonarjs/todo-tag'],
      'tests/unit/docs-plans.test.ts': [...EVERYWHERE, 'sonarjs/publicly-writable-directories', 'sonarjs/todo-tag'],
    });
  });

  it('lints every tracked TypeScript and JavaScript file but the dated probes and their copies', async () => {
    const code = trackedFiles().filter((f) => CODE.test(f));
    const ignored = await Promise.all(code.map(async (f) => [f, await eslint.isPathIgnored(join(ROOT, f))] as const));
    expect(ignored.filter(([f, isIgnored]) => isIgnored !== isRecord(f)).map(([f]) => f)).toEqual([]);
    expect(linted().length).toBeGreaterThan(0);
  });

  it("lints nothing in the folders git keeps out, the agents' checkouts, the reviews' runs or the dated probes", async () => {
    const ignored = await Promise.all(UNTRACKED.map((f) => eslint.isPathIgnored(join(ROOT, f))));
    expect(UNTRACKED.filter((_, i) => ignored[i] !== true)).toEqual([]);
  });

  // Its first lint builds the three TypeScript programs the config reads types from: 1,151 ms alone on 2026-10-17, past
  // the default 5 s under a coverage run of the whole unit tier on every core — so its own bound, six times that.
  // Under CI=true, which GitHub's runners set, typescript-eslint infers a single run and parses the file from disk, not
  // the text given: the canary linted abort.ts as committed and found nothing (2026-10-18). Its own instance says no.
  it(
    'reports, through the real config, a floating promise (type-aware) and an all-duplicated branch (SonarJS)',
    { timeout: 30_000 },
    async () => {
      const canary = new ESLint({
        cwd: ROOT,
        overrideConfig: { languageOptions: { parserOptions: { disallowAutomaticSingleRunInference: true } } },
      });
      const [result] = await canary.lintText(
        'export function f(p: Promise<number>): void {\n  p.then(() => 1);\n}\n' +
          'export const g = (b: boolean): number => (b ? 1 : 1);\n',
        { filePath: join(ROOT, 'src/shared/abort.ts') },
      );
      expect(result?.messages.map((m) => [m.ruleId, m.line, m.severity])).toEqual([
        ['@typescript-eslint/no-floating-promises', 2, 2],
        ['sonarjs/no-all-duplicated-branches', 4, 2],
      ]);
    },
  );

  it('reports an eslint-disable comment instead of obeying it, so --max-warnings 0 fails on it', async () => {
    const [result] = await eslint.lintText('// eslint-disable-next-line no-unused-vars\nexport const x = 1;\n', {
      filePath: join(ROOT, 'tools/demos/register.mjs'),
    });
    expect(result?.messages.map((m) => [m.ruleId, m.line, m.severity, m.message])).toEqual([
      [
        null,
        1,
        1,
        "'// eslint-disable-next-line no-unused-vars' has no effect because you have 'noInlineConfig' setting in your config.",
      ],
    ]);
  });
});

describe('Prettier', () => {
  it('reads .prettierrc.json for code: 120 columns and single quotes', async () => {
    expect(await prettier.resolveConfig(join(ROOT, 'src/shared/abort.ts'), { editorconfig: false })).toEqual({
      printWidth: 120,
      singleQuote: true,
    });
  });

  it('checks every tracked TypeScript and JavaScript file but the dated probes and their copies, and no other kind of file', async () => {
    const ignorePath = [join(ROOT, '.gitignore'), join(ROOT, '.prettierignore')];
    const checked: string[] = [];
    for (const f of trackedFiles()) {
      const info = await prettier.getFileInfo(join(ROOT, f), { ignorePath });
      if (!info.ignored && info.inferredParser !== null) checked.push(f);
    }
    expect(checked).toEqual(linted());
  });

  it("checks nothing in the folders git keeps out, the agents' checkouts, the reviews' runs or the dated probes", async () => {
    const ignorePath = [join(ROOT, '.gitignore'), join(ROOT, '.prettierignore')];
    const infos = await Promise.all(UNTRACKED.map((f) => prettier.getFileInfo(join(ROOT, f), { ignorePath })));
    expect(UNTRACKED.filter((_, i) => infos[i]?.ignored !== true)).toEqual([]);
  });

  it('fails an unformatted file and passes its formatted form', async () => {
    const options = { filepath: join(ROOT, 'src/shared/abort.ts'), printWidth: 120, singleQuote: true };
    expect(await prettier.check('export const a = {b:"c"}\n', options)).toBe(false);
    expect(await prettier.check("export const a = { b: 'c' };\n", options)).toBe(true);
  });
});
