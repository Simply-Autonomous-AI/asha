// A resolve hook, first written for the demo tools (docs/plans/demo-videos.md R1, R6) and now also registered by
// tools/agent-packages/build.mts and tools/release/pack.mts (each importing src/daemon/images/index.ts from its .ts
// source) and by the "decisions" script (--import, since tools/decision-queue/server.mts imports src/shared/order.ts
// at its own top level): every one of them runs with Node's own TypeScript support and imports the repo's
// TypeScript, whose relative imports name `.js` files (module nodenext), and a tool's own `.mts` modules by their
// `.mjs` names (tools/demos/decide.mts, since 2026-10-16). A relative `.js` specifier that names no file resolves to
// the `.ts` file beside it, and a `.mjs` one to the `.mts` file; every other specifier resolves as Node resolves it.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Each compiled extension a relative import names, and the TypeScript source beside it that it stands for. */
const SOURCES = [
  ['.js', '.ts'],
  ['.mjs', '.mts'],
];

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file:')) {
    for (const [compiled, source] of SOURCES) {
      if (!specifier.endsWith(compiled)) continue;
      const asCompiled = new URL(specifier, context.parentURL);
      if (existsSync(fileURLToPath(asCompiled))) break;
      const asSource = new URL(`${specifier.slice(0, -compiled.length)}${source}`, context.parentURL);
      if (existsSync(fileURLToPath(asSource))) return nextResolve(asSource.href, context);
    }
  }
  return nextResolve(specifier, context);
}
