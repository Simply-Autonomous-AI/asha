// The docs diagrams viewed on their own. A docs page inlines each diagram, and docs/assets/docs.css styles its
// classes there; GitHub, or a browser opening the .svg, shows the diagram as its own document without that
// stylesheet, so every box drew black (2026-10-18). Each docs SVG therefore carries a <style> holding the
// stylesheet's `svg …` rules, their var() values resolved, every selector under `svg:root`: it matches only where the
// svg is the document's root, never once the renderer has inlined the diagram into a page, where docs.css styles it
// as before. tests/unit/docs-standalone.test.ts fails on a diagram whose block is missing or stale.
//
// Run: node --experimental-strip-types tools/docs/svg-standalone.mts — rewrites each docs SVG whose block differs.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The first line of the block, which marks it as this tool's to replace. */
export const MARKER =
  '/* For a viewer showing this diagram on its own: docs/assets/docs.css, by tools/docs/svg-standalone.mts. */';

/** The `--name: value` custom properties of the stylesheet's first `:root` rule. */
function rootVariables(css: string): Map<string, string> {
  const root = /:root\s*\{([^}]*)\}/.exec(css);
  if (root === null) throw new Error('docs.css has no :root rule');
  const vars = new Map<string, string>();
  for (const declaration of (root[1] ?? '').split(';')) {
    const colon = declaration.indexOf(':');
    // The name is the last line before the colon: a comment line may come first.
    const name = (declaration.slice(0, colon).split('\n').pop() ?? '').trim();
    if (colon > 0 && name.startsWith('--')) vars.set(name, declaration.slice(colon + 1).trim());
  }
  return vars;
}

/** `declarations` with each var(--x) replaced by its value; an unknown variable, or a var() left over (one with a
 * fallback, say), throws. */
function resolve(declarations: string, vars: ReadonlyMap<string, string>): string {
  const resolved = declarations.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const value = vars.get(name);
    if (value === undefined) throw new Error(`docs.css uses ${name}, which its :root does not define`);
    return value;
  });
  if (resolved.includes('var(')) throw new Error(`docs.css has a var() this tool cannot resolve: ${declarations}`);
  return resolved;
}

/** The <style> element every docs SVG carries, built from the docs stylesheet's text. */
export function standaloneStyle(css: string): string {
  const vars = rootVariables(css);
  const rules = [...css.matchAll(/^svg ((?:\.[\w-]+)+) \{ ([^}]*) \}$/gm)].map(
    (m) => `svg:root ${m[1] ?? ''} { ${resolve(m[2] ?? '', vars)} }`,
  );
  if (rules.length === 0) throw new Error('docs.css has no `svg .class { … }` rule');
  // Every rule that starts `svg` is one of them: a rule in another form (a grouped selector, an element, a pseudo-class)
  // would be left out silently, and its shapes would draw black on GitHub again.
  const other = css.split('\n').filter((line) => /^svg\b/.test(line) && !/^svg (?:\.[\w-]+)+ \{ [^}]* \}$/.test(line));
  if (other.length > 0) throw new Error(`docs.css has an svg rule this tool cannot copy: ${other.join(' | ')}`);
  const font = /^figure\.diagram svg \{[^}]*font-family: ([^;]+);/m.exec(css);
  if (font === null) throw new Error('docs.css gives figure.diagram svg no font-family');
  const root = `svg:root { background: ${resolve('var(--surface)', vars)}; font-family: ${resolve(font[1] ?? '', vars)}; }`;
  return ['<style>', MARKER, root, ...rules, '</style>'].join('\n');
}

/** `svg` with `style` after its <desc> (or its <title> when it has none), in place of any earlier block of this tool's. */
export function withStandaloneStyle(svg: string, style: string): string {
  const bare = svg.replace(
    /\n[ \t]*<style>\n[ \t]*\/\* For a viewer showing this diagram on its own:[\s\S]*?<\/style>/g,
    '',
  );
  const anchor = /<\/desc>/.exec(bare) ?? /<\/title>/.exec(bare);
  if (anchor === null) throw new Error('the diagram has neither <desc> nor <title>');
  const at = anchor.index + anchor[0].length;
  const indent = /\n([ \t]*)<(?:title|desc)\b/.exec(bare)?.[1] ?? '  ';
  const indented = style.split('\n').join('\n' + indent);
  return `${bare.slice(0, at)}\n${indent}${indented}${bare.slice(at)}`;
}

/** Every tracked SVG under docs/. */
export function docsSvgs(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', 'docs/*.svg', 'docs/**/*.svg'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = join(import.meta.dirname, '..', '..');
  const style = standaloneStyle(readFileSync(join(root, 'docs', 'assets', 'docs.css'), 'utf8'));
  let changed = 0;
  for (const file of docsSvgs(root)) {
    const path = join(root, file);
    const before = readFileSync(path, 'utf8');
    const after = withStandaloneStyle(before, style);
    if (after !== before) {
      writeFileSync(path, after);
      changed += 1;
    }
  }
  process.stdout.write(`svg-standalone: ${String(changed)} diagram(s) rewritten\n`);
}
