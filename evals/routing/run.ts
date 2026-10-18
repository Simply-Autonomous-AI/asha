// The routing eval: runs every case in cases.ts against each named catalogue
// model, through the harness's real path — the model store (download and
// verify), llama-server, and the chat gateway, with the hello-world recipe's
// sampling settings merged over the model's. The request is built by the
// hello-world agent's own helloWorldTurn, with the persona its recipe gives it
// (persona.ts: the recipe's prompt and tools), and run through the SDK's decide()
// loop (list_agents answered with the case's roster), so what is measured is
// what ships.
//
//   npm run build && node dist/evals/routing/run.js [--held-out] [--gate] [--rainbow] [--out <dir>] [model-id ...]
//
// With no model ids it runs every chat model in the catalogue. Each case runs
// REPEATS times. Each results file records the git commit and whether the tree
// was dirty, the llama-server version line, each case's first request exactly
// as sent and its sha256, and every model round of every attempt (record.ts).
// Files go to <out>/<model>.json (default evals/routing/results/) and a table
// is printed.
//
//   --held-out  also runs held-out.ts, recorded under "heldOut" (never in "passed")
//   --gate      skips the cases taken out of the routing check (TAKEN_OUT_D30 and TAKEN_OUT_D51 in record.ts,
//               debts D30 and D51) and
//               exits 1, naming each case (and held-out case) it ran below REPEATS/REPEATS
//   --rainbow   runs only the rainbow set (rainbow.ts): the supervisor of teams/rainbow/, with its recipe's prompt,
//               full-text guidance and sampling, given its gather in nine orders (collaborating-agents A11); alone,
//               never with --held-out or --gate
//   --out <dir> where the results files go, relative to the repo root

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Definitions } from '../../src/daemon/definitions/index.js';
import { JsonLinesLogger } from '../../src/daemon/log.js';
import { LlamaCppServer, realOrphanSweep } from '../../src/daemon/model-server/index.js';
import { writePrivateFile } from '../../src/daemon/private-file/index.js';
import { HuggingFaceModelStore } from '../../src/daemon/model-store/index.js';
import { ExecCommandRunner } from '../../src/daemon/process/index.js';
import { SpawnProcessLauncher } from '../../src/daemon/process/launcher.js';
import { isAlive } from '../../src/daemon/process/pid-lock.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { MAX_CORRECTIONS, MAX_ROUNDS, helloWorldTurn } from '../../images/hello-world/src/agent.js';
import { CASES, caseMessage, type RoutingCase } from './cases.js';
import { recipePersona, teamMemberPersona } from './persona.js';
import { RAINBOW_CASES, RAINBOW_SUPERVISOR, RAINBOW_TEAM } from './rainbow.js';
import { HELD_OUT } from './held-out.js';
import {
  belowFull,
  grade,
  llamaServerVersion,
  parseArgs,
  planRun,
  recordedRequest,
  runAttempt,
  sha256,
  takenOutUnder,
  type Attempt,
} from './record.js';

const REPEATS = 3;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const workDir = join(root, '.tmp', 'eval-routing');

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/** `a/b`, both whole numbers: the results table's and the results file's "passes out of repeats" cells. */
function ratio(a: number, b: number): string {
  return `${String(a)}/${String(b)}`;
}

/** "pass", "FAIL" or "flaky": how a case's passes out of `repeats` reads on its per-case progress line. */
function gradeWord(passes: number, repeats: number): string {
  if (passes === repeats) return 'pass';
  if (passes === 0) return 'FAIL';
  return 'flaky';
}

/** With `--gate`, each debt's skipped cases, named (D30, D51); otherwise nothing to print. */
function printSkipped(skipped: readonly string[], gate: boolean): void {
  if (!gate) return;
  for (const debt of ['D30', 'D51']) {
    process.stdout.write(
      `skipped, taken out of the routing check under debt ${debt}: ${skipped.filter((id) => takenOutUnder(id) === debt).join(', ')}\n`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // The cases this run puts to the model: with --gate, every case but those taken out of the routing check (D30).
  const plan = planRun(args, CASES, HELD_OUT, RAINBOW_CASES);
  const models =
    args.models.length > 0
      ? args.models
      : readdirSync(join(root, 'catalogue'))
          // Routing is a chat decision: embedding models have nothing to route.
          .filter(
            (f) => (JSON.parse(readFileSync(join(root, 'catalogue', f), 'utf8')) as { kind: string }).kind === 'chat',
          )
          .map((f) => f.replace(/\.json$/, ''))
          .sort(byCodeUnit);
  const outDir = resolve(root, args.out ?? join('evals', 'routing', 'results'));
  const commit = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']) !== '';
  await mkdir(workDir, { recursive: true });
  await mkdir(outDir, { recursive: true });
  const logger = new JsonLinesLogger({
    file: join(workDir, 'eval.jsonl'),
    echo: () => undefined,
    clock: () => new Date(),
  });
  const runner = new ExecCommandRunner();
  // Before any case: the build that applies the chat template and the tool_choice grammar is an input to every result.
  const version = await llamaServerVersion(runner);
  const launcher = new SpawnProcessLauncher();
  const definitions = new Definitions(root);
  // The agent whose turns are measured: hello-world, or with --rainbow the rainbow team's supervisor.
  const { recipe, persona } = args.rainbow
    ? await teamMemberPersona(await definitions.team(RAINBOW_TEAM), RAINBOW_SUPERVISOR)
    : await (async () => {
        const helloWorld = await definitions.recipe('hello-world');
        return { recipe: helloWorld, persona: recipePersona(helloWorld) };
      })();
  const store = new HuggingFaceModelStore({
    modelsDir: process.env['ASHA_MODELS_DIR'] || join(homedir(), '.simplyautonomous', 'harness', 'models'),
    baseUrl: 'https://huggingface.co',
    fetch: globalThis.fetch,
    logger,
    stallTimeoutMs: 60_000,
    pid: process.pid,
    isAlive,
  });
  // As the daemon does: a fresh key per run in a 0600 file of its own, never on llama-server's command line.
  const server = new LlamaCppServer({
    runner,
    launcher,
    logger,
    fetch: globalThis.fetch,
    logDir: workDir,
    readyTimeoutMs: 180_000,
    keyFile: join(workDir, 'model-server.key'),
    writeKeyFile: writePrivateFile,
    orphans: realOrphanSweep,
    now: () => Date.now(),
  });

  const table: string[] = [];
  const below: string[] = [];
  try {
    for (const modelId of models) {
      const entry = await definitions.chatModel(modelId);
      process.stderr.write(`› ${modelId}: ensuring the model\n`);
      const endpoint = await server.ensureServing(entry, await store.ensure(entry));
      const runCases = async (cases: readonly RoutingCase[]) => {
        const results = [];
        for (const c of cases) {
          const attempts: Attempt[] = [];
          let request: string | undefined;
          for (let i = 0; i < REPEATS; i += 1) {
            const roster = c.others.map((handle) => ({
              handle,
              ...(c.describe?.[handle] ?? { recipe: 'hello-world', description: recipe.description }),
            }));
            const recorded = await runAttempt({
              fetch: globalThis.fetch,
              endpoint,
              chatDefaults: { ...entry.chat, ...recipe.chat },
              toolCallStart: entry.toolCallStart,
              // An approved-result case brings its own persona (debt-paydown R8: P7's payments agent).
              request: helloWorldTurn(caseMessage(c), c.handle, c.others, c.persona ?? persona),
              message: caseMessage(c),
              roster,
              maxRounds: MAX_ROUNDS,
              maxCorrections: MAX_CORRECTIONS,
            });
            request ??= recorded.firstRequest;
            attempts.push(recorded.attempt);
          }
          const passes = attempts.filter((a) => grade(c, a)).length;
          const sent = present(request, "the case's first request");
          results.push({
            id: c.id,
            checks: c.checks,
            expect:
              c.expect.tool === 'pass'
                ? { tool: 'pass' }
                : {
                    tool: c.expect.tool,
                    to: c.expect.to,
                    text: c.expect.text?.source ?? null,
                    ...(c.expect.notText === undefined ? {} : { notText: c.expect.notText.source }),
                  },
            call: c.call !== undefined,
            passes,
            request: recordedRequest(sent),
            requestSha256: sha256(sent),
            attempts,
          });
          process.stderr.write(`  ${gradeWord(passes, REPEATS)} ${ratio(passes, REPEATS)}  ${c.id}\n`);
        }
        return results;
      };
      const results = await runCases(plan.cases);
      const heldOut = plan.heldOut === null ? null : await runCases(plan.heldOut);
      await server.stopAll();
      const passed = results.filter((r) => r.passes === REPEATS).length;
      below.push(
        ...belowFull(modelId, results, REPEATS),
        ...(heldOut === null ? [] : belowFull(modelId, heldOut, REPEATS)),
      );
      writeFileSync(
        join(outDir, `${modelId}.json`),
        `${JSON.stringify(
          {
            model: { id: entry.id, repo: entry.repo, revision: entry.revision, weights: entry.weights },
            sampling: { ...entry.chat, ...recipe.chat },
            llamaServer: version,
            repeats: REPEATS,
            commit,
            dirty,
            ranAt: new Date().toISOString(),
            passed: ratio(passed, results.length),
            ...(args.gate ? { skipped: plan.skipped } : {}),
            results,
            ...(heldOut === null
              ? {}
              : {
                  heldOut: {
                    passed: ratio(heldOut.filter((r) => r.passes === REPEATS).length, heldOut.length),
                    results: heldOut,
                  },
                }),
          },
          null,
          2,
        )}\n`,
      );
      table.push(
        `${modelId.padEnd(18)} ${results.map((r) => ratio(r.passes, REPEATS)).join('  ')}   ${ratio(passed, results.length)} cases`,
      );
    }
  } finally {
    await server.stopAll();
  }
  process.stdout.write(`${'model'.padEnd(18)} ${plan.cases.map((c) => c.id).join('  ')}\n${table.join('\n')}\n`);
  printSkipped(plan.skipped, args.gate);
  process.stdout.write(`commit ${commit}${dirty ? ' (dirty tree)' : ''}; ${version}; results in ${outDir}\n`);
  if (args.gate && below.length > 0) {
    const indented = below.map((b) => `  ${b}\n`).join('');
    process.stderr.write(
      `routing gate: ${String(below.length)} case(s) below ${ratio(REPEATS, REPEATS)}:\n${indented}`,
    );
    process.exitCode = 1;
  }
}

await main();
