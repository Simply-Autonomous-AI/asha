// Loading the installed modules at the daemon's start (docs/plans/extension-modules.md R2, R3, R18a, R38): only
// manifests are read, never a module's code. With no ASHA_HOME/modules/, nothing more is read, refused or created. An
// entry whose name begins with `.` — an install's `.staging-*`, an upgrade's `.replaced-*` — is never loaded; a
// `.replaced-<id>-*` with no `<id>/` beside it is logged at error, `module.upgrade_interrupted`, naming the repair. A
// manifest that fails validation fails the start, naming the module and the field; so do approved caps that sum to
// more than the owner's $50 a month (R18a).

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { present } from '../../shared/assert-present.js';
import { MANIFEST_FILE, ManifestInvalid, parseModuleManifest } from '../../shared/modules.js';
import { byCodeUnit } from '../../shared/order.js';
import type { Logger } from '../log.js';
import type { InstalledModule } from './images.js';

/** The owner's approved cap over every metered and external-unmetered module together, in USD a month (R18a). */
export const APPROVED_CAP_TOTAL_USD = 50;

/** Approved caps over the owner's total (R18a). */
export class CapsOverApproval extends Error {
  constructor(readonly total: number) {
    super(
      `the installed modules' approved caps (cost.approved.capUsd) sum to ${String(total)} USD a month, over the ${String(APPROVED_CAP_TOTAL_USD)} the owner approved (docs/plans/extension-modules.md R18a)`,
    );
    this.name = 'CapsOverApproval';
  }
}

export async function loadInstalledModules(
  modulesDir: string,
  logger: Logger,
): Promise<ReadonlyMap<string, InstalledModule>> {
  let names: string[];
  try {
    names = await readdir(modulesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const installed = new Map<string, InstalledModule>();
  for (const name of names.toSorted(byCodeUnit)) {
    const replaced = /^\.replaced-([a-z][a-z0-9_]{0,31})-[0-9a-f]+$/.exec(name);
    if (replaced !== null && !names.includes(present(replaced[1], 'the upgrade-interrupted id capture'))) {
      const id = present(replaced[1], 'the upgrade-interrupted id capture');
      logger.error('module.upgrade_interrupted', {
        module: id,
        leftover: name,
        error: new Error(
          `an upgrade of module ${id} was interrupted, and it is not installed now; repair it by installing it again: asha --install-module path=<its directory>`,
        ),
      });
    }
    if (name.startsWith('.')) continue;
    const dir = join(modulesDir, name);
    const text = await readFile(join(dir, MANIFEST_FILE), 'utf8');
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      // Named, so the failed start says which module (R2; review of 2026-10-02, B-27).
      throw new ManifestInvalid(
        name,
        MANIFEST_FILE,
        `${join(dir, MANIFEST_FILE)} does not read as JSON (${(error as Error).message})`,
      );
    }
    installed.set(name, { manifest: parseModuleManifest(raw, join(dir, MANIFEST_FILE), name), dir });
  }
  const total = [...installed.values()].reduce(
    (sum, m) =>
      sum +
      ('approved' in m.manifest.cost && m.manifest.cost.approved !== undefined ? m.manifest.cost.approved.capUsd : 0),
    0,
  );
  if (total > APPROVED_CAP_TOTAL_USD) throw new CapsOverApproval(total);
  if (installed.size > 0) logger.info('modules.loaded', { modules: [...installed.keys()] });
  return installed;
}
