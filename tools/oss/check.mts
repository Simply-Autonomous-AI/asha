// npm run oss:check -- <commit> (docs/plans/oss-release.md R8, R16; A7, A13): the published tree checked as a stranger
// gets it, stopping at the first failure. In a new run folder: the commit exported (R1); the marker scan (R9) and both
// secret scans — every commit of the export and its tree (R8); no shipped file model weights or over 5 MB; then a
// `git clone` of the export into a folder with nothing beside it, where `npm ci`, every other npm step CI runs (the
// linters, the formatter, the typecheck, the unit and integration tests, the secret scan), the build and
// `npm run release` run with CI=true, as on GitHub's runners, and the release's tarball must hold what R30 names. Each
// step's command, exit status, time and output go to the run's log, with the internal commit, whether its tree was
// dirty, and the gitleaks, Node and npm versions; the run folder is printed.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { exportRelease } from './export.mjs';
import { matchLine, readMarkers, scanMarkers } from './markers.mjs';
import { findingLine, gitleaksVersion, scanHistory, scanTracked } from './secrets.mjs';

/** The largest file the published tree may hold (R16). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Model weights, which are never published: the user's machine downloads them (R16). */
const WEIGHTS = ['.gguf', '.safetensors', '.bin', '.pt', '.pth'] as const;
/** What the release's tarball must hold beside the code (R30). */
export const TARBALL_HOLDS = ['README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.md'] as const;

/** Each published file that is model weights or larger than MAX_FILE_BYTES, named with why. */
export function sizeProblems(files: readonly { readonly path: string; readonly bytes: number }[]): string[] {
  return files.flatMap((f) => [
    ...(WEIGHTS.some((w) => f.path.toLowerCase().endsWith(w)) ? [`${f.path}: model weights`] : []),
    ...(f.bytes > MAX_FILE_BYTES ? [`${f.path}: ${String(f.bytes)} bytes, over ${String(MAX_FILE_BYTES)}`] : []),
  ]);
}

/** Of a tarball's entries (`asha-<version>/<path>`), each of TARBALL_HOLDS it lacks. */
export function tarballLacks(entries: readonly string[], version: string): string[] {
  return TARBALL_HOLDS.filter((f) => !entries.includes(`asha-${version}/${f}`));
}

/** One step's record in the run's log. */
export interface StepRecord {
  readonly name: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly detail: string;
}

/** A step: its name, and what it does, returning its detail or throwing its failure. */
export interface Step {
  readonly name: string;
  readonly run: () => string;
}

/** Runs `steps` in order until one throws: every record, the failed one last, each also written by `log`. */
export function runSteps(steps: readonly Step[], log: (record: StepRecord) => void, now = Date.now): StepRecord[] {
  const records: StepRecord[] = [];
  for (const step of steps) {
    const began = now();
    let record: StepRecord;
    try {
      const detail = step.run();
      record = { name: step.name, ok: true, ms: now() - began, detail };
    } catch (error) {
      record = {
        name: step.name,
        ok: false,
        ms: now() - began,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    records.push(record);
    log(record);
    if (!record.ok) break;
  }
  return records;
}

/**
 * The npm commands the fresh clone runs after `npm ci`, in order, each with its bound in minutes: every npm step of CI
 * (`.github/workflows/check.yml`), so a published tree that would fail CI fails here first, and the build. The first
 * public push ran only the tests and the build here, and CI failed on `lint:unused` (2026-10-18, PRINCIPLES §21).
 */
export const CLONE_COMMANDS: readonly { readonly args: readonly string[]; readonly minutes: number }[] = [
  { args: ['run', 'lint'], minutes: 15 },
  { args: ['run', 'lint:unused'], minutes: 15 },
  { args: ['run', 'format:check'], minutes: 15 },
  { args: ['run', 'typecheck'], minutes: 15 },
  { args: ['run', 'build'], minutes: 15 },
  { args: ['test'], minutes: 30 },
  { args: ['run', 'test:integration'], minutes: 30 },
  { args: ['run', 'scan:secrets'], minutes: 15 },
];

/**
 * The environment the clone's npm steps run in: `env` with `CI=true`, as GitHub's runners set it. Tools read it:
 * typescript-eslint, seeing it, parses a file from disk instead of the text it is given, and a lint test passed here
 * and failed in CI's first test run (2026-10-18, PRINCIPLES §21).
 */
export function cloneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, CI: 'true' };
}

/** A command run in `cwd`, bounded; its output appended to the log; a non-zero exit or a timeout throws. */
function command(
  cwd: string,
  logFile: string,
  program: string,
  args: readonly string[],
  boundMs: number,
  env?: NodeJS.ProcessEnv,
): string {
  const run = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: boundMs, maxBuffer: 1 << 28, env });
  appendFileSync(logFile, `$ ${program} ${args.join(' ')}   (in ${cwd})\n${run.stdout}${run.stderr}\n`);
  if (run.error !== undefined) throw new Error(`${program} ${args.join(' ')}: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`${program} ${args.join(' ')} exited ${String(run.status)}`);
  const last = `${run.stdout}${run.stderr}`
    .trim()
    .split('\n')
    .filter((l) => l.trim() !== '');
  return last.slice(-3).join(' | ');
}

const MINUTES = 60_000;

/** R16's whole check of one internal commit: the run folder and every step's record. */
export function ossCheck(
  repo: string,
  commit: string,
  env: NodeJS.ProcessEnv,
): { readonly runDir: string; readonly records: StepRecord[] } {
  const runDir = mkdtempSync(join(tmpdir(), 'asha-oss-check-'));
  const logFile = join(runDir, 'run.log');
  const exported = join(runDir, 'export', 'asha');
  const cloneParent = join(runDir, 'clone');
  const clone = join(cloneParent, 'asha');
  const say = (text: string): void => {
    appendFileSync(logFile, `${text}\n`);
  };
  const internal = spawnSync('git', ['rev-parse', '--verify', `${commit}^{commit}`], {
    cwd: repo,
    encoding: 'utf8',
  }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).stdout.trim() !== '';
  const version = (text: string): string => text.trim().split('\n')[0] ?? '';
  writeFileSync(
    logFile,
    `oss:check of ${internal} (${dirty ? 'the internal tree dirty' : 'the internal tree clean'})\n` +
      `node ${process.version}; npm ${version(spawnSync('npm', ['--version'], { encoding: 'utf8' }).stdout)}\n`,
  );
  let releaseVersion = '';
  const steps: Step[] = [
    {
      name: 'gitleaks',
      run: () => {
        const v = gitleaksVersion();
        say(`gitleaks ${v}`);
        return `gitleaks ${v}`;
      },
    },
    {
      name: 'export',
      run: () => {
        const done = exportRelease({ repo, commit: internal, out: exported, env });
        releaseVersion = done.tag.slice(1);
        return `${String(done.files)} files, ${done.commit.slice(0, 12)} ${done.tag}`;
      },
    },
    {
      name: 'markers',
      run: () => {
        const found = scanMarkers(readMarkers(env, [repo, exported]), exported);
        if (found.length > 0)
          throw new Error(`${String(found.length)} marker match(es): ${found.map(matchLine).join('; ')}`);
        return 'no marker';
      },
    },
    {
      name: 'secrets in the history',
      run: () => {
        const found = scanHistory(exported);
        if (found.length > 0) throw new Error(found.map(findingLine).join('; '));
        return 'no finding';
      },
    },
    {
      name: 'secrets in the tree',
      run: () => {
        const found = scanTracked(exported);
        if (found.length > 0) throw new Error(found.map(findingLine).join('; '));
        return 'no finding';
      },
    },
    {
      name: 'sizes and weights',
      run: () => {
        const files = spawnSync('git', ['ls-files', '-z'], { cwd: exported, encoding: 'utf8' })
          .stdout.split('\0')
          .filter((f) => f !== '')
          .map((path) => ({ path, bytes: statSync(join(exported, path)).size }));
        const problems = sizeProblems(files);
        if (problems.length > 0) throw new Error(problems.join('; '));
        return `${String(files.length)} files, none weights or over 5 MB`;
      },
    },
    {
      name: 'clone',
      run: () => {
        mkdirSync(cloneParent);
        command(cloneParent, logFile, 'git', ['clone', '-q', exported, clone], 5 * MINUTES);
        const beside = readdirSync(cloneParent);
        if (beside.length !== 1) throw new Error(`the clone's folder holds ${beside.join(', ')}, not the clone alone`);
        return clone;
      },
    },
    {
      name: 'npm ci',
      run: () => command(clone, logFile, 'npm', ['ci', '--no-audit', '--no-fund'], 20 * MINUTES, cloneEnv(env)),
    },
    ...CLONE_COMMANDS.map(({ args, minutes }) => ({
      name: `npm ${args.join(' ')}`,
      run: () => command(clone, logFile, 'npm', args, minutes * MINUTES, cloneEnv(env)),
    })),
    {
      name: 'release',
      run: () => {
        command(clone, logFile, 'npm', ['run', '--silent', 'release'], 30 * MINUTES, cloneEnv(env));
        const tarball = join(clone, 'build', 'release', `v${releaseVersion}`, `asha-${releaseVersion}.tar.gz`);
        if (!existsSync(tarball)) throw new Error(`no tarball at ${tarball}`);
        const entries = spawnSync('tar', ['tzf', tarball], { encoding: 'utf8', maxBuffer: 1 << 28 }).stdout.split('\n');
        const lacks = tarballLacks(entries, releaseVersion);
        if (lacks.length > 0) throw new Error(`the tarball lacks ${lacks.join(', ')} (R30)`);
        return `${tarball}: ${String(entries.length)} entries`;
      },
    },
  ];
  const records = runSteps(steps, (r) => {
    say(`${r.ok ? 'pass' : 'FAIL'} ${r.name} (${String(Math.round(r.ms / 1000))} s): ${r.detail}`);
  });
  return { runDir: resolve(runDir), records };
}
