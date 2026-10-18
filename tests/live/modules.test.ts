// `npm run live:modules` (docs/plans/extension-modules.md R17, R18a, R19, R20): the opt-in live-vendor check of one
// installed module, outside the gate, in the home ASHA_HOME names (the CLI's default when unset). Name the module with
// ASHA_LIVE_MODULE=<id>, and for a ToolModule the call with ASHA_LIVE_TOOL=<tool> ASHA_LIVE_ARGS=<json>. It holds the
// home's daemon.lock — no daemon may run meanwhile, since both would set up the same egress network — runs the check
// through the module's own container and the egress proxy in colima, removes what it made (the reclaim), and writes
// its record, with the commit and whether the tree was dirty (PRINCIPLES §13), to
// evals/probes/extension-modules-live-<date>/<module>-<time>.json. It spends: only a module whose manifest records the
// owner's approval of its cost is run (R18a), checked before anything reaches the network.

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { productionDependencies } from '../../src/daemon/compose.js';
import { JsonLinesLogger } from '../../src/daemon/log.js';
import {
  appendOpen,
  createModuleServices,
  liveCheck,
  livePassed,
  loadInstalledModules,
  realSetTimer,
} from '../../src/daemon/modules/index.js';
import { acquirePidLock } from '../../src/daemon/process/pid-lock.js';
import { FileSecretStore } from '../../src/daemon/secrets/index.js';
import { ensureHome, harnessPaths, insideGitTree } from '../../src/shared/paths.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

it('checks one module against its live vendor', async () => {
  const id = process.env['ASHA_LIVE_MODULE'];
  if (id === undefined || id === '')
    throw new Error(
      'name the module: ASHA_LIVE_MODULE=<id> npm run live:modules (and, for a ToolModule, ASHA_LIVE_TOOL=<tool> ASHA_LIVE_ARGS=<json>)',
    );
  const paths = harnessPaths(process.env);
  await ensureHome(paths);
  await mkdir(paths.logsDir, { recursive: true });
  const logger = new JsonLinesLogger({
    file: join(paths.logsDir, 'live-modules.jsonl'),
    echo: (line) => process.stderr.write(`${line}\n`),
    clock: () => new Date(),
  });
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  };
  const release = await acquirePidLock({ file: paths.daemonLock, pid: process.pid, isAlive, logger });
  try {
    const installed = await loadInstalledModules(paths.modulesDir, logger);
    const module = installed.get(id);
    if (module === undefined) throw new Error(`module ${id} is not installed in ${paths.home}`);
    const dependencies = productionDependencies(paths, logger);
    const services = createModuleServices({
      runtime: dependencies.runtime,
      root: ROOT,
      paths,
      logger,
      installed,
      files: {
        readForPlugin: () => Promise.reject(new Error('the live check runs no command plugin')),
        writeFromPlugin: () => Promise.reject(new Error('the live check runs no command plugin')),
      },
      secrets: new FileSecretStore({
        home: paths.home,
        dir: paths.secretsDir,
        logger,
        pid: process.pid,
        isAlive,
        insideGitTree,
      }),
      setTimer: realSetTimer,
      now: () => Date.now(),
      online: () => false,
      appendOpen,
    });
    const tool = process.env['ASHA_LIVE_TOOL'];
    const record = await liveCheck({
      installed: module,
      host: services.host,
      ...(tool === undefined
        ? {}
        : {
            tool: {
              name: tool,
              arguments: JSON.parse(process.env['ASHA_LIVE_ARGS'] ?? '{}') as Record<string, unknown>,
            },
          }),
    });
    if (record.ok) await dependencies.runtime.reclaim();
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', timeout: 30_000 }).trim() !== '';
    const at = new Date().toISOString();
    const dir = join(ROOT, 'evals', 'probes', `extension-modules-live-${at.slice(0, 10)}`);
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${id}-${at.slice(11, 19).replaceAll(':', '')}.json`);
    await writeFile(
      file,
      `${JSON.stringify({ at, commit, dirty, module: id, version: module.manifest.version, record }, null, 2)}\n`,
    );
    let outcome: string;
    if (!record.ok) outcome = `refused: ${record.refused}`;
    else if (livePassed(record)) outcome = 'passed';
    else outcome = 'ran, and did not pass';
    process.stderr.write(`live check of ${id}: ${outcome}; record ${file}\n`);
    // Green only on a pass: a refused model, a failed call, or a vendor that ignored the forced tool call is red (B-28).
    expect(livePassed(record)).toBe(true);
  } finally {
    await release();
  }
});
