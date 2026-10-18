// The last step of `npm run build` (docs/plans/debt-paydown.md R10, debt D22): makes dist/agent-packages/, the agent
// packages' runtime files from a clean install of the committed lockfile, which every agent image is staged from
// (src/daemon/images/index.ts, stageAgentImage) and a release ships (tools/release/pack.mts). Never the checkout's
// node_modules, where a stray or locally edited file (a .DS_Store, a .env, a debugging edit) would reach an image.
//
// package.json and package-lock.json are copied into dist/.agent-packages-install/, `npm ci` installs exactly the
// lockfile's production packages there, verifying each tarball against its integrity; --offline takes them from the
// npm cache the developer's own install filled, so a build never reaches the network (probe P5: 0.34 s). `npm run
// --silent build` and `npm run build --dry-run` hand npm_config_loglevel and npm_config_dry_run to this npm too; the
// flags override them, or a cache miss would print nothing to name it by and a dry run would install nothing. Then
// copyAgentPackages copies the runtime files to dist/agent-packages/, the two files beside them, and the install
// folder is removed. Any failure fails the build: a cache miss is named as the release named it before this step.
//
// Run from the repo root (cwd): node --experimental-strip-types tools/agent-packages/build.mts

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// images/index.ts is imported below by its .ts source, whose own relative imports name .js files (module nodenext):
// the same resolve hook the demo tools use (tools/demos/ts-hooks.mjs) is registered before that import, so a .js
// specifier with no .js file beside it resolves to its .ts file instead.
register('../demos/ts-hooks.mjs', import.meta.url);

type Images = typeof import('../../src/daemon/images/index.js');
const IMAGES_MODULE = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'daemon', 'images', 'index.ts'),
).href;

/** The install's bound: a cold cache read of every locked package; measured 0.34 s warm (P5). */
const NPM_CI_TIMEOUT_MS = 600_000;
export const NPM_CI_ARGS = [
  'ci',
  '--omit=dev',
  '--ignore-scripts',
  '--offline',
  '--no-audit',
  '--no-fund',
  '--loglevel=error',
  '--no-dry-run',
] as const;

/** A precondition does not hold: the message says what to do. */
class BuildRefused extends Error {}

async function agentPackages(root: string): Promise<string> {
  const dist = join(root, 'dist');
  const install = join(dist, '.agent-packages-install');
  const out = join(dist, 'agent-packages');
  // `npm run build` starts with rm -rf dist; a leftover here is a run of this step alone, which starts clean.
  rmSync(install, { recursive: true, force: true });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(install, { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(root, file), join(install, file));
  const result = spawnSync('npm', [...NPM_CI_ARGS], {
    cwd: install,
    encoding: 'utf8',
    timeout: NPM_CI_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  if (result.error) throw new Error(`npm ci in ${install} could not run`, { cause: result.error });
  if (result.status !== 0) {
    const missing = /^npm error code ENOTCACHED$/m.test(result.stderr)
      ? /^npm error request to (\S+) failed/m.exec(result.stderr)
      : null;
    if (missing === null)
      throw new Error(`npm ci in ${install} exited ${String(result.status ?? result.signal)}:\n${result.stderr}`);
    throw new BuildRefused(
      `the npm cache does not hold an intact copy of ${String(missing[1])}, which package-lock.json locks; run npm ci in the checkout, then retry`,
    );
  }
  const images = (await import(IMAGES_MODULE)) as Images;
  let paths: readonly string[];
  try {
    paths = await images.copyAgentPackages(install, out);
  } catch (error) {
    if (!(error instanceof images.AgentPackagesInvalid)) throw error;
    throw new BuildRefused(error.message);
  }
  for (const file of ['package.json', 'package-lock.json']) cpSync(join(install, file), join(out, file));
  rmSync(install, { recursive: true });
  if (existsSync(install)) throw new Error(`${install} is still there after its removal`);
  return `agent packages: ${String(paths.length)} in ${out}\n`;
}

try {
  process.stderr.write(await agentPackages(process.cwd()));
} catch (error) {
  if (!(error instanceof BuildRefused)) throw error;
  process.stderr.write(`build: ${error.message}\n`);
  process.exitCode = 1;
}
