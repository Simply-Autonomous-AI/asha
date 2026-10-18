// The portal folders a test daemon reads at start (docs/plans/portal.md R2): the integration tier's compiled page
// (tests/helpers/portal-build.global.ts), or, for a unit test that starts a daemon and never loads the page, a stub
// holding every allow-listed file.

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { inject } from 'vitest';

import { PORTAL_MODULES, PORTAL_STATIC_FILES, type PortalFolders } from '../../src/daemon/portal/index.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** The repo's portal/ and the run's compiled modules: integration tests only, whose global setup compiles them. */
export function builtPortal(): PortalFolders {
  const modulesDir = inject('portalModulesDir');
  if (typeof modulesDir !== 'string')
    throw new Error(
      "builtPortal: no compiled portal; it is the integration config's globalSetup (tests/helpers/portal-build.global.ts) that compiles it",
    );
  return { staticDir: join(ROOT, 'portal'), modulesDir };
}

/** Every allow-listed file, each holding a line naming it: for a daemon whose page no test loads. */
export async function portalStub(): Promise<PortalFolders> {
  const root = await mkdtemp(join(tmpdir(), 'asha-portal-stub-'));
  const folders = { staticDir: join(root, 'static'), modulesDir: join(root, 'modules') };
  for (const name of PORTAL_STATIC_FILES) {
    await mkdir(folders.staticDir, { recursive: true });
    await writeFile(join(folders.staticDir, name), `stub ${name}\n`);
  }
  for (const path of PORTAL_MODULES) {
    await mkdir(dirname(join(folders.modulesDir, path)), { recursive: true });
    await writeFile(join(folders.modulesDir, path), `// stub ${path}\n`);
  }
  return folders;
}
