// The conversation route's validation (docs/plans/agent-files.md R3a, A4; debt D46) and, later, the file space's
// routes, against the real server and the real channel state.

import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NoAgentToRead } from '../../src/daemon/agents/index.js';
import { UnknownRecipe } from '../../src/daemon/definitions/index.js';
import { present } from '../../src/shared/assert-present.js';
import { Routes, type UploadResponse } from '../../src/shared/protocol.js';
import { traceIdFor } from '../../src/shared/trace-id.js';
import { SseDecoder } from '../../src/shared/sse.js';
import { serverHarness, type ServerHarness } from '../helpers/server-harness.js';

let h: ServerHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const post = (body: unknown) =>
  present(h, 'h').request(Routes.conversations, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('a refused conversation leaves no user online (D46, A4)', () => {
  it.each([
    ['an empty message', { channel: 'lab', user: 'alice', message: '' }],
    ['no message', { channel: 'lab', user: 'alice' }],
    ['an empty recipe', { channel: 'lab', user: 'alice', recipe: '', message: 'hi' }],
    ['an empty to', { channel: 'lab', user: 'alice', to: '', message: 'hi' }],
  ])('%s: 400, nothing posted, and channel.users() does not hold the user afterwards', async (_label, body) => {
    h = await serverHarness({});
    const response = await post(body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/must be a non-empty string/);
    expect(h.channels.get('lab').users()).toEqual([]);
    expect(h.logger.events()).not.toContain('channel.posted');
    expect(h.logger.events()).not.toContain('channel.user_online');
  });

  it('an issued user-<n> is not spent on a refused body', async () => {
    h = await serverHarness({});
    expect((await post({ channel: 'lab', message: '' })).status).toBe(400);
    // The next claim on the channel is still user-1.
    expect(h.channels.get('lab').claimUser().id).toBe('user-1');
  });
});

// ------------------------------------------------------------------ the file routes (R3a, R12, R12a; A4, A6)

const IMAGE = `asha-image-x:${'a'.repeat(64)}`;
const shaOf = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** An upload's body: the manifest line and the files' bytes. */
function uploadBody(files: { name: string; content: Buffer }[]): Buffer {
  return Buffer.concat([
    Buffer.from(
      `${JSON.stringify(files.map((f) => ({ name: f.name, size: f.content.length, sha256: shaOf(f.content) })))}\n`,
    ),
    ...files.map((f) => f.content),
  ]);
}

const upload = (query: string, bytes: Buffer, type = 'application/octet-stream') =>
  present(h, 'h').request(`${Routes.channelFiles}?${query}`, {
    method: 'POST',
    headers: { 'content-type': type },
    body: bytes,
  });

/** Every SSE event of a stream response, parsed. */
async function events(response: Response): Promise<unknown[]> {
  const decoder = new SseDecoder();
  const out: unknown[] = [];
  for (const event of decoder.push(await response.text())) out.push(event);
  return out;
}

describe('the upload route (R3a, A4)', () => {
  it('copies the files into the space and answers their paths; a conversation naming the upload delivers them as attachments', async () => {
    h = await serverHarness({ ensureOnline: () => Promise.resolve({} as never) });
    await h.files.ensure('lab', IMAGE);
    const response = await upload(
      'channel=lab&user=alice',
      uploadBody([{ name: 'notes.txt', content: Buffer.from('n\n') }]),
    );
    expect(response.status).toBe(200);
    const answer = (await response.json()) as UploadResponse;
    expect(answer.files).toEqual([
      {
        name: 'notes.txt',
        path: expect.stringMatching(/^\/channel\/upload-[0-9a-f]{16}\/notes\.txt$/) as string,
        size: 2,
        sha256: shaOf('n\n'),
      },
    ]);
    const lab = h.channels.get('lab');
    const delivered: unknown[] = [];
    lab.join('hewo', { deliver: (d) => delivered.push(d.message), deliveryTimeoutMs: 60_000 });
    const conversation = await post({
      channel: 'lab',
      user: 'alice',
      message: 'see /Users/x/notes.txt',
      attachments: answer.upload,
    });
    expect(conversation.status).toBe(200);
    const posted = (await readUntil(conversation, 'posted')) as { message: { attachments: unknown } };
    const path = present(answer.files[0], 'answer.files[0]').path;
    expect(posted.message.attachments).toEqual([{ path, size: 2, sha256: shaOf('n\n') }]);
    expect(delivered).toEqual([
      expect.objectContaining({
        text: 'see /Users/x/notes.txt',
        attachments: [{ path, size: 2, sha256: shaOf('n\n') }],
      }),
    ]);
    expect(h.logger.entries.filter((e) => e.event === 'files.attached').map((e) => e.fields)).toEqual([
      { user: 'alice', channel: 'lab', agents: ['hewo-1'], name: 'notes.txt', size: 2, sha256: shaOf('n\n') },
    ]);
  });

  it.each([
    ['an unknown upload id', () => 'f'.repeat(32)],
    ['an id already used', 'used'],
    ["another channel's id", 'other'],
  ] as const)(
    'a conversation naming %s is refused 400, nothing posted, and channel.users() does not hold its user',
    async (_label, which) => {
      h = await serverHarness({});
      await h.files.ensure('lab', IMAGE);
      await h.files.ensure('other', IMAGE);
      const up = (await (
        await upload(
          `channel=${which === 'other' ? 'other' : 'lab'}&user=alice`,
          uploadBody([{ name: 'a', content: Buffer.from('a') }]),
        )
      ).json()) as UploadResponse;
      if (which === 'used') {
        expect(h.files.claim('lab', up.upload).ok).toBe(true);
        h.files.used('lab', up.upload, { user: 'alice', agents: [] });
      }
      const id = typeof which === 'function' ? which() : up.upload;
      const response = await post({ channel: 'lab', user: 'alice', message: 'hi', attachments: id });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toMatch(
        /^attachments [0-9a-f]{32} (is unknown, expired or already used|was uploaded to another channel)$/,
      );
      expect(h.channels.get('lab').users()).toEqual([]);
      expect(h.logger.events()).not.toContain('channel.posted');
    },
  );

  it('a conversation naming a valid upload and an unknown recipe fails its stream, and the upload is rolled back', async () => {
    h = await serverHarness({ ensureOnline: async () => Promise.reject(new UnknownRecipe('nope')) });
    await h.files.ensure('lab', IMAGE);
    const up = (await (
      await upload('channel=lab&user=alice', uploadBody([{ name: 'a', content: Buffer.from('a') }]))
    ).json()) as UploadResponse;
    const response = await post({
      channel: 'lab',
      user: 'alice',
      recipe: 'nope',
      message: 'hi',
      attachments: up.upload,
    });
    expect(await events(response)).toEqual([
      { type: 'error', reason: 'unknown_recipe', detail: 'no recipe named "nope" (no recipes/nope.json)' },
    ]);
    await vi.waitFor(() => {
      expect(present(h, 'h').runtime.rollbacks.map((r) => r.folder)).toEqual([
        present(up.files[0], 'up.files[0]').path.split('/')[2],
      ]);
    });
    expect(h.files.table('lab')).toEqual([]);
    expect(h.channels.get('lab').users()).toEqual([]);
  });

  it('a conversation whose user= is refused rolls its claimed upload back', async () => {
    h = await serverHarness({});
    await h.files.ensure('lab', IMAGE);
    const up = (await (
      await upload('channel=lab&user=alice', uploadBody([{ name: 'a', content: Buffer.from('a') }]))
    ).json()) as UploadResponse;
    const response = await post({ channel: 'lab', user: 'Bad User', message: 'hi', attachments: up.upload });
    expect(response.status).toBe(400);
    await vi.waitFor(() => {
      expect(present(h, 'h').runtime.rollbacks).toHaveLength(1);
    });
  });

  it.each([
    ['no space', 'channel=lab&user=alice', 'application/octet-stream', 409, 'no_space'],
    ['a bad channel', 'channel=Lab&user=alice', 'application/octet-stream', 400, undefined],
    ['a bad user', 'channel=lab&user=user-x-1', 'application/octet-stream', 400, undefined],
    ['JSON', 'channel=lab&user=alice', 'application/json', 400, undefined],
  ] as const)('%s: %s', async (_label, query, type, status, reason) => {
    h = await serverHarness({});
    const response = await upload(query, uploadBody([{ name: 'a', content: Buffer.from('a') }]), type);
    expect(response.status).toBe(status);
    const body = (await response.json()) as { error: string; reason?: string };
    expect(body.reason).toBe(reason);
    expect(h.runtime.copyIns).toEqual([]);
  });
});

describe('the space route (R3a, R7; A4)', () => {
  it('streams the phases, then space_ready with the usage and cloudAgents', async () => {
    h = await serverHarness({
      prepareSpace: (_channel, recipe, sink) => {
        sink.phase('container_runtime', 'ready');
        sink.phase('image', `asha-image-x ${recipe ?? '?'}`);
        return Promise.resolve({ bytes: 12, entries: 3, cloudAgents: [] });
      },
    });
    const response = await h.request(Routes.channelSpace, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'lab', recipe: 'r' }),
    });
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await events(response)).toEqual([
      { type: 'phase', phase: 'container_runtime', detail: 'ready' },
      { type: 'phase', phase: 'image', detail: 'asha-image-x r' },
      { type: 'space_ready', channel: 'lab', bytes: 12, entries: 3, cloudAgents: [] },
    ]);
  });

  it('ends with error bad_request for a channel with no agent and no recipe, logged at warn', async () => {
    h = await serverHarness({ prepareSpace: async (channel) => Promise.reject(new NoAgentToRead(channel.name)) });
    const response = await h.request(Routes.channelSpace, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'lab' }),
    });
    expect(await events(response)).toEqual([
      { type: 'error', reason: 'bad_request', detail: 'no agent on channel lab to read the file' },
    ]);
    expect(h.logger.entries.find((e) => e.event === 'files.space_refused')).toEqual({
      level: 'warn',
      event: 'files.space_refused',
      fields: { channel: 'lab', detail: 'no agent on channel lab to read the file' },
    });
  });
});

describe('the download route (R12a, A6)', () => {
  async function returned() {
    h = await serverHarness({});
    await h.files.ensure('lab', IMAGE);
    present(h.runtime.volumes.get(`asha-abcd1234-0123abcd-lab`), 'runtime.volumes.get(...)').entries.set('out.txt', {
      type: 'file',
      content: Buffer.from('the result\n'),
      owner: '1000:1000',
      mode: 0o644,
    });
    const result = await h.files.returnFiles({
      channel: 'lab',
      conversation: 'c',
      user: 'alice',
      handle: 'hewo-1',
      paths: ['/channel/out.txt'],
    });
    if (!result.ok) throw new Error(result.rule);
    return present(result.files[0], 'result.files[0]');
  }

  it('streams the bytes with their length', async () => {
    const file = await returned();
    const response = await present(h, 'h').request(`${Routes.channelFiles}/${file.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('11');
    expect(await response.text()).toBe('the result\n');
  });

  it('a file changed since the reply ends one byte short: the reader sees a body cut before its length', async () => {
    const file = await returned();
    present(present(h, 'h').runtime.volumes.get(`asha-abcd1234-0123abcd-lab`), 'runtime.volumes.get(...)').entries.set(
      'out.txt',
      { type: 'file', content: Buffer.from('THE RESULT\n'), owner: '1000:1000', mode: 0o644 },
    );
    const response = await present(h, 'h').request(`${Routes.channelFiles}/${file.id}`);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
  });

  it('answers 404 for a random id', async () => {
    await returned();
    const response = await present(h, 'h').request(`${Routes.channelFiles}/${'0'.repeat(32)}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: `no returned file ${'0'.repeat(32)}`, reason: 'not_found' });
  });
});

describe("an agent's reply with files (R12, A6)", () => {
  const conversationTrace = (conversation: string) => `00-${traceIdFor(conversation)}-${'1'.repeat(16)}-01`;

  it('a refusal is 409 {error, reason: file_refused, file, rule}, nothing posted', async () => {
    h = await serverHarness({
      isAgentToken: () => true,
      postWithFiles: () => Promise.resolve({ ok: false, file: '/channel/p', rule: 'a link is never returned' }),
    });
    const response = await fetch(`${h.base}${Routes.agentMessages}`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer agent-token',
        'content-type': 'application/json',
        traceparent: conversationTrace('c1'),
      },
      body: JSON.stringify({ conversation: 'c1', kind: 'output', text: 'here', files: ['/channel/p'] }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'file refused: /channel/p: a link is never returned',
      reason: 'file_refused',
      file: '/channel/p',
      rule: 'a link is never returned',
    });
  });

  it('files come only on an output with no "to", as a list of paths', async () => {
    h = await serverHarness({
      isAgentToken: () => true,
      postWithFiles: async () => Promise.reject(new Error('not reached')),
    });
    for (const body of [
      { conversation: 'c1', kind: 'internal', text: 'x', files: ['/channel/a'] },
      { conversation: 'c1', kind: 'output', text: 'x', files: '/channel/a' },
      { conversation: 'c1', kind: 'output', text: 'x', files: [3] },
    ]) {
      const response = await fetch(`${h.base}${Routes.agentMessages}`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer agent-token',
          'content-type': 'application/json',
          traceparent: conversationTrace('c1'),
        },
        body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });
});

/** Reads a conversation stream until an event of `type`, which it returns. */
async function readUntil(response: Response, type: string): Promise<unknown> {
  const decoder = new SseDecoder();
  // Typed on the body's bytes (undici-types' Response.body is an untyped ReadableStream, defaulting its reads to
  // `any`, the same looseness src/shared/sse.ts's sseEvents avoids the same way) so the read below is not unsafe.
  const body = present(response.body, 'response.body') as ReadableStream<Uint8Array>;
  const reader = body.getReader();
  for (;;) {
    const read = await reader.read();
    if (read.done) throw new Error(`the stream ended before ${type}`);
    for (const event of decoder.push(new TextDecoder().decode(read.value))) {
      if ((event as { type: string }).type === type) {
        await reader.cancel();
        return event;
      }
    }
  }
}

describe('conversation.closed (found by agent-files A9, 2026-09-30)', () => {
  it('is logged once, naming the channel and the conversation, when the client hangs up after the conversation posted', async () => {
    h = await serverHarness({});
    const response = await post({ channel: 'lab', user: 'alice', message: 'hello' });
    expect(response.status).toBe(200);
    const posted = (await readUntil(response, 'posted')) as { message: { conversation: string } };
    // Nothing is logged while the stream is open; the hang-up (readUntil cancels the body) logs it, at once.
    await vi.waitFor(
      () => {
        expect(present(h, 'h').logger.events()).toContain('conversation.closed');
      },
      {
        timeout: 2_000,
        interval: 10,
      },
    );
    expect(h.logger.entries.filter((e) => e.event === 'conversation.closed')).toEqual([
      {
        level: 'info',
        event: 'conversation.closed',
        fields: { channel: 'lab', conversation: posted.message.conversation },
      },
    ]);
  });
});

/** A log field's error text as `String(error ?? '')` produced it: an Error's own toString, never Object's default
 * ("[object Object]"), '' when there is none. */
function errorText(error: unknown): string {
  if (error === undefined) return '';
  if (error instanceof Error) return String(error);
  return JSON.stringify(error);
}

describe('a handler failure logs the path, never the query (completion review, finding 4)', () => {
  it('an upload whose handler throws: 500, and http.handler_failed carries /v1/channel/files without its user=', async () => {
    h = await serverHarness(
      {},
      {
        files: {
          upload: () => Promise.reject(new Error('a defect in the handler')),
        } as never,
      },
    );
    const response = await upload(
      'channel=lab&user=alice-smith',
      uploadBody([{ name: 'a.txt', content: Buffer.from('a') }]),
    );
    expect(response.status).toBe(500);
    const failed = h.logger.entries.filter((e) => e.event === 'http.handler_failed');
    expect(failed).toHaveLength(1);
    expect(present(failed[0], 'failed[0]').fields['url']).toBe('/v1/channel/files');
    expect(
      JSON.stringify(
        h.logger.entries.map((e) => ({ ...e, fields: { ...e.fields, error: errorText(e.fields['error']) } })),
      ),
    ).not.toContain('alice-smith');
  });
});

describe('the launch route carries exposesFiles (R7; completion review, finding 5)', () => {
  const launchBody = (body: unknown) =>
    present(h, 'h').request(Routes.agents, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  const agent = (exposes: boolean) => ({
    handle: 'hewo-1',
    channel: 'lab',
    recipe: { id: 'hello-world' },
    image: { name: 'hello-world' },
    ...(exposes ? { exposesFiles: true as const } : {}),
  });

  it.each([
    [true, { exposesFiles: true }],
    [false, {}],
  ])('a launched agent with exposesFiles %s: the launched event says so exactly then', async (exposes, extra) => {
    h = await serverHarness({ launchNew: () => Promise.resolve(agent(exposes) as never) });
    const response = await launchBody({ channel: 'lab', recipe: 'hello-world' });
    expect(response.status).toBe(200);
    const launched = (await events(response)).find((e) => (e as { type: string }).type === 'launched');
    expect(launched).toEqual({
      type: 'launched',
      agent: { handle: 'hewo-1', channel: 'lab', recipe: 'hello-world', image: 'hello-world' },
      ...extra,
    });
  });
});

describe('the conversation route carries exposesFiles on announced (R7; completion review, finding 5)', () => {
  it('an agent brought online with exposesFiles: the announced event says so', async () => {
    const message = {
      id: 'm0',
      channel: 'lab',
      conversation: null,
      user: null,
      from: 'hewo-1',
      to: null,
      kind: 'status',
      text: 'Hi',
      at: '2026-09-30T00:00:00.000Z',
    };
    h = await serverHarness({
      ensureOnline: (
        _recipe: string,
        _channel: unknown,
        sink: { announced: (m: unknown, r: unknown, e?: true) => void },
      ) => {
        sink.announced(message, undefined, true);
        return Promise.resolve({} as never);
      },
    } as never);
    const response = await post({ channel: 'lab', user: 'alice', recipe: 'hello-world', message: 'hi' });
    expect(response.status).toBe(200);
    expect(await readUntil(response, 'announced')).toEqual({ type: 'announced', message, exposesFiles: true });
  });
});
