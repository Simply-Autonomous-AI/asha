// Cuts a release of asha: `npm run release`, run in the repo root at a clean
// commit tagged v<version> (<version> from package.json). Builds, then writes
// the tarball of the built files and the Homebrew formula for it into a
// directory unique to this run, and promotes that directory to
// build/release/v<version>/ only once every file is written (PRINCIPLES §13).
// Prints version, commit, sha256 and url; the formula carries all four (its
// version is the one Homebrew scans from the url's asha-<version>.tar.gz).
// Plan: docs/plans/brew-install.md, R2, R11, R12; first of all, the local tap's trust (docs/plans/debt-paydown-2.md R9).
//
// The tarball holds one directory, asha-<version>/, with exactly the files an
// installation needs: the tracked ones as committed, plus the fresh build and
// the agent packages' runtime files from the build's clean offline `npm ci` of the committed
// lockfile (dist/agent-packages/, tools/agent-packages/build.mts); the formula (from asha.rb.in beside this script) points
// at it with a file:// url — the local tap installs from disk (R7).

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// images/index.ts (dynamically imported below) and order.ts are imported by their .ts source, whose own relative
// imports name .js files (module nodenext): the same resolve hook the demo tools use (tools/demos/ts-hooks.mjs) is
// registered before either import, so a .js specifier with no .js file beside it resolves to its .ts file instead.
// A static top-level `import` is resolved before this runs, so order.ts, too, is imported dynamically, below.
register('../demos/ts-hooks.mjs', import.meta.url);

const { byCodeUnit } = await import('../../src/shared/order.js');

/** What an installation holds (R2): the built code and what it reads at run time — teams/ since `--launch team=` (collaborating-agents R5). */
const ENTRIES = [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_LICENSES.md',
  'asha',
  'catalogue',
  'decider',
  'dist',
  'harness-images',
  'images',
  'modules',
  'node_modules',
  'package-lock.json',
  'package.json',
  'portal',
  'recipes',
  'teams',
] as const;
/** The portal's page (docs/plans/portal.md R17): its static files and its compiled modules, each checked present. */
const PORTAL_SHIPPED = ['portal/index.html', 'dist/portal-build/src/portal/app.js'] as const;
/** The browser-test dependency, never shipped (R12, R17): npm ci --omit=dev leaves it out, and the tarball is checked. */
const NEVER_SHIPPED = /^node_modules\/playwright(-core)?\//;

/**
 * Committed but not shipped: the agent suite's fixture teams, two of them broken on purpose (tests/agents/teams.test.ts),
 * its test-only images (images/suite-*: agent-persistence A17's image that fails erase-user on purpose, agent-files'
 * scripted image), and the eval's test-only recipes (recipes/suite-*: agent-files A9's).
 */
const NOT_SHIPPED: readonly string[] = [
  ':(exclude)teams/suite-*',
  ':(exclude)images/suite-*',
  ':(exclude)recipes/suite-*',
];

/** The build compiles every image's source: a test-only image's compiled code under dist/images/ is left out too. */
const TEST_ONLY_IMAGE = /^suite-/;

/** Any path of an agent-suite fixture or test-only image, as the finished tarball is checked for (relative to its top). */
const SUITE_PATH = /^(images|dist\/images|teams|recipes)\/suite-/;

/** Entries not tracked in git: dist/ from the build, node_modules/ from copyAgentPackages over the build's dist/agent-packages/. */
const UNTRACKED: readonly string[] = ['dist', 'node_modules'];

/**
 * The agent packages come from the same function that stages an agent image, so a release holds exactly what its
 * installation stages (debt D15). Loaded from source by Node's type stripping, as this script is.
 */
type Images = typeof import('../../src/daemon/images/index.js');
const IMAGES_MODULE = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'daemon', 'images', 'index.ts'),
).href;

const TEMPLATE = join(dirname(fileURLToPath(import.meta.url)), 'asha.rb.in');

/** A precondition does not hold; nothing was written. */
class ReleaseRefused extends Error {}

/** The local tap (docs/plans/brew-install.md#procedure) and the bound on reading Homebrew's trust (debt-paydown-2 R9). */
const TAP = 'simplyautonomous/tap';
const TAP_TRUST_MS = 30_000;
const TRUST_KEYS = ['casks', 'commands', 'formulae', 'taps'] as const;

/**
 * Refuses a release from a Mac whose Homebrew trusts the local tap, or any formula of it, by name (debt-paydown-2 R9,
 * debt D12): a same-name tap cloned from GitHub would then be trusted for a load by short name. Reads Homebrew's own
 * interface, `brew trust --json=v1` (`{"taps":[…],"formulae":[…],"casks":[…],"commands":[…]}`), bounded; a `brew` that
 * is missing, fails, times out or prints anything else refuses too: a check that cannot run never passes.
 */
function checkTapTrust(root: string): void {
  const command = 'brew trust --json=v1';
  // Read-only: no auto-update, no analytics, no hints (each would add a network call or noise to a read).
  const env = { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ANALYTICS: '1', HOMEBREW_NO_ENV_HINTS: '1' };
  const result = spawnSync('brew', ['trust', '--json=v1'], { cwd: root, env, encoding: 'utf8', timeout: TAP_TRUST_MS });
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT')
      throw new ReleaseRefused(
        `the local tap's trust cannot be read: brew was not found on PATH (${command}); the release is a Homebrew release and needs it`,
      );
    if (code === 'ETIMEDOUT')
      throw new ReleaseRefused(
        `the local tap's trust cannot be read: ${command} did not answer within ${String(TAP_TRUST_MS)} ms`,
      );
    throw new ReleaseRefused(`the local tap's trust cannot be read: ${command} could not run: ${result.error.message}`);
  }
  if (result.status !== 0)
    throw new ReleaseRefused(
      `the local tap's trust cannot be read: ${command} exited ${String(result.status ?? result.signal)}:\n${result.stderr.trimEnd()}`,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new ReleaseRefused(
      `the local tap's trust cannot be read: ${command} printed something that is not JSON (${(error as Error).message}): ${JSON.stringify(result.stdout.slice(0, 200))}`,
    );
  }
  const store = parsed as Record<string, unknown>;
  const shaped =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    JSON.stringify(Object.keys(store).sort(byCodeUnit)) === JSON.stringify(TRUST_KEYS) &&
    TRUST_KEYS.every(
      (key) => Array.isArray(store[key]) && (store[key] as unknown[]).every((entry) => typeof entry === 'string'),
    );
  if (!shaped)
    throw new ReleaseRefused(
      `the local tap's trust cannot be read: ${command} printed JSON of another shape than {"taps":[…],"formulae":[…],"casks":[…],"commands":[…]}: ${JSON.stringify(result.stdout.slice(0, 200))}`,
    );
  const taps = (store['taps'] as string[]).filter((entry) => entry === TAP);
  const formulae = (store['formulae'] as string[]).filter((entry) => entry.startsWith(`${TAP}/`));
  if (taps.length + formulae.length === 0) return;
  const fix = [
    ...taps.map((tap) => `HOMEBREW_NO_AUTO_UPDATE=1 brew untrust --tap ${tap}`),
    ...formulae.map((formula) => `HOMEBREW_NO_AUTO_UPDATE=1 brew untrust --formula ${formula}`),
    `git -C "$(brew --repository ${TAP})" remote add origin "$(brew --repository ${TAP})"   # once, when the tap has no remote yet`,
    `HOMEBREW_NO_AUTO_UPDATE=1 brew trust --tap ${TAP}`,
  ];
  const fixLines = fix.map((line) => `  ${line}`).join('\n');
  throw new ReleaseRefused(
    `Homebrew trusts the local tap by name (${[...taps, ...formulae].join(', ')}): a same-name tap cloned from GitHub would be trusted too (debt D12). Trust it by its folder instead (docs/deployments/index.md#release):\n${fixLines}`,
  );
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 600_000 });
  if (result.error) throw new Error(`${command} ${args.join(' ')} could not run`, { cause: result.error });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status ?? result.signal)}:\n${result.stderr}`);
  }
  return result.stdout;
}

/** The tag `v<version>` exists and names HEAD (debt-paydown-2): HEAD's commit. */
function checkTagMatchesHead(root: string, version: string): string {
  const tag = `v${version}`;
  const tagged = spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (tagged.error) throw new Error('git rev-parse could not run', { cause: tagged.error });
  if (tagged.status === 1 && tagged.stdout === '')
    throw new ReleaseRefused(`there is no tag ${tag} (package.json version ${version})`);
  if (tagged.status !== 0) throw new Error(`git rev-parse ${tag} exited ${String(tagged.status)}:\n${tagged.stderr}`);
  const commit = run('git', ['rev-parse', 'HEAD'], root).trim();
  if (tagged.stdout.trim() !== commit)
    throw new ReleaseRefused(`HEAD (${commit}) is not the commit tagged ${tag} (${tagged.stdout.trim()})`);
  return commit;
}

/**
 * Builds the staged directory under `runDir`: the tracked entries as committed, the fresh build's dist/ (minus
 * test-only images), and the agent packages — the same function that stages an agent image (debt D15), from the
 * build's clean offline `npm ci` of the committed lockfile, never the checkout's node_modules (adversarial review,
 * 2026-09-27). Returns the staged directory.
 */
async function stageRelease(root: string, runDir: string, name: string): Promise<string> {
  const stage = join(runDir, name);
  mkdirSync(stage, { recursive: true });
  // The tracked entries come from the commit itself, so an ignored file in the
  // checkout (a .DS_Store, a stray node_modules) never ships (PRINCIPLES §13).
  // dist/ is not tracked: npm run build above recreated it from scratch.
  const archive = join(runDir, 'source.tar');
  run(
    'git',
    [
      'archive',
      '--format=tar',
      `--output=${archive}`,
      'HEAD',
      '--',
      ...ENTRIES.filter((entry) => !UNTRACKED.includes(entry)),
      ...NOT_SHIPPED,
    ],
    root,
  );
  run('tar', ['-xf', archive, '-C', stage], root);
  rmSync(archive);
  cpSync(join(root, 'dist'), join(stage, 'dist'), { recursive: true, verbatimSymlinks: true });
  const builtImages = join(stage, 'dist', 'images');
  if (existsSync(builtImages))
    for (const entry of readdirSync(builtImages))
      if (TEST_ONLY_IMAGE.test(entry)) rmSync(join(builtImages, entry), { recursive: true });

  const images = (await import(IMAGES_MODULE)) as Images;
  try {
    await images.copyAgentPackages(join(root, 'dist', 'agent-packages'), stage);
  } catch (error) {
    if (!(error instanceof images.AgentPackagesInvalid)) throw error;
    rmSync(runDir, { recursive: true });
    throw new ReleaseRefused(error.message);
  }
  return stage;
}

/**
 * The finished tarball itself, not only the steps that built it: exactly the entries ENTRIES names, no agent-suite
 * fixture or test-only image, the portal shipped whole, and no browser-test package (portal R17, R12).
 */
function verifyTarball(runDir: string, tarballName: string, name: string): void {
  const listed = run('tar', ['-tzf', tarballName], runDir).trim().split('\n');
  const topLevel = [...new Set(listed.map((entry) => entry.split('/').slice(0, 2).join('/')))];
  const expected = new Set([name, `${name}/`, ...ENTRIES.map((entry) => `${name}/${entry}`)]);
  const unexpected = topLevel.filter((entry) => !expected.has(entry));
  if (unexpected.length > 0)
    throw new Error(`the tarball in ${runDir} holds unexpected entries: ${unexpected.join(', ')}`);
  const testOnly = listed.filter((entry) => SUITE_PATH.test(entry.slice(name.length + 1)));
  if (testOnly.length > 0)
    throw new Error(`the tarball in ${runDir} holds the agent suite's test-only files: ${testOnly.join(', ')}`);
  const missingPortal = PORTAL_SHIPPED.filter((path) => !listed.includes(`${name}/${path}`));
  if (missingPortal.length > 0)
    throw new Error(`the tarball in ${runDir} lacks the portal's ${missingPortal.join(', ')}`);
  const testPackages = listed.filter((entry) => NEVER_SHIPPED.test(entry.slice(name.length + 1)));
  if (testPackages.length > 0)
    throw new Error(`the tarball in ${runDir} holds a test-only package: ${testPackages.join(', ')}`);
}

async function release(root: string): Promise<string> {
  // Before any other check (debt-paydown-2 R9).
  checkTapTrust(root);

  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

  const status = run('git', ['status', '--porcelain'], root);
  if (status !== '')
    throw new ReleaseRefused(`the working tree is not clean (git status --porcelain):\n${status.trimEnd()}`);

  const tag = `v${version}`;
  const commit = checkTagMatchesHead(root, version);

  const releases = join(root, 'build', 'release');
  const out = join(releases, tag);
  if (existsSync(out)) throw new ReleaseRefused(`${out} already exists; a release is never overwritten`);

  // Build output goes to stderr: stdout carries only the four values.
  const build = spawnSync('npm', ['run', 'build'], { cwd: root, stdio: ['ignore', 2, 2], timeout: 600_000 });
  if (build.error) throw new Error('npm run build could not run', { cause: build.error });
  if (build.status !== 0) throw new Error(`npm run build exited ${String(build.status ?? build.signal)}`);

  const runDir = join(releases, `.run-${new Date().toISOString().replace(/[-:.]/g, '')}-${String(process.pid)}`);
  const name = `asha-${version}`;
  const stage = await stageRelease(root, runDir, name);

  const tarballName = `${name}.tar.gz`;
  // COPYFILE_DISABLE: macOS tar would otherwise add ._* files for extended attributes.
  run('tar', ['-czf', tarballName, name], runDir, { ...process.env, COPYFILE_DISABLE: '1' });
  rmSync(stage, { recursive: true });

  verifyTarball(runDir, tarballName, name);

  const sha256 = createHash('sha256')
    .update(readFileSync(join(runDir, tarballName)))
    .digest('hex');
  const url = pathToFileURL(join(out, tarballName)).href;
  const values: Record<string, string> = { version, commit, sha256, url };
  const formula = readFileSync(TEMPLATE, 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`${TEMPLATE} names {{${key}}}, which the release does not supply`);
    return value;
  });
  writeFileSync(join(runDir, 'asha.rb'), formula);

  // A release that appeared meanwhile is not overwritten; the run directory stays as evidence.
  if (existsSync(out)) throw new Error(`${out} appeared during the run; this run's files are in ${runDir}`);
  renameSync(runDir, out);
  return `version: ${version}\ncommit: ${commit}\nsha256: ${sha256}\nurl: ${url}\n`;
}

try {
  process.stdout.write(await release(process.cwd()));
} catch (error) {
  if (!(error instanceof ReleaseRefused)) throw error;
  process.stderr.write(`release: ${error.message}\n`);
  process.exitCode = 1;
}
