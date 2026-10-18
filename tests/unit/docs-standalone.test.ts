// The docs as GitHub shows them, page by page, outside the rendered site (2026-10-18: the published architecture page
// showed "Error in user YAML" and black diagrams). Every published Markdown file's front matter is YAML a strict parser
// reads to the same values the docs renderer reads; every docs diagram carries the standalone style
// tools/docs/svg-standalone.mts builds from docs/assets/docs.css, matched only where the svg is its own document.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { MARKER, docsSvgs, standaloneStyle, withStandaloneStyle } from '../../tools/docs/svg-standalone.mjs';
import { readManifest, shipped } from '../../tools/oss/manifest.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const CSS = readFileSync(join(ROOT, 'docs', 'assets', 'docs.css'), 'utf8');

/** Each way `block`, a front matter's text, is not YAML whose values are the renderer's `key: value` texts. */
function frontMatterProblems(block: string): string[] {
  let parsed: unknown;
  try {
    // YAML 1.1, as GitHub reads front matter: `Yes` is a boolean there and a bare date a timestamp.
    parsed = parse(block, { version: '1.1', strict: true, uniqueKeys: true });
  } catch (error) {
    return [`not YAML: ${(error as Error).message.split('\n')[0] ?? ''}`];
  }
  const values = parsed as Record<string, unknown>;
  return block.split('\n').flatMap((line) => {
    const kv = /^([a-z]+):(.*)$/.exec(line);
    if (kv === null) return [`not "key: value": ${line}`];
    const [, key = '', text = ''] = kv;
    return values[key] === text.trim() ? [] : [`${key} reads as ${JSON.stringify(values[key])}`];
  });
}

describe('front matter GitHub can read (2026-10-18)', () => {
  it('is YAML in every Markdown file the export publishes, each value the text the renderer reads', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', '*.md'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((f) => f !== '');
    const files = shipped(readManifest(ROOT), tracked);
    const blocks = files.flatMap((f) => {
      const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(join(ROOT, f), 'utf8'));
      return m === null ? [] : [[f, m[1] ?? ''] as const];
    });
    expect(blocks.length).toBeGreaterThan(50);
    expect(blocks.flatMap(([f, block]) => frontMatterProblems(block).map((p) => `${f}: ${p}`))).toEqual([]);
  });

  it('names a second ": " in a value, a value YAML reads as another type, and a value that is plain text', () => {
    expect(frontMatterProblems('title: T\ndescription: How it is built: its parts.')).toEqual([
      'not YAML: Nested mappings are not allowed in compact mappings at line 2, column 14:',
    ]);
    expect(frontMatterProblems('title: 1.0\ndescription: D.')).toEqual(['title reads as 1']);
    expect(frontMatterProblems('title: Yes\ndescription: D.')).toEqual(['title reads as true']);
    expect(frontMatterProblems('title: 2026-10-18\ndescription: D.')).toEqual([
      'title reads as "2026-10-18T00:00:00.000Z"',
    ]);
    expect(frontMatterProblems('title: T\ndescription: How it is built — its parts.')).toEqual([]);
  });
});

describe('diagrams GitHub can draw (2026-10-18)', () => {
  const style = standaloneStyle(CSS);

  it("carries, in every docs diagram, the stylesheet's svg rules under svg:root", () => {
    const svgs = docsSvgs(ROOT);
    expect(svgs.length).toBeGreaterThan(50);
    const stale = svgs.filter((f) => {
      const svg = readFileSync(join(ROOT, f), 'utf8');
      return withStandaloneStyle(svg, style) !== svg;
    });
    expect(stale, 'run: node --experimental-strip-types tools/docs/svg-standalone.mts').toEqual([]);
  });

  it('builds the block from the stylesheet: each svg rule, its variables resolved, under svg:root', () => {
    const css = [
      ':root {\n  --surface: #fff;\n  /* a comment */\n  --ink: #111;\n  --sans: "Plex", sans-serif;\n  color-scheme: light;\n}',
      'figure.diagram svg { width: 100%; font-family: var(--sans); }',
      'svg .box { fill: var(--surface); stroke: var(--ink); }',
      'svg .label.small { font-size: 11px; }',
      'a.svg .box { fill: red; }',
    ].join('\n');
    expect(standaloneStyle(css).split('\n')).toEqual([
      '<style>',
      MARKER,
      'svg:root { background: #fff; font-family: "Plex", sans-serif; }',
      'svg:root .box { fill: #fff; stroke: #111; }',
      'svg:root .label.small { font-size: 11px; }',
      '</style>',
    ]);
    expect(() => standaloneStyle(css.replace('--ink: #111;', ''))).toThrow(
      'docs.css uses --ink, which its :root does not define',
    );
    expect(() => standaloneStyle(':root { --surface: #fff; }')).toThrow('docs.css has no `svg .class { … }` rule');
    for (const rule of [
      'svg .label.title, svg .label.strong { font-weight: 700; }',
      'svg text.label { fill: red; }',
      'svg .box{fill: red;}',
    ])
      expect(() => standaloneStyle(`${css}\n${rule}`)).toThrow(
        `docs.css has an svg rule this tool cannot copy: ${rule}`,
      );
    expect(() => standaloneStyle(`${css}\nsvg .edge { stroke: var(--sec, #000); }`)).toThrow(
      'docs.css has a var() this tool cannot resolve: stroke: var(--sec, #000);',
    );
  });

  it('puts the block after <desc>, or <title> without one, and replaces its own earlier block, once', () => {
    const block = '<style>\n/* For a viewer showing this diagram on its own: x */\nsvg:root .a { b: c; }\n</style>';
    const svg = '<svg>\n  <title>T</title>\n  <desc>D</desc>\n  <rect class="box"/>\n</svg>';
    const once = withStandaloneStyle(svg, block);
    expect(once).toBe(
      '<svg>\n  <title>T</title>\n  <desc>D</desc>\n  <style>\n  /* For a viewer showing this diagram on its own: x */\n' +
        '  svg:root .a { b: c; }\n  </style>\n  <rect class="box"/>\n</svg>',
    );
    expect(withStandaloneStyle(once, block)).toBe(once);
    expect(withStandaloneStyle(once, block.replace('b: c', 'b: d'))).toBe(once.replace('b: c', 'b: d'));
    expect(withStandaloneStyle('<svg>\n  <title>T</title>\n</svg>', block)).toContain('</title>\n  <style>');
    expect(() => withStandaloneStyle('<svg/>', block)).toThrow('the diagram has neither <desc> nor <title>');
  });
});
