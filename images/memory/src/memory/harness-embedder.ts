// The memory module's Embedder, backed by the harness's embedding route and
// the recipe's embedding model. An embedding the harness could not produce is
// an error here: recall and remember must not continue with no vectors (a
// memory silently not stored or not searched is the failure §9 rules out).

import type { EmbeddingClient } from '../../../../src/agent-sdk/index.js';
import type { Embedder } from './types.js';

export class EmbeddingFailed extends Error {
  constructor(reason: string, detail: string) {
    super(`embedding failed (${reason}): ${detail}`);
    this.name = 'EmbeddingFailed';
  }
}

export function harnessEmbedder(client: EmbeddingClient): Embedder {
  return {
    async embed(texts, purpose) {
      if (texts.length === 0) return [];
      const response = await client.embed(texts, purpose);
      if (!response.ok) throw new EmbeddingFailed(response.reason, response.detail);
      return response.vectors.map((v) => [...v]);
    },
  };
}
