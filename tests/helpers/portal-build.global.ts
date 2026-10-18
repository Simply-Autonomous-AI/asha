// globalSetup of the integration config (docs/plans/portal.md R2): compiles the portal's page with its own TypeScript
// project into a folder unique to this run, so every integration test's daemon serves the page of the tree under
// test — whatever `npm run build` last wrote to dist/ — and the gate's order (integration before build) holds. The
// folder is removed when the run ends.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');

declare module 'vitest' {
  export interface ProvidedContext {
    /** The run's compiled portal modules: the folder `GET /portal/js/<path>` serves from (dist/portal-build/src/ in production). */
    portalModulesDir: string;
  }
}

export default function setup(project: { provide(key: 'portalModulesDir', value: string): void }): () => void {
  const out = mkdtempSync(join(tmpdir(), 'asha-portal-build-'));
  // Its exit status is read: a page that does not compile fails the run here, naming tsc's errors.
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(ROOT, 'tsconfig.portal.json'), '--outDir', out],
    { cwd: ROOT, stdio: 'inherit' },
  );
  project.provide('portalModulesDir', join(out, 'src'));
  return () => {
    rmSync(out, { recursive: true, force: true });
  };
}
