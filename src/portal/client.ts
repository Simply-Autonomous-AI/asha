// The page's one client of the daemon (docs/plans/portal.md R6, R7, R18): every request the page makes goes through
// here, with the credential, bounded by the CLI's own constants, and every failure it meets is turned into what the
// view shows and, where R6 says so, a report to the daemon. No other page module calls fetch.
//
// What a failure shows, and whether it is reported (R6):
// - 401: "run asha --portal" — never reported (this page's credential is not the daemon's).
// - 503 while the daemon stops: "stopping" — never reported (R14).
// - a request that fails (request_failed), a stream cut or ended early (stream_cut), a bound passed (timeout), a status
//   a route does not answer on success (bad_status), a stream's error event (stream_error), the page's code throwing
//   (exception): shown, and reported — once, never retried. A report that cannot connect means the daemon is gone:
//   then the view says the daemon is unreachable instead. A report the daemon refuses is shown and not reported.
// - a report met after the page's beforeunload waits LEAVING_HOLD_MS (PageLeaving): a reload, a navigation or a closed
//   tab ends the page's requests — Firefox after beforeunload, before pagehide — and a page that is gone before the hold
//   ends never sends what those ends caused; a page that stays (a navigation answered 204, or as a download, fires
//   beforeunload too) sends its held reports then (found 2026-10-08: a reload while watching logged stream_cut). What
//   the hold leaves in Firefox — a navigation slower than the hold, a report cut in flight — is debt D64.
// A report's detail is built only from fixed parts: the route's path without its query, the HTTP status, the error
// event's reason and the thrown error's name — never an error's message, which can quote stream data.

import { parseRefusal, uploadRefusalLine } from '../shared/lines.js';
import { present } from '../shared/assert-present.js';
import { STOPPING_LINE, UNAUTHORIZED_LINE } from './messages.js';

export { UNREACHABLE_LINE } from './messages.js';
import { Routes, UPLOAD_REFUSALS, type UploadRefusal, type UploadResponse } from '../shared/protocol.js';
import { sseEvents } from '../shared/sse.js';
import { DOWNLOAD_IDLE_MS, HEALTH_TIMEOUT_MS, STREAM_IDLE_MS, UPLOAD_ANSWER_MS } from '../shared/timing.js';

/** Why the page reports a failure (R6), the daemon's PORTAL_ERROR_REASONS. */
export type FailureReason = 'request_failed' | 'bad_status' | 'stream_cut' | 'stream_error' | 'timeout' | 'exception';

/** The fixed parts a report's detail is built from. */
export interface DetailParts {
  readonly path?: string;
  readonly status?: number;
  readonly eventReason?: string;
  readonly errorName?: string;
}

/** A report's detail: the fixed parts present, in order, at most 200 characters (R6). */
export function detailOf(parts: DetailParts): string {
  return [parts.path, parts.status === undefined ? undefined : String(parts.status), parts.eventReason, parts.errorName]
    .filter((p): p is string => p !== undefined && p !== '')
    .join(' ')
    .slice(0, 200);
}

/** A failure a request met, before it is shown and reported. */
export class PortalFailure extends Error {
  constructor(
    /** `unauthorized` and `stopping` are shown, never reported; `report` is shown and reported as `reason`. */
    readonly kind: 'unauthorized' | 'stopping' | 'report',
    /** What the view shows, as a line. */
    readonly line: string,
    readonly reason?: FailureReason,
    readonly detail?: string,
  ) {
    super(line.trim());
    this.name = 'PortalFailure';
  }
}

/** What a stream's reading came to: the handler said it is done, the body ended first, or the caller aborted it. */
export type StreamOutcome = 'done' | 'ended' | 'aborted';

/** A JSON answer: its status and parsed body. */
export interface JsonAnswer<T> {
  readonly status: number;
  readonly body: T;
}

/** An upload's answer (R8a): accepted, or a refusal of UPLOAD_REFUSALS as the CLI prints it. */
export type UploadAnswer =
  { readonly ok: true; readonly answer: UploadResponse } | { readonly ok: false; readonly line: string };

/** The daemon's health as the stop view polls it (R14). */
export type HealthState = 'up' | 'stopping' | 'unreachable';

/** A returned file's bytes (R8; agent-files R12a), or the CLI's refusal rule for it (and the report, when due). */
export type DownloadAnswer =
  | { readonly ok: true; readonly blob: Blob }
  | {
      readonly ok: false;
      readonly rule: string;
      readonly report?: { readonly reason: FailureReason; readonly detail: string };
    };

/**
 * How long a report waits after the page's beforeunload. A reload of the page took 2–8 ms from beforeunload to
 * pagehide in Firefox and Chromium (10 reloads while watching, 2026-10-08: evals/probes/portal-leaving-2026-10-08/); a
 * navigation slower than this sends its held reports, a false report rather than a lost one (D64).
 */
export const LEAVING_HOLD_MS = 3_000;

/** Whether the page stays: what a report waits for (R6). */
export interface Leaving {
  /** Resolves at once on a page that has not begun to leave; else once the page has stayed through every hold begun. */
  stayed(): Promise<void>;
}

/** What PageLeaving listens to and times with: the page's window, as much of it as it uses. */
export interface PageLeavingProps {
  readonly win: {
    addEventListener(type: 'beforeunload', listener: () => void): void;
    setTimeout(handler: () => void, ms: number): unknown;
  };
  readonly holdMs: number;
}

/**
 * The page's leaving: each beforeunload begins a hold of `holdMs`. A page replaced during it never runs again, so
 * nothing waiting on it is sent; a page still here when it ends goes on as before.
 */
export class PageLeaving implements Leaving {
  private hold: Promise<void> | undefined;

  constructor(props: PageLeavingProps) {
    props.win.addEventListener('beforeunload', () => {
      const hold: Promise<void> = new Promise((resolve) => {
        props.win.setTimeout(() => {
          if (this.hold === hold) this.hold = undefined;
          resolve();
        }, props.holdMs);
      });
      this.hold = hold;
    });
  }

  async stayed(): Promise<void> {
    while (this.hold !== undefined) await this.hold;
  }
}

/** A client's inputs: the page's credential, and its leaving. */
export interface DaemonClientProps {
  readonly credential: string;
  readonly leaving: Leaving;
}

export class DaemonClient {
  constructor(private readonly props: DaemonClientProps) {}

  private headers(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.props.credential}`, ...extra };
  }

  /** A fetch that throws PortalFailure for a refused credential, a stopping daemon, a network failure or a bound passed. */
  private async send(path: string, init: RequestInit, bound: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(path, init);
    } catch (error) {
      if (bound.aborted)
        throw new PortalFailure(
          'report',
          `✗ timeout: ${pathOf(path)} did not answer in time\n`,
          'timeout',
          detailOf({ path: pathOf(path) }),
        );
      if (init.signal?.aborted === true) throw error;
      throw new PortalFailure(
        'report',
        `✗ request_failed: ${pathOf(path)} could not be sent (${nameOf(error)})\n`,
        'request_failed',
        detailOf({ path: pathOf(path), errorName: nameOf(error) }),
      );
    }
    if (response.status === 401) throw new PortalFailure('unauthorized', UNAUTHORIZED_LINE);
    return response;
  }

  /** Whether a 503 is the daemon stopping (`route()`'s answer while it stops, R14). */
  private static async stopping(response: Response): Promise<boolean> {
    if (response.status !== 503) return false;
    const refusal = parseRefusal(await response.text());
    // reason stopping since debt-paydown R15; none before it.
    return (
      (refusal.reason === undefined || refusal.reason === 'stopping') && refusal.error === 'the daemon is stopping'
    );
  }

  private async badStatus(path: string, response: Response): Promise<PortalFailure> {
    if (await DaemonClient.stopping(response)) return new PortalFailure('stopping', STOPPING_LINE);
    return new PortalFailure(
      'report',
      `✗ bad_status: ${pathOf(path)} answered HTTP ${String(response.status)}\n`,
      'bad_status',
      detailOf({ path: pathOf(path), status: response.status }),
    );
  }

  /**
   * A JSON route (health, telemetry, state, a reset, a report), bounded by HEALTH_TIMEOUT_MS. `answers` lists the
   * statuses the route answers as data (200, and 409 for a reset's refusal); any other is a failure.
   */
  async json<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    answers: readonly number[] = [200],
  ): Promise<JsonAnswer<T>> {
    const bound = bounded(HEALTH_TIMEOUT_MS);
    try {
      const response = await this.send(
        path,
        {
          method,
          headers: this.headers(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: bound.signal,
        },
        bound.signal,
      );
      if (!answers.includes(response.status)) throw await this.badStatus(path, response);
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        if (bound.signal.aborted)
          throw new PortalFailure(
            'report',
            `✗ timeout: ${pathOf(path)} did not answer in ${String(HEALTH_TIMEOUT_MS)} ms\n`,
            'timeout',
            detailOf({ path: pathOf(path) }),
          );
        throw new PortalFailure(
          'report',
          `✗ stream_cut: ${pathOf(path)}'s answer was cut short (${nameOf(error)})\n`,
          'stream_cut',
          detailOf({ path: pathOf(path), errorName: nameOf(error) }),
        );
      }
      // An answer that is not JSON throws SyntaxError: the page's exception, reported by its name alone.
      return { status: response.status, body: JSON.parse(text) as T };
    } finally {
      bound.clear();
    }
  }

  /** `send` for a stream (its fetch and the send-level failures): the response, or 'aborted' for the caller's own. */
  private async sendForStream(
    path: string,
    init: { readonly method: 'GET' | 'POST'; readonly body?: unknown },
    controllerSignal: AbortSignal,
    signal: AbortSignal | undefined,
    isIdle: () => boolean,
    timeout: () => PortalFailure,
  ): Promise<Response | 'aborted'> {
    try {
      return await this.send(
        path,
        {
          method: init.method,
          headers: this.headers(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: controllerSignal,
        },
        controllerSignal,
      );
    } catch (error) {
      if (signal?.aborted === true) return 'aborted';
      if (isIdle() && error instanceof PortalFailure && error.reason === 'timeout') throw timeout();
      throw error;
    }
  }

  /** The stream's answer when it is not a 200 with a body to read as events: a listed status's text, else a failure. */
  private async nonStreamAnswer(
    path: string,
    response: Response,
    answers: readonly number[],
    signal: AbortSignal | undefined,
    isIdle: () => boolean,
    timeout: () => PortalFailure,
  ): Promise<StreamOutcome | { readonly status: number; readonly text: string }> {
    try {
      if (answers.includes(response.status)) return { status: response.status, text: await response.text() };
      throw await this.badStatus(path, response);
    } catch (error) {
      if (error instanceof PortalFailure) throw error;
      if (signal?.aborted === true) return 'aborted';
      if (isIdle()) throw timeout();
      throw error;
    }
  }

  /** Reads the stream's events into `onEvent` until it is done, the body ends, or the caller aborts. */
  private async consumeEvents(
    body: ReadableStream<Uint8Array>,
    onEvent: (raw: unknown) => boolean,
    restart: () => void,
    path: string,
    signal: AbortSignal | undefined,
    isIdle: () => boolean,
    timeout: () => PortalFailure,
  ): Promise<StreamOutcome> {
    try {
      for await (const event of sseEvents(body, restart)) {
        if (onEvent(event)) return 'done';
      }
      return 'ended';
    } catch (error) {
      if (signal?.aborted === true) return 'aborted';
      if (isIdle()) throw timeout();
      if (error instanceof TypeError) {
        throw new PortalFailure(
          'report',
          `✗ stream_cut: the daemon closed ${pathOf(path)} before it was done (${error.name})\n`,
          'stream_cut',
          detailOf({ path: pathOf(path), errorName: error.name }),
        );
      }
      throw error;
    }
  }

  /**
   * A streaming route (a conversation, a launch, a watch, a space, an erase): each event to `onEvent` until it returns
   * true ('done'), the body ends ('ended'), or `signal` aborts ('aborted'). Silence — no event and no heartbeat — for
   * STREAM_IDLE_MS is a timeout. `answers` lists statuses answered as JSON before a stream (a reset's 409): such an
   * answer is returned as its text.
   */
  async stream(
    path: string,
    init: { readonly method: 'GET' | 'POST'; readonly body?: unknown },
    onEvent: (raw: unknown) => boolean,
    signal?: AbortSignal,
    answers: readonly number[] = [],
  ): Promise<StreamOutcome | { readonly status: number; readonly text: string }> {
    const controller = new AbortController();
    let idle = false;
    // Read through a call, never `idle` directly, past the point a closure that sets it true is only reachable
    // asynchronously (the timer firing): the type checker otherwise reads it as statically always `false` there.
    const isIdle = (): boolean => idle;
    let timer = setTimeout(() => {
      idle = true;
      controller.abort();
    }, STREAM_IDLE_MS);
    const restart = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        controller.abort();
      }, STREAM_IDLE_MS);
    };
    const stop = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', stop, { once: true });
    const timeout = (): PortalFailure =>
      new PortalFailure(
        'report',
        `✗ timeout: no word from the daemon for ${String(STREAM_IDLE_MS)} ms on ${pathOf(path)}\n`,
        'timeout',
        detailOf({ path: pathOf(path) }),
      );
    try {
      const response = await this.sendForStream(path, init, controller.signal, signal, isIdle, timeout);
      if (response === 'aborted') return 'aborted';
      if (answers.includes(response.status) || response.status !== 200 || response.body === null) {
        // The answer's body is read under the same idle bound: its end is a timeout or the user's abort, as the stream's is.
        return await this.nonStreamAnswer(path, response, answers, signal, isIdle, timeout);
      }
      return await this.consumeEvents(response.body, onEvent, restart, path, signal, isIdle, timeout);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
    }
  }

  /** The failure for a stream whose body ended before the CLI would have settled (R6). */
  cut(path: string): PortalFailure {
    return new PortalFailure(
      'report',
      `✗ stream_cut: the daemon closed ${pathOf(path)} before it was done\n`,
      'stream_cut',
      detailOf({ path: pathOf(path) }),
    );
  }

  /**
   * One upload (R8a): the manifest line and the picked files in order, as one Blob, bounded by UPLOAD_ANSWER_MS. A
   * refusal of UPLOAD_REFUSALS (its status the table's) is returned as the CLI's line and not reported; a 401 and a
   * 503 while stopping are handled as for every route; any other answer but 200 is bad_status.
   */
  async upload(channel: string, user: string, manifestLine: string, files: readonly Blob[]): Promise<UploadAnswer> {
    const bound = bounded(UPLOAD_ANSWER_MS);
    const query = new URLSearchParams({ channel, user });
    const path = `${Routes.channelFiles}?${query.toString()}`;
    let response: Response;
    let text: string;
    try {
      response = await this.send(
        path,
        {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/octet-stream' }),
          body: new Blob([manifestLine, ...files]),
          signal: bound.signal,
        },
        bound.signal,
      );
      try {
        text = await response.text();
      } catch (error) {
        if (bound.signal.aborted)
          throw new PortalFailure(
            'report',
            `✗ timeout: ${Routes.channelFiles} did not answer in ${String(UPLOAD_ANSWER_MS)} ms\n`,
            'timeout',
            detailOf({ path: Routes.channelFiles }),
          );
        throw new PortalFailure(
          'report',
          `✗ stream_cut: ${Routes.channelFiles}'s answer was cut short (${nameOf(error)})\n`,
          'stream_cut',
          detailOf({ path: Routes.channelFiles, errorName: nameOf(error) }),
        );
      }
    } finally {
      bound.clear();
    }
    if (response.status === 200) return { ok: true, answer: JSON.parse(text) as UploadResponse };
    const refusal = parseRefusal(text);
    // The daemon stopping, before the upload table: since debt-paydown R15 the route's 503 carries reason stopping, the
    // same body as the space's own refusal while it stops; both mean the daemon is stopping.
    if (
      response.status === 503 &&
      (refusal.reason === undefined || refusal.reason === 'stopping') &&
      refusal.error === 'the daemon is stopping'
    )
      throw new PortalFailure('stopping', STOPPING_LINE);
    if (
      refusal.reason !== undefined &&
      refusal.error !== undefined &&
      refusal.reason in UPLOAD_REFUSALS &&
      UPLOAD_REFUSALS[refusal.reason as UploadRefusal] === response.status
    ) {
      return { ok: false, line: uploadRefusalLine(channel, response.status, text) };
    }
    throw new PortalFailure(
      'report',
      `✗ bad_status: ${Routes.channelFiles} answered HTTP ${String(response.status)}\n`,
      'bad_status',
      detailOf({ path: Routes.channelFiles, status: response.status }),
    );
  }

  /**
   * Reads a download's body in chunks, restarting the DOWNLOAD_IDLE_MS bound on each: its bytes and their total
   * size, or the refusal once they exceed `file.size` or the bound passes.
   */
  private async readBody(
    body: ReadableStream<Uint8Array<ArrayBuffer>>,
    file: { readonly size: number },
    controller: AbortController,
    restart: () => void,
  ): Promise<
    | { readonly parts: Uint8Array<ArrayBuffer>[]; readonly size: number }
    | Extract<DownloadAnswer, { readonly ok: false }>
  > {
    const reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> = body.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    try {
      for (;;) {
        const read = await reader.read();
        if (read.done) return { parts, size };
        restart();
        size += read.value.byteLength;
        if (size > file.size) {
          await reader.cancel();
          return { ok: false, rule: `more than its ${String(file.size)} bytes arrived` };
        }
        parts.push(read.value);
      }
    } catch (error) {
      // A bound passed (R18) or the body cut: the CLI's line, and a report.
      if (controller.signal.aborted)
        return {
          ok: false,
          rule: `no bytes for ${String(DOWNLOAD_IDLE_MS / 1_000)} s`,
          report: { reason: 'timeout', detail: detailOf({ path: Routes.channelFiles }) },
        };
      return {
        ok: false,
        rule: `the download was cut short after ${String(size)} of ${String(file.size)} bytes (${nameOf(error)})`,
        report: { reason: 'stream_cut', detail: detailOf({ path: Routes.channelFiles, errorName: nameOf(error) }) },
      };
    }
  }

  /**
   * A returned file's bytes (R8; agent-files R12a), each read bounded by DOWNLOAD_IDLE_MS, checked against the record's
   * size and sha256: the bytes, or the CLI's refusal rule for the file.
   */
  async download(file: {
    readonly id: string;
    readonly size: number;
    readonly sha256: string;
  }): Promise<DownloadAnswer> {
    const path = `${Routes.channelFiles}/${file.id}`;
    const controller = new AbortController();
    let timer = setTimeout(() => {
      controller.abort();
    }, DOWNLOAD_IDLE_MS);
    const restart = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        controller.abort();
      }, DOWNLOAD_IDLE_MS);
    };
    try {
      let response: Response;
      try {
        response = await this.send(path, { headers: this.headers(), signal: controller.signal }, controller.signal);
      } catch (error) {
        // No answer within the bound counts as no bytes, as the CLI counts it: its line, and a timeout report.
        if (controller.signal.aborted)
          return {
            ok: false,
            rule: `no bytes for ${String(DOWNLOAD_IDLE_MS / 1_000)} s`,
            report: { reason: 'timeout', detail: detailOf({ path: Routes.channelFiles }) },
          };
        throw error;
      }
      if (response.status !== 200 || response.body === null) {
        if (await DaemonClient.stopping(response.clone())) throw new PortalFailure('stopping', STOPPING_LINE);
        // A status the route does not answer on success (R6): the CLI's line, and a report.
        return {
          ok: false,
          rule: `the daemon answered HTTP ${String(response.status)}: ${(await response.text()).slice(0, 200)}`,
          report: { reason: 'bad_status', detail: detailOf({ path: Routes.channelFiles, status: response.status }) },
        };
      }
      const read = await this.readBody(response.body, file, controller, restart);
      if ('ok' in read) return read;
      const { parts, size } = read;
      if (size !== file.size) return { ok: false, rule: `${String(size)} bytes arrived, not ${String(file.size)}` };
      const blob = new Blob(parts);
      const sha256 = await sha256Hex(blob);
      if (sha256 !== file.sha256)
        return { ok: false, rule: `its sha256 is ${sha256}, not the ${file.sha256} the reply named` };
      return { ok: true, blob };
    } finally {
      clearTimeout(timer);
    }
  }

  /** The daemon's health for the stop view (R14): answering, stopping (503), or unreachable; bounded by HEALTH_TIMEOUT_MS. */
  async health(): Promise<HealthState> {
    const bound = bounded(HEALTH_TIMEOUT_MS);
    try {
      const response = await fetch(Routes.health, { headers: this.headers(), signal: bound.signal });
      await response.body?.cancel();
      return response.status === 503 ? 'stopping' : 'up';
    } catch (error) {
      // A request that cannot connect, or no answer within the bound: what R14's view waits to see once the stop runs.
      if (error instanceof TypeError || bound.signal.aborted) return 'unreachable';
      throw error;
    } finally {
      bound.clear();
    }
  }

  /**
   * Reports a failure to the daemon (R6), once, when the page has stayed (Leaving): 'reported' on 204; 'unreachable'
   * when the report cannot connect (the daemon is gone); else the line saying the report failed, which is shown and
   * never reported.
   */
  async report(reason: FailureReason, detail: string): Promise<'reported' | 'unreachable' | { readonly line: string }> {
    await this.props.leaving.stayed();
    let response: Response;
    const bound = bounded(HEALTH_TIMEOUT_MS);
    try {
      response = await fetch(Routes.portalErrors, {
        method: 'POST',
        headers: this.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify({ reason, detail }),
        signal: bound.signal,
      });
    } catch (error) {
      if (error instanceof TypeError && !bound.signal.aborted) return 'unreachable';
      return { line: `✗ the failure could not be reported to the daemon (${nameOf(error)})\n` };
    } finally {
      bound.clear();
    }
    await response.body?.cancel();
    if (response.status === 204) return 'reported';
    if (response.status === 401) return { line: UNAUTHORIZED_LINE };
    return { line: `✗ the failure could not be reported to the daemon: it answered HTTP ${String(response.status)}\n` };
  }
}

/**
 * A bound on one request (R18): its signal aborts after `ms`, by the page's own timer, so a test's manual clock moves
 * it (AbortSignal.timeout runs on a clock no test can move). `clear` once the request is answered.
 */
function bounded(ms: number): { readonly signal: AbortSignal; clear(): void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`no answer in ${String(ms)} ms`, 'TimeoutError'));
  }, ms);
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer);
    },
  };
}

/** A path without its query: what a report's detail may name. */
function pathOf(path: string): string {
  return present(path.split('?')[0], 'path.split("?")[0]');
}

/** An error's name, never its message (R6). */
export function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** The sha256 of a file's bytes, in hex, by the page's own crypto (a secure context: 127.0.0.1). */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
