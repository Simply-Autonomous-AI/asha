// The secret scans (docs/plans/oss-release.md R5, R8): gitleaks, 8.30.1 or later and below 9, with its default rules
// only, over a temporary copy of exactly the files `git ls-files` lists (R5, `npm run scan:secrets`), or over every
// commit of a repository (R8, `npm run oss:check`). Its flags keep a found secret out of every output (`--redact`), take
// no in-file allowance (`--ignore-gitleaks-allow`), read no `.gitleaksignore` beside the files (an empty ignore path of
// its own), and its environment holds no GITLEAKS_CONFIG or GITLEAKS_CONFIG_TOML, so nothing outside these flags can
// switch a rule off; a `.gitleaks.toml` or `.gitleaksignore` among the scanned files is refused, since gitleaks would
// read the first. Findings are read from gitleaks' JSON report and printed as rule, file and line (and commit), never a
// value. A missing gitleaks, one outside the range, or any gitleaks failure is a refusal naming its cause.

import { spawnSync } from 'node:child_process';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** The scan refused to run, or gitleaks failed: its message names the cause. */
export class SecretScanRefused extends Error {
  override readonly name = 'SecretScanRefused';
}

/** One gitleaks finding, its value never kept. */
export interface SecretFinding {
  /** gitleaks' rule id, `aws-access-token` say. */
  readonly rule: string;
  /** The file, relative to the scanned folder or repository. */
  readonly file: string;
  readonly line: number;
  /** The commit, for a scan of a repository's history. */
  readonly commit?: string;
}

/** How long one gitleaks run may take: the whole tracked tree takes seconds. */
const GITLEAKS_BOUND_MS = 10 * 60_000;
/** The exit code gitleaks is told to give for findings, so a finding is never mistaken for gitleaks' own failure. */
const FOUND_EXIT = 97;
/** The files that could change gitleaks' rules if scanned: refused among the files (R5). */
const GITLEAKS_CONFIG_FILES = ['.gitleaks.toml', '.gitleaksignore'] as const;

/** Where the gitleaks binary is: `gitleaks` on PATH unless a test names another. */
export interface GitleaksBin {
  readonly bin?: string;
}

/** gitleaks' version, refused when it is missing or outside 8.30.1 to below 9, naming `brew install gitleaks`. */
export function gitleaksVersion(options: GitleaksBin = {}): string {
  const bin = options.bin ?? 'gitleaks';
  const run = spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 30_000, env: scanEnv() });
  if (run.error !== undefined) {
    const code = (run.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new SecretScanRefused('gitleaks is not installed: brew install gitleaks');
    throw new SecretScanRefused(`gitleaks version failed: ${run.error.message}`);
  }
  const version = /^v?(\d+)\.(\d+)\.(\d+)\s*$/.exec(run.stdout);
  if (run.status !== 0 || version === null)
    throw new SecretScanRefused(
      `gitleaks version printed no version (exit ${String(run.status)}): brew install gitleaks`,
    );
  const [major, minor, patch] = version.slice(1).map(Number) as [number, number, number];
  const atLeast = major > 8 || (major === 8 && (minor > 30 || (minor === 30 && patch >= 1)));
  const text = `${String(major)}.${String(minor)}.${String(patch)}`;
  if (!atLeast || major >= 9)
    throw new SecretScanRefused(`gitleaks ${text} is outside 8.30.1 to below 9: brew install gitleaks`);
  return text;
}

/** The scan's environment: this process's, less the two variables that would name another rule set (R5). */
function scanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['GITLEAKS_CONFIG'];
  delete env['GITLEAKS_CONFIG_TOML'];
  return env;
}

/** Copies each of `files` (relative to `from`) into `to`: a file by a clone of its bytes, a symlink as a symlink. */
function copyFiles(from: string, files: readonly string[], to: string): void {
  for (const file of files) {
    const source = join(from, file);
    const target = join(to, file);
    mkdirSync(dirname(target), { recursive: true });
    if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), target);
    else copyFileSync(source, target, constants.COPYFILE_FICLONE);
  }
}

/** gitleaks run as R5 says, in `cwd`, its report read back; `args` name the mode and its target. */
function gitleaks(args: readonly string[], cwd: string, options: GitleaksBin): SecretFinding[] {
  const work = mkdtempSync(join(tmpdir(), 'asha-gitleaks-'));
  try {
    const ignore = join(work, 'ignore');
    mkdirSync(ignore);
    const report = join(work, 'report.json');
    const run = spawnSync(
      options.bin ?? 'gitleaks',
      [
        ...args,
        '--redact',
        '--no-banner',
        '--ignore-gitleaks-allow',
        '--gitleaks-ignore-path',
        ignore,
        '--report-format',
        'json',
        '--report-path',
        report,
        '--exit-code',
        String(FOUND_EXIT),
        '--log-level',
        'error',
      ],
      { cwd, encoding: 'utf8', timeout: GITLEAKS_BOUND_MS, env: scanEnv(), maxBuffer: 1 << 26 },
    );
    if (run.error !== undefined) throw new SecretScanRefused(`gitleaks ${args[0] ?? ''} failed: ${run.error.message}`);
    if (run.status !== 0 && run.status !== FOUND_EXIT)
      throw new SecretScanRefused(
        `gitleaks ${args[0] ?? ''} exited ${String(run.status)}: ${run.stderr.split('\n').slice(0, 5).join(' ').trim()}`,
      );
    const found = JSON.parse(readFileSync(report, 'utf8')) as readonly {
      readonly RuleID: string;
      readonly File: string;
      readonly StartLine: number;
      readonly Commit?: string;
    }[];
    if ((run.status === FOUND_EXIT) !== found.length > 0)
      throw new SecretScanRefused(`gitleaks exited ${String(run.status)} with ${String(found.length)} findings`);
    return found.map((f) => ({
      rule: f.RuleID,
      file: f.File,
      line: f.StartLine,
      ...(f.Commit === undefined || f.Commit === '' ? {} : { commit: f.Commit }),
    }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** R5's scan of a folder: every file in it, refused when it holds a file that could change gitleaks' rules. */
export function scanFolder(dir: string, options: GitleaksBin = {}): SecretFinding[] {
  for (const name of GITLEAKS_CONFIG_FILES) {
    if (existsSync(join(dir, name)))
      throw new SecretScanRefused(`${name} is among the scanned files: no tracked file may be one (R5)`);
  }
  return gitleaks(['dir', '.'], dir, options);
}

/** R5's scan of a repository's tracked files: a temporary copy of exactly those `git ls-files` lists, scanned. */
export function scanTracked(repo: string, options: GitleaksBin = {}): SecretFinding[] {
  const list = spawnSync('git', ['ls-files', '-z'], { cwd: repo, encoding: 'utf8', timeout: 60_000 });
  if (list.status !== 0) throw new SecretScanRefused(`git ls-files failed in ${repo}: ${list.stderr.trim()}`);
  const files = list.stdout.split('\0').filter((f) => f !== '');
  const blocked = files.filter((f) => (GITLEAKS_CONFIG_FILES as readonly string[]).includes(f.split('/').at(-1) ?? ''));
  if (blocked.length > 0)
    throw new SecretScanRefused(`${blocked.join(', ')}: no tracked file may be a gitleaks configuration (R5)`);
  const copy = mkdtempSync(join(tmpdir(), 'asha-scan-'));
  try {
    copyFiles(repo, files, copy);
    return scanFolder(copy, options);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}

/** R8's scan of a repository's every commit. */
export function scanHistory(repo: string, options: GitleaksBin = {}): SecretFinding[] {
  return gitleaks(['git', '.'], repo, options);
}

/** A finding as printed: where it is and which rule, never its value. */
export function findingLine(f: SecretFinding): string {
  const where = `${f.file}:${String(f.line)} ${f.rule}`;
  return f.commit === undefined ? where : `${f.commit.slice(0, 12)} ${where}`;
}
