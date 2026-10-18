// The page's DaemonClient.stream reading an answer it takes as data (a 400 or 409) under the stream's idle bound
// (docs/plans/portal.md R18): a body that stalls past STREAM_IDLE_MS is a timeout, shown and reported as one, not an
// exception (the portal's completion review, finding 19). `fetch` is a stub whose body errors as the browser's does
// when the request's signal aborts. And the page's leaving: PageLeaving's hold, and DaemonClient.report waiting on it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DaemonClient,
  LEAVING_HOLD_MS,
  PageLeaving,
  PortalFailure,
  type Leaving,
  type PageLeavingProps,
} from '../../src/portal/client.js';
import { present } from '../../src/shared/assert-present.js';
import { Routes } from '../../src/shared/protocol.js';
import { STREAM_IDLE_MS } from '../../src/shared/timing.js';

/** The first argument `fetch` takes: a URL, in any of its three shapes. */
type FetchInput = string | URL | Request;

/** `input` as `fetch` would log it: the URL string itself, never a default `Object#toString`. */
function requestUrl(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/** `init.body` as `fetch` would log it: the body text itself, never a default `Object#toString`. */
function requestBodyText(body: RequestInit['body']): string {
  if (body === null) return 'null';
  if (body === undefined) return 'undefined';
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  return '[object Body]';
}

/** A fetch answering `status` with a body that sends nothing and errors once the request's signal aborts. */
function stalledAnswer(status: number): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const stub = ((input: FetchInput, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${requestUrl(input)}`);
    const signal = present(init, 'stalledAnswer: init').signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        present(signal, 'stalledAnswer: init.signal').addEventListener(
          'abort',
          () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'));
          },
          { once: true },
        );
      },
    });
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
  return { fetch: stub, calls };
}

/** A page that never begins to leave. */
const STAYING: Leaving = { stayed: () => Promise.resolve(undefined) };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DaemonClient.stream: an answer taken as data, its body stalled', () => {
  it.each([400, 409])(
    'HTTP %i whose body stalls past STREAM_IDLE_MS is a timeout PortalFailure naming the path, reported as timeout',
    async (status) => {
      const stub = stalledAnswer(status);
      vi.stubGlobal('fetch', stub.fetch);
      const client = new DaemonClient({ credential: 'credential-for-the-test', leaving: STAYING });
      const events: unknown[] = [];
      const outcome = client.stream(
        Routes.conversations,
        { method: 'POST', body: { text: 'hi' } },
        (e) => (events.push(e), false),
        undefined,
        [400, 409],
      );
      const settled = outcome.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await vi.advanceTimersByTimeAsync(STREAM_IDLE_MS - 1);
      let done = false;
      void settled.then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await settled;
      expect(result.ok).toBe(false);
      const error = (result as { error: unknown }).error;
      expect(error).toBeInstanceOf(PortalFailure);
      expect([
        (error as PortalFailure).kind,
        (error as PortalFailure).reason,
        (error as PortalFailure).detail,
        (error as PortalFailure).line,
      ]).toEqual([
        'report',
        'timeout',
        Routes.conversations,
        `✗ timeout: no word from the daemon for ${String(STREAM_IDLE_MS)} ms on ${Routes.conversations}\n`,
      ]);
      expect([stub.calls, events]).toEqual([[`POST ${Routes.conversations}`], []]);
    },
  );

  it("the caller's own abort while the answer's body is read is 'aborted', not a failure", async () => {
    vi.stubGlobal('fetch', stalledAnswer(400).fetch);
    const client = new DaemonClient({ credential: 'credential-for-the-test', leaving: STAYING });
    const caller = new AbortController();
    const outcome = client.stream(
      Routes.conversations,
      { method: 'POST', body: {} },
      () => false,
      caller.signal,
      [400],
    );
    await vi.advanceTimersByTimeAsync(10);
    caller.abort();
    expect(await outcome).toBe('aborted');
  });
});

describe('PageLeaving: each beforeunload begins a hold of holdMs, and stayed() waits out every hold begun', () => {
  /** A window that is an event target with the faked setTimeout. */
  const page = (): { win: PageLeavingProps['win']; leave(): void } => {
    const target = new EventTarget();
    return {
      win: {
        addEventListener: (type, listener) => {
          target.addEventListener(type, listener);
        },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
      },
      leave: () => {
        target.dispatchEvent(new Event('beforeunload'));
      },
    };
  };
  /** Whether `p` has settled after the pending microtasks. */
  const settled = async (p: Promise<void>): Promise<boolean> => {
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    return done;
  };

  it('a page that has not begun to leave: stayed() resolves at once', async () => {
    const p = page();
    expect(await settled(new PageLeaving({ win: p.win, holdMs: 3_000 }).stayed())).toBe(true);
  });

  it('after beforeunload, stayed() waits holdMs, then resolves; afterwards it resolves at once again', async () => {
    const p = page();
    const leaving = new PageLeaving({ win: p.win, holdMs: 3_000 });
    p.leave();
    const waiting = leaving.stayed();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(await settled(waiting)).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled(waiting)).toBe(true);
    expect(await settled(leaving.stayed())).toBe(true);
  });

  it('a second beforeunload during a hold: stayed() waits out the second hold too', async () => {
    const p = page();
    const leaving = new PageLeaving({ win: p.win, holdMs: 3_000 });
    p.leave();
    const waiting = leaving.stayed();
    await vi.advanceTimersByTimeAsync(2_000);
    p.leave();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await settled(waiting)).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await settled(waiting)).toBe(true);
  });

  it('LEAVING_HOLD_MS is 3,000 ms', () => {
    expect(LEAVING_HOLD_MS).toBe(3_000);
  });
});

describe('DaemonClient.report: sent once the page has stayed', () => {
  it('waits for leaving.stayed() before sending; then sends exactly one POST with the credential, reason and detail', async () => {
    const calls: { url: string; method: string; auth: string | null; body: string }[] = [];
    vi.stubGlobal('fetch', (input: FetchInput, init?: RequestInit) => {
      calls.push({
        url: requestUrl(input),
        method: init?.method ?? 'GET',
        auth: new Headers(init?.headers).get('authorization'),
        body: requestBodyText(init?.body),
      });
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    let stay: () => void = () => undefined;
    const stayed = new Promise<void>((resolve) => (stay = resolve));
    const client = new DaemonClient({ credential: 'credential-for-the-test', leaving: { stayed: () => stayed } });
    const outcome = client.report('stream_cut', '/v1/channel TypeError');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toEqual([]);
    stay();
    expect(await outcome).toBe('reported');
    expect(calls).toEqual([
      {
        url: Routes.portalErrors,
        method: 'POST',
        auth: 'Bearer credential-for-the-test',
        body: JSON.stringify({ reason: 'stream_cut', detail: '/v1/channel TypeError' }),
      },
    ]);
  });
});
