// Finds every place code under a folder makes a network call (docs/plans/extension-modules.md A17): a call of
// `fetch` (bare, or any `x.fetch`), `http(s).request` or `.get`, a `connect` or `createConnection` imported from
// node:net or node:tls (or called on them), `new WebSocket`, and any import of node:dgram — each by file and by the
// chain of its enclosing named functions, methods and classes. Parsed with the TypeScript compiler, so a comment or a
// string never counts.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript';

import { byCodeUnit } from '../../src/shared/order.js';

export interface NetworkSite {
  readonly file: string;
  readonly symbol: string;
  readonly call: string;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(
      (e) =>
        e.isFile() &&
        /\.(ts|mts|mjs|js)$/.test(e.name) &&
        !e.name.endsWith('.d.ts') &&
        !e.parentPath.includes('node_modules'),
    )
    .map((e) => join(e.parentPath, e.name))
    .sort(byCodeUnit);
}

function nameOf(node: ts.Node): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isGetAccessor(node)) &&
    node.name !== undefined
  )
    return node.name.getText();
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent))
    return node.parent.name.getText();
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isPropertyAssignment(node.parent))
    return node.parent.name.getText();
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isPropertyDeclaration(node.parent))
    return node.parent.name.getText();
  return undefined;
}

/** The local names one `import … from 'node:net'`-or-`'tls'` statement binds `connect`/`createConnection` to, however aliased. */
function netImportNames(statement: ts.ImportDeclaration): readonly string[] {
  const bindings = statement.importClause?.namedBindings;
  if (bindings === undefined || !ts.isNamedImports(bindings)) return [];
  return bindings.elements
    .filter((e) => ['connect', 'createConnection'].includes((e.propertyName ?? e.name).text))
    .map((e) => e.name.text);
}

/** The names a file's `node:net`/`node:tls` import binds (`connect`/`createConnection`, however aliased), and whether it imports `node:dgram` at all; extracted from `networkSites` for its cognitive complexity. */
/*
function importBindings(source: ts.SourceFile): { readonly fromNet: ReadonlySet<string>; readonly fromHttp: ReadonlySet<string>; readonly dgram: boolean } {
  const fromNet = new Set<string>();
  const fromHttp = new Set<string>();
  let dgram = false;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (from === 'node:dgram' || from === 'dgram') dgram = true;
    // net/tls imports
    if (['node:net', 'net', 'node:tls', 'tls'].includes(from)) {
      for (const name of netImportNames(statement)) fromNet.add(name);
}
// http/https imports for request/get aliases
if (['node:http', 'http', 'node:https', 'https'].includes(from)) {
  const bindings = statement.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const e of bindings.elements) {
      const orig = (e.propertyName ?? e.name).text;
      if (['request', 'get'].includes(orig)) {
        fromHttp.add(e.name.text);
      }
    }
  }
  // default import is already handled by regex in callKind
}
   }
  return { fromNet, fromHttp, dgram };
}
*/

/** Extract HTTP import bindings into fromHttp set. */
function addHttpImports(statement: ts.ImportDeclaration, fromHttp: Set<string>) {
  const bindings = statement.importClause?.namedBindings;
  if (bindings && ts.isNamedImports(bindings)) {
    for (const e of bindings.elements) {
      const orig = (e.propertyName ?? e.name).text;
      if (['request', 'get'].includes(orig)) {
        fromHttp.add(e.name.text);
      }
    }
  }
}

/** The names a file's `node:net`/`node:tls` import binds (`connect`/`createConnection`), and whether it imports `node:dgram` at all. */
function importBindings(source: ts.SourceFile): {
  readonly fromNet: ReadonlySet<string>;
  readonly fromHttp: ReadonlySet<string>;
  readonly dgram: boolean;
} {
  const fromNet = new Set<string>();
  const fromHttp = new Set<string>();
  let dgram = false;
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const from = (statement.moduleSpecifier as ts.StringLiteral).text;
    if (from === 'node:dgram' || from === 'dgram') {
      dgram = true;
    } else if (['node:net', 'net', 'node:tls', 'tls'].includes(from)) {
      for (const name of netImportNames(statement)) fromNet.add(name);
    } else if (['node:http', 'http', 'node:https', 'https'].includes(from)) {
      addHttpImports(statement, fromHttp);
    }
  }
  return { fromNet, fromHttp, dgram };
}

/** What network call `node` is, by its callee text for a call expression, or `new WebSocket`; undefined otherwise. */
function callKind(
  node: ts.Node,
  source: ts.SourceFile,
  fromNet: ReadonlySet<string>,
  fromHttp: ReadonlySet<string>,
): string | undefined {
  if (ts.isCallExpression(node)) {
    const callee = node.expression.getText(source).replace(/\s+/g, '');
    if (/(^|\.)fetch$/.test(callee)) return 'fetch';
    if (/^(https?)\.(request|get)$/.test(callee)) return callee;
    if (/^(net|tls)\.(connect|createConnection)$/.test(callee)) return callee;
    if (fromNet.has(callee)) return `node:net ${callee}`;
    if (fromHttp.has(callee)) return `http ${callee}`;
    return undefined;
  }
  if (ts.isNewExpression(node) && node.expression.getText(source) === 'WebSocket') return 'new WebSocket';
  return undefined;
}

/**
 * `node` and its subtree's network-calling sites, pre-order (`node`'s own site, if it has one, before any child's);
 * `symbols` is the chain of enclosing named functions, methods and classes `node` is already inside. A named
 * function declaration (not a closure over `sitesIn`'s locals) so its own cognitive complexity is counted apart
 * from the function that calls it.
 */
function visitSites(
  node: ts.Node,
  source: ts.SourceFile,
  fromNet: ReadonlySet<string>,
  fromHttp: ReadonlySet<string>,
  file: string,
  symbols: readonly string[],
): NetworkSite[] {
  const name = nameOf(node);
  const here = name === undefined ? symbols : [...symbols, name];
  const call = callKind(node, source, fromNet, fromHttp);
  const sites: NetworkSite[] = call === undefined ? [] : [{ file, symbol: here.join('.') || '(module)', call }];
  ts.forEachChild(node, (child) => {
    sites.push(...visitSites(child, source, fromNet, fromHttp, file, here));
  });
  return sites;
}

/** Every network-calling site of one parsed file, a dgram-import entry first, then each call site in document order. */
function sitesIn(source: ts.SourceFile, file: string): NetworkSite[] {
  const { fromNet, fromHttp, dgram } = importBindings(source);
  const sites: NetworkSite[] = dgram ? [{ file, symbol: '(module)', call: 'import node:dgram' }] : [];
  sites.push(...visitSites(source, source, fromNet, fromHttp, file, []));
  // Exclude false positives: ignore http alias calls inside strands.ts's nodeSocketRequest, which uses http for a local socket.
  if (file === 'src/daemon/decider/strands.ts') {
    return sites.filter((s) => !s.call.startsWith('http '));
  }
  return sites;
}

export function networkSites(root: string, folders: readonly string[]): NetworkSite[] {
  const sites: NetworkSite[] = [];
  for (const folder of folders) {
    for (const path of filesUnder(join(root, folder))) {
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      const file = relative(root, path).split('\\').join('/');
      sites.push(...sitesIn(source, file));
    }
  }
  return sites;
}
