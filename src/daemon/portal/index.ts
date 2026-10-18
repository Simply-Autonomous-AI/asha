// The portal (docs/plans/portal.md): the page's files, served by the daemon from its one listener (R2, R13), and the
// page's failure reports (R6). The files are read once, at the daemon's start, from the two folders StartDaemonProps
// names — so a page always matches the daemon that serves it — and only the files named in the allow-lists below are
// ever served, byte for byte as read, with no credential and nothing from a channel in them.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { byCodeUnit } from '../../shared/order.js';
import type { Logger } from '../log.js';
import type { Schedule } from '../refusal-log/index.js';

/** The page's static files, under `portal/`: served at `/portal/static/<name>`, and index.html at `/` too. */
export const PORTAL_STATIC_FILES = ['index.html', 'portal.css', 'favicon.svg'] as const;

/**
 * The page's compiled modules, by path under the portal build's `src/` folder (R15): served at `/portal/js/<path>`, so
 * a module's relative import (`../shared/sse.js` from `portal/app.js`) resolves to another served URL. Exactly the
 * modules app.js loads, directly or through another (a unit guard compares this list with the import graph).
 */
export const PORTAL_MODULES = [
  'portal/app.js',
  'portal/catalog.js',
  'portal/chat-thread.js',
  'portal/client.js',
  'portal/converse.js',
  'portal/dom.js',
  'portal/launch-view.js',
  'portal/messages.js',
  'portal/scene-draw.js',
  'portal/scene-sim.js',
  'portal/send-view.js',
  'portal/session.js',
  'portal/state-view.js',
  'portal/status-view.js',
  'portal/view.js',
  'portal/watch-view.js',
  'shared/assert-present.js',
  'shared/credentials.js',
  'shared/files.js',
  'shared/lines.js',
  'shared/order.js',
  'shared/protocol.js',
  'shared/sse.js',
  'shared/state-lines.js',
  'shared/timing.js',
] as const;

/** R13's policy, on every response the portal's paths answer: the page loads and runs nothing but its own files. */
export const PORTAL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Where the daemon reads the portal's files at start (production: `<root>/portal/` and `<root>/dist/portal-build/src/`). */
export interface PortalFolders {
  readonly staticDir: string;
  readonly modulesDir: string;
}

/** The production folders, under a repo root or an installed release. */
export function portalFolders(root: string): PortalFolders {
  return { staticDir: join(root, 'portal'), modulesDir: join(root, 'dist', 'portal-build', 'src') };
}

/** An allow-listed file is missing or unreadable: the daemon does not start (R2). */
export class PortalFileMissing extends Error {
  constructor(
    readonly path: string,
    options: { readonly cause: unknown },
  ) {
    super(`the portal's file ${path} could not be read`, options);
    this.name = 'PortalFileMissing';
  }
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** The headers every response of a portal path carries (R2, R13). */
export function portalHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': PORTAL_CSP,
  };
}

/** One served file: its bytes and its content type. */
export interface PortalFile {
  readonly body: Buffer;
  readonly contentType: string;
}

/** The portal's files, read at the daemon's start; `file` answers a request path, or undefined (404). */
export class PortalFiles {
  private constructor(private readonly byPath: ReadonlyMap<string, PortalFile>) {}

  /** Reads every allow-listed file; the first one that cannot be read throws PortalFileMissing naming its path. */
  static async load(folders: PortalFolders): Promise<PortalFiles> {
    const byPath = new Map<string, PortalFile>();
    const read = async (path: string): Promise<PortalFile> => {
      let body: Buffer;
      try {
        body = await readFile(path);
      } catch (error) {
        throw new PortalFileMissing(path, { cause: error });
      }
      const type = TYPES[path.slice(path.lastIndexOf('.'))];
      if (type === undefined) throw new Error(`the portal's file ${path} has no content type`);
      return { body, contentType: type };
    };
    for (const name of PORTAL_STATIC_FILES) {
      const file = await read(join(folders.staticDir, name));
      byPath.set(`/portal/static/${name}`, file);
      if (name === 'index.html') byPath.set('/', file);
    }
    for (const path of PORTAL_MODULES) byPath.set(`/portal/js/${path}`, await read(join(folders.modulesDir, path)));
    return new PortalFiles(byPath);
  }

  /** The file a `GET` of `path` (the URL's path, as the server parsed it) answers; undefined for any other path. */
  file(path: string): PortalFile | undefined {
    return this.byPath.get(path);
  }
}

// ------------------------------------------------------------------ failure reports (R6)

/** Why the page reports a failure (R6): a closed set. */
const PORTAL_ERROR_REASONS = [
  'request_failed',
  'bad_status',
  'stream_cut',
  'stream_error',
  'timeout',
  'exception',
] as const;
export type PortalErrorReason = (typeof PORTAL_ERROR_REASONS)[number];

/** The largest report body, and the most characters of its `detail` (R6). */
export const PORTAL_ERROR_MAX_BYTES = 4_096;
const PORTAL_ERROR_MAX_DETAIL = 200;
/** At most this many reports are logged per window; the rest are counted (R6). */
const PORTAL_ERROR_MAX_PER_WINDOW = 10;
const PORTAL_ERROR_WINDOW_MS = 60_000;

/**
 * A report's body, exactly `{reason, detail}`, or why it is refused (400).
 * @returns the parsed report, or a string naming why the body is refused.
 */
export function parsePortalError(
  body: unknown,
): { readonly reason: PortalErrorReason; readonly detail: string } | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'a report is a JSON object';
  const keys = Object.keys(body).sort(byCodeUnit);
  if (keys.join() !== 'detail,reason') return 'a report is exactly {reason, detail}';
  const { reason, detail } = body as { reason: unknown; detail: unknown };
  if (typeof reason !== 'string' || !(PORTAL_ERROR_REASONS as readonly string[]).includes(reason))
    return `reason must be one of ${PORTAL_ERROR_REASONS.join(', ')}`;
  if (typeof detail !== 'string' || detail.length > PORTAL_ERROR_MAX_DETAIL)
    return `detail must be a string of at most ${String(PORTAL_ERROR_MAX_DETAIL)} characters`;
  return { reason: reason as PortalErrorReason, detail };
}

export interface PortalErrorLogProps {
  readonly logger: Logger;
  readonly schedule: Schedule;
}

/**
 * The page's failure reports, logged bounded (R6): the first PORTAL_ERROR_MAX_PER_WINDOW of a window as
 * `portal.client_error` at error level; the rest counted, and the count logged as `portal.client_error_dropped` at
 * warn when the window ends or at `flush` (the daemon closing its server), whichever comes first.
 */
export class PortalErrorLog {
  private window: { logged: number; dropped: number; cancel: () => void } | undefined;

  constructor(private readonly props: PortalErrorLogProps) {}

  record(report: { readonly reason: PortalErrorReason; readonly detail: string }): void {
    if (this.window === undefined) {
      const window: { logged: number; dropped: number; cancel: () => void } = {
        logged: 0,
        dropped: 0,
        cancel: () => undefined,
      };
      window.cancel = this.props.schedule(() => {
        this.close(window);
      }, PORTAL_ERROR_WINDOW_MS);
      this.window = window;
    }
    const window = this.window;
    if (window.logged >= PORTAL_ERROR_MAX_PER_WINDOW) {
      window.dropped += 1;
      return;
    }
    window.logged += 1;
    // The facade's error field carries the same two fields, and nothing else: a report holds no user data (R6).
    this.props.logger.error('portal.client_error', {
      reason: report.reason,
      detail: report.detail,
      error: new Error(`the portal page reported ${report.reason}: ${report.detail}`),
    });
  }

  /** Logs the window's dropped count now, if any, and clears its timer. */
  flush(): void {
    const window = this.window;
    if (window === undefined) return;
    window.cancel();
    this.close(window);
  }

  private close(window: { logged: number; dropped: number; cancel: () => void }): void {
    if (this.window !== window) return;
    this.window = undefined;
    if (window.dropped > 0) this.props.logger.warn('portal.client_error_dropped', { count: window.dropped });
  }
}
