import { describe, expect, it } from 'vitest';

import type { EmbeddingClient } from '../../../src/agent-sdk/index.js';
import { present } from '../../../src/shared/assert-present.js';
import type { EmbedResponse } from '../../../src/shared/protocol.js';
import { EmbeddingFailed, harnessEmbedder } from '../../../images/memory/src/memory/index.js';

/**
 * The harness client harnessEmbedder is handed: it answers every embed call with `answer`, and records the call. Like
 * the real one (HarnessClient.embed, src/agent-sdk/index.ts, reads its own `this`; images/memory/src/main.ts hands it
 * in), its embed works only when called as a method of its client: an embedder that took embed off the client
 * (`const { embed } = client`) would call it with no `this`, and fail every test here with a TypeError.
 */
class RecordingClient implements EmbeddingClient {
  readonly calls: [readonly string[], 'query' | 'document'][] = [];
  constructor(private readonly answer: () => Promise<EmbedResponse>) {}
  embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<EmbedResponse> {
    this.calls.push([texts, purpose]);
    return this.answer();
  }
}

describe('harnessEmbedder', () => {
  it("returns the harness's vector for each text, in the texts' order", async () => {
    // A distinct vector per text, in an order that is neither sorted nor reversed, so a reordered, sorted, repeated or
    // invented vector cannot pass.
    const vectors = [
      [0.5, 0.6],
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    const client = new RecordingClient(() => Promise.resolve({ ok: true, vectors }));
    const embedder = harnessEmbedder(client);
    expect(await embedder.embed(['a', 'b', 'c'], 'document')).toEqual([
      [0.5, 0.6],
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(client.calls).toEqual([[['a', 'b', 'c'], 'document']]);
  });

  it("returns copies, the list and every vector in it, so the caller may change them without touching the client's vectors", async () => {
    const vectors = [
      [0.5, 0.6],
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    const client = new RecordingClient(() => Promise.resolve({ ok: true, vectors }));
    const embedder = harnessEmbedder(client);
    const result = await embedder.embed(['a', 'b', 'c'], 'document');
    expect(result).toEqual([
      [0.5, 0.6],
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    // The client's vectors are readonly (EmbedResponse) and the Embedder's are the caller's own, so each is a copy: the
    // list and every vector in it, none of them the client's array.
    expect(result).not.toBe(vectors);
    expect(result.map((vector, i) => vector === vectors[i])).toEqual([false, false, false]);
    // So changing what it returned changes nothing the client holds.
    present(result[0], 'result[0]')[0] = 9;
    result.push([7, 7]);
    expect(vectors).toEqual([
      [0.5, 0.6],
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(client.calls).toEqual([[['a', 'b', 'c'], 'document']]);
  });

  it('returns no vectors for no texts, and makes no call to the harness', async () => {
    // A client that would answer with a vector, so a call made for no texts would show in what is returned as well as
    // in the calls.
    const client = new RecordingClient(() => Promise.resolve({ ok: true, vectors: [[0.5, 0.6]] }));
    const embedder = harnessEmbedder(client);
    expect(await embedder.embed([], 'query')).toEqual([]);
    expect(client.calls).toEqual([]);
  });

  // Two reasons, each with its own detail: a message that named one fixed reason or detail, whatever the harness
  // answered, fails one of them.
  it.each([
    {
      reason: 'timeout',
      detail: 'no response within 60000 ms',
      message: 'embedding failed (timeout): no response within 60000 ms',
    },
    {
      reason: 'upstream_error',
      detail: 'the model server answered 503',
      message: 'embedding failed (upstream_error): the model server answered 503',
    },
  ] as const)(
    'fails loudly when the harness could not embed ($reason): memory never continues without vectors',
    async ({ reason, detail, message }) => {
      const client = new RecordingClient(() => Promise.resolve({ ok: false, reason, detail }));
      const embedder = harnessEmbedder(client);
      const error: unknown = await embedder.embed(['a'], 'query').then(
        (vectors) => vectors,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(EmbeddingFailed);
      // Literal values, not ones built by the class under test: the message is all the agent's log shows of the failure.
      expect({ name: (error as Error).name, message: (error as Error).message }).toStrictEqual({
        name: 'EmbeddingFailed',
        message,
      });
      expect(client.calls).toEqual([[['a'], 'query']]);
    },
  );

  it('passes on a client that rejects, the same error unwrapped, never turned into no vectors', async () => {
    const failure = new Error('harness answered 500');
    const client = new RecordingClient(() => Promise.reject(failure));
    const embedder = harnessEmbedder(client);
    await expect(embedder.embed(['a'], 'query')).rejects.toBe(failure);
    expect(client.calls).toEqual([[['a'], 'query']]);
  });
});
