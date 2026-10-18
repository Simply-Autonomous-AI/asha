// The guards that a user's ID and text stay out of failure records (docs/plans/agent-persistence.md R9 (h), R15;
// A15), and that the daemon does not reach into an image's code (R16; A16). Every `.ts` under src/ and images/ is
// parsed with the TypeScript compiler, and each log call — the daemon's facade and the SDK's `AgentLog`
// (`<x>.info|warn|error('<event>', { … })`), and the memory image's `logError('<event>', { … }, error)` — is read
// for the keys of its fields. Fields given as a `const` object literal in the same file are followed to it; fields
// that cannot be resolved syntactically are listed below by hand, each with why it holds no user field, so a new
// unresolvable site fails the guard until someone has looked at it.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** R9's events: at any level, never a `user` or `text` field. */
// redelivery_[a-z_]+ covers patterns-phase-5's state.redelivery_superseded (its completion review, finding 1: the list
// named each redelivery_ event and missed the new one).
const R9_EVENTS = /^state\.(pending_[a-z_]+|redelivered|redelivery_[a-z_]+)$/;

/**
 * Log calls whose fields spread or pass something the guard cannot read, each checked by hand (2026-09-29): what it
 * spreads and why no user field can be in it. `file: event` identifies the site.
 */
const UNRESOLVED: Readonly<Record<string, string>> = {
  'src/daemon/server.ts: stream.slow_reader':
    '`...route` is the route descriptor (its method and path), built from the request line',
  'src/daemon/agents/index.ts: model.call_abandoned':
    "`fields` spreads `...stats`, the chat stream's timing and token counts (model-streaming R8), never text",
  'src/daemon/agents/index.ts: model.chat_failed': "`fields` spreads `...stats`, as model.call_abandoned's",
  // Checked by hand 2026-10-01 (extension-modules R35):
  'src/daemon/modules/host.ts: egress.refused':
    "`fields` is the egress proxy's own record less its event — exactly {module, host, rule} (src/egress-proxy/proxy.ts ProxyRecord), the harness's image, never a module's — with no user, text or body",
  // Checked by hand 2026-10-14 (lint-format R11):
  'src/daemon/modules/host.ts: egress.handle_failed':
    "`where` is the egress proxy's own record less its event and detail — exactly {module, host} (src/egress-proxy/proxy.ts ProxyRecord), the harness's image, never a module's; the error's message is the proxy's detail, the message of an error raised in its own connection handling (its resolver, its dial, the sockets), never a request's bytes",
  'src/daemon/modules/plugins.ts: plugin.failed':
    "`fields()` is {agent, plugin, command, argumentsSha256, pathsIn, pathsBack, durationMs}: the agent's handle, never a user ID; the arguments only as their sha256; path arguments as the paths they are, which R12 (f) and R33 name as logged",
};

/**
 * Failure records whose fields carry a command's stderr that is not a container's output, each checked by hand
 * (2026-09-30): what the stderr is and why no model-written or user's text can be in it beyond what the record may
 * name. `file: event` identifies the site.
 */
const DOCKER_ERRORS: Readonly<Record<string, string>> = {
  'src/daemon/files/index.ts: files.copy_failed':
    "docker cp's own error for a copy into a holder that is never started (docs/plans/agent-files.md R14 requires it): no container runs, so no container output; it can name an entry of the space, as every files.* record names files",
};

interface LogCall {
  readonly site: string;
  readonly file: string;
  readonly line: number;
  readonly level: 'info' | 'warn' | 'error';
  readonly event: string;
  /** Each field's key and its initializer's source text; undefined when the fields cannot be read. */
  readonly fields: readonly { readonly key: string; readonly text: string }[] | undefined;
}

function sources(dirs: readonly string[]): string[] {
  return dirs.flatMap((dir) =>
    readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.includes('node_modules') && !f.endsWith('.d.ts'))
      .map((f) => join(dir, f)),
  );
}

/** The object literal a `const <name> = { … }` in `scope`'s file declares, the nearest one before `at`. */
function constObject(file: ts.SourceFile, name: string, at: number): ts.ObjectLiteralExpression | undefined {
  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (n: ts.Node): void => {
    if (n.getStart() > at) return;
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === name &&
      n.initializer !== undefined &&
      ts.isObjectLiteralExpression(n.initializer)
    )
      found = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(file);
  return found;
}

/** The keys of an object literal, following `const` literals it spreads; undefined if any part cannot be read. */
function keysOf(
  file: ts.SourceFile,
  o: ts.ObjectLiteralExpression,
  depth = 0,
): { key: string; text: string }[] | undefined {
  const out: { key: string; text: string }[] = [];
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
      out.push({ key: p.name.text, text: p.initializer.getText(file) });
    else if (ts.isShorthandPropertyAssignment(p)) out.push({ key: p.name.text, text: p.name.text });
    else if (ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression) && depth < 3) {
      const inner = constObject(file, p.expression.text, p.getStart());
      const keys = inner === undefined ? undefined : keysOf(file, inner, depth + 1);
      if (keys === undefined) return undefined;
      out.push(...keys);
    } else return undefined;
  }
  return out;
}

/** The log level a call's callee names: `<x>.info|warn|error(…)`, or `logError(…)` as 'error'; else undefined. */
function levelOf(callee: ts.LeftHandSideExpression): LogCall['level'] | undefined {
  if (ts.isPropertyAccessExpression(callee) && ['info', 'warn', 'error'].includes(callee.name.text))
    return callee.name.text as LogCall['level'];
  if (ts.isIdentifier(callee) && callee.text === 'logError') return 'error';
  return undefined;
}

/** The fields of a log call's second argument, following a `const` literal it names; undefined if unreadable. */
function fieldsOf(file: ts.SourceFile, second: ts.Expression | undefined, at: number): LogCall['fields'] {
  if (second === undefined) return [];
  if (ts.isObjectLiteralExpression(second)) return keysOf(file, second);
  if (ts.isIdentifier(second)) {
    const o = constObject(file, second.text, at);
    return o === undefined ? undefined : keysOf(file, o);
  }
  return undefined;
}

/** Every log call in `code`, a source file's text. */
export function logCalls(path: string, code: string): LogCall[] {
  const file = ts.createSourceFile(path, code, ts.ScriptTarget.Latest, true);
  const calls: LogCall[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const level = levelOf(callee);
      const [first, second] = n.arguments;
      // Only calls naming an event: `console.error('failed', error)` in an image's main is its crash line, not a record.
      if (
        level !== undefined &&
        first !== undefined &&
        ts.isStringLiteralLike(first) &&
        /^[a-z][a-z_]*\.[a-z_.]+$/.test(first.text)
      ) {
        const fields = fieldsOf(file, second, n.getStart());
        const line = file.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        calls.push({ site: `${path}: ${first.text}`, file: path, line, level, event: first.text, fields });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
  return calls;
}

/** The three A15 checks over `calls`; each offender as `file:line event — why`. */
export function privacyOffenders(calls: readonly LogCall[]): {
  user: string[];
  tail: string[];
  r9: string[];
  unresolved: string[];
} {
  const where = (c: LogCall) => `${c.file}:${String(c.line)} ${c.event}`;
  const failure = calls.filter((c) => c.level !== 'info');
  return {
    user: [
      ...failure
        .filter((c) => c.fields?.some((f) => f.key === 'user'))
        .map((c) => `${where(c)} — a user field at ${c.level}`),
      // A request's URL whole: its query can carry a user ID (agent-files' upload route, user=; completion review, finding 4).
      ...failure
        .filter((c) => c.fields?.some((f) => /\breq\.url\b/.test(f.text)))
        .map((c) => `${where(c)} — a request URL with its query at ${c.level}`),
    ],
    tail: failure
      .filter(
        (c) => !(c.site in DOCKER_ERRORS) && c.fields?.some((f) => /\blogTail\(|\b(stdout|stderr)\b/.test(f.text)),
      )
      .map((c) => `${where(c)} — a container's output or log tail at ${c.level}`),
    r9: calls
      .filter((c) => R9_EVENTS.test(c.event) && c.fields?.some((f) => f.key === 'user' || f.key === 'text'))
      .map((c) => `${where(c)} — a user or text field on R9's event`),
    unresolved: [
      ...new Set(
        calls
          .filter((c) => c.fields === undefined && (c.level !== 'info' || R9_EVENTS.test(c.event)))
          .map((c) => c.site),
      ),
    ].filter((s) => !(s in UNRESOLVED)),
  };
}

const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

describe("no user ID or container output in a failure record, and no user or text in R9's (A15)", () => {
  const files = sources(['src', 'images']);
  const calls = files.flatMap((f) => logCalls(f, read(f)));

  it('reads the log calls of the daemon, the SDK and the memory image', () => {
    expect(files.length).toBeGreaterThan(40);
    const events = new Set(calls.map((c) => c.event));
    // The path ran: calls of each facade were found, and R9's events among them.
    for (const e of [
      'agent.exited_unexpectedly',
      'channel.delivery_timeout',
      'memory.save_failed',
      'state.redelivered',
      'state.redelivery_failed',
      'state.pending_found',
    ])
      expect(events, e).toContain(e);
    expect(calls.filter((c) => c.level !== 'info').length).toBeGreaterThan(50);
  });

  it('finds no offender, and every unresolved site is one checked by hand', () => {
    expect(privacyOffenders(calls)).toEqual({ user: [], tail: [], r9: [], unresolved: [] });
  });

  it('every hand-checked site still exists, so the list cannot go stale', () => {
    const sites = new Set(calls.filter((c) => c.fields === undefined).map((c) => c.site));
    expect(Object.keys(UNRESOLVED).filter((s) => !sites.has(s))).toEqual([]);
    // And every docker-error exception still carries a stderr, so it is not a stale pass for something else.
    const withStderr = new Set(
      calls.filter((c) => c.fields?.some((f) => /\bstderr\b/.test(f.text))).map((c) => c.site),
    );
    expect(Object.keys(DOCKER_ERRORS).filter((s) => !withStderr.has(s))).toEqual([]);
  });

  it.each([
    [
      "this.props.logger.warn('channel.delivery_timeout', { channel, user: message.user });",
      'user',
      'x.ts:1 channel.delivery_timeout — a user field at warn',
    ],
    [
      "const fields = { user };\nlog.error('agent.failed', fields);",
      'user',
      'x.ts:2 agent.failed — a user field at error',
    ],
    [
      "logError('memory.save_failed', { scope, user }, error);",
      'user',
      'x.ts:1 memory.save_failed — a user field at error',
    ],
    [
      "props.logger.error('http.handler_failed', { method: req.method, url: req.url, error });",
      'user',
      'x.ts:1 http.handler_failed — a request URL with its query at error',
    ],
    [
      "logger.error('agent.exited_unexpectedly', { code, output: await logTail(file), error });",
      'tail',
      "x.ts:1 agent.exited_unexpectedly — a container's output or log tail at error",
    ],
    [
      "logger.warn('state.erase_failed', { reason, detail: run.stderr });",
      'tail',
      "x.ts:1 state.erase_failed — a container's output or log tail at warn",
    ],
    [
      "logger.info('state.redelivered', { identity, text: entry.text });",
      'r9',
      "x.ts:1 state.redelivered — a user or text field on R9's event",
    ],
    [
      "logger.info('state.pending_found', { identity, user });",
      'r9',
      "x.ts:1 state.pending_found — a user or text field on R9's event",
    ],
    ["logger.error('state.redelivery_failed', { ...entry, error });", 'unresolved', 'x.ts: state.redelivery_failed'],
  ] as const)('fails on a planted %j', (code, check, offender) => {
    expect(privacyOffenders(logCalls('x.ts', code))[check]).toEqual([offender]);
  });

  it('passes an info record with a user field that is not one of R9 (a conversation record, R15 allows it)', () => {
    expect(privacyOffenders(logCalls('x.ts', "logger.info('conversation.started', { user, channel });"))).toEqual({
      user: [],
      tail: [],
      r9: [],
      unresolved: [],
    });
  });
});

describe("the daemon does not reach into an image's code (R16; A16)", () => {
  /**
   * Each `file:line` under src/daemon/ importing from the repo's images/ (a relative import resolved against the file:
   * the daemon's own src/daemon/images/ module is not an image's code) or naming scopeKey.
   */
  function reaches(files: readonly string[], text: (file: string) => string): string[] {
    const intoImages = (file: string, spec: string) =>
      spec.startsWith('.') && join(dirname(file), spec).startsWith('images/');
    return files.flatMap((file) =>
      text(file)
        .split('\n')
        .flatMap((line, i) => {
          const spec = /(?:from|import)(?:\s*\(\s*|\s*)['"]([^'"]+)['"]/.exec(line)?.[1];
          return (spec !== undefined && intoImages(file, spec)) || /\bscopeKey\b/.test(line)
            ? [`${file}:${String(i + 1)}: ${line.trim()}`]
            : [];
        }),
    );
  }

  it('nothing under src/daemon/ imports from images/ or names scopeKey', () => {
    const files = sources(['src/daemon']);
    expect(files.length).toBeGreaterThan(20);
    expect(reaches(files, read)).toEqual([]);
  });

  it("fails on a planted import and a planted scopeKey, and passes the daemon's own images module", () => {
    const planted: Record<string, string> = {
      'src/daemon/agents/a.ts': "import { eraseUser } from '../../../images/memory/src/memory/persisted.js';",
      'src/daemon/b.ts': 'const dir = scopeKey({ channel, user });',
      'src/daemon/agents/c.ts': "import { stageAgentImage } from '../images/index.js';",
    };
    expect(reaches(Object.keys(planted), (f) => present(planted[f], `planted[${f}]`))).toEqual([
      "src/daemon/agents/a.ts:1: import { eraseUser } from '../../../images/memory/src/memory/persisted.js';",
      'src/daemon/b.ts:1: const dir = scopeKey({ channel, user });',
    ]);
  });
});
