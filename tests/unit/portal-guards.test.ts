// Guards over the portal's sources and its dependency (docs/plans/portal.md A3, A13, A16): the page loads nothing from
// the network and renders nothing as markup (R3, R13); no module it serves reaches a `node:` import, and none of its
// own modules decodes a stream, renders the CLI's lines, or calls fetch outside its one client (R15); the browser-test
// dependency is test-only, exactly pinned, and runs no install script (R12). Each guard is proven to fail on a fixture
// naming the offender.

import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PORTAL_MODULES, PORTAL_STATIC_FILES } from '../../src/daemon/portal/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { INSTALL_STEP, requireBrowser } from '../helpers/browser.js';
import { nodeImportsReachable, runtimeImports } from '../helpers/import-graph.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** Every file under `dir`, recursively, relative to ROOT. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name !== '.DS_Store') out.push(relative(ROOT, path));
    }
  };
  walk(join(ROOT, dir));
  return out.sort(byCodeUnit);
}

const read = (path: string): { path: string; text: string } => ({ path, text: readFileSync(join(ROOT, path), 'utf8') });

// ------------------------------------------------------------------ A3 (R3, R13)

/** The end of the run of `[a-z]` in case-folded `lower`, starting at `i`, bounded by `limit`. */
function letterRunEnd(lower: string, i: number, limit: number): number {
  let j = i;
  while (j < limit && /[a-z]/.test(lower[j] ?? '')) j += 1;
  return j;
}

/** The end of the run of whitespace in case-folded `lower`, starting at `i`, bounded by `limit`. */
function spaceRunEnd(lower: string, i: number, limit: number): number {
  let j = i;
  while (j < limit && /\s/.test(lower[j] ?? '')) j += 1;
  return j;
}

/** Whether `on[a-z]+\s*=` begins right after the whitespace at `lower[i]`, bounded by `limit`. */
function onAttributeAt(lower: string, i: number, limit: number): boolean {
  if (lower[i + 1] !== 'o' || lower[i + 2] !== 'n') return false;
  const afterLetters = letterRunEnd(lower, i + 3, limit);
  if (afterLetters === i + 3) return false;
  return lower[spaceRunEnd(lower, afterLetters, limit)] === '=';
}

/**
 * The index in `text` of a whitespace-preceded `on<letters>`, followed (after optional whitespace) by `=`, within
 * a tag that opened at or before it (a `<` with no `>` yet) — found by scanning character by character, in place
 * of the single regex `<[^>]*\son[a-z]+\s*=/i`, whose `[^>]*` overlaps the `\s` right after it
 * (sonarjs/super-linear-regex). Matches that regex exactly: confirmed by a fuzz comparison of 200,000 random
 * strings, plus the cases below, before this change.
 */
function onAttributeIndex(text: string): number | undefined {
  const lower = text.toLowerCase();
  for (let open = text.indexOf('<'); open !== -1; open = text.indexOf('<', open + 1)) {
    const tagEnd = text.indexOf('>', open + 1);
    const limit = tagEnd === -1 ? text.length : tagEnd;
    for (let i = open + 1; i < limit; i += 1) {
      if (/\s/.test(lower[i] ?? '') && onAttributeAt(lower, i, limit)) return open;
    }
  }
  return undefined;
}

/** Each kind of thing the page's sources must not hold, by file type: a regex, or (just the one above) a scanner. */
const FORBIDDEN: readonly {
  readonly kind: string;
  readonly applies: RegExp;
  readonly pattern: RegExp | ((text: string) => number | undefined);
}[] = [
  { kind: 'a remote URL', applies: /./, pattern: /\b(?:https?|wss?):\/\/|(?:src|href)\s*=\s*["']?\/\// },
  { kind: '@import', applies: /\.css$/, pattern: /@import/ },
  { kind: 'url()', applies: /\.css$/, pattern: /url\s*\(/ },
  { kind: 'innerHTML', applies: /\.(ts|html)$/, pattern: /\binnerHTML\b/ },
  { kind: 'outerHTML', applies: /\.(ts|html)$/, pattern: /\bouterHTML\b/ },
  { kind: 'insertAdjacentHTML', applies: /\.(ts|html)$/, pattern: /\binsertAdjacentHTML\b/ },
  { kind: 'document.write', applies: /\.(ts|html)$/, pattern: /\bdocument\s*\.\s*write(?:ln)?\b/ },
  { kind: 'eval', applies: /\.(ts|html)$/, pattern: /\beval\s*\(/ },
  { kind: 'new Function', applies: /\.(ts|html)$/, pattern: /\bnew\s+Function\b/ },
  { kind: 'an inline <script> body', applies: /\.html$/, pattern: /<script\b[^>]*>\s*[^<\s]/i },
  { kind: 'an on*= event-handler attribute', applies: /\.(html|svg)$/, pattern: onAttributeIndex },
  { kind: 'an event handler set as an attribute', applies: /\.ts$/, pattern: /setAttribute\(\s*['"]on/ },
  { kind: 'localStorage', applies: /\.(ts|html)$/, pattern: /\blocalStorage\b/ },
  { kind: 'document.cookie', applies: /\.(ts|html)$/, pattern: /\bdocument\s*\.\s*cookie\b/ },
];

/** Every offence in the files, as `<file>: <kind> (line n)`. */
export function portalSourceOffenders(files: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text: raw } of files) {
    // An XML namespace names a vocabulary and loads nothing: an SVG's xmlns is not a remote URL.
    const text = raw.replace(/\sxmlns(?::\w+)?="[^"]*"/g, '');
    for (const rule of FORBIDDEN) {
      if (!rule.applies.test(path)) continue;
      const index = typeof rule.pattern === 'function' ? rule.pattern(text) : rule.pattern.exec(text)?.index;
      if (index !== undefined)
        out.push(`${path}: ${rule.kind} (line ${String(text.slice(0, index).split('\n').length)})`);
    }
  }
  return out;
}

describe('the page loads nothing from the network and renders nothing as markup (A3; R3, R13)', () => {
  const sources = [...filesUnder('portal'), ...filesUnder('src/portal')];

  it('covers every file under portal/ and src/portal/', () => {
    expect(sources.filter((f) => f.startsWith('portal/'))).toEqual(
      PORTAL_STATIC_FILES.map((n) => `portal/${n}`).sort(byCodeUnit),
    );
    expect(sources.filter((f) => f.startsWith('src/portal/')).length).toBeGreaterThan(5);
  });

  it('finds no offender in them', () => {
    expect(portalSourceOffenders(sources.map(read))).toEqual([]);
  });

  it.each([
    ['portal/x.html', '<img src="https://evil.example/a.png">', 'a remote URL'],
    ['portal/x.html', '<script src="//cdn.example/x.js"></script>', 'a remote URL'],
    ['portal/x.css', '@import "other.css";', '@import'],
    ['portal/x.css', 'body { background: url(a.png); }', 'url()'],
    ['src/portal/x.ts', 'node.innerHTML = text;', 'innerHTML'],
    ['src/portal/x.ts', 'node.outerHTML = text;', 'outerHTML'],
    ['src/portal/x.ts', "node.insertAdjacentHTML('beforeend', text);", 'insertAdjacentHTML'],
    ['src/portal/x.ts', 'document.write(text);', 'document.write'],
    ['src/portal/x.ts', 'eval(text);', 'eval'],
    ['src/portal/x.ts', "const f = new Function('return 1');", 'new Function'],
    ['portal/x.html', '<script>alert(1)</script>', 'an inline <script> body'],
    ['portal/x.html', '<button onclick="go()">x</button>', 'an on*= event-handler attribute'],
    ['src/portal/x.ts', "button.setAttribute('onclick', 'go()');", 'an event handler set as an attribute'],
    ['src/portal/x.ts', "localStorage.setItem('c', credential);", 'localStorage'],
    ['src/portal/x.ts', "document.cookie = 'c=' + credential;", 'document.cookie'],
  ])('fails on %s holding %s, naming the file and the kind', (path, text, kind) => {
    expect(portalSourceOffenders([{ path, text: `// a fixture\n${text}\n` }])).toEqual([`${path}: ${kind} (line 2)`]);
  });
});

// ------------------------------------------------------------------ A16 (R15)

/** The TypeScript source of a served module path (`portal/app.js` → `src/portal/app.ts`). */
const sourceOf = (served: string): string => `src/${served.replace(/\.js$/, '.ts')}`;

/** Every module reachable from `entry` by its run-time relative imports, as served paths. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { specifier } of runtimeImports(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) visit(resolve(join(file, '..'), specifier.replace(/\.js$/, '.ts')));
    }
  };
  visit(join(ROOT, entry));
  return [...seen].map((f) => relative(join(ROOT, 'src'), f).replace(/\.ts$/, '.js')).sort(byCodeUnit);
}

/** Every stream event type a control stream carries: no page module may handle one by a `case` of its own. */
const EVENT_TYPES = [
  'phase',
  'announced',
  'posted',
  'message',
  'status',
  'agent_left',
  'agent_joined',
  'model_delta',
  'model_done',
  'error',
  'watching',
  'launched',
  'member',
  'team_launched',
  'resending',
  'settled',
  'space_ready',
  'erased',
  'no_memory',
  'erase_failed',
  'kept',
  'erase_done',
];

/** A page module that decodes a stream, handles a stream's events itself, or calls fetch outside the client. */
export function pageModuleOffenders(files: readonly { path: string; text: string }[], client: string): string[] {
  const out: string[] = [];
  const kinds: [string, RegExp][] = [
    ['an SSE `event: ` line', /event: /],
    ['an SSE `data: ` line', /data: /],
    ['a case naming a stream event type', new RegExp(`case\\s+['"](${EVENT_TYPES.join('|')})['"]`)],
    // The CLI's own lines are printed by the shared functions, never copied (daemonRefusedLine, stillRunningLine).
    ['a copy of a CLI line', /✗ the daemon (refused|rejected) the |is still running \$\{/],
  ];
  for (const { path, text } of files) {
    for (const [kind, pattern] of kinds) if (pattern.test(text)) out.push(`${path}: ${kind}`);
    if (path !== client && /\bfetch\s*\(/.test(text)) out.push(`${path}: a call to fetch( outside ${client}`);
  }
  return out;
}

describe('the modules the portal serves (A16; R15)', () => {
  it('reads only the imports that survive compilation', () => {
    const source = [
      "import type { A } from './a.js';",
      "import { type B } from './b.js';",
      "import { C, D } from './c.js';",
      'import {',
      '  E,',
      "} from 'node:fs';",
      "export type { F } from './f.js';",
      "export { G } from './g.js';",
      'export const h = \'import x from "./not-an-import.js"\';',
    ].join('\n');
    expect(runtimeImports(source)).toEqual([
      { specifier: './b.js', line: 2 },
      { specifier: './c.js', line: 3 },
      { specifier: 'node:fs', line: 4 },
      { specifier: './g.js', line: 8 },
    ]);
  });

  it('finds a node: import reached through another module, naming the chain', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asha-graph-'));
    writeFileSync(join(dir, 'page.ts'), "import { x } from './mid.js';\nexport const y = x;\n");
    writeFileSync(join(dir, 'mid.ts'), "import { createHash } from 'node:crypto';\nexport const x = createHash;\n");
    expect(nodeImportsReachable(join(dir, 'page.ts'), dir)).toEqual([
      { chain: ['page.ts', 'mid.ts'], specifier: 'node:crypto (line 1)' },
    ]);
  });

  it('the allow-list is exactly the modules app.js loads, directly or through another', () => {
    expect([...PORTAL_MODULES].sort(byCodeUnit)).toEqual(reachable('src/portal/app.ts'));
  });

  it.each(PORTAL_MODULES.map(sourceOf))('%s reaches no node: import', (file) => {
    expect(nodeImportsReachable(join(ROOT, file), ROOT)).toEqual([]);
  });

  it('no page module decodes a stream, handles a stream event by a case of its own, or calls fetch outside client.ts', () => {
    const pages = filesUnder('src/portal').map(read);
    expect(pageModuleOffenders(pages, 'src/portal/client.ts')).toEqual([]);
  });

  it.each([
    [
      'decodes a stream',
      "for (const line of text.split('\\n')) if (line.startsWith('data: ')) handle(JSON.parse(line.slice(6)));",
      'an SSE `data: ` line',
    ],
    ['reads the event line', "if (line.startsWith('event: ')) type = line.slice(7);", 'an SSE `event: ` line'],
    [
      'switches on a stream event',
      "switch (event.type) { case 'model_delta': draw(event); }",
      'a case naming a stream event type',
    ],
    ['fetches by itself', "const answer = await fetch('/v1/health');", 'a call to fetch( outside src/portal/client.ts'],
    [
      'copies a CLI line',
      'out.stderr(`✗ the daemon refused the launch: HTTP ${status}: ${text}`);',
      'a copy of a CLI line',
    ],
  ])('fails on a page module that %s, naming it', (_label, text, kind) => {
    expect(pageModuleOffenders([{ path: 'src/portal/fixture.ts', text }], 'src/portal/client.ts')).toEqual([
      `src/portal/fixture.ts: ${kind}`,
    ]);
  });

  it('each line-printing function and the stream decoder has one definition, under src/shared/', () => {
    const definitions =
      /\b(class SseDecoder|function formatWatchEvent|function fileLine|function cloudWarning|function uploadRefusalLine|function deniedName|class ConversationTracker|class DeltaPrinter|function daemonRefusedLine|function stillRunningLine)\b/g;
    const found: string[] = [];
    for (const file of [...filesUnder('src'), ...filesUnder('images').filter((f) => f.endsWith('.ts'))]) {
      if (!file.endsWith('.ts')) continue;
      for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(definitions))
        found.push(`${present(m[1], 'the definitions regex match')} ${file}`);
    }
    expect(found.toSorted(byCodeUnit)).toEqual(
      [
        'class ConversationTracker src/shared/lines.ts',
        'class DeltaPrinter src/shared/lines.ts',
        'class SseDecoder src/shared/sse.ts',
        'function cloudWarning src/shared/lines.ts',
        'function daemonRefusedLine src/shared/lines.ts',
        'function deniedName src/shared/credentials.ts',
        'function fileLine src/shared/lines.ts',
        'function formatWatchEvent src/shared/lines.ts',
        'function stillRunningLine src/shared/lines.ts',
        'function uploadRefusalLine src/shared/lines.ts',
      ].sort(byCodeUnit),
    );
  });
});

// ------------------------------------------------------------------ A13 (R12)

/**
 * portal-scene-chat R15, A11: one function sends a message and follows its conversation — converse() in
 * src/portal/converse.ts — and every page module that sends one imports it; none follows a conversation itself
 * (`new ConversationTracker(`) or posts to the conversations route by its own request.
 */
export function conversationOffenders(pages: readonly { readonly path: string; readonly text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text } of pages) {
    if (path === 'src/portal/converse.ts') continue;
    if (text.includes('new ConversationTracker('))
      out.push(`${path}: follows a conversation itself (new ConversationTracker)`);
    if (/Routes\.conversations/.test(text)) out.push(`${path}: posts to the conversations route itself`);
  }
  for (const user of ['src/portal/send-view.ts', 'src/portal/watch-view.ts']) {
    const page = pages.find((p) => p.path === user);
    if (page === undefined || !/import \{[^}]*\bconverse\b[^}]*\} from '\.\/converse\.js'/.test(page.text))
      out.push(`${user}: does not import converse() from ./converse.js`);
  }
  return out;
}

describe('one conversation function (portal-scene-chat R15, A11)', () => {
  it('converse() is the only code that follows a conversation, and both views import it', () => {
    expect(conversationOffenders(filesUnder('src/portal').map(read))).toEqual([]);
  });

  it('names a page that follows a conversation itself, and a view that does not import converse()', () => {
    const pages = filesUnder('src/portal')
      .map(read)
      .map((p) =>
        p.path === 'src/portal/watch-view.ts'
          ? {
              path: p.path,
              text: p.text.replace(
                "import { converse } from './converse.js';",
                "import { ConversationTracker } from '../shared/lines.js';\nconst t = new ConversationTracker(out, {});",
              ),
            }
          : p,
      );
    expect(conversationOffenders(pages)).toEqual([
      'src/portal/watch-view.ts: follows a conversation itself (new ConversationTracker)',
      'src/portal/watch-view.ts: does not import converse() from ./converse.js',
    ]);
  });
});

describe('the browser-test dependency (A13; R12)', () => {
  it('is playwright-core at exactly 1.63.0, a devDependency only, with no install script', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as {
      packages: Record<
        string,
        {
          version?: string;
          dev?: boolean;
          hasInstallScript?: boolean;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        }
      >;
    };
    expect(pkg.devDependencies?.['playwright-core']).toBe('1.63.0');
    expect(pkg.dependencies?.['playwright-core']).toBeUndefined();
    const entry = lock.packages['node_modules/playwright-core'];
    expect(entry).toMatchObject({ version: '1.63.0', dev: true });
    expect(entry?.hasInstallScript).toBeUndefined();
    expect(lock.packages['']?.devDependencies?.['playwright-core']).toBe('1.63.0');
    expect(lock.packages['']?.dependencies?.['playwright-core']).toBeUndefined();
    // Nothing else in the tree is named playwright: no second copy, and not the package whose install downloads browsers.
    expect(Object.keys(lock.packages).filter((p) => /(^|\/)playwright/.test(p))).toEqual([
      'node_modules/playwright-core',
    ]);
  });

  it('is imported by no file under src/, images/ or portal/', () => {
    const shipped = [...filesUnder('src'), ...filesUnder('images'), ...filesUnder('portal')].filter(
      (f) => !f.includes('/node_modules/'),
    );
    expect(shipped.filter((f) => /playwright/.test(readFileSync(join(ROOT, f), 'utf8')))).toEqual([]);
  });

  it('a missing browser fails before launch, naming the one-time install step', () => {
    const empty = mkdtempSync(join(tmpdir(), 'asha-no-browsers-'));
    expect(() => requireBrowser('chromium', empty)).toThrow(`run ${INSTALL_STEP} once`);
    expect(() => requireBrowser('firefox', empty)).toThrow(`run ${INSTALL_STEP} once`);
    expect(INSTALL_STEP).toBe('npx playwright-core install --no-remove chromium-headless-shell firefox');
  });
});
