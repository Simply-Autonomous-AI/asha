// The import graph of TypeScript sources, as the compiled modules will load it (docs/plans/portal.md R15, A16):
// every `import … from` and `export … from` that survives compilation — `import type` and `export type` are erased
// under verbatimModuleSyntax; `import { type A }` is not (it still loads its module). Used to prove no module the
// portal serves reaches a `node:` import.

import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import { present } from '../../src/shared/assert-present.js';

/** One module specifier a source loads at run time, and the line it is on. */
export interface RuntimeImport {
  readonly specifier: string;
  readonly line: number;
}

/**
 * Whether `middle` — the text of a statement between `import`/`export` and its quoted specifier — opens with a
 * `type` keyword (erased at compile time) and, once that prefix is removed, ends in a `from` keyword (so the
 * specifier is actually loaded, as opposed to, say, `export { x }` with no `from` at all).
 */
function classifyStatement(middle: string): { readonly isType: boolean; readonly isFrom: boolean } {
  const typePrefix = /^\s*type\s+/.exec(middle);
  const isType = typePrefix !== null;
  const afterType = isType ? middle.slice(typePrefix[0].length) : middle;
  return { isType, isFrom: /\bfrom\s*$/.test(afterType) };
}

/** The specifiers a source loads at run time. */
export function runtimeImports(source: string): RuntimeImport[] {
  const found: RuntimeImport[] = [];
  // Statements may span lines: match from `import`/`export` to the quoted specifier that ends the statement. The
  // text between them is captured whole (one quantifier, unambiguous since it excludes the quote and `;` it stops
  // at) rather than split into two adjacent optional groups, whose overlap `sonarjs/super-linear-regex` correctly
  // flagged; `classifyStatement` does the `type`/`from` classification the two groups used to, on that capture.
  const statement = /(^|\n)[ \t]*(import|export)\s([^;'"]*)['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(statement)) {
    const middle = present(m[3], 'regex capture group 3 (statement body)');
    const { isType, isFrom } = classifyStatement(middle);
    if (isType || !(isFrom || m[2] === 'import')) continue;
    const line = source.slice(0, m.index + present(m[1], 'regex capture group 1 (prefix)').length).split('\n').length;
    found.push({ specifier: present(m[4], 'regex capture group 4 (specifier)'), line });
  }
  return found;
}

/** A path, relative to `root`, from an importing module to a `node:` import it reaches, or undefined. */
export interface NodeReach {
  readonly chain: readonly string[];
  readonly specifier: string;
}

/**
 * Walks every module reachable from `entry` (a .ts file) by relative imports, a `.js` specifier naming its `.ts`
 * source, and returns each path that reaches a `node:` import (or a bare package name: nothing the page serves is a
 * package). `root` makes the reported paths relative.
 */
export function nodeImportsReachable(entry: string, root: string): NodeReach[] {
  const reaches: NodeReach[] = [];
  const seen = new Set<string>();
  const visit = (file: string, chain: readonly string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const here = [...chain, relative(root, file)];
    for (const { specifier, line } of runtimeImports(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        visit(resolve(dirname(file), specifier.replace(/\.js$/, '.ts')), here);
        continue;
      }
      reaches.push({ chain: here, specifier: `${specifier} (line ${String(line)})` });
    }
  };
  visit(resolve(entry), []);
  return reaches;
}
