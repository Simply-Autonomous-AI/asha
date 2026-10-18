// Renders docs/**/*.md to docs/**/*.html, file for file (PRINCIPLES §17). The
// Markdown is the source; the HTML is a committed render, never edited by
// hand. Byte-identical in harness and web — verify with
//   md5 harness/tools/docs/render.mts web/tools/docs/render.mts
// Run: npm run docs. The docs guard (tests/unit/docs.test.ts) re-renders every
// page and fails on a committed .html that differs.
//
// A source is front matter, then one `# Title` heading, then the page:
//
//   ---
//   title: Two to four words      (the <title>)
//   description: One sentence.    (the meta description)
//   status: draft                 (plan pages only: draft|ready|in-progress|done)
//   ---
//
// Everything before the first `##` goes in the page header; each `##` starts a
// <section>. `{#id}` at the end of a heading sets its id. A local .svg image
// alone in a paragraph is inlined as a diagram. Raw HTML passes through.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Marked, type MaybePromise, type Token, type Tokens } from 'marked';

import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';

export const PLAN_STATUSES: readonly string[] = ['draft', 'ready', 'in-progress', 'done'];
const PLAN_PAGES_WITHOUT_STATUS: readonly string[] = ['plans/index.md', 'plans/template.md', 'plans/debt.md'];
const TOC_MIN_SECTIONS = 4;
/** "> [!KIND] optional title" at the start of a quote makes it a callout of that kind. */
const CALLOUT_KINDS: Readonly<Record<string, string>> = {
  NOTE: 'Note',
  TIP: 'Tip',
  WARNING: 'Warning',
  DECISION: 'Decision',
  SUMMARY: 'In short',
};
/** A status value, and the badge class and label it renders as. */
const STATUS_BADGE: Readonly<Record<string, readonly [string, string]>> = {
  draft: ['draft', 'draft'],
  ready: ['ready', 'ready'],
  'in-progress': ['progress', 'in progress'],
  done: ['done', 'done'],
};

export class DocsRenderError extends Error {
  readonly file: string;
  constructor(file: string, detail: string, options?: { readonly cause?: unknown }) {
    super(`${file}: ${detail}`, options);
    this.name = 'DocsRenderError';
    this.file = file;
  }
}

export interface FrontMatter {
  readonly title: string;
  readonly description: string;
  readonly status?: string;
}

export interface RenderPageProps {
  /** Path of the source relative to docs/, with forward slashes: `cli/index.md`. */
  readonly file: string;
  readonly source: string;
  /** The front-matter title of another source, by its docs/-relative path. */
  readonly titleOf: (file: string) => string;
  /** The text of a file, by its docs/-relative path (for inlined SVG). */
  readonly readFile: (file: string) => string;
}

/** "key: value" per line of the front matter block: split at the first ": ", no quoting, trimmed; an empty value fails. */
function parseFrontMatterFields(file: string, block: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of block.split('\n')) {
    const kv = /^([a-z]+):\s*(\S.*)$/.exec(line);
    if (kv === null) throw new DocsRenderError(file, `front matter line is not "key: value": ${JSON.stringify(line)}`);
    const key = present(kv[1], "the front matter line's key");
    const value = present(kv[2], "the front matter line's value");
    if (fields.has(key)) throw new DocsRenderError(file, `front matter key "${key}" appears twice`);
    fields.set(key, value.trim());
  }
  return fields;
}

/** Every field is one of `allowed`, and every one of `allowed` is there. */
function checkFrontMatterKeys(file: string, fields: ReadonlyMap<string, string>, allowed: readonly string[]): void {
  for (const key of fields.keys()) {
    if (!allowed.includes(key))
      throw new DocsRenderError(file, `unknown front matter key "${key}" (allowed: ${allowed.join(', ')})`);
  }
  for (const key of allowed) {
    if (!fields.has(key)) throw new DocsRenderError(file, `front matter is missing "${key}"`);
  }
}

export function parseFrontMatter(file: string, source: string): { readonly meta: FrontMatter; readonly body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (match === null) throw new DocsRenderError(file, 'no front matter (--- title/description --- at the top)');
  const fields = parseFrontMatterFields(file, present(match[1], 'the front matter block'));
  const isPlan = file.startsWith('plans/') && !PLAN_PAGES_WITHOUT_STATUS.includes(file);
  const allowed = isPlan ? ['title', 'description', 'status'] : ['title', 'description'];
  checkFrontMatterKeys(file, fields, allowed);
  const status = fields.get('status');
  if (status !== undefined && !PLAN_STATUSES.includes(status)) {
    throw new DocsRenderError(file, `status "${status}" is not one of ${PLAN_STATUSES.join(', ')}`);
  }
  const meta: FrontMatter = {
    title: present(fields.get('title'), 'front matter title'),
    description: present(fields.get('description'), 'front matter description'),
    ...(status === undefined ? {} : { status }),
  };
  return { meta, body: source.slice(match[0].length) };
}

/** Lowercase; tags and entities dropped; every run of other characters becomes one "-"; trimmed. */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      // `(?=(…))\1` emulates an atomic group (JS has none): the same match as a plain quantifier, but without the
      // engine's wasted backtracking into it on failure (sonarjs/super-linear-regex), verified byte-for-byte equal.
      .replace(/<(?=([^>]+))\1>/g, '')
      .replace(/&[a-z0-9#]+;/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^(?=(-+))\1|(?=(-+))\2$/g, '')
  );
}

// escapeText's pattern, in named fragments (sonarjs/regex-complexity: one literal this size is harder to read than
// its parts named); the assembled pattern is the same regex, unchanged, as the single literal it replaces.
const ESCAPE_SPECIAL = String.raw`[<>"]`;
const ESCAPE_ENTITY_REF = String.raw`(?:#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);`;
const ESCAPE_TEXT = new RegExp(`${ESCAPE_SPECIAL}|&(?!${ESCAPE_ENTITY_REF})`, 'g');
const ESCAPES: Readonly<Record<string, string>> = { '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' };

/** Escapes Markdown text, leaving entities the author wrote (&lt; &amp; &#58;) as they are. */
function escapeText(text: string): string {
  return text.replace(ESCAPE_TEXT, (c) => present(ESCAPES[c], `an escape for ${JSON.stringify(c)}`));
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Runs `cb` — a `marked.walkTokens` call, whose callback (`walk`, below) is synchronous throughout — and throws if
 * it returned any promise: a renderer that is pure and synchronous everywhere else must never silently drop a
 * walkTokens callback's async work, so a promise here fails loudly (PRINCIPLES §9) rather than being discarded.
 */
function runWalkSync(cb: () => MaybePromise[]): void {
  for (const result of cb()) {
    if (result instanceof Promise)
      throw new Error(
        'marked.walkTokens returned a promise; the docs renderer expects every walkTokens callback to be synchronous',
      );
  }
}

const REMOTE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/**
 * `x.md#f` → `x.html#f` for a relative link from a page in `dir` to a source
 * under docs/. Links outside docs/ (../../AGENTS.md), remote links and
 * fragments are unchanged.
 */
export function rewriteHref(dir: string, href: string): string {
  if (REMOTE.test(href) || href.startsWith('#')) return href;
  const path = present(href.split('#', 1)[0], 'the href before its fragment');
  if (!path.endsWith('.md')) return href;
  const target = posix.normalize(posix.join(dir, path));
  if (target === '..' || target.startsWith('../')) return href;
  return href.replace(/\.md(?=#|$)/, '.html');
}

/** Renders one source to its HTML page. Pure: all file access is injected. */
export function renderPage(props: RenderPageProps): string {
  const { file } = props;
  const { meta, body } = parseFrontMatter(file, props.source);
  const dir = posix.dirname(file);
  if (file.split('/').length > 2) throw new DocsRenderError(file, 'is nested deeper than docs/<section>/<page>.md');
  const ids = new Set<string>();
  const claim = (id: string, heading: string): string => {
    if (id === '')
      throw new DocsRenderError(file, `heading "${heading}" has no letters or digits for an id; give it {#id}`);
    if (ids.has(id)) throw new DocsRenderError(file, `duplicate id "${id}"`);
    ids.add(id);
    return id;
  };

  const marked = new Marked({ gfm: true });
  const tokens = marked.lexer(body);
  // A heading token's id: from an explicit `{#id}` suffix (removed from its text), or slugged from its words.
  // The leading `\s*` of the {#id} match is atomic-emulated (as slug's regexes are, below), which shifts its id's
  // capture from group 1 to group 2; the trailing `\s*$`, anchored at the end, needs no such care (scslre).
  const headingId = (token: Tokens.Heading): string => {
    const explicit = /(?=(\s*))\1\{#([A-Za-z0-9_.-]+)\}\s*$/.exec(token.text);
    const last = token.tokens[token.tokens.length - 1];
    if (explicit === null) {
      // Slug the heading's words: link and image targets and code backticks are not part of them.
      const words = token.text.replace(/!?\[(?=([^\]]*))\1\]\([^)]*\)/g, '$1').replace(/`/g, '');
      return slug(words);
    }
    token.text = token.text.slice(0, explicit.index);
    if (last !== undefined && 'text' in last)
      last.text = (last.text as string).replace(/(?=(\s*))\1\{#[A-Za-z0-9_.-]+\}\s*$/, '');
    if (last !== undefined && 'raw' in last) last.raw = last.raw.replace(/(?=(\s*))\1\{#[A-Za-z0-9_.-]+\}\s*$/, '');
    return present(explicit[2], "the heading's explicit {#id}");
  };
  const walk = (token: Token): void => {
    if (token.type === 'heading') {
      (token as Tokens.Heading & { id?: string }).id = headingId(token as Tokens.Heading);
    } else if (token.type === 'link') {
      token.href = rewriteHref(dir, token.href as string);
    } else if (token.type === 'image') {
      // Checked here; a lone local .svg in its own paragraph is inlined by the paragraph renderer.
      if (REMOTE.test(token.href as string))
        throw new DocsRenderError(file, `image loads from the network: ${token.href as string}`);
      if (!/\.svg$/i.test(token.href as string))
        throw new DocsRenderError(file, `image ${token.href as string} is not an .svg diagram`);
    } else if (token.type === 'html') {
      const rewritten = (token.text as string).replace(
        /\bhref="([^"]*)"/g,
        (_m, href: string) => `href="${rewriteHref(dir, href)}"`,
      );
      token.text = rewritten;
      token.raw = rewritten;
    }
  };
  // Registered so every parse runs it, captions included; the page tokens are walked here too, because lexing
  // alone does not run walkTokens.
  marked.use({ walkTokens: walk });
  runWalkSync(() => marked.walkTokens(tokens, walk));

  marked.use({
    renderer: {
      heading(token) {
        // The h1 is the page title and carries no id, so it claims none.
        if (token.depth === 1) return `<h1>${this.parser.parseInline(token.tokens)}</h1>\n`;
        const id = claim((token as Tokens.Heading & { id?: string }).id ?? '', token.text);
        const inner = this.parser.parseInline(token.tokens);
        // An h2 is rendered by the section wrapper below, which carries its id.
        return token.depth === 2
          ? `<h2>${inner}</h2>\n`
          : `<h${String(token.depth)} id="${id}">${inner}</h${String(token.depth)}>\n`;
      },
      // A diagram is inlined only when alone in its own paragraph (above); an image anywhere
      // else (a sentence, a list item, a table cell, a heading, a link) is an error.
      image(token) {
        throw new DocsRenderError(file, `diagram ${token.href} must be alone in its own paragraph`);
      },
      blockquote(token) {
        const first = token.tokens[0];
        const marker =
          first?.type === 'paragraph'
            ? /^\[!([A-Za-z]+)\][ \t]*([^\n]*)\n?/.exec((first as Tokens.Paragraph).text)
            : null;
        if (marker === null) return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
        // Any case is accepted ("> [!note]" as GitHub does); an unknown kind is an error, never a plain quote.
        const kindRaw = present(marker[1], "the callout marker's kind");
        const kind = kindRaw.toUpperCase();
        const label = CALLOUT_KINDS[kind];
        if (label === undefined)
          throw new DocsRenderError(
            file,
            `unknown callout [!${kindRaw}] (use ${Object.keys(CALLOUT_KINDS).join(', ')})`,
          );
        // Drop the marker line from the first paragraph; whatever follows it is the callout's body.
        const rest = (first as Tokens.Paragraph).text.slice(marker[0].length);
        const inline = marked.Lexer.lexInline(rest);
        runWalkSync(() => marked.walkTokens(inline, walk)); // the rewrite pass ran before this text was re-lexed
        const body = [
          ...(rest.trim() === '' ? [] : [{ ...first, text: rest, raw: rest, tokens: inline } as Token]),
          ...token.tokens.slice(1),
        ];
        const titleRaw = present(marker[2], "the callout marker's title").trim();
        const title = titleRaw === '' ? label : (marked.parseInline(titleRaw) as string);
        return `<div class="callout ${kind.toLowerCase()}">\n<p class="callout-title">${title}</p>\n${this.parser.parse(body)}</div>\n`;
      },
      table(token) {
        return `<div class="table-wrap">\n${renderTable(this.parser, token)}</div>\n`;
      },
      paragraph(token) {
        const only = token.tokens.length === 1 ? token.tokens[0] : undefined;
        if (only?.type === 'image') {
          const image = only as Tokens.Image;
          return figure(image.href, image.text);
        }
        return `<p>${this.parser.parseInline(token.tokens)}</p>\n`;
      },
      text(token) {
        // A text token with children (a list item's text) is rendered through them; only leaves are wrapped.
        if ('tokens' in token && token.tokens !== undefined) return this.parser.parseInline(token.tokens);
        const html = 'escaped' in token && token.escaped === true ? token.text : escapeText(token.text);
        // Only a literal "TODO:" in the source is a gap; "TODO&#58;" (a mention of the marker) renders as text.
        if (!token.raw.includes('TODO:')) return html;
        return html.replace(/TODO:[^\n]*/g, (gap) => `<span class="todo">${gap}</span>`);
      },
    },
  });

  function figure(href: string, caption: string): string {
    const target = posix.normalize(posix.join(dir, href));
    if (target === '..' || target.startsWith('../'))
      throw new DocsRenderError(file, `diagram ${href} is outside docs/`);
    let svg: string;
    try {
      svg = props.readFile(target);
    } catch (error) {
      throw new DocsRenderError(file, `diagram ${href} cannot be read: ${(error as Error).message}`, { cause: error });
    }
    if (!/<title[\s>]/.test(svg)) throw new DocsRenderError(file, `diagram ${href} has no <title>`);
    const body = svg
      .replace(/^<\?xml[^>]*>\s*/, '')
      .replace(/^<!DOCTYPE[^>]*>\s*/i, '')
      .trim();
    return `<figure class="diagram">\n${body}\n<figcaption>${marked.parseInline(caption) as string}</figcaption>\n</figure>\n`;
  }

  // Split the page: exactly one h1; what precedes the first h2 is the header.
  const h1s = tokens.filter((t) => t.type === 'heading' && (t as Tokens.Heading).depth === 1);
  if (h1s.length !== 1) throw new DocsRenderError(file, `needs exactly one "# " heading, found ${String(h1s.length)}`);
  const chunks: { heading?: Tokens.Heading; tokens: Token[] }[] = [{ tokens: [] }];
  for (const token of tokens) {
    if (token.type === 'heading' && (token as Tokens.Heading).depth === 2)
      chunks.push({ heading: token as Tokens.Heading, tokens: [token] });
    else present(chunks[chunks.length - 1], 'the chunk being built').tokens.push(token);
  }
  const parse = (list: Token[]): string => marked.parser(Object.assign(list, { links: tokens.links }));

  /** A chunk's heading, with the id `headingId` claimed for it: set on every heading but the page's own h1. */
  const headingOf = (chunk: { heading?: Tokens.Heading }): Tokens.Heading & { id: string } => {
    const heading = present(chunk.heading, "a section chunk's heading");
    return { ...heading, id: present((heading as Tokens.Heading & { id?: string }).id, "the heading's claimed id") };
  };

  // The first paragraph after the title is the page's lede.
  const header = parse(present(chunks[0], 'the header chunk').tokens).replace(/(<\/h1>\n)<p>/, '$1<p class="lede">');
  const sections = chunks.slice(1).map((chunk) => {
    const { id } = headingOf(chunk);
    return `<section id="${id}">\n${parse(chunk.tokens)}</section>`;
  });
  const toc =
    sections.length >= TOC_MIN_SECTIONS
      ? `<nav class="toc" aria-label="On this page">\n<h2>On this page</h2>\n<ol>\n${chunks
          .slice(1)
          .map((c) => {
            const heading = headingOf(c);
            const label = (marked.parseInline(heading.text) as string).replace(/<\/?a\b[^>]*>/g, '');
            return `<li><a href="#${heading.id}">${label}</a></li>`;
          })
          .join('\n')}\n</ol>\n</nav>\n`
      : '';

  const up = dir === '.' ? '' : '../'.repeat(dir.split('/').length);
  const badge = meta.status === undefined ? undefined : present(STATUS_BADGE[meta.status], 'a status badge');
  const status = badge === undefined ? '' : `<p class="facts"><span class="badge ${badge[0]}">${badge[1]}</span></p>\n`;
  const section = dir === '.' ? 'home' : present(dir.split('/')[0], "the page's section");

  return `<!doctype html>
<!-- Generated from docs/${file} by tools/docs/render.mts. Edit the Markdown, then run npm run docs. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<meta name="description" content="${escapeHtml(meta.description)}">
<link rel="stylesheet" href="${up}assets/docs.css">
</head>
<body data-section="${section}">
<main>
<header class="page">
<nav class="crumbs">${crumbs(file, props.titleOf)}</nav>
${status}${header}</header>
${toc}${sections.join('\n')}
<footer class="page"><span>Source: <code>docs/${file}</code></span><span>Rendered by tools/docs/render.mts — edit the Markdown, not this file.</span><span>Copyright © 2026 SimplyAutonomous.AI, LLC. All rights reserved, except as the repository's LICENSE grants.</span></footer>
</main>
</body>
</html>
`;
}

function renderTable(parser: { parseInline(tokens: Token[]): string }, token: Tokens.Table): string {
  const align = (a: string | null): string => (a === null ? '' : ` style="text-align:${a}"`);
  const head = token.header
    .map((cell, i) => `<th${align(token.align[i] ?? null)}>${parser.parseInline(cell.tokens)}</th>`)
    .join('');
  const rowCells = (row: Tokens.TableCell[]): string =>
    row.map((cell, i) => `<td${align(token.align[i] ?? null)}>${parser.parseInline(cell.tokens)}</td>`).join('');
  const rows = token.rows.map((row) => `<tr>${rowCells(row)}</tr>`).join('\n');
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>\n`;
}

/** docs index → section index → page; every step a link except the page itself. */
function crumbs(file: string, titleOf: (file: string) => string): string {
  const parts = file.split('/');
  const steps: { file: string; label: string }[] = [{ file: 'index.md', label: titleOf('index.md') }];
  if (parts.length > 1) {
    const section = present(parts[0], "the page's section");
    steps.push({ file: `${section}/index.md`, label: titleOf(`${section}/index.md`) });
  }
  if (parts.length > 1 && parts[parts.length - 1] !== 'index.md') steps.push({ file, label: titleOf(file) });
  const from = posix.dirname(file);
  return steps
    .map((step) =>
      step.file === file
        ? escapeHtml(step.label)
        : `<a href="${posix.relative(from, step.file).replace(/\.md$/, '.html')}">${escapeHtml(step.label)}</a>`,
    )
    .join(' / ');
}

/** Every .md under docsRoot, as docs/-relative forward-slash paths, sorted. */
export function listSources(docsRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md')) out.push(relative(docsRoot, path).split(sep).join('/'));
    }
  };
  walk(docsRoot);
  return out.sort(byCodeUnit);
}

/** Renders every source under docsRoot; keys are docs/-relative .html paths. */
export function renderAll(docsRoot: string, only?: readonly string[]): Map<string, string> {
  const files = listSources(docsRoot);
  const titles = new Map(
    files.map((f) => [f, parseFrontMatter(f, readFileSync(join(docsRoot, f), 'utf8')).meta.title]),
  );
  const titleOf = (f: string): string => {
    const title = titles.get(f);
    if (title === undefined) throw new DocsRenderError(f, 'is linked in the breadcrumbs but has no source');
    return title;
  };
  const readFile = (f: string): string => readFileSync(join(docsRoot, f), 'utf8');
  const out = new Map<string, string>();
  for (const f of only ?? files) {
    if (!titles.has(f)) throw new DocsRenderError(f, 'no such source under docs/');
    out.set(f.replace(/\.md$/, '.html'), renderPage({ file: f, source: readFile(f), titleOf, readFile }));
  }
  return out;
}

/** Renders every source, or only the named ones (docs/-relative .md paths). */
export function main(docsRoot: string, only: readonly string[]): void {
  const pages = renderAll(docsRoot, only.length === 0 ? undefined : only);
  for (const [file, html] of pages) writeFileSync(join(docsRoot, file), html);
  process.stdout.write(`rendered ${String(pages.size)} pages under ${docsRoot}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs'), process.argv.slice(2));
}
