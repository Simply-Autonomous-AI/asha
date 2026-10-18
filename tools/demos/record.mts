// npm run demos:record [pNN …] (docs/plans/demo-videos.md R1, R5, R12): records each named pattern demo, or all 25 in
// catalogue order, one at a time — its agent-suite file run alone with ASHA_RECORD_DIR set, so its recorder
// (tests/agents/patterns/recorder.ts) takes the frames beside the real run — then encodes each recording once, under
// its own hold of the agent-suite lock, and promotes the video to docs/patterns/videos/ only when nothing refuses it.
// Every recording stays in the run's folder, promoted or not, with what refused it. Exits 1 when any named demo is not
// promoted, naming each with its reasons; 2 for a usage error.
//
// Runs with Node's TypeScript support and the resolve hook beside it (package.json `demos:record`).

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

import { RESULTS_PATHS } from '../../evals/patterns/selection.js';
import { loadTeam, parseCatalogueEntry } from '../../src/daemon/definitions/index.js';
import { treeDigest } from '../../src/daemon/model-store/index.js';
import { isAlive } from '../../src/daemon/process/pid-lock.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { harnessPaths } from '../../src/shared/paths.js';
import { pinnedRevision, browsersPath } from '../../tests/helpers/browser.js';
import {
  AGENT_SUITE_LOCK,
  LIGHT_RUNS_DIR,
  agentSuiteSetup,
  nodeLightRunFs,
  stderrLogger,
} from '../../tests/helpers/suite-lock.js';
import {
  RECORDING_FILE,
  encode,
  encodeUnderLock,
  ffmpegRunner,
  refusals,
  type RecordingFacts,
} from '../../tests/agents/patterns/recorder.js';

import { catalogueOrder, demoSidecar, selectWanted, slugOf, type DemoEntry } from './decide.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const VIDEOS = join(REPO, 'docs', 'patterns', 'videos');
/** A demo's suite run, at most: its own bounds come well inside this one (P20's recorded runs take about 3 minutes). */
const SUITE_BOUND_MS = 60 * 60_000;
/** After the bound's SIGKILL, how long the record waits for the suite's output to end before it goes on (R4-DESIGN-004). */
const SUITE_CLOSE_WAIT_MS = 10_000;
/** Vitest's own entry point, run by this Node: no npx between, so the bound's SIGKILL reaches vitest itself. */
const VITEST = join(REPO, 'node_modules', 'vitest', 'vitest.mjs');

interface Demo extends DemoEntry {
  readonly team: string;
  readonly suite: string;
}

const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();

/** R1's condition: no change outside docs/patterns/videos/ and the agent suite's results paths. */
const treeClean = (): boolean =>
  git('status', '--porcelain', '--', '.', ':!docs/patterns/videos/', ...RESULTS_PATHS.map((p) => `:!${p}`)) === '';

/** Each local model a demo's team names, by catalogue id, with whether the shared model cache holds it. */
async function modelsOf(demo: Demo, modelsDir: string): Promise<{ readonly id: string; readonly cached: boolean }[]> {
  const team = await loadTeam(join(REPO, 'teams'), demo.team);
  const ids = new Set<string>();
  for (const member of team.members) {
    ids.add(member.recipe.model);
    if (member.recipe.embeddingModel !== null) ids.add(member.recipe.embeddingModel);
  }
  return [...ids].sort(byCodeUnit).map((id) => {
    const file = join(REPO, 'catalogue', `${id}.json`);
    const entry = parseCatalogueEntry(JSON.parse(readFileSync(file, 'utf8')), file);
    return { id, cached: existsSync(join(modelsDir, `sha256-${treeDigest(entry.files)}`)) };
  });
}

/**
 * The demo's suite run alone, its output in the run folder: its exit code, and whether its bound killed it. Vitest runs
 * under this Node directly — under npx a SIGKILL ended only npx, and vitest went on holding the output, so the bound
 * never ended the wait (the code review's round 4, R4-DESIGN-004); past the bound, the wait for the output's end is
 * itself bounded.
 */
function runSuite(demo: Demo, dir: string): Promise<{ readonly code: number | null; readonly timedOut: boolean }> {
  if (!existsSync(VITEST)) throw new Error(`no ${VITEST}: run npm install`);
  return new Promise((resolveRun, reject) => {
    const log = join(dir, 'vitest.log');
    const child = spawn(process.execPath, [VITEST, 'run', '--config', 'vitest.agents.config.mts', demo.suite], {
      cwd: REPO,
      env: { ...process.env, ASHA_RECORD_DIR: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let text = '';
    let timedOut = false;
    let closeWait: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(closeWait);
      writeFileSync(log, text);
      resolveRun({ code, timedOut });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, SUITE_BOUND_MS);
    child.stdout.on('data', (d: Buffer) => (text += d.toString()));
    child.stderr.on('data', (d: Buffer) => (text += d.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    // Killed at its bound, a worker of its own may hold the output a moment longer: waited for, at most this long.
    child.on('exit', (code) => {
      if (timedOut)
        closeWait = setTimeout(() => {
          finish(code);
        }, SUITE_CLOSE_WAIT_MS);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}

/** A path as committed: the temporary folder and the home folder named, never spelled out. */
const committedPath = (path: string): string => path.replace(tmpdir(), '<tmp>').replace(homedir(), '~');

async function recordOne(
  demo: Demo,
  runRoot: string,
  headAtStart: string,
  ffmpeg: string,
  version: string,
  modelsDir: string,
): Promise<{ readonly promoted: boolean; readonly reasons: readonly string[] }> {
  const slug = slugOf(demo.page);
  const dir = join(runRoot, slug);
  mkdirSync(dir, { recursive: true });
  const runStartedAt = new Date().toISOString();
  process.stderr.write(`› ${demo.pattern}: recording ${demo.suite} into ${dir}\n`);
  const { code, timedOut } = await runSuite(demo, dir);
  if (timedOut)
    return {
      promoted: false,
      reasons: [
        `the suite ran past its bound of ${String(SUITE_BOUND_MS / 60_000)} minutes and was killed (see vitest.log)`,
      ],
    };
  const recordingFile = join(dir, RECORDING_FILE);
  if (!existsSync(recordingFile))
    return {
      promoted: false,
      reasons: [
        `the suite exited ${String(code)} and left no ${RECORDING_FILE}: its recorder did not end (see vitest.log)`,
      ],
    };
  const recording = JSON.parse(readFileSync(recordingFile, 'utf8')) as RecordingFacts;
  const resultsFile = join(REPO, 'tests', 'agents', 'results', `${slug}.json`);
  const results = JSON.parse(readFileSync(resultsFile, 'utf8')) as {
    readonly startedAt: string;
    readonly scenarios: readonly { readonly scenario: { readonly id: string }; readonly state: string }[];
  };
  if (results.startedAt < runStartedAt)
    return {
      promoted: false,
      reasons: [
        `${resultsFile} is from an earlier run (started ${results.startedAt}); the suite exited ${String(code)}`,
      ],
    };
  const scenarios = results.scenarios.map((s) => ({ id: s.scenario.id, state: s.state }));

  // The encode, once, under the agent-suite lock (R12): never beside a suite, an eval or another encode.
  const output = join(dir, `${slug}.webm`);
  process.stderr.write(`› ${demo.pattern}: encoding ${String(recording.frames.length)} frames\n`);
  const encoded = await encodeUnderLock({
    take: () =>
      agentSuiteSetup({
        lockFile: AGENT_SUITE_LOCK,
        pid: process.pid,
        dir: LIGHT_RUNS_DIR,
        fs: nodeLightRunFs,
        isAlive,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: () => Date.now(),
        stderr: (text) => {
          process.stderr.write(text);
        },
        logger: stderrLogger,
      }),
    run: () =>
      encode({
        frames: recording.frames,
        framesDir: join(dir, 'frames'),
        output,
        version,
        run: ffmpegRunner(ffmpeg),
        readFrame: (file) => readFileSync(file),
        exists: existsSync,
        size: (path) => statSync(path).size,
        removeFrames: (path) => {
          rmSync(path, { recursive: true, force: true });
        },
      }),
  });

  const reasons = refusals({
    recording,
    scenarios,
    tree: { clean: treeClean(), head: git('rev-parse', 'HEAD'), headAtStart },
    encode: encoded,
    privacy: { login: userInfo().username, home: homedir(), tmp: tmpdir() },
  });
  if (reasons.length > 0) {
    writeFileSync(join(dir, 'refused.json'), `${JSON.stringify({ reasons, encode: encoded }, null, 1)}\n`);
    return { promoted: false, reasons };
  }
  const bytes = readFileSync(output);
  const sidecar = demoSidecar({
    pattern: demo.pattern,
    commit: headAtStart,
    startedAt: runStartedAt,
    runFolder: committedPath(dir),
    models: (await modelsOf(demo, modelsDir)).map((m) => m.id),
    recording,
    encoded,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    scenarios,
  });
  mkdirSync(VIDEOS, { recursive: true });
  // Written beside its final name, then renamed: a reader never sees half a video.
  const video = join(VIDEOS, `${slug}.webm`);
  copyFileSync(output, `${video}.partial`);
  renameSync(`${video}.partial`, video);
  writeFileSync(join(VIDEOS, `${slug}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  writeFileSync(join(dir, 'promoted.json'), `${JSON.stringify(sidecar, null, 1)}\n`);
  return { promoted: true, reasons: [] };
}

/** Before any recording, every problem named (R1): a dirty tree, an uncached model, or ffmpeg not installed. */
async function preflight(
  demos: readonly Demo[],
  modelsDir: string,
): Promise<{ readonly problems: string[]; readonly ffmpeg: string; readonly version: string }> {
  const problems: string[] = [];
  if (!treeClean())
    problems.push(
      'the tree has a change outside docs/patterns/videos/ and the results paths: commit it, or record from a clean worktree',
    );
  for (const demo of demos)
    for (const m of await modelsOf(demo, modelsDir))
      if (!m.cached)
        problems.push(`${demo.pattern}'s model ${m.id} is not in the shared model cache (${committedPath(modelsDir)})`);
  const ffmpeg = join(browsersPath(), `ffmpeg-${pinnedRevision('ffmpeg')}`, 'ffmpeg-mac');
  let version = '';
  if (!existsSync(ffmpeg)) problems.push(`the bundled ffmpeg is not installed at ${committedPath(ffmpeg)}`);
  else version = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' });
  return { problems, ffmpeg, version };
}

async function main(argv: readonly string[]): Promise<number> {
  const all = catalogueOrder(
    JSON.parse(readFileSync(join(REPO, 'tests', 'agents', 'patterns', 'demos.json'), 'utf8')) as Demo[],
    readFileSync(join(REPO, 'docs', 'patterns', 'index.md'), 'utf8'),
  );
  const selected = selectWanted(argv, all);
  if ('problem' in selected) {
    process.stderr.write(`✗ ${selected.problem}\n`);
    return 2;
  }
  const { demos } = selected;
  const modelsDir = harnessPaths({ ASHA_MODELS_DIR: process.env['ASHA_MODELS_DIR'] }).modelsDir;

  const { problems, ffmpeg, version } = await preflight(demos, modelsDir);
  if (problems.length > 0) {
    for (const p of [...new Set(problems)]) process.stderr.write(`✗ ${p}\n`);
    return 1;
  }

  const runRoot = mkdtempSync(join(tmpdir(), 'asha-record-'));
  const headAtStart = git('rev-parse', 'HEAD');
  process.stderr.write(
    `› recording ${demos.map((d) => d.pattern).join(', ')} at ${headAtStart.slice(0, 12)} into ${runRoot}\n`,
  );
  const failed: string[] = [];
  for (const demo of demos) {
    const outcome = await recordOne(demo, runRoot, headAtStart, ffmpeg, version, modelsDir);
    if (outcome.promoted)
      process.stdout.write(`promoted ${demo.pattern}: docs/patterns/videos/${slugOf(demo.page)}.webm\n`);
    else {
      failed.push(demo.pattern);
      const reasons = outcome.reasons.map((r) => `  - ${r}\n`).join('');
      process.stderr.write(`✗ ${demo.pattern} not promoted:\n${reasons}`);
    }
  }
  process.stderr.write(`› the run's folder: ${runRoot}\n`);
  if (failed.length > 0) {
    process.stderr.write(`✗ not promoted: ${failed.join(', ')}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
