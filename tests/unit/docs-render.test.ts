// The docs renderer (tools/docs/render.mts): Markdown source → HTML page.
// Plan: docs/plans/markdown-docs.md, acceptance criteria A2–A8.

import { describe, expect, it } from 'vitest';

import { DocsRenderError, parseFrontMatter, renderPage, rewriteHref, slug } from '../../tools/docs/render.mjs';

const TITLES: Record<string, string> = {
  'index.md': 'Root docs',
  'sec/index.md': 'Section',
  'sec/page.md': 'Page',
  'plans/index.md': 'Plans',
  'plans/x.md': 'P',
};

function render(file: string, body: string, opts: { front?: string; files?: Record<string, string> } = {}): string {
  const front = opts.front ?? 'title: Page\ndescription: A page.';
  return renderPage({
    file,
    source: `---\n${front}\n---\n\n${body}`,
    titleOf: (f) => {
      const t = TITLES[f];
      if (t === undefined) throw new Error(`no title for ${f}`);
      return t;
    },
    readFile: (f) => {
      const text = opts.files?.[f];
      if (text === undefined) throw new Error(`ENOENT ${f}`);
      return text;
    },
  });
}

function renderError(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DocsRenderError);
    return (error as Error).message;
  }
  throw new Error('expected a DocsRenderError');
}

describe('front matter (A2)', () => {
  it('reads title and description, and status on a plan page', () => {
    expect(parseFrontMatter('plans/x.md', '---\ntitle: T\ndescription: D.\nstatus: in-progress\n---\nbody')).toEqual({
      meta: { title: 'T', description: 'D.', status: 'in-progress' },
      body: 'body',
    });
  });

  it.each([
    ['sec/page.md', 'description: D.', 'sec/page.md: front matter is missing "title"'],
    [
      'sec/page.md',
      'title: T\ndescription: D.\nauthor: x',
      'sec/page.md: unknown front matter key "author" (allowed: title, description)',
    ],
    [
      'plans/x.md',
      'title: T\ndescription: D.\nstatus: maybe',
      'plans/x.md: status "maybe" is not one of draft, ready, in-progress, done',
    ],
    ['plans/x.md', 'title: T\ndescription: D.', 'plans/x.md: front matter is missing "status"'],
    [
      'plans/index.md',
      'title: T\ndescription: D.\nstatus: draft',
      'plans/index.md: unknown front matter key "status" (allowed: title, description)',
    ],
    ['sec/page.md', 'title: T\ntitle: U\ndescription: D.', 'sec/page.md: front matter key "title" appears twice'],
    ['sec/page.md', 'title:\ndescription: D.', 'sec/page.md: front matter line is not "key: value": "title:"'],
  ])('%s with %j fails naming the file and key', (file, front, message) => {
    expect(renderError(() => parseFrontMatter(file, `---\n${front}\n---\nx`))).toBe(message);
  });

  it('fails with no front matter at all', () => {
    expect(renderError(() => parseFrontMatter('a.md', '# x'))).toBe(
      'a.md: no front matter (--- title/description --- at the top)',
    );
  });
});

describe('page chrome (A4)', () => {
  const four = '# A page\n\nThe lede.\n\n## One\n1\n## Two\n2\n## Three\n3\n## Four\n4\n';

  it('renders the exact head, breadcrumbs, lede, sections and footer', () => {
    const html = render('sec/page.md', '# A page\n\nThe lede.\n\nMore header.\n\n## One\nText.\n');
    expect(html).toBe(`<!doctype html>
<!-- Generated from docs/sec/page.md by tools/docs/render.mts. Edit the Markdown, then run npm run docs. -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Page</title>
<meta name="description" content="A page.">
<link rel="stylesheet" href="../assets/docs.css">
</head>
<body data-section="sec">
<main>
<header class="page">
<nav class="crumbs"><a href="../index.html">Root docs</a> / <a href="index.html">Section</a> / Page</nav>
<h1>A page</h1>
<p class="lede">The lede.</p>
<p>More header.</p>
</header>
<section id="one">
<h2>One</h2>
<p>Text.</p>
</section>
<footer class="page"><span>Source: <code>docs/sec/page.md</code></span><span>Rendered by tools/docs/render.mts — edit the Markdown, not this file.</span><span>Copyright © 2026 SimplyAutonomous.AI, LLC. All rights reserved, except as the repository's LICENSE grants.</span></footer>
</main>
</body>
</html>
`);
  });

  it('adds a table of contents at four sections, listing only the h2s', () => {
    const html = render('sec/page.md', `${four}### Sub\n`);
    expect(html).toContain(
      '<nav class="toc" aria-label="On this page">\n<h2>On this page</h2>\n<ol>\n<li><a href="#one">One</a></li>\n<li><a href="#two">Two</a></li>\n<li><a href="#three">Three</a></li>\n<li><a href="#four">Four</a></li>\n</ol>\n</nav>',
    );
  });

  it('has no table of contents at three sections', () => {
    expect(render('sec/page.md', '# A page\n\n## One\n1\n## Two\n2\n## Three\n3\n')).not.toContain('nav class="toc"');
  });

  it('crumbs: the docs index has none linked; a section index links only the docs index', () => {
    expect(render('index.md', '# Root\n\n## A\nx\n')).toContain('<nav class="crumbs">Root docs</nav>');
    expect(render('sec/index.md', '# Sec\n\n## A\nx\n')).toContain(
      '<nav class="crumbs"><a href="../index.html">Root docs</a> / Section</nav>',
    );
  });

  it('shows a plan status as its badge', () => {
    const html = render('plans/x.md', '# Plan\n\n## A\nx\n', {
      front: 'title: P\ndescription: D.\nstatus: in-progress',
    });
    expect(html).toContain('<p class="facts"><span class="badge progress">in progress</span></p>');
  });

  it.each([
    ['needs exactly one h1', 'sec/page.md', '## A\nx\n', 'sec/page.md: needs exactly one "# " heading, found 0'],
    ['refuses two h1s', 'sec/page.md', '# A\n# B\n', 'sec/page.md: needs exactly one "# " heading, found 2'],
    ['refuses deep nesting', 'a/b/c.md', '# A\n', 'a/b/c.md: is nested deeper than docs/<section>/<page>.md'],
  ])('%s', (_name, file, body, message) => {
    expect(renderError(() => render(file, body))).toBe(message);
  });
});

describe('heading ids (A5)', () => {
  it('uses {#id} when given, and a slug otherwise', () => {
    const html = render(
      'sec/page.md',
      '# A page\n\n## Logs and the 3am query {#logs}\nx\n### How it `works`, really?\nx\n',
    );
    expect(html).toContain('<section id="logs">\n<h2>Logs and the 3am query</h2>');
    expect(html).toContain('<h3 id="how-it-works-really">How it <code>works</code>, really?</h3>');
  });

  it('fails on a duplicate id, naming it', () => {
    expect(renderError(() => render('sec/page.md', '# A\n\n## One\nx\n## Two {#one}\ny\n'))).toBe(
      'sec/page.md: duplicate id "one"',
    );
  });

  it('slugs: lowercase, tags and entities dropped, runs collapsed, trimmed', () => {
    expect(slug('  The <code>--quiet</code> flag &amp; more!  ')).toBe('the-quiet-flag-more');
  });
});

describe('links (A6)', () => {
  it('rewrites .md links under docs/ and leaves everything else alone', () => {
    const html = render(
      'sec/page.md',
      '# A\n\n## L\n[a](x.md#f) [b](../../src/a.ts) [c](https://e.com/x.md) [d](../../AGENTS.md) [e](../index.md) [f](#top)\n',
    );
    expect(html).toContain(
      '<a href="x.html#f">a</a> <a href="../../src/a.ts">b</a> <a href="https://e.com/x.md">c</a> <a href="../../AGENTS.md">d</a> <a href="../index.html">e</a> <a href="#top">f</a>',
    );
  });

  it('rewrites raw HTML links the same way', () => {
    const html = render('sec/page.md', '# A\n\n## L\n<a class="badge planned" href="../plans/x.md">planned</a>\n');
    expect(html).toContain('<a class="badge planned" href="../plans/x.html">planned</a>');
  });

  it('rewriteHref: a link resolving outside docs/ is unchanged', () => {
    expect(rewriteHref('.', '../README.md')).toBe('../README.md');
    expect(rewriteHref('sec', '../other/y.md#z')).toBe('../other/y.html#z');
  });
});

describe('diagrams (A7)', () => {
  const svg = '<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"><title>Flow</title></svg>\n';

  it('inlines a lone local .svg as a figure with its caption', () => {
    const html = render('sec/page.md', '# A\n\n## D\n![The *flow*](flow.svg)\n', { files: { 'sec/flow.svg': svg } });
    expect(html).toContain(
      '<figure class="diagram">\n<svg viewBox="0 0 1 1"><title>Flow</title></svg>\n<figcaption>The <em>flow</em></figcaption>\n</figure>',
    );
  });

  it.each([
    [
      'an svg without <title>',
      '![x](d.svg)',
      { 'sec/d.svg': '<svg></svg>' },
      'sec/page.md: diagram d.svg has no <title>',
    ],
    ['a missing svg', '![x](gone.svg)', {}, 'sec/page.md: diagram gone.svg cannot be read: ENOENT sec/gone.svg'],
    [
      'a remote image',
      '![x](https://e.com/a.png)',
      {},
      'sec/page.md: image loads from the network: https://e.com/a.png',
    ],
    ['a local raster image', '![x](a.png)', {}, 'sec/page.md: image a.png is not an .svg diagram'],
    [
      'a diagram inside a sentence',
      'See ![x](d.svg) here.',
      { 'sec/d.svg': svg },
      'sec/page.md: diagram d.svg must be alone in its own paragraph',
    ],
    [
      'a diagram in a list item',
      '- ![x](d.svg)',
      { 'sec/d.svg': svg },
      'sec/page.md: diagram d.svg must be alone in its own paragraph',
    ],
    [
      'a diagram in a table cell',
      '| a |\n|---|\n| ![x](d.svg) |',
      { 'sec/d.svg': svg },
      'sec/page.md: diagram d.svg must be alone in its own paragraph',
    ],
    [
      'a diagram in a heading',
      '### S ![x](d.svg)',
      { 'sec/d.svg': svg },
      'sec/page.md: diagram d.svg must be alone in its own paragraph',
    ],
    [
      'a diagram inside a link',
      '[![x](d.svg)](x.md)',
      { 'sec/d.svg': svg },
      'sec/page.md: diagram d.svg must be alone in its own paragraph',
    ],
    ['a diagram outside docs/', '![x](../../src/d.svg)', {}, 'sec/page.md: diagram ../../src/d.svg is outside docs/'],
  ])('fails on %s', (_name, md, files, message) => {
    expect(renderError(() => render('sec/page.md', `# A\n\n## D\n${md}\n`, { files }))).toBe(message);
  });
});

describe('raw HTML and TODO markers (A8)', () => {
  it('passes raw HTML through', () => {
    const html = render('sec/page.md', '# A\n\n## R\n<div class="note"><strong>Note.</strong> Kept.</div>\n');
    expect(html).toContain('<div class="note"><strong>Note.</strong> Kept.</div>');
  });

  it('wraps a TODO: in prose to the end of its text, and stops at a table cell', () => {
    const html = render('sec/page.md', '# A\n\n## T\nTODO: fill this in.\n\n| a | b |\n|---|---|\n| TODO: x | y |\n');
    expect(html).toContain('<p><span class="todo">TODO: fill this in.</span></p>');
    expect(html).toContain('<td><span class="todo">TODO: x</span></td><td>y</td>');
    expect(html).toContain('<div class="table-wrap">\n<table>');
  });

  it('does not wrap TODO: inside code', () => {
    const html = render('sec/page.md', '# A\n\n## T\nWrite `TODO: x` in a page.\n\n```\nTODO: y\n```\n');
    expect(html).not.toContain('span class="todo"');
  });
});

describe('regressions found in conversion (2026-09-27)', () => {
  it('rewrites .md links inside a diagram caption', () => {
    const html = render('sec/page.md', '# A\n\n## D\n![See [debt](../plans/debt.md#d1)](d.svg)\n', {
      files: { 'sec/d.svg': '<svg><title>t</title></svg>' },
    });
    expect(html).toContain('<figcaption>See <a href="../plans/debt.html#d1">debt</a></figcaption>');
  });

  it('keeps entities the author wrote, and escapes bare characters once', () => {
    const html = render('sec/page.md', '# A\n\n## E\nC &#58; D &lt; E &amp; F &mdash; G \\<b> H & I\n');
    expect(html).toContain('<p>C : D &lt; E &amp; F &mdash; G &lt;b&gt; H &amp; I</p>');
  });

  it('renders a TODO&#58; mention as text, not as a gap', () => {
    const html = render('sec/page.md', '# A\n\n## M\nMark gaps with TODO&#58; and a note.\n');
    expect(html).toContain('<p>Mark gaps with TODO: and a note.</p>');
  });

  it('wraps a TODO: in a list item exactly once', () => {
    const html = render('sec/page.md', '# A\n\n## L\n- one\n- TODO: two\n');
    expect(html).toContain('<li><span class="todo">TODO: two</span></li>');
    expect(html).not.toContain('<span class="todo"><span class="todo">');
  });

  it('gives the h1 no id, so a section may use the same words as the title', () => {
    const html = render('sec/page.md', '# Plans\n\n## Plans {#plans}\nx\n');
    expect(html).toContain('<h1>Plans</h1>');
    expect(html).toContain('<section id="plans">');
  });

  it('accepts dots in an explicit id', () => {
    expect(render('sec/page.md', '# A\n\n## Q {#qwen3-1.7b-4b}\nx\n')).toContain('<section id="qwen3-1.7b-4b">');
  });
});

describe('found by the completion review (2026-09-27)', () => {
  it('escapes the title, description and crumbs', () => {
    const html = render('sec/page.md', '# A\n\n## B\nx\n', { front: 'title: A & "B" <C>\ndescription: D & "E" <F>.' });
    expect(html).toContain('<title>A &amp; &quot;B&quot; &lt;C&gt;</title>');
    expect(html).toContain('<meta name="description" content="D &amp; &quot;E&quot; &lt;F&gt;.">');
  });

  it('strips a DOCTYPE from an inlined diagram', () => {
    const html = render('sec/page.md', '# A\n\n## D\n![c](d.svg)\n', {
      files: {
        'sec/d.svg':
          '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg><title>t</title></svg>',
      },
    });
    expect(html).toContain('<figure class="diagram">\n<svg><title>t</title></svg>\n');
    expect(html).not.toContain('DOCTYPE svg');
  });

  it('slugs a heading by its words and lists it in the TOC without a nested link', () => {
    const html = render('sec/page.md', '# A\n\n## See [the guide](guide.md)\nx\n## Two\nx\n## Three\nx\n## Four\nx\n');
    expect(html).toContain('<section id="see-the-guide">\n<h2>See <a href="guide.html">the guide</a></h2>');
    expect(html).toContain('<li><a href="#see-the-guide">See the guide</a></li>');
  });

  it('names a heading that has no letters or digits for an id', () => {
    expect(renderError(() => render('sec/page.md', '# A\n\n## ???\nx\n'))).toBe(
      'sec/page.md: heading "???" has no letters or digits for an id; give it {#id}',
    );
  });

  it('keeps the read error as the cause of a missing diagram', () => {
    try {
      render('sec/page.md', '# A\n\n## D\n![c](gone.svg)\n');
    } catch (error) {
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toBe('ENOENT sec/gone.svg');
      return;
    }
    throw new Error('expected a DocsRenderError');
  });
});

describe('callouts and sections (2026-09-27)', () => {
  it('turns "> [!TIP]" into a callout with its default title', () => {
    const html = render('sec/page.md', '# A\n\n## C\n> [!TIP]\n> Run `npm run docs` after editing.\n');
    expect(html).toContain(
      '<div class="callout tip">\n<p class="callout-title">Tip</p>\n<p>Run <code>npm run docs</code> after editing.</p>\n</div>',
    );
  });

  it('takes a title from the marker line and keeps later paragraphs', () => {
    const html = render('sec/page.md', '# A\n\n## C\n> [!SUMMARY] What this page covers\n> - one\n> - two\n');
    expect(html).toContain(
      '<div class="callout summary">\n<p class="callout-title">What this page covers</p>\n<ul>\n<li>one</li>\n<li>two</li>\n</ul>\n</div>',
    );
  });

  it('rewrites .md links inside a callout', () => {
    const html = render('sec/page.md', '# A\n\n## C\n> [!NOTE]\n> See [the guide](guide.md).\n');
    expect(html).toContain('See <a href="guide.html">the guide</a>.');
  });

  it('leaves an ordinary quote alone and refuses an unknown kind', () => {
    expect(render('sec/page.md', '# A\n\n## C\n> Just a quote.\n')).toContain(
      '<blockquote>\n<p>Just a quote.</p>\n</blockquote>',
    );
    expect(renderError(() => render('sec/page.md', '# A\n\n## C\n> [!DANGER]\n> x\n'))).toBe(
      'sec/page.md: unknown callout [!DANGER] (use NOTE, TIP, WARNING, DECISION, SUMMARY)',
    );
  });

  it('stamps the section on the body, "home" at the docs root', () => {
    expect(render('sec/page.md', '# A\n\n## B\nx\n')).toContain('<body data-section="sec">');
    expect(render('index.md', '# A\n\n## B\nx\n')).toContain('<body data-section="home">');
  });
});

describe('callout edge cases (review, 2026-09-27)', () => {
  it('accepts a lowercase marker', () => {
    expect(render('sec/page.md', '# A\n\n## C\n> [!note]\n> Hi.\n')).toContain(
      '<div class="callout note">\n<p class="callout-title">Note</p>\n<p>Hi.</p>\n</div>',
    );
  });
  it('keeps a code block, a table and a nested callout inside', () => {
    const html = render(
      'sec/page.md',
      '# A\n\n## C\n> [!TIP] Try it\n> ```\n> npm run docs\n> ```\n>\n> | a | b |\n> |---|---|\n> | 1 | 2 |\n>\n> > [!WARNING]\n> > Careful.\n',
    );
    expect(html).toContain(
      '<div class="callout tip">\n<p class="callout-title">Try it</p>\n<pre><code>npm run docs\n</code></pre>',
    );
    expect(html).toContain('<div class="table-wrap">');
    expect(html).toContain(
      '<div class="callout warning">\n<p class="callout-title">Warning</p>\n<p>Careful.</p>\n</div>',
    );
  });
  it('renders a callout that has only a title', () => {
    expect(render('sec/page.md', '# A\n\n## C\n> [!DECISION] Apache-2.0, 2026-09-27\n')).toContain(
      '<div class="callout decision">\n<p class="callout-title">Apache-2.0, 2026-09-27</p>\n</div>',
    );
  });
});
