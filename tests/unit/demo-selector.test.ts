// The gate's demo selector (docs/plans/demo-selector.md; orchestration-patterns
// R11(b)–(e), A8), run for real against temporary git repositories: which demos a
// change touches, when the last green gate is a base and when it is not, the
// selection record and its reading by repeats 2 and 3, the environment
// fingerprint, and the `demos:select` entry. Every git command is real; the
// fingerprint is faked except in its own tests, which fake the runner.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { main } from '../../evals/patterns/select.js';
import {
  COMMAND_TIMEOUT_MS,
  GIT_OVERRIDES,
  RESULTS_PATHS,
  SELECTION,
  SelectionFailed,
  SelectionUnusable,
  computeSelection,
  environmentFingerprint,
  nodeFileOps,
  parseSelection,
  select,
  suitesForRepeat,
  type FileOps,
  type Fingerprint,
  type SelectionRecord,
} from '../../evals/patterns/selection.js';
import { treeDigest } from '../../src/daemon/model-store/index.js';
import { parseCatalogueEntry } from '../../src/daemon/definitions/index.js';
import {
  CommandNotFound,
  CommandTimedOut,
  ExecCommandRunner,
  type CommandResult,
  type CommandRunner,
  type RunOptions,
  type StreamResult,
} from '../../src/daemon/process/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { FakeRunner, fail, ok } from '../helpers/fakes.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const FAKE: Fingerprint = {
  node: 'v22.13.1',
  llamaServer: 'version: 0.5.0 (build 11146, commit 7fe450e19)',
  colima: 'colima version 0.10.3',
  docker: 'Server: Docker Engine - Community',
  npmInstall: 'a'.repeat(64),
  models: { 'qwen3-8b-q4_k_m': 'sha256-abc' },
};

const DEMOS = [
  { pattern: 'P1', team: 'alpha', page: 'docs/patterns/p01-alpha.md', suite: 'tests/agents/p01-alpha.test.ts' },
  { pattern: 'P2', team: 'beta', page: 'docs/patterns/p02-beta.md', suite: 'tests/agents/p02-beta.test.ts' },
  { pattern: 'P3', team: 'gamma', page: 'docs/patterns/p03-gamma.md', suite: 'tests/agents/p03-gamma.test.ts' },
];

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function write(root: string, path: string, text: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), text);
}

function sh(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

interface Fixture {
  readonly root: string;
  /** The commit the green gate ran at: gate.json's `commit`. */
  readonly base: string;
}

/**
 * A repository with three demos A, B, C (alpha, beta, gamma), their pages, renders, diagrams, suites and teams, an
 * unlisted team, a catalogue page, shared files and results files, committed as the base; then a commit holding the
 * green gate's record, naming the base, with the test's fake fingerprint and the sha256 of the results file it checked.
 * `gate` overrides the record's fields (`null` leaves the record out).
 */
let template: Fixture | undefined;
afterAll(() => {
  if (template !== undefined) rmSync(template.root, { recursive: true, force: true });
});

/** The base commit every fixture starts from, built once for this file and copied: a fixture costs a copy, not a dozen git commands. */
function baseRepository(): Fixture {
  if (template !== undefined) return template;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'asha-selector-template-')));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 'selector@example.invalid');
  sh(root, 'config', 'user.name', 'selector');
  sh(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'tests/agents/patterns/demos.json', `${JSON.stringify(DEMOS, null, 2)}\n`);
  for (const d of DEMOS) {
    write(root, d.page, `# ${d.pattern}\n`);
    write(root, d.page.replace(/\.md$/, '.html'), '<p>render</p>\n');
    write(root, d.suite, '// suite\n');
    write(root, `teams/${d.team}/team.json`, '{}\n');
    write(root, `teams/${d.team}/guide.md`, 'guide\n');
  }
  write(root, 'docs/patterns/p02-beta.svg', '<svg/>\n');
  write(root, 'docs/patterns/p02-beta-flow.svg', '<svg/>\n');
  write(root, 'docs/patterns/index.md', '# Patterns\n');
  write(root, 'docs/other/page.md', '# Other\n');
  write(root, 'teams/unlisted/team.json', '{}\n');
  write(root, 'src/x.ts', 'export {};\n');
  write(root, 'images/hello/image.json', '{}\n');
  write(root, 'tests/agents/results/p01-alpha.json', '{"suite":"p01-alpha"}\n');
  write(root, 'evals/routing/results/q.json', '{}\n');
  write(root, '.gitignore', 'ignored/\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-qm', 'base');
  template = { root, base: sh(root, 'rev-parse', 'HEAD').trim() };
  return template;
}

function fixture(gate: Record<string, unknown> | null = {}): Fixture {
  const { root: from, base } = baseRepository();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'asha-selector-')));
  roots.push(root);
  cpSync(from, root, { recursive: true });
  if (gate !== null) {
    const record = {
      commit: base,
      dirty: false,
      mode: 'check',
      environment: FAKE,
      results: { 'tests/agents/results/p01-alpha.json': sha256('{"suite":"p01-alpha"}\n') },
      ...gate,
    };
    write(root, 'tests/agents/results/gate.json', `${JSON.stringify(record, null, 2)}\n`);
    sh(root, 'add', '-A');
    sh(root, 'commit', '-qm', 'gate results');
  }
  return { root, base };
}

/** A runner that runs every command for real and records each call; `answer` may replace a call's result. */
class RecordingRunner implements CommandRunner {
  readonly calls: { command: string; args: readonly string[]; options: RunOptions }[] = [];
  constructor(
    private readonly answer: (args: readonly string[]) => CommandResult | Error | undefined = () => undefined,
  ) {}
  async run(command: string, args: readonly string[], options: RunOptions): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    const replaced = this.answer(args);
    if (replaced instanceof Error) throw replaced;
    if (replaced !== undefined) return replaced;
    return new ExecCommandRunner().run(command, args, options);
  }

  /** The selector never streams a command; a call here is a defect the test should see. */
  stream(command: string): Promise<StreamResult> {
    return Promise.reject(new Error(`RecordingRunner: the selector streamed ${command}`));
  }
}

/** A git call's own arguments, after `-C <root>` and the selector's config overrides. */
const gitArgs = (args: readonly string[]): readonly string[] => args.slice(2 + GIT_OVERRIDES.length);

interface Run {
  readonly record: SelectionRecord;
  readonly fingerprints: number;
}

async function selectIn(
  root: string,
  options: { mode?: 'check' | 'full'; fingerprint?: Fingerprint; runner?: CommandRunner; files?: FileOps } = {},
): Promise<Run> {
  let fingerprints = 0;
  const record = await select({
    root,
    mode: options.mode ?? 'check',
    runner: options.runner ?? new ExecCommandRunner(),
    fingerprint: () => {
      fingerprints += 1;
      return Promise.resolve(options.fingerprint ?? FAKE);
    },
    files: options.files ?? nodeFileOps,
  });
  return { record, fingerprints };
}

const counts = (record: SelectionRecord): number[] => record.demos.map((d) => d.repeats);
const reasons = (record: SelectionRecord): string[] => record.demos.map((d) => d.reason);

describe('which demos a change touches (orchestration-patterns A8 cases 1–8, 15)', () => {
  it('(1) a file in teams/alpha/ repeats only A, own', async () => {
    const { root } = fixture();
    write(root, 'teams/alpha/guide.md', 'changed\n');
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([3, 1, 1]);
    expect(reasons(record)).toEqual(['own: teams/alpha/guide.md', 'untouched', 'untouched']);
  });

  it.each([
    'docs/patterns/p02-beta.md',
    'docs/patterns/p02-beta.html',
    'docs/patterns/p02-beta.svg',
    'docs/patterns/p02-beta-flow.svg',
  ])("(2) B's page, its render, or a diagram, %s, repeats only B", async (path) => {
    {
      const { root } = fixture();
      write(root, path, 'changed\n');
      const { record } = await selectIn(root);
      expect(counts(record), path).toEqual([1, 3, 1]);
      expect(reasons(record), path).toEqual(['untouched', `own: ${path}`, 'untouched']);
    }
  });

  it('(3) a file under src/ repeats every demo, shared', async () => {
    const { root } = fixture();
    write(root, 'src/x.ts', 'export const x = 1;\n');
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([3, 3, 3]);
    expect(reasons(record)).toEqual(['shared: src/x.ts', 'shared: src/x.ts', 'shared: src/x.ts']);
  });

  it.each([
    'docs/other/page.md',
    'tests/agents/results/p01-alpha.json',
    'evals/routing/results/q.json',
    'docs/patterns/videos/p02-beta.webm',
    'docs/patterns/videos/p02-beta.json',
  ])(
    '(4) %s, outside docs/patterns/, under a results path, or a video or its sidecar (demo-videos R11), touches no demo',
    async (path) => {
      {
        const { root } = fixture();
        write(root, path, 'changed\n');
        const { record } = await selectIn(root);
        expect(counts(record), path).toEqual([1, 1, 1]);
        expect(record.changed, path).toEqual([...new Set([path, 'tests/agents/results/gate.json'])].sort(byCodeUnit));
      }
    },
  );

  it('(5) an untracked new file under images/ repeats every demo', async () => {
    const { root } = fixture();
    write(root, 'images/hello/new.txt', 'new\n');
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([3, 3, 3]);
    expect(reasons(record)).toEqual([
      'shared: images/hello/new.txt',
      'shared: images/hello/new.txt',
      'shared: images/hello/new.txt',
    ]);
  });

  it("(6) a move from A's folder to B's, committed and staged, repeats both, own", async () => {
    const committed = fixture();
    sh(committed.root, 'mv', 'teams/alpha/guide.md', 'teams/beta/moved.md');
    sh(committed.root, 'commit', '-qm', 'move');
    const a = await selectIn(committed.root);
    expect(counts(a.record)).toEqual([3, 3, 1]);
    expect(reasons(a.record)).toEqual(['own: teams/alpha/guide.md', 'own: teams/beta/moved.md', 'untouched']);

    const staged = fixture();
    sh(staged.root, 'mv', 'teams/alpha/guide.md', 'teams/beta/moved.md');
    const b = await selectIn(staged.root);
    expect(counts(b.record)).toEqual([3, 3, 1]);
    expect(reasons(b.record)).toEqual(['own: teams/alpha/guide.md', 'own: teams/beta/moved.md', 'untouched']);
  });

  it('(6) a committed move from A to B undone by a staged move back repeats both: only the diff against HEAD sees it', async () => {
    const { root } = fixture();
    sh(root, 'mv', 'teams/alpha/guide.md', 'teams/beta/moved.md');
    sh(root, 'commit', '-qm', 'move');
    sh(root, 'mv', 'teams/beta/moved.md', 'teams/alpha/guide.md');
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([3, 3, 1]);
    expect(reasons(record)).toEqual(['own: teams/alpha/guide.md', 'own: teams/beta/moved.md', 'untouched']);
  });

  it("(7) a file deleted from A's folder repeats A", async () => {
    const { root } = fixture();
    rmSync(join(root, 'teams/alpha/guide.md'));
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([3, 1, 1]);
    expect(reasons(record)[0]).toBe('own: teams/alpha/guide.md');
  });

  it.each(['teams/unlisted/team.json', 'docs/patterns/index.md'])(
    '(8) %s, a team folder no demo lists or the catalogue page, repeats every demo, shared',
    async (path) => {
      {
        const { root } = fixture();
        write(root, path, 'changed\n');
        const { record } = await selectIn(root);
        expect(counts(record), path).toEqual([3, 3, 3]);
        expect(reasons(record), path).toEqual([`shared: ${path}`, `shared: ${path}`, `shared: ${path}`]);
      }
    },
  );

  it("(15) a sibling folder sharing team A's name as a prefix is shared, not A's", async () => {
    const { root } = fixture();
    write(root, 'teams/alphax/team.json', '{}\n');
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([3, 3, 3]);
    expect(reasons(record)).toEqual([
      'shared: teams/alphax/team.json',
      'shared: teams/alphax/team.json',
      'shared: teams/alphax/team.json',
    ]);
  });

  it('a demo touched by an own path and a shared path gives own', async () => {
    const { root } = fixture();
    write(root, 'teams/gamma/guide.md', 'changed\n');
    write(root, 'src/x.ts', 'changed\n');
    const { record } = await selectIn(root);
    expect(reasons(record)).toEqual(['shared: src/x.ts', 'shared: src/x.ts', 'own: teams/gamma/guide.md']);
  });

  it("nothing changed since the base but the gate's own results: every demo once", async () => {
    const { root, base } = fixture();
    const { record } = await selectIn(root);
    expect(record.base).toBe(base);
    expect(record.changed).toEqual(['tests/agents/results/gate.json']);
    expect(counts(record)).toEqual([1, 1, 1]);
  });
});

describe('the base (orchestration-patterns A8 case 9; demo-selector R6)', () => {
  it.each([
    ['no gate.json', null, 'no-record'],
    ['one that does not parse', {}, 'unreadable'],
    ['one with dirty: true', { dirty: true }, 'dirty'],
  ])('%s gives 3, 3, 3 and no-base', async (_, gate, why) => {
    const { root } = fixture(gate);
    if (why === 'unreadable') {
      write(root, 'tests/agents/results/gate.json', '{ not json');
      sh(root, 'commit', '-qam', 'broken record');
    }
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([3, 3, 3]);
    expect(reasons(record)).toEqual([`no-base: ${why}`, `no-base: ${why}`, `no-base: ${why}`]);
    expect(record.base).toBeNull();
    expect(record.changed).toBeNull();
  });

  it('an environment that differs gives no-base: environment changed, naming the keys', async () => {
    const { root } = fixture();
    const { record } = await selectIn(root, { fingerprint: { ...FAKE, node: 'v24.0.0', models: {} } });
    expect(reasons(record)).toEqual([
      'no-base: environment changed',
      'no-base: environment changed',
      'no-base: environment changed',
    ]);
    expect(record.baseDetail).toBe('differs: models, node');
  });

  it('a commit that is not an ancestor of HEAD, and one git does not hold', async () => {
    const outside = fixture();
    const orphan = sh(outside.root, 'commit-tree', `${outside.base}^{tree}`, '-m', 'orphan').trim();
    const gate = JSON.parse(readFileSync(join(outside.root, 'tests/agents/results/gate.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    write(outside.root, 'tests/agents/results/gate.json', JSON.stringify({ ...gate, commit: orphan }));
    sh(outside.root, 'commit', '-qam', 'a record naming a commit off this history');
    const a = await selectIn(outside.root);
    expect(reasons(a.record)).toEqual(['no-base: not-ancestor', 'no-base: not-ancestor', 'no-base: not-ancestor']);
    expect(a.record.baseDetail).toBe(`${orphan} is not an ancestor of HEAD`);

    const unknown = fixture({ commit: '0123456789abcdef0123456789abcdef01234567' });
    const b = await selectIn(unknown.root);
    expect(reasons(b.record)).toEqual([
      'no-base: unknown-commit',
      'no-base: unknown-commit',
      'no-base: unknown-commit',
    ]);
    expect(b.record.baseDetail).toBe('fatal: Not a valid commit name 0123456789abcdef0123456789abcdef01234567');
  });

  it('(d) refuses a commit that is not 40 hex without passing it to git, one naming HEAD, a string dirty, and results that differ at HEAD', async () => {
    const relative = fixture({ commit: 'HEAD~1' });
    const runner = new RecordingRunner();
    const a = await selectIn(relative.root, { runner });
    expect(a.record.baseReason).toBe('no-base: unreadable');
    expect(a.record.baseDetail).toBe('tests/agents/results/gate.json: commit is not 40 lowercase hex characters');
    expect(runner.calls.filter((c) => c.args.some((arg) => arg.includes('HEAD~1')))).toEqual([]);

    // A commit cannot hold a record naming itself, so the committed record is replaced as git reads it.
    const self = fixture();
    const head = sh(self.root, 'rev-parse', 'HEAD').trim();
    const record = JSON.parse(readFileSync(join(self.root, 'tests/agents/results/gate.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    const b = await computeSelection({
      root: self.root,
      mode: 'check',
      runner: new RecordingRunner((args) =>
        args.includes('cat-file') && args.at(-1) === 'HEAD:tests/agents/results/gate.json'
          ? ok(JSON.stringify({ ...record, commit: head }))
          : undefined,
      ),
      fingerprint: () => Promise.resolve(FAKE),
      files: nodeFileOps,
    });
    expect(b.baseReason).toBe('no-base: unreadable');
    expect(b.baseDetail).toBe(
      'tests/agents/results/gate.json: commit is HEAD itself, which cannot hold a record of itself',
    );

    const stringDirty = fixture({ dirty: 'false' });
    expect((await selectIn(stringDirty.root)).record.baseDetail).toBe(
      'tests/agents/results/gate.json: dirty is not a boolean',
    );

    const differs = fixture();
    write(differs.root, 'tests/agents/results/p01-alpha.json', '{"suite":"p01-alpha","edited":true}\n');
    sh(differs.root, 'commit', '-qam', 'results changed after the gate');
    const c = await selectIn(differs.root);
    expect(c.record.baseReason).toBe('no-base: unreadable');
    expect(c.record.baseDetail).toBe(
      'tests/agents/results/p01-alpha.json at HEAD is not the file tests/agents/results/gate.json checked (sha256 differs)',
    );
  });

  it('refuses a results map that is empty, names a path outside the results paths, or a file HEAD does not hold', async () => {
    const empty = fixture({ results: {} });
    expect((await selectIn(empty.root)).record.baseDetail).toBe(
      'tests/agents/results/gate.json: results is not a non-empty object of results files and their sha256',
    );
    const outside = fixture({ results: { 'src/x.ts': 'b'.repeat(64) } });
    expect((await selectIn(outside.root)).record.baseDetail).toBe(
      'tests/agents/results/gate.json: results names src/x.ts, outside the results paths',
    );
    const missing = fixture({ results: { 'tests/agents/results/gone.json': 'b'.repeat(64) } });
    expect((await selectIn(missing.root)).record.baseDetail).toBe(
      'tests/agents/results/gone.json, which tests/agents/results/gate.json checked, is not at HEAD',
    );
  });

  it('reads gate.json from HEAD, never from the working tree', async () => {
    const { root, base } = fixture(null);
    const record = {
      commit: base,
      dirty: false,
      environment: FAKE,
      results: { 'tests/agents/results/p01-alpha.json': sha256('{"suite":"p01-alpha"}\n') },
    };
    write(root, 'tests/agents/results/gate.json', JSON.stringify(record));
    const { record: selection } = await selectIn(root);
    expect(selection.baseReason).toBe('no-base: no-record');
    expect(selection.baseDetail).toBe('HEAD holds no tests/agents/results/gate.json');
  });

  it('(e) computes no fingerprint with no record, or with a dirty one', async () => {
    expect((await selectIn(fixture(null).root)).fingerprints).toBe(0);
    expect((await selectIn(fixture({ dirty: true }).root)).fingerprints).toBe(0);
    expect((await selectIn(fixture().root)).fingerprints).toBe(1);
  });

  it('(f) an unavailable fingerprint entry refuses the base, even beside an identical record', async () => {
    const unavailable = { ...FAKE, docker: 'unavailable: colima status --profile default --json: exit 1: not running' };
    const { root } = fixture({ environment: unavailable });
    const { record } = await selectIn(root, { fingerprint: unavailable });
    expect(record.baseReason).toBe('no-base: environment changed');
    expect(record.baseDetail).toBe('unavailable: docker (colima status --profile default --json: exit 1: not running)');
  });

  it('(10) full mode gives every demo 3, full, with no base and no changed files', async () => {
    const { root } = fixture();
    write(root, 'src/x.ts', 'changed\n');
    const { record, fingerprints } = await selectIn(root, { mode: 'full' });
    expect(record).toEqual({
      commit: sh(root, 'rev-parse', 'HEAD').trim(),
      mode: 'full',
      base: null,
      baseReason: 'full',
      baseDetail: null,
      changed: null,
      demos: DEMOS.map((d) => ({ pattern: d.pattern, suite: d.suite, repeats: 3, reason: 'full' })),
    });
    expect(fingerprints).toBe(0);
  });
});

describe("what git hides (demo-selector R2's additions)", () => {
  it('(a) an untracked file under images/ listed in .git/info/exclude is still changed', async () => {
    const { root } = fixture();
    write(root, 'images/hello/hidden.txt', 'hidden\n');
    writeFileSync(join(root, '.git/info/exclude'), 'images/hello/hidden.txt\n', { flag: 'a' });
    const { record } = await selectIn(root);
    expect(reasons(record)).toEqual([
      'shared: images/hello/hidden.txt',
      'shared: images/hello/hidden.txt',
      'shared: images/hello/hidden.txt',
    ]);
  });

  it('an untracked file the committed .gitignore ignores is not', async () => {
    const { root } = fixture();
    write(root, 'ignored/x.txt', 'x\n');
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([1, 1, 1]);
  });

  it.each([['--skip-worktree'], ['--assume-unchanged']])(
    "(b) a file in A's folder flagged %s and edited repeats A",
    async (flag) => {
      const { root } = fixture();
      sh(root, 'update-index', flag, 'teams/alpha/guide.md');
      write(root, 'teams/alpha/guide.md', 'edited behind the flag\n');
      expect(sh(root, 'diff', '--name-only', 'HEAD')).toBe('');
      const { record } = await selectIn(root);
      expect(counts(record)).toEqual([3, 1, 1]);
      expect(reasons(record)[0]).toBe('own: teams/alpha/guide.md');
    },
  );

  it.each([
    ['diff', '--name-only', '--no-renames', '-z', 'BASE'],
    ['diff', '--name-only', '--no-renames', '-z', 'HEAD'],
    ['ls-files', '--others', '--exclude-per-directory=.gitignore', '-z'],
    ['ls-files', '--others', '-z', '--', ':(glob)**/.gitignore', 'teams/', 'docs/patterns/', 'tests/agents/'],
    ['ls-files', '-v', '-z'],
    ['rev-parse', '--show-toplevel'],
    ['ls-tree', '-z', 'HEAD', '--', 'tests/agents/results/gate.json'],
    ['cat-file', 'blob', 'HEAD:tests/agents/results/gate.json'],
    ['rev-parse', '--verify', 'HEAD'],
  ])('(c) git %s exiting 128 fails the step naming it, and writes nothing', async (...command) => {
    const { root, base } = fixture();
    const target = command.map((a) => (a === 'BASE' ? base : a));
    const runner = new RecordingRunner((args) =>
      gitArgs(args).join(' ') === target.join(' ') ? fail(128, 'fatal: bad object') : undefined,
    );
    await expect(selectIn(root, { runner })).rejects.toThrow(
      new SelectionFailed(`git ${target.join(' ')} exited 128: fatal: bad object`),
    );
    expect(existsSync(join(root, SELECTION))).toBe(false);
  });

  it('(c) an is-ancestor status other than 0, 1 and 128 fails naming it; a git not found or timing out fails; every git call is bounded', async () => {
    const { root } = fixture();
    const odd = new RecordingRunner((args) => (gitArgs(args)[0] === 'merge-base' ? fail(129, 'usage') : undefined));
    await expect(selectIn(root, { runner: odd })).rejects.toThrow(
      /^git merge-base --is-ancestor [0-9a-f]{40} HEAD exited 129: usage$/,
    );
    await expect(selectIn(root, { runner: new RecordingRunner(() => new CommandNotFound('git')) })).rejects.toThrow(
      'command not found on PATH: git',
    );
    await expect(
      selectIn(root, {
        runner: new RecordingRunner((args) =>
          gitArgs(args)[0] === 'ls-files' ? new CommandTimedOut('git', args, COMMAND_TIMEOUT_MS) : undefined,
        ),
      }),
    ).rejects.toThrow(/did not finish within 30000 ms/);
    const runner = new RecordingRunner();
    await selectIn(root, { runner });
    expect(runner.calls.length).toBeGreaterThan(5);
    expect(
      runner.calls.every(
        (c) => c.command === 'git' && c.args[0] === '-C' && c.args[1] === root && c.options.timeoutMs === 30_000,
      ),
    ).toBe(true);
    // Each machine-local setting that could hide a change is overridden on every call, by name (the completion
    // review, finding 2: only core.fileMode's effect is reproducible in a test, so each override is asserted here).
    const overrides = new Set(runner.calls.map((c) => JSON.stringify(c.args.slice(2, 8))));
    expect([...overrides]).toEqual([
      JSON.stringify(['-c', 'core.fileMode=true', '-c', 'core.fsmonitor=false', '-c', 'diff.ignoreSubmodules=none']),
    ]);
  });

  it("(g) a link in a demo's own paths fails the step naming it", async () => {
    const folder = fixture();
    rmSync(join(folder.root, 'teams/alpha'), { recursive: true });
    symlinkSync(join(folder.root, 'docs/other'), join(folder.root, 'teams/alpha'));
    write(folder.root, 'docs/other/team.json', '{}\n');
    await expect(selectIn(folder.root)).rejects.toThrow(
      "P1: teams/alpha is not a real directory; a change reached through a link is reported under its target's path",
    );

    const inside = fixture();
    symlinkSync('../../docs/other/page.md', join(inside.root, 'teams/beta/borrowed.md'));
    await expect(selectIn(inside.root)).rejects.toThrow('P2: teams/beta/borrowed.md is a symlink');
    sh(inside.root, 'add', 'teams/beta/borrowed.md');
    sh(inside.root, 'commit', '-qm', 'tracked link');
    await expect(selectIn(inside.root)).rejects.toThrow('P2: teams/beta/borrowed.md is a symlink');

    const suite = fixture();
    const demo3 = present(DEMOS[2], 'DEMOS[2]');
    rmSync(join(suite.root, demo3.suite));
    symlinkSync(join(suite.root, 'src/x.ts'), join(suite.root, demo3.suite));
    await expect(selectIn(suite.root)).rejects.toThrow(
      'P3: tests/agents/p03-gamma.test.ts is reached through a symlink',
    );

    const page = fixture();
    const demo2 = present(DEMOS[1], 'DEMOS[1]');
    rmSync(join(page.root, demo2.page));
    symlinkSync(join(page.root, 'docs/other/page.md'), join(page.root, demo2.page));
    await expect(selectIn(page.root)).rejects.toThrow('P2: docs/patterns/p02-beta.md is reached through a symlink');
  });

  it("(g) a folder above a demo's own paths that is a link fails the step naming the path (the code review, finding 2)", async () => {
    for (const [dir, message] of [
      ['teams', 'P1: teams/alpha is reached through a symlink'],
      ['docs/patterns', 'P1: docs/patterns/p01-alpha.md is reached through a symlink'],
    ] as const) {
      const { root } = fixture();
      cpSync(join(root, dir), join(root, 'elsewhere'), { recursive: true });
      rmSync(join(root, dir), { recursive: true });
      symlinkSync(join(root, 'elsewhere'), join(root, dir));
      await expect(selectIn(root), dir).rejects.toThrow(message);
    }
  });

  it('a team name that is not a plain folder name fails the step', async () => {
    const { root } = fixture();
    write(root, 'teams/_alpha/team.json', '{}\n');
    write(root, 'tests/agents/patterns/demos.json', JSON.stringify([{ ...DEMOS[0], team: '_alpha' }]));
    await expect(selectIn(root)).rejects.toThrow('P1: team "_alpha" is not a plain folder name');
  });

  it('a git work tree other than the root (an inherited GIT_DIR) fails the step', async () => {
    const { root } = fixture();
    const runner = new RecordingRunner((args) =>
      gitArgs(args).join(' ') === 'rev-parse --show-toplevel' ? ok(`${tmpdir()}\n`) : undefined,
    );
    await expect(selectIn(root, { runner })).rejects.toThrow(
      `git's work tree is ${tmpdir()}, not ${root} (is GIT_DIR or GIT_WORK_TREE set?)`,
    );
  });

  it('an untracked .gitignore that hides itself and a new file beside it repeats the demo (the code review, finding 1)', async () => {
    const { root } = fixture();
    write(root, 'teams/alpha/.gitignore', '*\n');
    write(root, 'teams/alpha/new-doc.md', 'new\n');
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([3, 1, 1]);
    expect(reasons(record)[0]).toBe('own: teams/alpha/.gitignore');
    expect(record.changed).toContain('teams/alpha/new-doc.md');

    const rootIgnore = fixture();
    write(rootIgnore.root, 'images/.gitignore', '*\n');
    write(rootIgnore.root, 'images/hello/new.txt', 'new\n');
    expect(reasons((await selectIn(rootIgnore.root)).record)).toEqual([
      'shared: images/.gitignore',
      'shared: images/.gitignore',
      'shared: images/.gitignore',
    ]);
  });

  it('a file in a team folder that the committed .gitignore ignores repeats the demo (finding 12)', async () => {
    const { root } = fixture();
    write(root, 'teams/beta/ignored/notes.md', 'notes\n');
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([1, 3, 1]);
    expect(reasons(record)[1]).toBe('own: teams/beta/ignored/notes.md');
  });

  it('a mode change hidden by core.fileMode=false repeats the demo (finding 4)', async () => {
    const { root } = fixture();
    sh(root, 'config', 'core.fileMode', 'false');
    chmodSync(join(root, 'teams/alpha/guide.md'), 0o755);
    expect(sh(root, 'diff', '--name-only', 'HEAD')).toBe('');
    const { record } = await selectIn(root);
    expect(counts(record)).toEqual([3, 1, 1]);
  });

  it('a path starting docs but not docs/, and a results path climbing out with .., are not docs-only or results', async () => {
    const { root } = fixture();
    write(root, 'docsx/a.md', 'x\n');
    expect(reasons((await selectIn(root)).record)).toEqual([
      'shared: docsx/a.md',
      'shared: docsx/a.md',
      'shared: docsx/a.md',
    ]);
    const climbing = fixture({ results: { 'tests/agents/results/../../../src/x.ts': 'b'.repeat(64) } });
    expect((await selectIn(climbing.root)).record.baseDetail).toBe(
      'tests/agents/results/gate.json: results names tests/agents/results/../../../src/x.ts, outside the results paths',
    );
  });
});

describe('the selection record (A8 cases 11, 12, 14; demo-selector R8, R9)', () => {
  it("(11) holds the base, the changed files and each demo's line exactly, and removes the .r2 and .r3 files of the demos selected once", async () => {
    const { root, base } = fixture();
    for (const stem of ['p01-alpha', 'p02-beta', 'p03-gamma'])
      for (const n of [1, 2, 3]) write(root, `tests/agents/results/${stem}.r${String(n)}.json`, '{}\n');
    sh(root, 'add', '-A');
    sh(root, 'commit', '-qm', 'earlier repeats');
    write(root, 'teams/beta/guide.md', 'changed\n');
    await selectIn(root);
    const head = sh(root, 'rev-parse', 'HEAD').trim();
    const expected = {
      commit: head,
      mode: 'check',
      base,
      baseReason: 'last green gate',
      baseDetail: null,
      changed: [
        'teams/beta/guide.md',
        'tests/agents/results/gate.json',
        'tests/agents/results/p01-alpha.r1.json',
        'tests/agents/results/p01-alpha.r2.json',
        'tests/agents/results/p01-alpha.r3.json',
        'tests/agents/results/p02-beta.r1.json',
        'tests/agents/results/p02-beta.r2.json',
        'tests/agents/results/p02-beta.r3.json',
        'tests/agents/results/p03-gamma.r1.json',
        'tests/agents/results/p03-gamma.r2.json',
        'tests/agents/results/p03-gamma.r3.json',
      ],
      demos: [
        { pattern: 'P1', suite: 'tests/agents/p01-alpha.test.ts', repeats: 1, reason: 'untouched' },
        { pattern: 'P2', suite: 'tests/agents/p02-beta.test.ts', repeats: 3, reason: 'own: teams/beta/guide.md' },
        { pattern: 'P3', suite: 'tests/agents/p03-gamma.test.ts', repeats: 1, reason: 'untouched' },
      ],
    };
    expect(readFileSync(join(root, SELECTION), 'utf8')).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    const left = readdirSync(join(root, 'tests/agents/results')).sort(byCodeUnit);
    expect(left).toEqual([
      'gate.json',
      'p01-alpha.json',
      'p01-alpha.r1.json',
      'p02-beta.r1.json',
      'p02-beta.r2.json',
      'p02-beta.r3.json',
      'p03-gamma.r1.json',
      'selection.json',
    ]);
  });

  it('writes with no base as R8 gives it, and leaves no temporary file', async () => {
    const { root } = fixture(null);
    await selectIn(root);
    const text = readFileSync(join(root, SELECTION), 'utf8');
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'commit',
      'mode',
      'base',
      'baseReason',
      'baseDetail',
      'changed',
      'demos',
    ]);
    expect(JSON.parse(text)).toMatchObject({
      mode: 'check',
      base: null,
      baseReason: 'no-base: no-record',
      baseDetail: 'HEAD holds no tests/agents/results/gate.json',
      changed: null,
    });
    expect(readdirSync(join(root, 'tests/agents/results')).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('writes through a rename; a failed rename removes the temporary file, writes no selection and fails', async () => {
    const { root } = fixture(null);
    const seen: string[] = [];
    const files: FileOps = {
      ...nodeFileOps,
      write: (path, text) => {
        seen.push(`write ${path}`);
        nodeFileOps.write(path, text);
      },
      rename: (from, to) => {
        seen.push(`rename ${from} ${to}`);
        throw new Error('EXDEV: cross-device link');
      },
    };
    await expect(selectIn(root, { files })).rejects.toThrow(`writing ${SELECTION} failed: EXDEV: cross-device link`);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^write .*\/tests\/agents\/results\/\.selection-\d+-[0-9a-f]{12}\.json$/);
    expect(seen[1]).toBe(`rename ${present(seen[0], 'seen[0]').slice('write '.length)} ${join(root, SELECTION)}`);
    expect(existsSync(join(root, SELECTION))).toBe(false);
    expect(readdirSync(join(root, 'tests/agents/results')).filter((f) => f.startsWith('.'))).toEqual([]);
  });

  it('a deletion that fails with other than a missing file fails the step', async () => {
    const { root } = fixture();
    const files: FileOps = {
      ...nodeFileOps,
      remove: () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    };
    await expect(selectIn(root, { files })).rejects.toThrow('EACCES: permission denied');
    expect(existsSync(join(root, SELECTION))).toBe(false);
  });

  it('the repository ignores the temporary files', () => {
    expect(
      execFileSync('git', ['-C', REPO, 'check-ignore', 'tests/agents/results/.selection-1-abcdef012345.json'], {
        encoding: 'utf8',
      }).trim(),
    ).toBe('tests/agents/results/.selection-1-abcdef012345.json');
  });

  it('(12) repeats 2 and 3 read the three-repeat suites; no file, a malformed one, or one at another commit fails naming it', async () => {
    const { root } = fixture();
    const runner = new ExecCommandRunner();
    await expect(suitesForRepeat({ runner, root, repeat: 2 })).rejects.toThrow(
      new SelectionUnusable('missing: run npm run demos:select before the agent suite'),
    );
    write(root, 'teams/beta/guide.md', 'changed\n');
    await selectIn(root);
    expect(await suitesForRepeat({ runner, root, repeat: 2 })).toEqual(['tests/agents/p02-beta.test.ts']);
    expect(await suitesForRepeat({ runner, root, repeat: 3 })).toEqual(['tests/agents/p02-beta.test.ts']);
    await expect(suitesForRepeat({ runner, root, repeat: 1 })).rejects.toThrow(
      `${SELECTION}: repeat 1 does not read the selection`,
    );
    await expect(suitesForRepeat({ runner, root, repeat: 4 })).rejects.toThrow(
      `${SELECTION}: repeat 4 does not read the selection`,
    );
    sh(root, 'commit', '-qam', 'a later commit');
    await expect(suitesForRepeat({ runner, root, repeat: 2 })).rejects.toThrow(
      /^tests\/agents\/results\/selection\.json: computed at [0-9a-f]{40}, not at HEAD [0-9a-f]{40}: run npm run demos:select again$/,
    );
    write(root, SELECTION, '{"commit":"x"}');
    await expect(suitesForRepeat({ runner, root, repeat: 2 })).rejects.toThrow(
      `${SELECTION}: must be an object with exactly commit, mode, base, baseReason, baseDetail, changed, demos, in that order`,
    );
    expect(() => parseSelection('{')).toThrow(`${SELECTION}: not valid JSON`);
  });

  it('(14) the same selection twice, the clock moved a day between, is byte-identical', async () => {
    const { root } = fixture();
    write(root, 'teams/alpha/guide.md', 'changed\n');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-29T12:00:00Z'));
    await selectIn(root);
    const first = readFileSync(join(root, SELECTION), 'utf8');
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    await selectIn(root);
    expect(readFileSync(join(root, SELECTION), 'utf8')).toBe(first);
  });
});

describe('the manifest (A8 case 13, first half)', () => {
  it('a manifest naming one pattern twice fails the step naming it', async () => {
    const { root } = fixture();
    write(root, 'tests/agents/patterns/demos.json', JSON.stringify([DEMOS[0], DEMOS[0]]));
    await expect(selectIn(root)).rejects.toThrow('tests/agents/patterns/demos.json: P1 is listed twice');
  });
});

describe('the one results-paths constant (A8)', () => {
  it("is the two results paths, and support.ts's dirty check builds its pathspecs from it, spelling neither", () => {
    expect(RESULTS_PATHS).toEqual(['tests/agents/results/', 'evals/routing/results/']);
    const support = readFileSync(join(REPO, 'tests/agents/support.ts'), 'utf8');
    expect(support).toContain("import { RESULTS_PATHS } from '../../evals/patterns/selection.js';");
    expect(support).toContain('RESULTS_PATHS.map((path) => `:!${path}`)');
    expect(support).not.toMatch(/tests\/agents\/results'|evals\/routing\/results/);
  });

  it('and support.ts reads its model cache from harnessPaths, as the fingerprint does (R7)', () => {
    const support = readFileSync(join(REPO, 'tests/agents/support.ts'), 'utf8');
    expect(support).toContain(
      "ASHA_MODELS_DIR: harnessPaths({ ASHA_MODELS_DIR: process.env['ASHA_MODELS_DIR'] }).modelsDir,",
    );
    expect(support).not.toContain('.simplyautonomous');
    expect(readFileSync(join(REPO, 'evals/patterns/select.ts'), 'utf8')).toContain(
      "harnessPaths({ ASHA_MODELS_DIR: process.env['ASHA_MODELS_DIR'] }).modelsDir",
    );
  });
});

describe('the environment fingerprint (demo-selector R7, A3)', () => {
  const SOCKET = 'unix:///Users/someone/.colima/default/docker.sock';
  const STATUS = JSON.stringify({ runtime: 'docker', docker_socket: SOCKET });
  const LLAMA = {
    code: 0,
    stdout: '',
    stderr:
      '0.00.000.062 I srv  llama_server: initializing ...\nversion: 0.5.0 (build 11146, commit 7fe450e19)\nbuilt with AppleClang 21.0.0.21000334 for Darwin arm64\n',
  };

  /** A root holding two demos' teams (one with an embedding model), the catalogue, and a lockfile; a models directory with one model cached. */
  function fingerprintRoot(): {
    root: string;
    modelsDir: string;
    demos: typeof DEMOS;
    cached: string;
    embedding: string;
  } {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'asha-fingerprint-')));
    roots.push(root);
    cpSync(join(REPO, 'teams/delegation'), join(root, 'teams/delegation'), { recursive: true });
    cpSync(join(REPO, 'teams/suite-memory-pair'), join(root, 'teams/suite-memory-pair'), { recursive: true });
    cpSync(join(REPO, 'catalogue'), join(root, 'catalogue'), { recursive: true });
    write(root, 'node_modules/.package-lock.json', '{"lockfileVersion":3}\n');
    const digest = (id: string): string => {
      const file = join(REPO, 'catalogue', `${id}.json`);
      return `sha256-${treeDigest(parseCatalogueEntry(JSON.parse(readFileSync(file, 'utf8')), file).files)}`;
    };
    const modelsDir = join(root, 'models');
    const cached = digest('qwen3-8b-q4_k_m');
    mkdirSync(join(modelsDir, cached), { recursive: true });
    const demos = [
      {
        pattern: 'P1',
        team: 'delegation',
        page: 'docs/patterns/p01-delegation.md',
        suite: 'tests/agents/p01-delegation.test.ts',
      },
      {
        pattern: 'P2',
        team: 'suite-memory-pair',
        page: 'docs/patterns/p02-pair.md',
        suite: 'tests/agents/p02-pair.test.ts',
      },
    ];
    return { root, modelsDir, demos, cached, embedding: digest('qwen3-embedding-0.6b-q8_0') };
  }

  const answering = (): FakeRunner =>
    new FakeRunner()
      .on('node --version', ok('v22.13.1\n'))
      .on('llama-server --version', LLAMA)
      .on('colima version', ok('colima version 0.10.3\nruntime: docker\n'))
      .on('colima status --profile default --json', ok(STATUS))
      .on('docker version', ok('Client: 29.8.1\nServer: 29.2.1\n'));

  it("reads every value, runs exactly the five commands bounded, docker against colima's socket", async () => {
    const f = fingerprintRoot();
    const runner = answering();
    expect(await environmentFingerprint({ runner, root: f.root, modelsDir: f.modelsDir, demos: f.demos })).toEqual({
      node: 'v22.13.1',
      llamaServer:
        'version: 0.5.0 (build 11146, commit 7fe450e19)\nbuilt with AppleClang 21.0.0.21000334 for Darwin arm64',
      colima: 'colima version 0.10.3\nruntime: docker',
      docker: 'Client: 29.8.1\nServer: 29.2.1',
      npmInstall: sha256('{"lockfileVersion":3}\n'),
      // The delegation team's greeter names pico-v2-q8_0 since demo-model-pico R3 (2026-10-10), absent from this cache.
      models: { 'pico-v2-q8_0': 'absent', 'qwen3-8b-q4_k_m': f.cached, 'qwen3-embedding-0.6b-q8_0': 'absent' },
    });
    expect(runner.lines()).toEqual([
      'node --version',
      'llama-server --version',
      'colima version',
      'colima status --profile default --json',
      'docker version',
    ]);
    expect(runner.calls.map((c) => c.options)).toEqual([
      { timeoutMs: 30_000 },
      { timeoutMs: 30_000 },
      { timeoutMs: 30_000 },
      { timeoutMs: 30_000 },
      { timeoutMs: 30_000, env: { DOCKER_HOST: SOCKET } },
    ]);
    expect(f.embedding).toMatch(/^sha256-[0-9a-f]{64}$/);
  });

  it('keeps llama-server\'s version and "built with" lines only, so its log line\'s elapsed time never changes the fingerprint (R7, amended 2026-09-29)', async () => {
    const f = fingerprintRoot();
    // FakeRunner answers the first matching prefix, so the scripted llama-server line comes first.
    const script = (elapsed: string, built: string): FakeRunner => {
      const r = new FakeRunner().on('llama-server --version', {
        code: 0,
        stdout: '',
        stderr: `${elapsed} I srv  llama_server: initializing ...\nversion: 0.5.0 (build 11146, commit 7fe450e19)\nbuilt with ${built}\n`,
      });
      return r
        .on('node --version', ok('v22.13.1\n'))
        .on('colima version', ok('c\n'))
        .on('colima status --profile default --json', ok(STATUS))
        .on('docker version', ok('d\n'));
    };
    const one = await environmentFingerprint({
      runner: script('0.00.000.062', 'AppleClang 21'),
      root: f.root,
      modelsDir: f.modelsDir,
      demos: f.demos,
    });
    const two = await environmentFingerprint({
      runner: script('0.00.000.080', 'AppleClang 21'),
      root: f.root,
      modelsDir: f.modelsDir,
      demos: f.demos,
    });
    expect(one.llamaServer).toBe('version: 0.5.0 (build 11146, commit 7fe450e19)\nbuilt with AppleClang 21');
    expect(two).toEqual(one);
    const rebuilt = await environmentFingerprint({
      runner: script('0.00.000.062', 'AppleClang 22'),
      root: f.root,
      modelsDir: f.modelsDir,
      demos: f.demos,
    });
    expect(rebuilt.llamaServer).toBe('version: 0.5.0 (build 11146, commit 7fe450e19)\nbuilt with AppleClang 22');
    // Lines separated by a bare carriage return, or indented, are still the build's lines (the bounded review, finding 7).
    const crOnly = new FakeRunner()
      .on('llama-server --version', {
        code: 0,
        stdout: '',
        stderr: '0.1 I log\r  version: 8130 (ed4837891)\r  built with cc for x\r',
      })
      .on('node --version', ok('v\n'))
      .on('colima version', ok('c\n'))
      .on('colima status --profile default --json', ok(STATUS))
      .on('docker version', ok('d\n'));
    expect(
      (await environmentFingerprint({ runner: crOnly, root: f.root, modelsDir: f.modelsDir, demos: f.demos }))
        .llamaServer,
    ).toBe('version: 8130 (ed4837891)\nbuilt with cc for x');
  });

  it.each([
    [
      'llama-server exiting 1',
      (r: FakeRunner) => r.on('llama-server --version', fail(1, 'dyld: missing')),
      'llamaServer',
      'unavailable: llama-server --version: exit 1: dyld: missing',
    ],
    [
      'llama-server not found',
      (r: FakeRunner) => r.on('llama-server --version', 'not-found'),
      'llamaServer',
      'unavailable: llama-server --version: not found',
    ],
    [
      'llama-server timing out',
      (r: FakeRunner) => r.on('llama-server --version', new CommandTimedOut('llama-server', ['--version'], 30_000)),
      'llamaServer',
      'unavailable: llama-server --version: timed out after 30000 ms',
    ],
    [
      'llama-server with no version line',
      (r: FakeRunner) => r.on('llama-server --version', ok('something else')),
      'llamaServer',
      'unavailable: llama-server --version: no version line',
    ],
    [
      'docker not found',
      (r: FakeRunner) => r.on('docker version', 'not-found'),
      'docker',
      'unavailable: docker version: not found',
    ],
    [
      'node timing out',
      (r: FakeRunner) => r.on('node --version', new CommandTimedOut('node', ['--version'], 30_000)),
      'node',
      'unavailable: node --version: timed out after 30000 ms',
    ],
  ])('%s gives that key unavailable', async (_, script, key, value) => {
    const f = fingerprintRoot();
    const runner = script(new FakeRunner());
    for (const [prefix, result] of [
      ['node --version', ok('v22\n')],
      ['llama-server --version', LLAMA],
      ['colima version', ok('c\n')],
      ['colima status', ok(STATUS)],
      ['docker version', ok('d\n')],
    ] as const)
      runner.on(prefix, result);
    const print = await environmentFingerprint({ runner, root: f.root, modelsDir: f.modelsDir, demos: f.demos });
    expect((print as unknown as Record<string, unknown>)[key]).toBe(value);
  });

  it('colima status failing, or naming no docker socket, leaves docker unavailable and unrun', async () => {
    for (const [status, value] of [
      [
        fail(1, 'colima is not running'),
        'unavailable: colima status --profile default --json: exit 1: colima is not running',
      ],
      [
        ok('{"runtime":"containerd"}'),
        'unavailable: colima status --profile default --json: colima status --json has no docker_socket (is the runtime docker?): {"runtime":"containerd"}',
      ],
    ] as const) {
      const f = fingerprintRoot();
      const runner = new FakeRunner()
        .on('node --version', ok('v\n'))
        .on('llama-server --version', LLAMA)
        .on('colima version', ok('c\n'))
        .on('colima status', status);
      const print = await environmentFingerprint({ runner, root: f.root, modelsDir: f.modelsDir, demos: f.demos });
      expect(print.docker).toBe(value);
      expect(runner.lines()).not.toContain('docker version');
    }
  });

  it('a missing lockfile is unavailable; an unexpected error throws', async () => {
    const f = fingerprintRoot();
    rmSync(join(f.root, 'node_modules'), { recursive: true });
    expect(
      (await environmentFingerprint({ runner: answering(), root: f.root, modelsDir: f.modelsDir, demos: f.demos }))
        .npmInstall,
    ).toBe('unavailable: node_modules/.package-lock.json: no such file');
    const broken = new FakeRunner().on('node --version', new Error('spawn EPERM'));
    await expect(
      environmentFingerprint({ runner: broken, root: f.root, modelsDir: f.modelsDir, demos: f.demos }),
    ).rejects.toThrow('spawn EPERM');
  });
});

describe('the demos:select entry (demo-selector R10, A5)', () => {
  function io(): { out: string[]; err: string[]; stdout: (l: string) => void; stderr: (l: string) => void } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (l) => out.push(l), stderr: (l) => err.push(l) };
  }
  const props = (root: string, argv: string[], streams: ReturnType<typeof io>) => ({
    argv,
    root,
    runner: new ExecCommandRunner(),
    fingerprint: () => Promise.resolve(FAKE),
    files: nodeFileOps,
    stdout: streams.stdout,
    stderr: streams.stderr,
  });

  it('selects, prints one line per demo and the file, and exits 0', async () => {
    const { root } = fixture();
    write(root, 'teams/alpha/guide.md', 'changed\n');
    const streams = io();
    expect(await main(props(root, [], streams))).toBe(0);
    expect(streams.out).toEqual([
      'P1 tests/agents/p01-alpha.test.ts: 3 repeats (own: teams/alpha/guide.md)',
      'P2 tests/agents/p02-beta.test.ts: 1 repeat (untouched)',
      'P3 tests/agents/p03-gamma.test.ts: 1 repeat (untouched)',
      'wrote tests/agents/results/selection.json',
    ]);
    expect(streams.err).toEqual([]);
  });

  it('--full selects every demo three times', async () => {
    const streams = io();
    expect(await main(props(fixture().root, ['--full'], streams))).toBe(0);
    expect(streams.out.slice(0, 3)).toEqual([
      'P1 tests/agents/p01-alpha.test.ts: 3 repeats (full)',
      'P2 tests/agents/p02-beta.test.ts: 3 repeats (full)',
      'P3 tests/agents/p03-gamma.test.ts: 3 repeats (full)',
    ]);
  });

  it('refuses any other argument, and a failure, with one JSON line on stderr and nothing written', async () => {
    const extra = io();
    expect(await main(props(fixture().root, ['--full', 'x'], extra))).toBe(1);
    expect(extra.err).toEqual([
      JSON.stringify({
        level: 'error',
        event: 'demos.select_failed',
        error: 'usage: demos:select [--full]; got ["--full","x"]',
      }),
    ]);

    const bogus = fixture();
    const a = io();
    expect(await main(props(bogus.root, ['--bogus'], a))).toBe(1);
    expect(a.err).toEqual([
      JSON.stringify({
        level: 'error',
        event: 'demos.select_failed',
        error: 'usage: demos:select [--full]; got ["--bogus"]',
      }),
    ]);
    expect(a.out).toEqual([]);
    expect(existsSync(join(bogus.root, SELECTION))).toBe(false);

    const twice = fixture();
    write(twice.root, 'tests/agents/patterns/demos.json', JSON.stringify([DEMOS[0], DEMOS[0]]));
    const b = io();
    expect(await main(props(twice.root, [], b))).toBe(1);
    expect(b.err.map((l) => JSON.parse(l) as unknown)).toEqual([
      { level: 'error', event: 'demos.select_failed', error: 'tests/agents/patterns/demos.json: P1 is listed twice' },
    ]);
    expect(existsSync(join(twice.root, SELECTION))).toBe(false);
  });
});
