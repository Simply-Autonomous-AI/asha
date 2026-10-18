// Fakes for the memory tests: a deterministic embedder (words hashed into a
// small vector, so texts that share words are similar) and a model that
// answers extraction calls from a script.

import type { ModelClient } from '../../../src/agent-sdk/index.js';
import { present } from '../../../src/shared/assert-present.js';
import type { ChatRequest, ChatResponse } from '../../../src/shared/protocol.js';
import type { Embedder } from '../../../images/memory/src/memory/index.js';

const DIM = 64;
const STOP = new Set([
  'the',
  'a',
  'an',
  'is',
  'my',
  'i',
  'to',
  'of',
  'and',
  'what',
  'user',
  'wrote',
  'answered',
  'you',
  'your',
  'me',
  'do',
  'it',
]);

export function wordVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(word)) continue;
    let h = 0;
    for (const c of word) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const i = h % DIM;
    v[i] = present(v[i], `wordVector: index ${String(i)} out of bounds`) + 1;
  }
  return v;
}

export class FakeEmbedder implements Embedder {
  readonly calls: { texts: string[]; purpose: string }[] = [];
  embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<number[][]> {
    this.calls.push({ texts: [...texts], purpose });
    return Promise.resolve(texts.map(wordVector));
  }
}

/** Answers save_facts / save_procedures from the given functions of the exchange text; records every request. */
export class ExtractingModel implements ModelClient {
  readonly requests: ChatRequest[] = [];
  constructor(
    private readonly facts: (exchange: string) => string[] = () => [],
    private readonly procedures: (exchange: string) => string[] = () => [],
    private readonly turn: (request: ChatRequest) => ChatResponse = () => ({
      ok: true,
      text: '',
      toolCalls: [{ id: 'r', name: 'reply', arguments: { text: 'ok' } }],
    }),
  ) {}
  chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const tool = request.tools?.[0]?.function.name;
    const content = request.messages.at(-1)?.content ?? '';
    const exchange = content.slice(content.indexOf('The exchange:'));
    if (tool === 'save_facts')
      return Promise.resolve({
        ok: true,
        text: '',
        toolCalls: [{ id: 'f', name: 'save_facts', arguments: { items: this.facts(exchange) } }],
      });
    if (tool === 'save_procedures')
      return Promise.resolve({
        ok: true,
        text: '',
        toolCalls: [{ id: 'l', name: 'save_procedures', arguments: { items: this.procedures(exchange) } }],
      });
    return Promise.resolve(this.turn(request));
  }
}
