// The agent suite's reader of a channel's board (docs/plans/patterns-phase-4.md R6, A3): readBoard pages through
// GET /v1/blackboard while `more`, sends the control credential only as a bearer header, fails on any status but 200
// naming it and never the credential, and fails at its bound against a daemon that never answers.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { BOARD_READ_TIMEOUT_MS, readBoard } from '../agents/support.js';

const DAEMON = { port: 4321, credential: 'c'.repeat(64) };
const entry = (id: number) => ({
  id,
  author: 'hewo-1',
  ts: '2026-10-03T00:00:00.000Z',
  text: `n${String(id)}`,
  session: 1,
});

/** A fake fetch answering each call from `pages` in turn, recording each URL and init. */
function pages(answers: readonly Response[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let i = 0;
  const fetch = ((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const answer = answers[i++];
    if (answer === undefined) throw new Error(`unexpected fetch ${url}`);
    return Promise.resolve(answer);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => {
  vi.useRealTimers();
});

describe('readBoard (patterns-phase-4 R6)', () => {
  it('pages while more, from the id after the last entry, with the credential as a bearer header only', async () => {
    const { fetch, calls } = pages([
      json({ entries: [entry(4), entry(5)], more: true }),
      json({ entries: [entry(6)], more: false }),
    ]);
    expect(await readBoard({ daemon: DAEMON, channel: 'main', since: 3, fetch })).toEqual([
      entry(4),
      entry(5),
      entry(6),
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      'http://127.0.0.1:4321/v1/blackboard?channel=main&since=3',
      'http://127.0.0.1:4321/v1/blackboard?channel=main&since=5',
    ]);
    for (const c of calls) {
      expect(c.init?.headers).toEqual({ authorization: `Bearer ${DAEMON.credential}` });
      expect(c.url).not.toContain(DAEMON.credential);
    }
  });

  it('answers an empty board with no entries after one request', async () => {
    const { fetch, calls } = pages([json({ entries: [], more: false })]);
    expect(await readBoard({ daemon: DAEMON, channel: 'lab', since: 0, fetch })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    [404, { error: 'no channel main on this daemon', reason: 'unknown_channel' }],
    [500, { error: 'boom' }],
    [401, { error: 'invalid control credential' }],
  ])('fails on %i naming the status, and not the credential', async (status, body) => {
    const { fetch } = pages([json(body, status)]);
    const error = (await readBoard({ daemon: DAEMON, channel: 'main', since: 0, fetch }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(error.message).toBe(
      `GET /v1/blackboard?channel=main&since=0 answered ${String(status)}: ${JSON.stringify(body)}`,
    );
    expect(error.message).not.toContain(DAEMON.credential);
  });

  it('fails on a page saying more with no entry, rather than reading forever', async () => {
    const { fetch } = pages([json({ entries: [], more: true })]);
    await expect(readBoard({ daemon: DAEMON, channel: 'main', since: 0, fetch })).rejects.toThrow(
      'GET /v1/blackboard?channel=main&since=0 answered more with no entry',
    );
  });

  it(`fails at its ${String(BOARD_READ_TIMEOUT_MS)} ms bound against a daemon that never answers`, async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetch = ((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        present(signal, 'signal').addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    }) as unknown as typeof globalThis.fetch;
    const reading = readBoard({ daemon: DAEMON, channel: 'main', since: 0, fetch }).catch((e: unknown) => e as Error);
    await vi.advanceTimersByTimeAsync(BOARD_READ_TIMEOUT_MS - 1);
    expect(present(signal, 'signal').aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await reading) as Error).message).toBe(
      `GET /v1/blackboard?channel=main&since=0 passed its ${String(BOARD_READ_TIMEOUT_MS)} ms bound`,
    );
  });
});
