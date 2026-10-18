import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ModelClient } from '../../../src/agent-sdk/index.js';
import { present } from '../../../src/shared/assert-present.js';
import { byCodeUnit } from '../../../src/shared/order.js';
import type { ChatRequest, ChatResponse, ToolDefinition } from '../../../src/shared/protocol.js';
import {
  AgentMemory,
  DEFAULT_POLICY,
  EmbeddingFailed,
  MemoryCache,
  MemoryFileInvalid,
  MemoryStore,
  assemble,
  type MemoryPolicy,
  type Scope,
  type Turn,
} from '../../../images/memory/src/memory/index.js';
import { extractFacts, extractProcedures, ExtractionFailed } from '../../../images/memory/src/memory/extract.js';
import { cosine, search } from '../../../images/memory/src/memory/relevance.js';
import { currentSession, episodeText, slide } from '../../../images/memory/src/memory/session.js';
import { ExtractingModel, FakeEmbedder, wordVector } from './fakes.js';

const T0 = Date.parse('2026-09-26T12:00:00.000Z');
const at = (min: number): string => new Date(T0 + min * 60_000).toISOString();
const turn = (id: string, min: number, input = `input ${id}`, response = `response ${id}`, from = 'alice'): Turn => ({
  id,
  ts: at(min),
  conversation: `c-${id}`,
  from,
  input,
  response,
});
const ALICE: Scope = { channel: 'main', user: 'alice' };
const BOB: Scope = { channel: 'main', user: 'bob' };
/**
 * The idle time the session tests, and the AgentMemory test of its own sessionIdleMs, pass: 10 minutes, a third of
 * DEFAULT_POLICY's 30 (pinned by the DEFAULT_POLICY test below). Each places a gap of 2 × or 1.5 × it, under 30
 * minutes, where it decides the answer, so code that used 30 minutes in place of the idle time it was given would fail.
 */
const IDLE_MIN = 10;
const IDLE = IDLE_MIN * 60_000;

/** How the `# Memory` section opens, before the first tier's heading. */
const HEADER =
  '# Memory\n\nWhat you remember about the user you are talking to. Use it when it helps; never mention these notes.';

// The extraction requests, written out in full: the system prompts carry the owner's definitions of the two
// tiers (2026-09-26), and the forced tools carry the limits the model is held to.
const FACTS_SYSTEM = [
  'You maintain the long-term memory of an assistant about one user.',
  'From the exchange below, extract facts about the user that stay true and useful for weeks: who they are, what they have, what they like or prefer (including how they want answers given), their plans and their situation.',
  'A fact is NOT a log of what happened in this exchange, not a greeting, and not something the assistant said about itself.',
  'Ask of each candidate: would this still be true and useful weeks from now? If not, leave it out.',
  'Never repeat or paraphrase a fact that is already known. Save at most 3. When nothing qualifies, save an empty list.',
].join('\n');
const PROCEDURES_SYSTEM = [
  'You maintain the procedural memory of an assistant: reusable techniques for getting things done.',
  'Read the exchange below. If the assistant accomplished a task in it with a technique that worked and that would be useful again for similar tasks, record that technique as a procedure.',
  'Write each as "To <accomplish what>: <the steps or technique that worked>", general enough to reuse, with the specifics of this one exchange left out.',
  'A procedure is NOT a fact or a preference about the user, NOT a summary of the exchange, and NOT a guess: record only what demonstrably worked. Most exchanges have none.',
  'Never repeat or paraphrase a procedure that is already known. Save at most 2. When nothing qualifies, save an empty list.',
].join('\n');
const SAVE_FACTS_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'save_facts',
    description: 'Save new facts about the user. Save an empty list when there is nothing new worth keeping.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'string',
            description: 'One fact about the user, as a short sentence in the third person ("The user ...").',
          },
          maxItems: 3,
        },
      },
      required: ['items'],
    },
  },
};
const SAVE_PROCEDURES_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'save_procedures',
    description:
      'Save reusable procedures: techniques that proved effective for accomplishing a task. Save an empty list when there is none.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'string',
            description: 'One procedure, as "To <accomplish what>: <the steps or technique that worked>".',
          },
          maxItems: 2,
        },
      },
      required: ['items'],
    },
  },
};
const NOTHING = '(nothing yet)';

/** One extraction request in full, as the extraction tests pin it: the known list (given literally), then the exchange. */
function asked(tier: 'facts' | 'procedures', known: string, exchange: string): ChatRequest {
  return {
    messages: [
      { role: 'system', content: tier === 'facts' ? FACTS_SYSTEM : PROCEDURES_SYSTEM },
      {
        role: 'user',
        content: `Already known (do NOT repeat or paraphrase these):\n${known}\n\nThe exchange:\n${exchange}`,
      },
    ],
    maxTokens: 300,
    tools: [tier === 'facts' ? SAVE_FACTS_TOOL : SAVE_PROCEDURES_TOOL],
    requireToolCall: true,
  };
}

/** The two extraction requests every remembered turn makes, facts first. */
const asks = (knownFacts: string, knownProcedures: string, exchange: string): ChatRequest[] => [
  asked('facts', knownFacts, exchange),
  asked('procedures', knownProcedures, exchange),
];

/** A memory as the fake embedder stored it. */
const memoryOf = (id: string, ts: string, text: string) => ({ id, ts, text, embedding: wordVector(text) });
/**
 * A recalled memory and its score. Every score below is a cosine worked out by hand from the words two texts share:
 * the fake embedder counts each word that is not a stop word in a bucket of its own (the words of every test below
 * were checked to land in distinct buckets), so a cosine is shared words / √(words of one · words of the other),
 * written as that expression and compared exactly: integer counts, one correctly rounded square root and one division.
 */
const scored = (id: string, ts: string, text: string, score: number) => ({ memory: memoryOf(id, ts, text), score });
const doc = (...texts: string[]) => ({ texts, purpose: 'document' });
const query = (text: string) => ({ texts: [text], purpose: 'query' });
/**
 * For calls made by writes that ran at once, in no fixed order: compared as a set, by sorting both sides by their JSON,
 * code unit by code unit (never by the host's locale collation, under which two different strings can compare equal).
 */
const sorted = <T>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => byCodeUnit(JSON.stringify(a), JSON.stringify(b)));

/** An error as its class, name and message, to compare in one go. */
const described = (error: Error): { type: unknown; name: string; message: string } => ({
  type: error.constructor,
  name: error.name,
  message: error.message,
});
/** Each report AgentMemory made, with its error as class, name and message. */
const reportsOf = (failures: readonly unknown[][]): unknown[][] =>
  failures.map((report) => report.map((x) => (x instanceof Error ? described(x) : x)));

/**
 * A fake embedder whose `failing` 'document' calls (counted from 1) are recorded and reject, as the harness embedder does
 * when the harness could not embed; each rejection names its call, so two failures are told apart.
 */
class DocumentCallFails extends FakeEmbedder {
  private documents = 0;
  private readonly failing: readonly number[];
  constructor(...failing: number[]) {
    super();
    this.failing = failing;
  }
  override async embed(texts: readonly string[], purpose: 'query' | 'document'): Promise<number[][]> {
    if (purpose !== 'document') return super.embed(texts, purpose);
    this.documents += 1;
    if (!this.failing.includes(this.documents)) return super.embed(texts, purpose);
    this.calls.push({ texts: [...texts], purpose });
    throw new EmbeddingFailed('timeout', `embedder down at document call ${String(this.documents)}`);
  }
}
/** The report of a write that failed at the given 'document' call of a DocumentCallFails. */
const embeddingFailedAt = (call: number) => [
  'write',
  ALICE,
  {
    type: EmbeddingFailed,
    name: 'EmbeddingFailed',
    message: `embedding failed (timeout): embedder down at document call ${String(call)}`,
  },
];

/** What a promise rejected with, as it is. Fails the test if it resolved. */
async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected a rejection, but the promise resolved');
    },
    (reason: unknown) => reason,
  );
}

/** What a promise rejected with: its class, name and message, to compare in one go. Fails the test if it resolved. */
async function rejection(promise: Promise<unknown>): Promise<{ type: unknown; name: string; message: string }> {
  const error = await reasonOf(promise);
  if (!(error instanceof Error)) throw new Error(`expected an Error, got ${String(error)}`);
  return described(error);
}

/** A model that records every request and answers each with `answer(request)`. */
function recording(answer: (request: ChatRequest) => ChatResponse): ModelClient & { readonly requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  return {
    requests,
    chat: (request: ChatRequest): Promise<ChatResponse> => {
      requests.push(request);
      return Promise.resolve(answer(request));
    },
  };
}

/** How extraction shows the model `turn('t', 0)`. */
const EXCHANGE_T = 'The user wrote: input t\nThe assistant answered: response t';

/** A searchable tier's document as the store holds it, written while the clock read T0. */
const kept = (tier: string, records: unknown[]) => ({ schemaVersion: 1, tier, updatedAt: at(0), records });

/** The four tiers, as their files are named. */
const TIER_NAMES = ['session', 'episodic', 'semantic', 'procedural'] as const;
/**
 * The error a read of a folder fails with, where a tier's file belongs, as described() gives it: Node 22.13.1's own, a
 * plain Error with no path in its message (seen 2026-10-11: code EISDIR, syscall read).
 */
const EISDIR_READ = { type: Error, name: 'Error', message: 'EISDIR: illegal operation on a directory, read' };
/** A file-system error's code and syscall. */
const errnoOf = (error: unknown): { code: string | undefined; syscall: string | undefined } => ({
  code: (error as NodeJS.ErrnoException).code,
  syscall: (error as NodeJS.ErrnoException).syscall,
});

describe('relevance', () => {
  it('cosine is 1 for the same direction, 0 for orthogonal vectors or a zero vector, and refuses different sizes', () => {
    expect(cosine([1, 2], [2, 4])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 0])).toBe(0);
    expect(cosine([1, 0], [0, 0])).toBe(0);
    expect(() => cosine([1], [1, 2])).toThrow(new Error('cosine of vectors of different sizes: 1 and 2'));
  });

  it('search keeps only memories at or above minScore, best first, at most k, ties to the newer', () => {
    const m = (id: string, ts: string, embedding: number[]) => ({ id, ts, text: id, embedding });
    const low = m('low', at(0), [0, 1]);
    const old = m('old', at(0), [1, 0]);
    const newer = m('new', at(5), [1, 0]);
    const mid = m('mid', at(1), [1, 1]);
    expect(search([low, old, newer, mid], [1, 0], 2, 0.5)).toEqual([
      { memory: newer, score: 1 },
      { memory: old, score: 1 },
    ]);
    expect(search([low, old, newer, mid], [1, 0], 5, 0.5)).toEqual([
      { memory: newer, score: 1 },
      { memory: old, score: 1 },
      { memory: mid, score: 1 / Math.sqrt(2) },
    ]); // 1 / √(2 · 1)
    expect(search([low], [1, 0], 5, 0.3)).toEqual([]);
  });

  it('search keeps a memory scoring exactly minScore, and drops one just under it', () => {
    const exact = { id: 'exact', ts: at(0), text: 'exact', embedding: [3, 4] }; // against [1, 0]: 3 / 5 = 0.6, exact in floating point
    const under = { id: 'under', ts: at(1), text: 'under', embedding: [3, 4.1] }; // 3 / √25.81 ≈ 0.5905
    expect(search([under, exact], [1, 0], 5, 0.6)).toEqual([{ memory: exact, score: 0.6 }]);
  });
});

describe('session', () => {
  it('the current session is the latest run of turns with no gap longer than the idle time', () => {
    // a to b and c to d: half the idle time; b to c: twice it (20 minutes, under the default 30).
    const B = IDLE_MIN / 2;
    const C = B + 2 * IDLE_MIN;
    const D = C + IDLE_MIN / 2;
    const turns = [turn('a', 0), turn('b', B), turn('c', C), turn('d', D)];
    expect(currentSession(turns, new Date(at(D + IDLE_MIN / 2)), IDLE)).toEqual([turns[2], turns[3]]);
    // Twice the idle time after d: the session has ended.
    expect(currentSession(turns, new Date(at(D + 2 * IDLE_MIN)), IDLE)).toEqual([]);
  });

  it('a gap of exactly the idle time stays in the session; a millisecond more ends it, and so does one under the default but over the idle time', () => {
    const B = 2 * IDLE_MIN; // a to b: twice the idle time
    const C = B + IDLE_MIN; // b to c: exactly the idle time
    const turns = [turn('a', 0), turn('b', B), turn('c', C)];
    expect(currentSession(turns, new Date(at(C + IDLE_MIN)), IDLE)).toEqual([turns[1], turns[2]]); // c to now: exactly the idle time
    // The same turns under DEFAULT_POLICY's idle time: a gap of twice IDLE is under it, so a stays in the session.
    expect(currentSession(turns, new Date(at(C + IDLE_MIN)), DEFAULT_POLICY.sessionIdleMs)).toEqual(turns);
    expect(currentSession(turns, new Date(T0 + (C + IDLE_MIN) * 60_000 + 1), IDLE)).toEqual([]); // c to now: the idle time and 1 ms
    const late = [turn('b', B), { ...turn('c', C), ts: new Date(T0 + C * 60_000 + 1).toISOString() }]; // b to c: the idle time and 1 ms
    expect(currentSession(late, new Date(at(C + 1)), IDLE)).toEqual([late[1]]);
  });

  it('slide keeps the last `window` turns of the current session; everything else overflows', () => {
    // a to b: twice the idle time, so the current session is b, c and d.
    const B = 2 * IDLE_MIN;
    const turns = [turn('a', 0), turn('b', B), turn('c', B + 1), turn('d', B + 2)];
    // A window shorter than the session: its last two turns are kept; b, and a from before the session, overflow.
    expect(slide(turns, new Date(at(B + 2)), IDLE, 2)).toEqual({
      keep: [turns[2], turns[3]],
      overflow: [turns[0], turns[1]],
    });
    // A window as long as all four turns: the idle time alone decides, and a overflows.
    expect(slide(turns, new Date(at(B + 2)), IDLE, 4)).toEqual({
      keep: [turns[1], turns[2], turns[3]],
      overflow: [turns[0]],
    });
    // Under DEFAULT_POLICY's idle time a gap of twice IDLE is no gap: all four are kept.
    expect(slide(turns, new Date(at(B + 2)), DEFAULT_POLICY.sessionIdleMs, 4)).toEqual({ keep: turns, overflow: [] });
  });

  it('orders turns by time whatever order they come in: the session and the overflow are both oldest first', () => {
    // As in the first session test: b to c is twice the idle time, every other gap half of it.
    const B = IDLE_MIN / 2;
    const C = B + 2 * IDLE_MIN;
    const D = C + IDLE_MIN / 2;
    const [a, b, c, d] = [turn('a', 0), turn('b', B), turn('c', C), turn('d', D)];
    expect(currentSession([d, a, c, b], new Date(at(D + IDLE_MIN / 2)), IDLE)).toEqual([c, d]);
    expect(currentSession([d, c], new Date(at(D + IDLE_MIN / 2)), IDLE)).toEqual([c, d]);
    // e to f: twice the idle time; f, g and h a minute apart.
    const F = 2 * IDLE_MIN;
    const [e, f, g, h] = [turn('e', 0), turn('f', F), turn('g', F + 1), turn('h', F + 2)];
    expect(slide([h, f, e, g], new Date(at(F + 2)), IDLE, 2)).toEqual({ keep: [g, h], overflow: [e, f] });
  });

  it("an episode reads in the agent's own voice, naming an agent that passed on the user's task", () => {
    expect(episodeText(turn('t', 0, 'Book a table for two', 'Booked for 8 pm.'), 'alice')).toBe(
      'The user wrote: Book a table for two\nI answered: Booked for 8 pm.',
    );
    expect(episodeText(turn('t', 0, 'Book a table for two', 'Booked for 8 pm.', 'planner'), 'alice')).toBe(
      'Agent planner, for the user, wrote: Book a table for two\nI answered: Booked for 8 pm.',
    );
  });
});

describe('extraction', () => {
  it('asks for facts with a forced save_facts call, shows what is known, and keeps at most 3 non-empty items', async () => {
    const model = new ExtractingModel(() => ['The user likes teal.', ' ', '  A  ', 'B', 'C']);
    const facts = await extractFacts(
      model,
      ['The user is Alice.', 'The user lives in Porto.'],
      turn('t', 0, 'My favourite colour is teal', 'Noted!'),
      'alice',
    );
    expect(facts).toEqual(['The user likes teal.', 'A', 'B']);
    expect(model.requests).toEqual([
      {
        messages: [
          { role: 'system', content: FACTS_SYSTEM },
          {
            role: 'user',
            content:
              'Already known (do NOT repeat or paraphrase these):\n- The user is Alice.\n- The user lives in Porto.\n\nThe exchange:\nThe user wrote: My favourite colour is teal\nThe assistant answered: Noted!',
          },
        ],
        maxTokens: 300,
        tools: [SAVE_FACTS_TOOL],
        requireToolCall: true,
      },
    ]);
  });

  it('asks for reusable procedures with save_procedures, at most 2', async () => {
    const model = new ExtractingModel(undefined, () => ['a', 'b', 'c']);
    expect(await extractProcedures(model, [], turn('t', 0), 'alice')).toEqual(['a', 'b']);
    expect(model.requests).toEqual([
      {
        messages: [
          { role: 'system', content: PROCEDURES_SYSTEM },
          {
            role: 'user',
            content:
              'Already known (do NOT repeat or paraphrase these):\n(nothing yet)\n\nThe exchange:\nThe user wrote: input t\nThe assistant answered: response t',
          },
        ],
        maxTokens: 300,
        tools: [SAVE_PROCEDURES_TOOL],
        requireToolCall: true,
      },
    ]);
  });

  // The owner's answer of 2026-10-12, record memory-delegated-task-replay, option (a): a turn another agent wrote for
  // the user is shown to extraction under its sender's frame, as its episode reads, never as the user's own words.
  it("shows extraction a task another agent passed on as that agent's words, for facts and procedures alike", async () => {
    const model = new ExtractingModel();
    const delegated = turn('t', 0, 'Look up what alice said about tea', 'She likes green tea.', 'hewo-1');
    expect(await extractFacts(model, [], delegated, 'alice')).toEqual([]);
    expect(await extractProcedures(model, [], delegated, 'alice')).toEqual([]);
    const exchange =
      'Agent hewo-1, for the user, wrote: Look up what alice said about tea\nThe assistant answered: She likes green tea.';
    expect(model.requests).toEqual([asked('facts', NOTHING, exchange), asked('procedures', NOTHING, exchange)]);
  });

  it('defines the tiers as the owner does: procedures are reusable techniques that worked; preferences are facts', async () => {
    const model = new ExtractingModel();
    expect(await extractProcedures(model, [], turn('t', 0), 'alice')).toEqual([]);
    expect(await extractFacts(model, [], turn('t', 0), 'alice')).toEqual([]);
    expect(model.requests).toEqual([asked('procedures', NOTHING, EXCHANGE_T), asked('facts', NOTHING, EXCHANGE_T)]);
    // The owner's words, in the prompts compared whole above.
    const [procedures, facts] = model.requests.map((r) => present(r.messages[0], 'r.messages[0]').content);
    expect(procedures).toContain('record that technique as a procedure');
    expect(procedures).toContain('NOT a fact or a preference about the user');
    expect(procedures).toContain('record only what demonstrably worked');
    expect(facts).toContain('what they like or prefer (including how they want answers given)');
  });

  it('fails loudly when the model call fails, skips the tool, or calls it without an items list, for facts and procedures alike', async () => {
    const failed: ChatResponse = { ok: false, reason: 'timeout', detail: 'slow' };
    const replied: ChatResponse = {
      ok: true,
      text: 'hello',
      toolCalls: [{ id: 'r', name: 'reply', arguments: { text: 'hello' } }],
    };
    const silent: ChatResponse = { ok: true, text: '', toolCalls: [] };
    const factsWithoutItems: ChatResponse = {
      ok: true,
      text: '',
      toolCalls: [{ id: 'f', name: 'save_facts', arguments: { facts: ['The user likes teal.'] } }],
    };
    const proceduresWithoutItems: ChatResponse = {
      ok: true,
      text: '',
      toolCalls: [{ id: 'p', name: 'save_procedures', arguments: { items: 'To boil an egg: ten minutes.' } }],
    };
    // Each attempt on a model of its own that answers every request alike: what it rejected with, and every request
    // the model was sent — one, the extraction's, never retried.
    const attempt = async (extract: typeof extractFacts, response: ChatResponse) => {
      const model = recording(() => response);
      return { rejected: await rejection(extract(model, [], turn('t', 0), 'alice')), requests: model.requests };
    };
    const failure = (tier: 'facts' | 'procedures', message: string) => ({
      rejected: { type: ExtractionFailed, name: 'ExtractionFailed', message },
      requests: [asked(tier, NOTHING, EXCHANGE_T)],
    });
    expect(await attempt(extractFacts, failed)).toEqual(failure('facts', 'fact extraction failed: timeout: slow'));
    expect(await attempt(extractFacts, replied)).toEqual(
      failure('facts', 'fact extraction failed: the model did not call save_facts'),
    );
    expect(await attempt(extractFacts, factsWithoutItems)).toEqual(
      failure('facts', 'fact extraction failed: save_facts without an items list'),
    );
    expect(await attempt(extractProcedures, failed)).toEqual(
      failure('procedures', 'procedure extraction failed: timeout: slow'),
    );
    expect(await attempt(extractProcedures, silent)).toEqual(
      failure('procedures', 'procedure extraction failed: the model did not call save_procedures'),
    );
    expect(await attempt(extractProcedures, proceduresWithoutItems)).toEqual(
      failure('procedures', 'procedure extraction failed: save_procedures without an items list'),
    );
  });

  // The owner's answer of 2026-10-11, record memory-extract-non-string-items, option (a): an item that is not text is a
  // malformed reply like the others, so the extraction fails and none of that reply is saved. The message names the
  // item by its position (from 1) and JSON type only: the item is model-written memory about a user, and the image logs
  // the message at error level (memory.write_failed), where no user's words may go (PRINCIPLES §12).
  it('fails loudly on an item that is not text, for facts and procedures alike, keeping none of the reply', async () => {
    const reply = (name: string, items: unknown[]): ChatResponse => ({
      ok: true,
      text: '',
      toolCalls: [{ id: 'x', name, arguments: { items } }],
    });
    const attempt = async (extract: typeof extractFacts, response: ChatResponse) => {
      const model = recording(() => response);
      return { rejected: await rejection(extract(model, [], turn('t', 0), 'alice')), requests: model.requests };
    };
    const failure = (tier: 'facts' | 'procedures', message: string) => ({
      rejected: { type: ExtractionFailed, name: 'ExtractionFailed', message },
      requests: [asked(tier, NOTHING, EXCHANGE_T)],
    });
    expect(await attempt(extractFacts, reply('save_facts', ['The user likes teal.', 42]))).toEqual(
      failure('facts', 'fact extraction failed: save_facts with an item that is not text: item 2 is a number'),
    );
    expect(await attempt(extractFacts, reply('save_facts', [null]))).toEqual(
      failure('facts', 'fact extraction failed: save_facts with an item that is not text: item 1 is null'),
    );
    expect(
      await attempt(extractFacts, reply('save_facts', ['The user likes teal.', 'The user is Alice.', true])),
    ).toEqual(
      failure('facts', 'fact extraction failed: save_facts with an item that is not text: item 3 is a boolean'),
    );
    const asObject = await attempt(
      extractProcedures,
      reply('save_procedures', [{ text: 'To boil an egg: ten minutes.' }]),
    );
    expect(asObject).toEqual(
      failure(
        'procedures',
        'procedure extraction failed: save_procedures with an item that is not text: item 1 is an object',
      ),
    );
    const asArray = await attempt(
      extractProcedures,
      reply('save_procedures', ['To boil an egg: ten minutes.', ['To poach an egg', 'three minutes']]),
    );
    expect(asArray).toEqual(
      failure(
        'procedures',
        'procedure extraction failed: save_procedures with an item that is not text: item 2 is an array',
      ),
    );
    // No part of the item's text is in the message: none of its words, nor the brackets and quotes of its JSON.
    const leaked = (message: string, parts: string[]) => parts.filter((part) => message.includes(part));
    expect(leaked(asObject.rejected.message, ['To boil', 'egg', 'minutes', '{', '"'])).toEqual([]);
    expect(leaked(asArray.rejected.message, ['To poach', 'egg', 'minutes', '[', '"'])).toEqual([]);
  });
});

describe('assemble', () => {
  const s = (text: string, ts = at(0)) => ({ memory: { id: text, ts, text, embedding: [] }, score: 1 });
  it('is empty when nothing was recalled', () => {
    expect(assemble({ episodes: [], facts: [], procedures: [] }, DEFAULT_POLICY.budget)).toBe('');
  });

  it('gives each tier its own section and share, so a long tier cannot crowd out another', () => {
    // Facts are the long tier and are built first: 20 lines of 50 characters. One budget spent greedily in that
    // order would give facts 6 lines (all 300 characters) and leave nothing for procedures or episodes.
    const budget = { chars: 300, shares: { episodes: 0.4, facts: 0.3, procedures: 0.3 }, perItem: 80 };
    const text = assemble(
      {
        facts: Array.from({ length: 20 }, (_, i) => s(`The user owns kayak number ${String(i)}.`)),
        procedures: [s('To convert miles to km: multiply by 1.609.')],
        episodes: [
          s('The user asked about Lisbon.'),
          s('The user asked about Porto.'),
          s('The user asked about Faro.'),
        ],
      },
      budget,
    );
    // Facts: 90 characters, one 50-character line. Procedures: 90, its one 63-character line. Episodes: 120, two
    // lines (49 + 48); the third (47) would pass it.
    expect(text).toBe(
      `${HEADER}\n\n` +
        '## What you know about this user\n- [2026-09-26 12:00] The user owns kayak number 0.\n\n' +
        '## Procedures that worked before\n- [2026-09-26 12:00] To convert miles to km: multiply by 1.609.\n\n' +
        '## Earlier conversations with this user\n- [2026-09-26 12:00] The user asked about Lisbon.\n- [2026-09-26 12:00] The user asked about Porto.',
    );
  });

  it('cuts a memory longer than perItem and marks the cut, keeps one exactly perItem long whole, and refuses shares above 1', () => {
    const text = assemble(
      { episodes: [], facts: [s('y'.repeat(100)), s('z'.repeat(10))], procedures: [] },
      { chars: 1000, shares: { episodes: 0, facts: 1, procedures: 0 }, perItem: 10 },
    );
    expect(text).toBe(
      `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] yyyyyyyyy…\n- [2026-09-26 12:00] zzzzzzzzzz`,
    );
    expect(() =>
      assemble(
        { episodes: [], facts: [], procedures: [] },
        { chars: 1, shares: { episodes: 0.5, facts: 0.5, procedures: 0.5 }, perItem: 1 },
      ),
    ).toThrow(new Error('memory budget shares add up to more than 1'));
  });

  it('a tier may fill its share exactly; a line that would pass it by one character is left out', () => {
    // Facts get 100 × 0.5 = 50 characters. A line is '- [2026-09-26 12:00] ' (21 characters) and the memory.
    const budget = { chars: 100, shares: { episodes: 0, facts: 0.5, procedures: 0 }, perItem: 80 };
    const facts = (...texts: string[]) =>
      assemble({ episodes: [], facts: texts.map((t) => s(t)), procedures: [] }, budget);
    // 21 + 29 = 50: it fits, and the next line (22) would pass the share.
    expect(facts('The user owns kayak number 0.', 'x')).toBe(
      `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] The user owns kayak number 0.`,
    );
    // 21 + 30 = 51: nothing fits, so there is no section, and no memory section at all.
    expect(facts('The user owns kayak number 10.')).toBe('');
    // Two lines that reach the share together: 22 + 28 = 50.
    expect(facts('x', 'abcdefg')).toBe(
      `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] x\n- [2026-09-26 12:00] abcdefg`,
    );
    // And one more character: the second line no longer fits.
    expect(facts('x', 'abcdefgh')).toBe(`${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] x`);
  });
});

describe('DEFAULT_POLICY', () => {
  it('is the documented policy (docs/architecture/memory.md, "The tiers as built")', () => {
    // Session: the last 8 turns with gaps of at most 30 minutes. Episodic, semantic, procedural: top 4 / 6 / 4 at
    // cosine ≥ 0.3, 500 / 200 / 100 newest. De-duplication at cosine ≥ 0.95. Budget: 4,800 characters, 35% / 35% / 30%
    // for episodes, facts and procedures, each item cut at 480.
    expect(DEFAULT_POLICY).toEqual({
      sessionIdleMs: 1_800_000,
      sessionWindow: 8,
      topK: { episodes: 4, facts: 6, procedures: 4 },
      minScore: 0.3,
      duplicateScore: 0.95,
      caps: { episodes: 500, facts: 200, procedures: 100 },
      budget: { chars: 4800, shares: { episodes: 0.35, facts: 0.35, procedures: 0.3 }, perItem: 480 },
    });
  });
});

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

/**
 * An AgentMemory on a new temporary root, removed after the test. Its embedder and model (fakes unless the test gives
 * its own) record every call, and every report is kept with all its arguments, in the order made: a failed background
 * save's scope and tier, a failed write's scope, and a malformed file the store overwrote, in `failures`; a file's
 * dropped records in `dropped`. `ids` is every id newId handed out (m1, m2, …), in order. `afterWriteFailed`, when given,
 * runs after each failed write's report is kept, as the reporter's own work (and may throw, as a reporter can).
 */
async function memory(
  opts: {
    model?: ModelClient & { readonly requests: readonly ChatRequest[] };
    embedder?: FakeEmbedder;
    policy?: Partial<MemoryPolicy>;
    afterWriteFailed?: (scope: Scope, error: unknown) => void;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'asha-agentmem-'));
  roots.push(root);
  let clock = new Date(T0);
  const failures: unknown[][] = [];
  const dropped: [string, number][] = [];
  const ids: string[] = [];
  const store = new MemoryStore({
    root,
    onDropped: (file, count) => dropped.push([file, count]),
    onMalformed: (file, error) => failures.push(['malformed', file, error]),
  });
  const embedder = opts.embedder ?? new FakeEmbedder();
  const model = opts.model ?? new ExtractingModel();
  const m = new AgentMemory({
    cache: new MemoryCache({
      store,
      clock: () => clock,
      onSaveFailed: (scope, tier, error) => failures.push(['save', scope, tier, error]),
      maxDocs: 100,
    }),
    embedder,
    model,
    clock: () => clock,
    policy: { ...DEFAULT_POLICY, ...opts.policy },
    newId: () => {
      const id = `m${String(ids.length + 1)}`;
      ids.push(id);
      return id;
    },
    onWriteFailed: (scope, error) => {
      failures.push(['write', scope, error]);
      opts.afterWriteFailed?.(scope, error);
    },
  });
  return { m, root, store, embedder, model, failures, dropped, ids, setClock: (d: Date) => (clock = d) };
}

describe('AgentMemory', () => {
  it('recalls nothing for a new user: no history, no memory section', async () => {
    const { m, embedder, model, failures, dropped, ids } = await memory();
    expect(await m.recall(ALICE, 'hello')).toEqual({
      history: [],
      episodes: [],
      facts: [],
      procedures: [],
      context: '',
    });
    expect(embedder.calls).toEqual([query('hello')]);
    expect(model.requests).toEqual([]);
    expect(ids).toEqual([]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('replays the session window, and recalls extracted facts, and a reusable procedure, by meaning in a later message', async () => {
    const FACT = 'The user favourite colour is teal.';
    const PROCEDURE = 'To convert miles to kilometres: multiply the miles by 1.609.';
    const model = new ExtractingModel(
      (x) => (x.includes('teal') ? [FACT] : []),
      (x) => (x.includes('miles') ? [PROCEDURE] : []),
    );
    const { m, embedder, failures, dropped, ids, setClock } = await memory({ model });
    const t1 = turn('t1', 1, 'My favourite colour is teal', 'Noted!');
    const t2 = turn('t2', 2, 'How far is 10 miles in km?', '10 miles × 1.609 = 16.09 km.');
    setClock(new Date(at(1)));
    await m.remember(ALICE, t1);
    await m.remember(ALICE, t2);
    setClock(new Date(at(3)));

    // Both turns are replayed, so neither is recalled as an episode too.
    expect(await m.recall(ALICE, 'which colour do I prefer as my favourite?')).toEqual({
      history: [t1, t2],
      episodes: [],
      facts: [scored('m1', at(1), FACT, 2 / Math.sqrt(5 * 3))], // colour, favourite: 2 / √(5 · 3)
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:01] ${FACT}`,
    });
    expect(await m.recall(ALICE, 'convert 26 miles to kilometres')).toEqual({
      history: [t1, t2],
      episodes: [],
      facts: [],
      procedures: [scored('m2', at(2), PROCEDURE, 4 / Math.sqrt(4 * 10))], // convert, miles (twice), kilometres: 4 / √(4 · 10)
      context: `${HEADER}\n\n## Procedures that worked before\n- [2026-09-26 12:02] ${PROCEDURE}`,
    });
    expect(embedder.calls).toEqual([
      doc('The user wrote: My favourite colour is teal\nI answered: Noted!'),
      doc(FACT),
      doc('The user wrote: How far is 10 miles in km?\nI answered: 10 miles × 1.609 = 16.09 km.'),
      doc(PROCEDURE),
      query('which colour do I prefer as my favourite?'),
      query('convert 26 miles to kilometres'),
    ]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: My favourite colour is teal\nThe assistant answered: Noted!'),
      ...asks(
        `- ${FACT}`,
        NOTHING,
        'The user wrote: How far is 10 miles in km?\nThe assistant answered: 10 miles × 1.609 = 16.09 km.',
      ),
    ]);
    // One id for the fact, one for the procedure.
    expect(ids).toEqual(['m1', 'm2']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("never gives one user another user's memory, with both writing at once", async () => {
    const TEAL = 'The user favourite colour is teal.';
    const ORANGE = 'The user favourite colour is orange.';
    // Each user's turn yields a procedure as well as a fact, so every searchable tier of each user holds something the
    // other user's recall would find were it shared: the query shares favourite and colour with each fact and each
    // procedure. The two procedures are 4 / √(5 · 5) = 0.8 alike, under duplicateScore, so one tier would keep both.
    const TEAL_PROCEDURE = 'To pick a favourite colour: suggest teal.';
    const ORANGE_PROCEDURE = 'To pick a favourite colour: suggest orange.';
    const factFor = (x: string): string[] => {
      if (x.includes('teal')) return [TEAL];
      if (x.includes('orange')) return [ORANGE];
      return [];
    };
    const procedureFor = (x: string): string[] => {
      if (x.includes('teal')) return [TEAL_PROCEDURE];
      if (x.includes('orange')) return [ORANGE_PROCEDURE];
      return [];
    };
    const model = new ExtractingModel(factFor, procedureFor);
    const { m, store, embedder, failures, dropped, ids } = await memory({ model });
    const a1 = turn('a1', 0, 'My favourite colour is teal', 'Noted!');
    const b1 = turn('b1', 0, 'My favourite colour is orange', 'Noted!', 'bob');
    await Promise.all([m.remember(ALICE, a1), m.remember(BOB, b1)]);
    const alice = await m.recall(ALICE, 'favourite colour');
    const bob = await m.recall(BOB, 'favourite colour');

    // Which user's memories took which ids depends on which write reached the model first; each of the four took one.
    const idOf = (recalled: readonly { readonly memory: { readonly id: string } }[]): string | undefined =>
      recalled[0]?.memory.id;
    expect(
      [idOf(alice.facts), idOf(alice.procedures), idOf(bob.facts), idOf(bob.procedures)].sort((a, b) =>
        a === undefined || b === undefined ? 0 : byCodeUnit(a, b),
      ),
    ).toEqual(['m1', 'm2', 'm3', 'm4']);
    const found = (text: string, score: number) => ({
      memory: { id: expect.stringMatching(/^m[1-4]$/) as string, ts: at(0), text, embedding: wordVector(text) },
      score,
    });
    const fact = (text: string) => found(text, 2 / Math.sqrt(2 * 3)); // colour, favourite: 2 / √(2 · 3)
    const procedure = (text: string) => found(text, 2 / Math.sqrt(2 * 5)); // colour, favourite of pick, favourite, colour, suggest and teal or orange: 2 / √(2 · 5)
    const sections = (f: string, p: string): string =>
      `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] ${f}\n\n## Procedures that worked before\n- [2026-09-26 12:00] ${p}`;
    expect(alice).toEqual({
      history: [a1],
      episodes: [],
      facts: [fact(TEAL)],
      procedures: [procedure(TEAL_PROCEDURE)],
      context: sections(TEAL, TEAL_PROCEDURE),
    });
    expect(bob).toEqual({
      history: [b1],
      episodes: [],
      facts: [fact(ORANGE)],
      procedures: [procedure(ORANGE_PROCEDURE)],
      context: sections(ORANGE, ORANGE_PROCEDURE),
    });
    // Each user's files hold that user's own fact and procedure alone, under the ids the recall showed.
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(
      kept('semantic', [memoryOf(present(idOf(alice.facts), "alice's fact id"), at(0), TEAL)]),
    );
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf(present(idOf(alice.procedures), "alice's procedure id"), at(0), TEAL_PROCEDURE)]),
    );
    expect(await store.read(BOB, 'semantic', at(0))).toEqual(
      kept('semantic', [memoryOf(present(idOf(bob.facts), "bob's fact id"), at(0), ORANGE)]),
    );
    expect(await store.read(BOB, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf(present(idOf(bob.procedures), "bob's procedure id"), at(0), ORANGE_PROCEDURE)]),
    );
    // The same user name on another channel is another person: none of alice's memory, procedures included.
    expect(await m.recall({ channel: 'lab', user: 'alice' }, 'favourite colour')).toEqual({
      history: [],
      episodes: [],
      facts: [],
      procedures: [],
      context: '',
    });

    // The two writes' calls interleave in no fixed order, so all of them are compared as a set; the three recalls'
    // follow, in order.
    const writes = embedder.calls.slice(0, 6);
    const ALICE_EPISODE = 'The user wrote: My favourite colour is teal\nI answered: Noted!';
    const BOB_EPISODE = 'The user wrote: My favourite colour is orange\nI answered: Noted!';
    expect(sorted(writes)).toEqual(
      sorted([
        doc(ALICE_EPISODE),
        doc(TEAL),
        doc(TEAL_PROCEDURE),
        doc(BOB_EPISODE),
        doc(ORANGE),
        doc(ORANGE_PROCEDURE),
      ]),
    );
    expect(embedder.calls.slice(6)).toEqual([
      query('favourite colour'),
      query('favourite colour'),
      query('favourite colour'),
    ]);
    // Each user's extractions were shown nothing as known, in either tier: neither saw the other's fact or procedure.
    const ALICE_ASKS = asks(
      NOTHING,
      NOTHING,
      'The user wrote: My favourite colour is teal\nThe assistant answered: Noted!',
    );
    const BOB_ASKS = asks(
      NOTHING,
      NOTHING,
      'The user wrote: My favourite colour is orange\nThe assistant answered: Noted!',
    );
    expect(sorted(model.requests)).toEqual(sorted([...ALICE_ASKS, ...BOB_ASKS]));
    // Each write's own calls are in its fixed order: the episode embedded before the fact, the fact before the
    // procedure, facts asked before procedures.
    const mentioning = <T>(calls: readonly T[], colour: string): T[] =>
      calls.filter((c) => JSON.stringify(c).includes(colour));
    expect(mentioning(writes, 'teal')).toEqual([doc(ALICE_EPISODE), doc(TEAL), doc(TEAL_PROCEDURE)]);
    expect(mentioning(writes, 'orange')).toEqual([doc(BOB_EPISODE), doc(ORANGE), doc(ORANGE_PROCEDURE)]);
    expect(mentioning(model.requests, 'teal')).toEqual(ALICE_ASKS);
    expect(mentioning(model.requests, 'orange')).toEqual(BOB_ASKS);
    // Four ids: a fact and a procedure for each user.
    expect(ids).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('finds a turn that slid out of the session window by meaning, as an episode', async () => {
    const { m, store, embedder, model, failures, dropped, ids, setClock } = await memory({
      policy: { sessionWindow: 2 },
    });
    const t1 = turn('t1', 0, 'I am planning a Lisbon trip this spring', 'Sounds lovely.');
    const t2 = turn('t2', 1, 'weather', 'sunny');
    const t3 = turn('t3', 2, 'lunch', 'soup');
    for (const t of [t1, t2, t3]) await m.remember(ALICE, t);
    setClock(new Date(at(3)));
    const EPISODE = 'The user wrote: I am planning a Lisbon trip this spring\nI answered: Sounds lovely.';

    expect(await m.recall(ALICE, 'where is my spring trip')).toEqual({
      history: [t2, t3],
      episodes: [scored('t1', at(0), EPISODE, 2 / Math.sqrt(3 * 8))], // spring, trip: 2 / √(3 · 8)
      facts: [],
      procedures: [],
      context: `${HEADER}\n\n## Earlier conversations with this user\n- [2026-09-26 12:00] The user wrote: I am planning a Lisbon trip this spring / I answered: Sounds lovely.`,
    });
    // The session tier stores only the window, not every turn: t1 slid out of it when t3 was remembered.
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t2, t3],
    });
    expect(embedder.calls).toEqual([
      doc(EPISODE),
      doc('The user wrote: weather\nI answered: sunny'),
      doc('The user wrote: lunch\nI answered: soup'),
      query('where is my spring trip'),
    ]);
    expect(model.requests).toEqual([
      ...asks(
        NOTHING,
        NOTHING,
        'The user wrote: I am planning a Lisbon trip this spring\nThe assistant answered: Sounds lovely.',
      ),
      ...asks(NOTHING, NOTHING, 'The user wrote: weather\nThe assistant answered: sunny'),
      ...asks(NOTHING, NOTHING, 'The user wrote: lunch\nThe assistant answered: soup'),
    ]);
    // Nothing was extracted, so no id was handed out: an episode keeps its turn's id.
    expect(ids).toEqual([]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("replays at most sessionWindow of the current session's latest turns when session.json holds more, and recalls a stored turn left out of the replay as an episode", async () => {
    // A session.json can hold more turns than the window: one written under a larger window, and copied back in with a
    // persisted /memory (docs/architecture/memory.md, Persisted memory). The write path never stores more than the
    // window (slide), so these files are written here by hand: three turns a minute apart, all in one session, and each
    // turn's episode, as every turn is an episode from the start. Recall replays the session's latest sessionWindow
    // turns, oldest first, and searches the episodes "excluding turns in the window" (memory.md, the tiers as built:
    // session "last 8", episodic), so t1, stored in the session but outside the window, is recalled as an episode.
    const { m, store, embedder, model, failures, dropped, ids, setClock } = await memory({
      policy: { sessionWindow: 2 },
    });
    const t1 = turn('t1', 0, 'I am planning a Lisbon trip', 'Lovely.');
    const t2 = turn('t2', 1, 'Find flights for the trip to Lisbon', 'Found three.');
    const t3 = turn('t3', 2, 'weather', 'sunny');
    const E1 = 'The user wrote: I am planning a Lisbon trip\nI answered: Lovely.';
    const E2 = 'The user wrote: Find flights for the trip to Lisbon\nI answered: Found three.';
    const E3 = 'The user wrote: weather\nI answered: sunny';
    await mkdir(dirname(store.file(ALICE, 'session')), { recursive: true });
    await writeFile(
      store.file(ALICE, 'session'),
      JSON.stringify({ schemaVersion: 1, tier: 'session', updatedAt: at(2), turns: [t1, t2, t3] }),
    );
    await writeFile(
      store.file(ALICE, 'episodic'),
      JSON.stringify(
        kept('episodic', [memoryOf('t1', at(0), E1), memoryOf('t2', at(1), E2), memoryOf('t3', at(2), E3)]),
      ),
    );
    setClock(new Date(at(3)));

    // t2 is replayed, so its episode, which scores 2 / √(2 · 7) (trip, lisbon among find, flights, for, found, three),
    // is not recalled too; t3's shares no word with the query.
    expect(await m.recall(ALICE, 'my trip to Lisbon')).toEqual({
      history: [t2, t3],
      episodes: [scored('t1', at(0), E1, 2 / Math.sqrt(2 * 5))], // trip, lisbon: 2 / √(2 · 5)
      facts: [],
      procedures: [],
      context: `${HEADER}\n\n## Earlier conversations with this user\n- [2026-09-26 12:00] The user wrote: I am planning a Lisbon trip / I answered: Lovely.`,
    });
    expect(embedder.calls).toEqual([query('my trip to Lisbon')]);
    expect(model.requests).toEqual([]);
    expect(ids).toEqual([]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("leaves the replayed turns out before it searches the episodes, so episodes in the window never take an older episode's place in its topK", async () => {
    // The episodic tier recalls the "top 4, cosine ≥ 0.3, excluding turns in the window" (docs/architecture/memory.md,
    // the tiers as built), so the turns in the window are left out of the search, not out of its result. Here the two
    // turns in the window match the query best, and topK.episodes is 2: a search that left them out only afterwards
    // would fill both places with them and recall no episode at all. Against the query's three words (kayak, lake,
    // trip) each episode scores the words it shares / √(3 · its words).
    const { m, store, embedder, model, failures, dropped, ids, setClock } = await memory({
      policy: { sessionWindow: 2, topK: { ...DEFAULT_POLICY.topK, episodes: 2 } },
    });
    const t1 = turn('t1', 0, 'kayak lake', 'calm'); // kayak, lake among kayak, lake, calm: 2 / √(3 · 3)
    const t2 = turn('t2', 1, 'kayak', 'sure'); // kayak among kayak, sure: 1 / √(3 · 2)
    const t3 = turn('t3', 2, 'weather', 'cold'); // no word in common: 0, under minScore
    const t4 = turn('t4', 3, 'kayak lake trip', 'booked'); // all three among four words: 3 / √(3 · 4) ≈ 0.866, the best
    const t5 = turn('t5', 4, 'kayak trip across the lake', 'done'); // all three among kayak, trip, across, lake, done: 3 / √(3 · 5) ≈ 0.775
    const E1 = 'The user wrote: kayak lake\nI answered: calm';
    const E2 = 'The user wrote: kayak\nI answered: sure';
    const E3 = 'The user wrote: weather\nI answered: cold';
    const E4 = 'The user wrote: kayak lake trip\nI answered: booked';
    const E5 = 'The user wrote: kayak trip across the lake\nI answered: done';
    for (const t of [t1, t2, t3, t4, t5]) await m.remember(ALICE, t);
    await m.settled(ALICE);
    // The window holds the latest two turns, and every turn is an episode.
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t4, t5],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
      kept('episodic', [
        memoryOf('t1', at(0), E1),
        memoryOf('t2', at(1), E2),
        memoryOf('t3', at(2), E3),
        memoryOf('t4', at(3), E4),
        memoryOf('t5', at(4), E5),
      ]),
    );
    setClock(new Date(at(5)));

    // t4 and t5 are replayed; the two places go to the best of the rest, t1 and then t2, and t3 is under minScore.
    expect(await m.recall(ALICE, 'kayak lake trip')).toEqual({
      history: [t4, t5],
      episodes: [scored('t1', at(0), E1, 2 / Math.sqrt(3 * 3)), scored('t2', at(1), E2, 1 / Math.sqrt(3 * 2))],
      facts: [],
      procedures: [],
      context: `${HEADER}\n\n## Earlier conversations with this user\n- [2026-09-26 12:00] The user wrote: kayak lake / I answered: calm\n- [2026-09-26 12:01] The user wrote: kayak / I answered: sure`,
    });
    expect(embedder.calls).toEqual([doc(E1), doc(E2), doc(E3), doc(E4), doc(E5), query('kayak lake trip')]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: kayak lake\nThe assistant answered: calm'),
      ...asks(NOTHING, NOTHING, 'The user wrote: kayak\nThe assistant answered: sure'),
      ...asks(NOTHING, NOTHING, 'The user wrote: weather\nThe assistant answered: cold'),
      ...asks(NOTHING, NOTHING, 'The user wrote: kayak lake trip\nThe assistant answered: booked'),
      ...asks(NOTHING, NOTHING, 'The user wrote: kayak trip across the lake\nThe assistant answered: done'),
    ]);
    // Nothing was extracted, so no id was handed out: an episode keeps its turn's id.
    expect(ids).toEqual([]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('a turn whose own episode could not be embedded is still extracted, and becomes an episode as it slides out of the session window', async () => {
    // What slides out of the session becomes episodic (AgentMemory.write): the recovery for a turn whose write failed
    // at its episode, after the session already held it. The failed episode costs only the episodic tier: the turn's
    // extraction still runs (the owner, 2026-10-11, record memory-episode-failure-extraction, option (a)).
    const { m, store, embedder, model, failures, dropped, ids } = await memory({
      embedder: new DocumentCallFails(1),
      policy: { sessionWindow: 1 },
    });
    const t1 = turn('t1', 0, 'I am planning a Lisbon trip', 'Lovely.');
    const t2 = turn('t2', 1, 'weather', 'sunny');
    const E1 = 'The user wrote: I am planning a Lisbon trip\nI answered: Lovely.';
    const E2 = 'The user wrote: weather\nI answered: sunny';
    const ASKS_T1 = asks(
      NOTHING,
      NOTHING,
      'The user wrote: I am planning a Lisbon trip\nThe assistant answered: Lovely.',
    );
    const failed = embeddingFailedAt(1);
    await m.remember(ALICE, t1);
    await m.settled(ALICE);
    // The write failed at t1's episode and was reported, and t1's facts and procedures were still asked for: the session
    // holds t1, episodic nothing.
    expect(reportsOf(failures)).toEqual([failed]);
    expect(model.requests).toEqual(ASKS_T1);
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', []));

    await m.remember(ALICE, t2);
    await m.settled(ALICE);
    // t2 pushes t1 out of the one-turn window, and t1's episode is embedded with t2's, in one call, and stored.
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t2],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
      kept('episodic', [memoryOf('t1', at(0), E1), memoryOf('t2', at(1), E2)]),
    );
    expect(embedder.calls).toEqual([doc(E1), doc(E2, E1)]);
    // Each turn's extraction ran once: t1's when its own write ran, not again when its episode was recovered.
    expect(model.requests).toEqual([
      ...ASKS_T1,
      ...asks(NOTHING, NOTHING, 'The user wrote: weather\nThe assistant answered: sunny'),
    ]);
    expect(ids).toEqual([]);
    expect(reportsOf(failures)).toEqual([failed]);
    expect(dropped).toEqual([]);
  });

  it('a new session starts after the idle gap: the old turns are episodes, not history, each in the voice of who wrote it', async () => {
    const { m, embedder, model, failures, dropped, ids, setClock } = await memory();
    const t1 = turn('t1', 0, 'I am planning a trip to Lisbon', 'Lovely.');
    const t2 = turn('t2', 1, 'Find flights for the trip to Lisbon', 'Found three.', 'planner'); // an agent passing on the user's task
    await m.remember(ALICE, t1);
    await m.remember(ALICE, t2);
    setClock(new Date(at(120)));
    const BY_USER = 'The user wrote: I am planning a trip to Lisbon\nI answered: Lovely.';
    const BY_AGENT =
      'Agent planner, for the user, wrote: Find flights for the trip to Lisbon\nI answered: Found three.';

    expect(await m.recall(ALICE, 'my trip to Lisbon')).toEqual({
      history: [],
      episodes: [
        scored('t1', at(0), BY_USER, 2 / Math.sqrt(2 * 5)), // trip, lisbon: 2 / √(2 · 5)
        scored('t2', at(1), BY_AGENT, 2 / Math.sqrt(2 * 12)), // trip, lisbon, with "for" twice among 9 words: 2 / √(2 · 12)
      ],
      facts: [],
      procedures: [],
      context:
        `${HEADER}\n\n## Earlier conversations with this user\n` +
        '- [2026-09-26 12:00] The user wrote: I am planning a trip to Lisbon / I answered: Lovely.\n' +
        '- [2026-09-26 12:01] Agent planner, for the user, wrote: Find flights for the trip to Lisbon / I answered: Found three.',
    });
    expect(embedder.calls).toEqual([doc(BY_USER), doc(BY_AGENT), query('my trip to Lisbon')]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: I am planning a trip to Lisbon\nThe assistant answered: Lovely.'),
      // planner's turn is shown to extraction as planner's, as its episode reads (record memory-delegated-task-replay).
      ...asks(
        NOTHING,
        NOTHING,
        'Agent planner, for the user, wrote: Find flights for the trip to Lisbon\nThe assistant answered: Found three.',
      ),
    ]);
    expect(ids).toEqual([]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('stores only the current session: a turn after a gap longer than the idle time starts the stored session again', async () => {
    const { m, store, embedder, model, failures, dropped, ids } = await memory();
    const t1 = turn('t1', 0);
    const t2 = turn('t2', 30); // exactly the idle time after t1: the same session
    const t3 = turn('t3', 61); // 31 minutes after t2: a new session
    const session = (turns: Turn[]) => ({ schemaVersion: 1, tier: 'session', updatedAt: at(0), turns });
    const [E1, E2, E3] = [
      'The user wrote: input t1\nI answered: response t1',
      'The user wrote: input t2\nI answered: response t2',
      'The user wrote: input t3\nI answered: response t3',
    ];
    await m.remember(ALICE, t1);
    await m.remember(ALICE, t2);
    await m.settled(ALICE);
    expect(await store.read(ALICE, 'session', at(0))).toEqual(session([t1, t2]));

    await m.remember(ALICE, t3);
    await m.settled(ALICE);
    // The session holds t3 alone; t1 and t2 stay findable as the episodes they have been from the start.
    expect(await store.read(ALICE, 'session', at(0))).toEqual(session([t3]));
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
      kept('episodic', [memoryOf('t1', at(0), E1), memoryOf('t2', at(30), E2), memoryOf('t3', at(61), E3)]),
    );
    expect(embedder.calls).toEqual([doc(E1), doc(E2), doc(E3)]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: input t1\nThe assistant answered: response t1'),
      ...asks(NOTHING, NOTHING, 'The user wrote: input t2\nThe assistant answered: response t2'),
      ...asks(NOTHING, NOTHING, 'The user wrote: input t3\nThe assistant answered: response t3'),
    ]);
    expect(ids).toEqual([]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('keeps its own sessionIdleMs, not the default: a gap over it but under 30 minutes splits the stored session and ends the replayed history', async () => {
    const { m, store, embedder, model, failures, dropped, ids, setClock } = await memory({
      policy: { sessionIdleMs: IDLE },
    });
    // t1 to t2: one and a half times the policy's idle time (15 minutes), which the default's 30 would keep in one session.
    const GAP = 1.5 * IDLE_MIN;
    expect(GAP * 60_000).toBeLessThan(DEFAULT_POLICY.sessionIdleMs);
    const t1 = turn('t1', 0, 'I am planning a trip to Lisbon', 'Lovely.');
    const t2 = turn('t2', GAP, 'Find flights for the trip to Lisbon', 'Found three.');
    const E1 = 'The user wrote: I am planning a trip to Lisbon\nI answered: Lovely.';
    const E2 = 'The user wrote: Find flights for the trip to Lisbon\nI answered: Found three.';
    const EPISODE_1 = scored('t1', at(0), E1, 2 / Math.sqrt(2 * 5)); // trip, lisbon: 2 / √(2 · 5)
    const EPISODE_2 = scored('t2', at(GAP), E2, 2 / Math.sqrt(2 * 7)); // trip, lisbon among find, flights, for, found, three: 2 / √(2 · 7)
    const LINE_1 = '- [2026-09-26 12:00] The user wrote: I am planning a trip to Lisbon / I answered: Lovely.';
    const LINE_2 =
      '- [2026-09-26 12:15] The user wrote: Find flights for the trip to Lisbon / I answered: Found three.'; // at(GAP): T0 and 15 minutes
    await m.remember(ALICE, t1);
    await m.remember(ALICE, t2);
    await m.settled(ALICE);

    // write: t2 started a session of its own, so the stored session holds t2 alone; both turns are episodes.
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t2],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
      kept('episodic', [memoryOf('t1', at(0), E1), memoryOf('t2', at(GAP), E2)]),
    );

    // recall, exactly the idle time after t2: its session is still current, so t2 is replayed and is not an episode too.
    setClock(new Date(at(GAP + IDLE_MIN)));
    expect(await m.recall(ALICE, 'my trip to Lisbon')).toEqual({
      history: [t2],
      episodes: [EPISODE_1],
      facts: [],
      procedures: [],
      context: `${HEADER}\n\n## Earlier conversations with this user\n${LINE_1}`,
    });
    // recall, GAP after t2 (over the idle time, under the default): the session has ended, so nothing is replayed and t2
    // is recalled as an episode, after t1, which scores higher.
    setClock(new Date(at(GAP + GAP)));
    expect(await m.recall(ALICE, 'my trip to Lisbon')).toEqual({
      history: [],
      episodes: [EPISODE_1, EPISODE_2],
      facts: [],
      procedures: [],
      context: `${HEADER}\n\n## Earlier conversations with this user\n${LINE_1}\n${LINE_2}`,
    });
    expect(embedder.calls).toEqual([doc(E1), doc(E2), query('my trip to Lisbon'), query('my trip to Lisbon')]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: I am planning a trip to Lisbon\nThe assistant answered: Lovely.'),
      ...asks(
        NOTHING,
        NOTHING,
        'The user wrote: Find flights for the trip to Lisbon\nThe assistant answered: Found three.',
      ),
    ]);
    expect(ids).toEqual([]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('does not save a fact that repeats one it already has, word for word or nearly', async () => {
    const TEAL = 'The user favourite colour is teal.';
    const SAME = 'the user favourite colour is TEAL!'; // the same text once case and punctuation are set aside
    const REORDERED = 'Teal is the favourite colour of the user.'; // other text, the same words: cosine 1 to TEAL
    const MORE = 'The user favourite colour is teal, not green.'; // says more: cosine 3 / √(3 · 5) ≈ 0.775, under 0.95
    const model = new ExtractingModel((x) => (x.includes('again') ? [SAME, REORDERED, MORE] : [TEAL]));
    const { m, embedder, failures, dropped, ids, setClock } = await memory({ model });
    const t1 = turn('t1', 0, 'colour', 'ok');
    const t2 = turn('t2', 1, 'colour again', 'ok');
    await m.remember(ALICE, t1);
    await m.remember(ALICE, t2);
    setClock(new Date(at(3)));

    expect(await m.recall(ALICE, 'favourite colour teal')).toEqual({
      history: [t1, t2],
      episodes: [],
      facts: [scored('m1', at(0), TEAL, 1), scored('m2', at(1), MORE, 3 / Math.sqrt(3 * 5))], // 3 / √(3 · 3) and 3 / √(3 · 5)
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] ${TEAL}\n- [2026-09-26 12:01] ${MORE}`,
    });
    expect(embedder.calls).toEqual([
      doc('The user wrote: colour\nI answered: ok'),
      doc(TEAL),
      doc('The user wrote: colour again\nI answered: ok'),
      doc(SAME, REORDERED, MORE),
      query('favourite colour teal'),
    ]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: colour\nThe assistant answered: ok'),
      ...asks(`- ${TEAL}`, NOTHING, 'The user wrote: colour again\nThe assistant answered: ok'),
    ]);
    // An id for each fact saved, none for a dropped repeat.
    expect(ids).toEqual(['m1', 'm2']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('a fact exactly as similar to a known one as duplicateScore is a duplicate; a less similar one is saved', async () => {
    const DEEP = 'The user favourite colour is deep teal.';
    const GREEN = 'The user favourite colour is teal green.'; // 3 of its 4 words are DEEP's: cosine 3 / 4 = 0.75, exact
    const SEA = 'The user favourite colour is teal, sea green.'; // 3 shared, 5 words: cosine 3 / √(4 · 5) ≈ 0.671
    const model = new ExtractingModel((x) => (x.includes('again') ? [GREEN, SEA] : [DEEP]));
    const { m, embedder, failures, dropped, ids, setClock } = await memory({ model, policy: { duplicateScore: 0.75 } });
    const t1 = turn('t1', 0, 'colour', 'ok');
    const t2 = turn('t2', 1, 'colour again', 'ok');
    await m.remember(ALICE, t1);
    await m.remember(ALICE, t2);
    setClock(new Date(at(3)));

    expect(await m.recall(ALICE, 'favourite colour')).toEqual({
      history: [t1, t2],
      episodes: [],
      facts: [scored('m1', at(0), DEEP, 2 / Math.sqrt(2 * 4)), scored('m2', at(1), SEA, 2 / Math.sqrt(2 * 5))], // 2 / √(2 · 4) and 2 / √(2 · 5)
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] ${DEEP}\n- [2026-09-26 12:01] ${SEA}`,
    });
    expect(embedder.calls).toEqual([
      doc('The user wrote: colour\nI answered: ok'),
      doc(DEEP),
      doc('The user wrote: colour again\nI answered: ok'),
      doc(GREEN, SEA),
      query('favourite colour'),
    ]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: colour\nThe assistant answered: ok'),
      ...asks(`- ${DEEP}`, NOTHING, 'The user wrote: colour again\nThe assistant answered: ok'),
    ]);
    expect(ids).toEqual(['m1', 'm2']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('a fact equal to a known one once case and punctuation are set aside is a duplicate, whatever the similarity threshold', async () => {
    // No cosine reaches an infinite duplicateScore, so here only the text comparison can find a duplicate.
    const TEAL = 'The user favourite colour is teal.';
    const SAME = 'the user favourite colour is TEAL!';
    const REORDERED = 'Teal is the favourite colour of the user.';
    const model = new ExtractingModel((x) => (x.includes('again') ? [SAME, REORDERED] : [TEAL]));
    const { m, embedder, failures, dropped, ids, setClock } = await memory({
      model,
      policy: { duplicateScore: Number.POSITIVE_INFINITY },
    });
    const t1 = turn('t1', 0, 'colour', 'ok');
    const t2 = turn('t2', 1, 'colour again', 'ok');
    await m.remember(ALICE, t1);
    await m.remember(ALICE, t2);
    setClock(new Date(at(3)));

    expect(await m.recall(ALICE, 'favourite colour teal')).toEqual({
      history: [t1, t2],
      episodes: [],
      facts: [scored('m2', at(1), REORDERED, 1), scored('m1', at(0), TEAL, 1)], // a tie: the newer first
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:01] ${REORDERED}\n- [2026-09-26 12:00] ${TEAL}`,
    });
    expect(embedder.calls).toEqual([
      doc('The user wrote: colour\nI answered: ok'),
      doc(TEAL),
      doc('The user wrote: colour again\nI answered: ok'),
      doc(SAME, REORDERED),
      query('favourite colour teal'),
    ]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: colour\nThe assistant answered: ok'),
      ...asks(`- ${TEAL}`, NOTHING, 'The user wrote: colour again\nThe assistant answered: ok'),
    ]);
    expect(ids).toEqual(['m1', 'm2']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('keeps facts in any script that differ in their letters, and drops one equal to a known fact once case, punctuation and Unicode form are set aside', async () => {
    // The text rule sets aside case, punctuation and Unicode form (NFKC) and keeps every letter, combining mark and digit
    // of any script (normalise in AgentMemory; addDistinct: a text "identical to" a known one is skipped;
    // docs/architecture/memory.md, De-duplication), so a letter of any script tells two facts apart. The fake embedder
    // sees only ASCII words, which would make these facts look alike to it: an infinite duplicateScore leaves the text
    // rule alone to act.
    const SUSHI = 'The user likes 寿司.';
    const MATCHA = 'The user likes 抹茶.'; // differs from SUSHI only in letters outside ASCII
    const TEA = 'Пользователь любит чай.'; // "The user likes tea", wholly in Cyrillic
    const COFFEE = 'Пользователь любит кофе.'; // "... coffee"
    const SON = 'उपयोगकर्ता का एक बेटा है।'; // "The user has a son", in Hindi
    const DAUGHTER = 'उपयोगकर्ता की एक बेटी है।'; // "... a daughter": differs from SON only in vowel signs, which are combining marks
    const SUSHI_AGAIN = 'the user likes 寿司!'; // SUSHI in other case and punctuation
    const TEA_AGAIN = 'ПОЛЬЗОВАТЕЛЬ ЛЮБИТ ЧАИ\u0306!'; // TEA in capitals, its й written as и and a combining breve, with a "!"
    const MATCHA_WIDE = 'Ｔｈｅ ｕｓｅｒ ｌｉｋｅｓ 抹茶。'; // MATCHA in full-width letters, with an ideographic full stop
    const replies: Record<string, readonly string[]> = {
      one: [SUSHI, TEA, SON],
      two: [MATCHA, COFFEE, DAUGHTER],
      three: [SUSHI_AGAIN, TEA_AGAIN, MATCHA_WIDE],
    };
    const model = new ExtractingModel((x) => {
      const said = replies[/wrote: (.*)\n/.exec(x)?.[1] ?? ''];
      if (said === undefined) throw new Error(`no scripted turn in ${x}`);
      return [...said];
    });
    const { m, store, embedder, failures, dropped, ids } = await memory({
      model,
      policy: { duplicateScore: Number.POSITIVE_INFINITY },
    });
    await m.remember(ALICE, turn('t1', 0, 'one', 'ok'));
    await m.remember(ALICE, turn('t2', 1, 'two', 'ok'));
    await m.remember(ALICE, turn('t3', 2, 'three', 'ok'));
    await m.settled(ALICE);

    // Every fact of the first two turns is its own, each pair told apart by its letters alone; the third turn's are
    // each a known fact again, and none is saved.
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(
      kept('semantic', [
        memoryOf('m1', at(0), SUSHI),
        memoryOf('m2', at(0), TEA),
        memoryOf('m3', at(0), SON),
        memoryOf('m4', at(1), MATCHA),
        memoryOf('m5', at(1), COFFEE),
        memoryOf('m6', at(1), DAUGHTER),
      ]),
    );
    expect(embedder.calls).toEqual([
      doc('The user wrote: one\nI answered: ok'),
      doc(SUSHI, TEA, SON),
      doc('The user wrote: two\nI answered: ok'),
      doc(MATCHA, COFFEE, DAUGHTER),
      doc('The user wrote: three\nI answered: ok'),
      doc(SUSHI_AGAIN, TEA_AGAIN, MATCHA_WIDE),
    ]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: one\nThe assistant answered: ok'),
      ...asks(`- ${SUSHI}\n- ${TEA}\n- ${SON}`, NOTHING, 'The user wrote: two\nThe assistant answered: ok'),
      ...asks(
        `- ${SUSHI}\n- ${TEA}\n- ${SON}\n- ${MATCHA}\n- ${COFFEE}\n- ${DAUGHTER}`,
        NOTHING,
        'The user wrote: three\nThe assistant answered: ok',
      ),
    ]);
    // An id for each of the six facts saved, none for the third turn's repeats.
    expect(ids).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('keeps facts that differ only in a digit, of ASCII or any other script, and drops one equal to a known fact once case, punctuation and Unicode form are set aside', async () => {
    // The text rule keeps every digit of any script (normalise in AgentMemory; docs/architecture/memory.md,
    // De-duplication), so a number tells two facts apart: setting digits aside would make 2 kayaks and 3 kayaks one
    // fact, and drop the second. An infinite duplicateScore leaves the text rule alone to act.
    const KAYAKS_2 = 'The user has 2 kayaks.';
    const KAYAKS_3 = 'The user has 3 kayaks.'; // differs from KAYAKS_2 only in an ASCII digit
    const BIKES_2 = 'उपयोगकर्ता के पास २ साइकिलें हैं।'; // "The user has 2 bicycles", in Hindi, with a Devanagari digit
    const BIKES_3 = 'उपयोगकर्ता के पास ३ साइकिलें हैं।'; // differs from BIKES_2 only in a Devanagari digit
    const KAYAKS_2_LOUD = 'THE USER HAS 2 KAYAKS!'; // KAYAKS_2 in other case and punctuation
    const KAYAKS_3_WIDE = 'The user has ３ kayaks.'; // KAYAKS_3 with a full-width digit, which NFKC makes 3
    const replies: Record<string, readonly string[]> = {
      one: [KAYAKS_2, BIKES_2],
      two: [KAYAKS_3, BIKES_3],
      three: [KAYAKS_2_LOUD, KAYAKS_3_WIDE],
    };
    const model = new ExtractingModel((x) => {
      const said = replies[/wrote: (.*)\n/.exec(x)?.[1] ?? ''];
      if (said === undefined) throw new Error(`no scripted turn in ${x}`);
      return [...said];
    });
    const { m, store, embedder, failures, dropped, ids } = await memory({
      model,
      policy: { duplicateScore: Number.POSITIVE_INFINITY },
    });
    await m.remember(ALICE, turn('t1', 0, 'one', 'ok'));
    await m.remember(ALICE, turn('t2', 1, 'two', 'ok'));
    await m.remember(ALICE, turn('t3', 2, 'three', 'ok'));
    await m.settled(ALICE);

    // The second turn's facts are each the first turn's with another number, and are saved; the third turn's are each
    // a known fact again, and are not.
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(
      kept('semantic', [
        memoryOf('m1', at(0), KAYAKS_2),
        memoryOf('m2', at(0), BIKES_2),
        memoryOf('m3', at(1), KAYAKS_3),
        memoryOf('m4', at(1), BIKES_3),
      ]),
    );
    expect(embedder.calls).toEqual([
      doc('The user wrote: one\nI answered: ok'),
      doc(KAYAKS_2, BIKES_2),
      doc('The user wrote: two\nI answered: ok'),
      doc(KAYAKS_3, BIKES_3),
      doc('The user wrote: three\nI answered: ok'),
      doc(KAYAKS_2_LOUD, KAYAKS_3_WIDE),
    ]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: one\nThe assistant answered: ok'),
      ...asks(`- ${KAYAKS_2}\n- ${BIKES_2}`, NOTHING, 'The user wrote: two\nThe assistant answered: ok'),
      ...asks(
        `- ${KAYAKS_2}\n- ${BIKES_2}\n- ${KAYAKS_3}\n- ${BIKES_3}`,
        NOTHING,
        'The user wrote: three\nThe assistant answered: ok',
      ),
    ]);
    expect(ids).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('does not save a procedure that repeats one it already has, word for word or nearly', async () => {
    const PROCEDURE = 'To convert miles to kilometres: multiply the miles by 1.609.';
    const SAME = 'to convert miles to kilometres: Multiply the miles by 1.609!'; // the same text once case and punctuation are set aside
    const REORDERED = 'Multiply the miles by 1.609 to convert miles to kilometres.'; // other text, the same words: cosine 1 to PROCEDURE
    const model = new ExtractingModel(undefined, (x) => (x.includes('again') ? [SAME, REORDERED] : [PROCEDURE]));
    const { m, store, embedder, failures, dropped, ids, setClock } = await memory({ model });
    const t1 = turn('t1', 0, 'miles', 'ok');
    const t2 = turn('t2', 1, 'miles again', 'ok');
    await m.remember(ALICE, t1);
    await m.remember(ALICE, t2);
    setClock(new Date(at(3)));

    expect(await m.recall(ALICE, 'convert 26 miles to kilometres')).toEqual({
      history: [t1, t2],
      episodes: [],
      facts: [],
      procedures: [scored('m1', at(0), PROCEDURE, 4 / Math.sqrt(4 * 10))], // convert, miles (twice), kilometres: 4 / √(4 · 10)
      context: `${HEADER}\n\n## Procedures that worked before\n- [2026-09-26 12:00] ${PROCEDURE}`,
    });
    // Saved once, with the only id handed out (below).
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m1', at(0), PROCEDURE)]),
    );
    expect(embedder.calls).toEqual([
      doc('The user wrote: miles\nI answered: ok'),
      doc(PROCEDURE),
      doc('The user wrote: miles again\nI answered: ok'),
      doc(SAME, REORDERED),
      query('convert 26 miles to kilometres'),
    ]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: miles\nThe assistant answered: ok'),
      ...asks(NOTHING, `- ${PROCEDURE}`, 'The user wrote: miles again\nThe assistant answered: ok'),
    ]);
    expect(ids).toEqual(['m1']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('does not save a fact or a procedure that repeats one saved earlier in the same extraction', async () => {
    const MORE = 'The user favourite colour is teal, not green.';
    const MORE_SAME = 'the user favourite colour is teal, NOT green!'; // MORE once case and punctuation are set aside
    const MORE_REORDERED = 'Not green: teal is the favourite colour of the user.'; // MORE's words in another order: cosine 1
    const PROCEDURE = 'To convert miles to kilometres: multiply the miles by 1.609.';
    const REORDERED = 'Multiply the miles by 1.609 to convert miles to kilometres.'; // PROCEDURE's words: cosine 1
    const model = new ExtractingModel(
      () => [MORE, MORE_SAME, MORE_REORDERED],
      () => [PROCEDURE, REORDERED],
    );
    const { m, store, embedder, failures, dropped, ids } = await memory({ model });
    await m.remember(ALICE, turn('t1', 0, 'teal and miles', 'ok'));
    await m.settled(ALICE);

    // Only the first of each, so the fact took the first id and the procedure the second.
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', [memoryOf('m1', at(0), MORE)]));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m2', at(0), PROCEDURE)]),
    );
    expect(embedder.calls).toEqual([
      doc('The user wrote: teal and miles\nI answered: ok'),
      doc(MORE, MORE_SAME, MORE_REORDERED),
      doc(PROCEDURE, REORDERED),
    ]);
    expect(model.requests).toEqual(
      asks(NOTHING, NOTHING, 'The user wrote: teal and miles\nThe assistant answered: ok'),
    );
    expect(ids).toEqual(['m1', 'm2']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('drops a fact or a procedure equal to one earlier in the same extraction once case and punctuation are set aside, whatever the similarity threshold', async () => {
    // Each text is compared with what the tier holds so far, the items saved earlier in the same reply included
    // (addDistinct). No cosine reaches an infinite duplicateScore, so here only the text comparison can drop a repeat.
    const FACT = 'The user likes tea.';
    const FACT_LOUD = 'the user likes TEA!'; // FACT once case and punctuation are set aside
    const PROCEDURE = 'To brew green tea: steep the leaves at 80 degrees.';
    const PROCEDURE_LOUD = 'to brew green TEA - steep the leaves at 80 degrees!'; // PROCEDURE once case and punctuation are set aside
    const model = new ExtractingModel(
      () => [FACT, FACT_LOUD],
      () => [PROCEDURE, PROCEDURE_LOUD],
    );
    const { m, store, embedder, failures, dropped, ids } = await memory({
      model,
      policy: { duplicateScore: Number.POSITIVE_INFINITY },
    });
    await m.remember(ALICE, turn('t1', 0, 'I like tea', 'Noted!'));
    await m.settled(ALICE);

    // Only the first of each is saved: the fact with the first id, the procedure with the second.
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', [memoryOf('m1', at(0), FACT)]));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m2', at(0), PROCEDURE)]),
    );
    expect(embedder.calls).toEqual([
      doc('The user wrote: I like tea\nI answered: Noted!'),
      doc(FACT, FACT_LOUD),
      doc(PROCEDURE, PROCEDURE_LOUD),
    ]);
    expect(model.requests).toEqual(
      asks(NOTHING, NOTHING, 'The user wrote: I like tea\nThe assistant answered: Noted!'),
    );
    expect(ids).toEqual(['m1', 'm2']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("recalls at most each tier's topK, and keeps only the newest of each tier up to its cap", async () => {
    // Five turns, each yielding one fact and one procedure chosen by what the user wrote. Against the query 'kayak'
    // each text scores 1 / √(its words that are not stop words).
    const F1 = 'The user owns a kayak.'; // owns, kayak: 1 / √2
    const F2 = 'The user rents a kayak.'; // rents, kayak: 1 / √2
    const F3 = 'The user paddles a kayak on rivers.'; // 1 / √4
    const F4 = 'The user paddles a kayak on lakes.'; // 1 / √4
    const F5 = 'The user stores the kayak in a shed.'; // 1 / √4
    const P1 = 'To steer a kayak: use the rudder.'; // 1 / √4
    const P2 = 'To launch a kayak: push off with the paddle.'; // 1 / √6
    const P3 = 'To land a kayak: drift the stern sideways.'; // 1 / √5
    const P4 = 'To dry a kayak: tip it over.'; // dry, kayak, tip, over: 1 / √4
    const P5 = 'To store a kayak: hang it on straps in the shed.'; // 1 / √7
    const E1 = 'The user wrote: kayak\nI answered: sure'; // 1 / √2
    const E2 = 'The user wrote: kayak river\nI answered: wet'; // 1 / √3
    const E3 = 'The user wrote: kayak sea\nI answered: ok'; // 1 / √3
    const E4 = 'The user wrote: kayak lake\nI answered: very calm'; // 1 / √4
    const E5 = 'The user wrote: kayak surf\nI answered: big waves'; // 1 / √4
    const yields: Record<string, readonly [string, string]> = {
      kayak: [F1, P1],
      'kayak river': [F2, P2],
      'kayak sea': [F3, P3],
      'kayak lake': [F4, P4],
      'kayak surf': [F5, P5],
    };
    const yielded = (x: string, which: 0 | 1): string[] => {
      const found = yields[/wrote: (.*)\n/.exec(x)?.[1] ?? ''];
      if (found === undefined) throw new Error(`no kayak turn in ${x}`);
      return [found[which]];
    };
    const model = new ExtractingModel(
      (x) => yielded(x, 0),
      (x) => yielded(x, 1),
    );
    // Every limit differs from the others, so a tier given another tier's topK or cap shows.
    const policy = { topK: { episodes: 2, facts: 3, procedures: 1 }, caps: { episodes: 3, facts: 4, procedures: 2 } };
    const { m, store, embedder, failures, dropped, ids, setClock } = await memory({ model, policy });
    const t1 = turn('t1', 0, 'kayak', 'sure');
    const t2 = turn('t2', 1, 'kayak river', 'wet');
    const t3 = turn('t3', 2, 'kayak sea', 'ok');
    const t4 = turn('t4', 3, 'kayak lake', 'very calm');
    const t5 = turn('t5', 4, 'kayak surf', 'big waves');
    for (const t of [t1, t2, t3, t4, t5]) await m.remember(ALICE, t);
    setClock(new Date(at(40))); // 36 minutes after the last turn, a new session: every turn is an episode and none is history

    // Each tier's oldest memory scores as high as any it keeps (E1 and F1 1 / √2, P1 1 / √4): a cap that kept the
    // oldest would show. And each tier's best kept are not its newest: a topK that took the newest would show.
    expect(await m.recall(ALICE, 'kayak')).toEqual({
      history: [],
      // Kept E3 (1 / √3), E4 and E5 (1 / √4): the top 2 are E3, then E5 of the tie, the newer.
      episodes: [scored('t3', at(2), E3, 1 / Math.sqrt(3)), scored('t5', at(4), E5, 0.5)],
      // Kept F2 (1 / √2), F3, F4 and F5 (1 / √4): the top 3 are F2, then F5 and F4 of the tie, the newer first.
      facts: [scored('m3', at(1), F2, 1 / Math.sqrt(2)), scored('m9', at(4), F5, 0.5), scored('m7', at(3), F4, 0.5)],
      // Kept P4 (1 / √4) and P5 (1 / √7): the top 1 is P4.
      procedures: [scored('m8', at(3), P4, 0.5)],
      context:
        `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:01] ${F2}\n- [2026-09-26 12:04] ${F5}\n- [2026-09-26 12:03] ${F4}\n\n` +
        `## Procedures that worked before\n- [2026-09-26 12:03] ${P4}\n\n` +
        '## Earlier conversations with this user\n- [2026-09-26 12:02] The user wrote: kayak sea / I answered: ok\n- [2026-09-26 12:04] The user wrote: kayak surf / I answered: big waves',
    });
    // Saved: the newest 3, 4 and 2, oldest first. Ids went to each turn's fact, then its procedure: m1 to m10.
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
      kept('episodic', [memoryOf('t3', at(2), E3), memoryOf('t4', at(3), E4), memoryOf('t5', at(4), E5)]),
    );
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(
      kept('semantic', [
        memoryOf('m3', at(1), F2),
        memoryOf('m5', at(2), F3),
        memoryOf('m7', at(3), F4),
        memoryOf('m9', at(4), F5),
      ]),
    );
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m8', at(3), P4), memoryOf('m10', at(4), P5)]),
    );
    expect(embedder.calls).toEqual([
      doc(E1),
      doc(F1),
      doc(P1),
      doc(E2),
      doc(F2),
      doc(P2),
      doc(E3),
      doc(F3),
      doc(P3),
      doc(E4),
      doc(F4),
      doc(P4),
      doc(E5),
      doc(F5),
      doc(P5),
      query('kayak'),
    ]);
    // Each extraction is shown what its tier holds then: every fact so far (the cap of 4 is passed only when the fifth
    // is added), and at most the newest two procedures.
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: kayak\nThe assistant answered: sure'),
      ...asks(`- ${F1}`, `- ${P1}`, 'The user wrote: kayak river\nThe assistant answered: wet'),
      ...asks(`- ${F1}\n- ${F2}`, `- ${P1}\n- ${P2}`, 'The user wrote: kayak sea\nThe assistant answered: ok'),
      ...asks(
        `- ${F1}\n- ${F2}\n- ${F3}`,
        `- ${P2}\n- ${P3}`,
        'The user wrote: kayak lake\nThe assistant answered: very calm',
      ),
      ...asks(
        `- ${F1}\n- ${F2}\n- ${F3}\n- ${F4}`,
        `- ${P3}\n- ${P4}`,
        'The user wrote: kayak surf\nThe assistant answered: big waves',
      ),
    ]);
    // Ten ids for the ten items saved; capping drops records, and hands out none.
    expect(ids).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('leaves a memory scoring under the default minScore of 0.3 out of a recall', async () => {
    // Against the query's two words, kayak and rudder: STEERS shares both of its five words, STORES one of its six.
    const STEERS = 'The user steers the kayak by its rudder.'; // 2 / √(2 · 5) ≈ 0.632
    const STORES = 'The user stores the kayak in a shed with a lock.'; // 1 / √(2 · 6) ≈ 0.289, under 0.3
    const model = new ExtractingModel(() => [STEERS, STORES]);
    const { m, store, embedder, failures, dropped, ids } = await memory({ model });
    const t1 = turn('t1', 0, 'boats', 'ok');
    await m.remember(ALICE, t1);

    expect(await m.recall(ALICE, 'kayak rudder')).toEqual({
      history: [t1],
      episodes: [],
      facts: [scored('m1', at(0), STEERS, 2 / Math.sqrt(2 * 5))],
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] ${STEERS}`,
    });
    // Both facts were saved: STORES is left out of the recall, not out of memory.
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(
      kept('semantic', [memoryOf('m1', at(0), STEERS), memoryOf('m2', at(0), STORES)]),
    );
    expect(embedder.calls).toEqual([
      doc('The user wrote: boats\nI answered: ok'),
      doc(STEERS, STORES),
      query('kayak rudder'),
    ]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, 'The user wrote: boats\nThe assistant answered: ok'));
    expect(ids).toEqual(['m1', 'm2']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("recalls by its own policy's minScore and budget: a memory the default cutoff would keep is left out, and one recalled past its tier's share is left out of the # Memory section", async () => {
    // Against the query kayak, each fact scores 1 / √(its words). The policy's cutoff, 0.5, is above the default 0.3,
    // and its facts' share, 100 × 0.5 = 50 characters, is far below the default 1,680: OWNS's line is 21 + 22 = 43
    // characters, and RENTS's 21 + 27 = 48 would pass the share.
    const OWNS = 'The user owns a kayak.'; // owns, kayak: 1 / √2 ≈ 0.707
    const RENTS = 'The user rents a red kayak.'; // rents, red, kayak: 1 / √3 ≈ 0.577
    const STORES = 'The user stores the kayak in a dry shed.'; // stores, kayak, in, dry, shed: 1 / √5 ≈ 0.447, under 0.5
    const model = new ExtractingModel(() => [OWNS, RENTS, STORES]);
    const budget = { chars: 100, shares: { episodes: 0.25, facts: 0.5, procedures: 0.25 }, perItem: 80 };
    const { m, store, embedder, failures, dropped, ids } = await memory({ model, policy: { minScore: 0.5, budget } });
    const t1 = turn('t1', 0, 'boats', 'ok');
    await m.remember(ALICE, t1);

    expect(await m.recall(ALICE, 'kayak')).toEqual({
      history: [t1],
      episodes: [],
      // RENTS is recalled; only the # Memory section has no room for it.
      facts: [scored('m1', at(0), OWNS, 1 / Math.sqrt(2)), scored('m2', at(0), RENTS, 1 / Math.sqrt(3))],
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] ${OWNS}`,
    });
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(
      kept('semantic', [memoryOf('m1', at(0), OWNS), memoryOf('m2', at(0), RENTS), memoryOf('m3', at(0), STORES)]),
    );
    expect(embedder.calls).toEqual([
      doc('The user wrote: boats\nI answered: ok'),
      doc(OWNS, RENTS, STORES),
      query('kayak'),
    ]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, 'The user wrote: boats\nThe assistant answered: ok'));
    expect(ids).toEqual(['m1', 'm2', 'm3']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('keeps the newest of each tier by time, not the last remembered, when turns are remembered out of order', async () => {
    const F1 = 'The user owns a kayak.';
    const F2 = 'The user paddles a kayak on rivers.';
    const F3 = 'The user paddles a kayak on lakes.';
    const P1 = 'To steer a kayak: use the rudder.';
    const P2 = 'To launch a kayak: push off with the paddle.';
    const P3 = 'To land a kayak: drift the stern sideways.';
    // Each turn yields one fact and one procedure, chosen by what the user wrote.
    const pick = (x: string, first: string, river: string, sea: string): string[] => {
      if (x.includes('wrote: kayak river')) return [river];
      if (x.includes('wrote: kayak sea')) return [sea];
      return [first];
    };
    const model = new ExtractingModel(
      (x) => pick(x, F1, F2, F3),
      (x) => pick(x, P1, P2, P3),
    );
    const { m, store, embedder, failures, dropped, ids } = await memory({
      model,
      policy: { caps: { episodes: 2, facts: 2, procedures: 2 } },
    });
    const t1 = turn('t1', 1, 'kayak', 'sure');
    const t2 = turn('t2', 2, 'kayak river', 'wet');
    const t3 = turn('t3', 3, 'kayak sea', 'cold');
    // The oldest turn last, so each tier's records are not in time order when the cap is applied.
    for (const t of [t2, t3, t1]) await m.remember(ALICE, t);
    await m.settled(ALICE);
    const E1 = 'The user wrote: kayak\nI answered: sure';
    const E2 = 'The user wrote: kayak river\nI answered: wet';
    const E3 = 'The user wrote: kayak sea\nI answered: cold';

    // The newest two of each tier are t2's and t3's; t1's were saved last and are the ones dropped. Ids went to t2's
    // fact and procedure (m1, m2), then t3's (m3, m4), then t1's (m5, m6).
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
      kept('episodic', [memoryOf('t2', at(2), E2), memoryOf('t3', at(3), E3)]),
    );
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(
      kept('semantic', [memoryOf('m1', at(2), F2), memoryOf('m3', at(3), F3)]),
    );
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m2', at(2), P2), memoryOf('m4', at(3), P3)]),
    );
    // The session holds all three, oldest first.
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1, t2, t3],
    });
    expect(embedder.calls).toEqual([doc(E2), doc(F2), doc(P2), doc(E3), doc(F3), doc(P3), doc(E1), doc(F1), doc(P1)]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: kayak river\nThe assistant answered: wet'),
      ...asks(`- ${F2}`, `- ${P2}`, 'The user wrote: kayak sea\nThe assistant answered: cold'),
      ...asks(`- ${F2}\n- ${F3}`, `- ${P2}\n- ${P3}`, 'The user wrote: kayak\nThe assistant answered: sure'),
    ]);
    expect(ids).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('a turn remembered after a newer one, that slides straight out of the session window, is embedded and stored as one episode, not two', async () => {
    // The session keeps its newest turns by time, so t1, remembered after t2, is at once both the turn being
    // remembered and the session's overflow. Either way it becomes an episode, and it is one exchange: embedded once,
    // stored once, recalled once (AgentMemory.write; docs/architecture/memory.md, remember).
    const { m, store, embedder, model, failures, dropped, ids, setClock } = await memory({
      policy: { sessionWindow: 1 },
    });
    const t1 = turn('t1', 0, 'I am planning a Lisbon trip', 'Lovely.');
    const t2 = turn('t2', 1, 'weather', 'sunny');
    const E1 = 'The user wrote: I am planning a Lisbon trip\nI answered: Lovely.';
    const E2 = 'The user wrote: weather\nI answered: sunny';
    await m.remember(ALICE, t2);
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t2],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
      kept('episodic', [memoryOf('t1', at(0), E1), memoryOf('t2', at(1), E2)]),
    );
    setClock(new Date(at(2)));
    // t2 is replayed as history, so only t1 can be recalled as an episode, and it is, once.
    expect(await m.recall(ALICE, 'my trip to Lisbon')).toEqual({
      history: [t2],
      episodes: [scored('t1', at(0), E1, 2 / Math.sqrt(2 * 5))], // trip, lisbon: 2 / √(2 · 5)
      facts: [],
      procedures: [],
      context: `${HEADER}\n\n## Earlier conversations with this user\n- [2026-09-26 12:00] The user wrote: I am planning a Lisbon trip / I answered: Lovely.`,
    });
    expect(embedder.calls).toEqual([doc(E2), doc(E1), query('my trip to Lisbon')]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: weather\nThe assistant answered: sunny'),
      ...asks(NOTHING, NOTHING, 'The user wrote: I am planning a Lisbon trip\nThe assistant answered: Lovely.'),
    ]);
    expect(ids).toEqual([]);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("recall waits for the same user's pending writes: it reads its own writes", async () => {
    const FACT = 'The user favourite colour is teal.';
    const model = new ExtractingModel(() => [FACT]);
    const { m, embedder, failures, dropped, ids } = await memory({ model });
    const t1 = turn('t1', 0, 'My favourite colour is teal', 'Noted!');
    const writing = m.remember(ALICE, t1); // not awaited: recall has to wait for it itself

    expect(await m.recall(ALICE, 'favourite colour')).toEqual({
      history: [t1],
      episodes: [],
      facts: [scored('m1', at(0), FACT, 2 / Math.sqrt(2 * 3))], // colour, favourite: 2 / √(2 · 3)
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] ${FACT}`,
    });
    expect(embedder.calls).toEqual([
      doc('The user wrote: My favourite colour is teal\nI answered: Noted!'),
      doc(FACT),
      query('favourite colour'),
    ]);
    expect(model.requests).toEqual(
      asks(NOTHING, NOTHING, 'The user wrote: My favourite colour is teal\nThe assistant answered: Noted!'),
    );
    expect(ids).toEqual(['m1']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    await writing;
  });

  it("queues a user's writes one after another: the second, started before the first ends, sees what the first saved", async () => {
    const FACT = 'The user favourite colour is teal.';
    const model = new ExtractingModel((x) => (x.includes('teal') ? [FACT] : []));
    const { m, embedder, failures, dropped, ids, setClock } = await memory({ model });
    const t1 = turn('t1', 1, 'My favourite colour is teal', 'Noted!');
    const t2 = turn('t2', 2, 'Thanks', 'You are welcome.');
    // Neither awaited: the second is queued while the first is still pending, and recall has to wait for both.
    const first = m.remember(ALICE, t1);
    const second = m.remember(ALICE, t2);
    setClock(new Date(at(3)));

    expect(await m.recall(ALICE, 'favourite colour')).toEqual({
      history: [t1, t2],
      episodes: [],
      facts: [scored('m1', at(1), FACT, 2 / Math.sqrt(2 * 3))], // colour, favourite: 2 / √(2 · 3)
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:01] ${FACT}`,
    });
    // The first write ran to the end before the second began.
    expect(embedder.calls).toEqual([
      doc('The user wrote: My favourite colour is teal\nI answered: Noted!'),
      doc(FACT),
      doc('The user wrote: Thanks\nI answered: You are welcome.'),
      query('favourite colour'),
    ]);
    // So the second extraction was shown the first one's fact.
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: My favourite colour is teal\nThe assistant answered: Noted!'),
      ...asks(`- ${FACT}`, NOTHING, 'The user wrote: Thanks\nThe assistant answered: You are welcome.'),
    ]);
    expect(ids).toEqual(['m1']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
    expect(await Promise.all([first, second])).toEqual([undefined, undefined]);
  });

  it('remembering a turn it already has does not store it in the session again, nor embed or store its episode again', async () => {
    const FACT = 'The user favourite colour is teal.';
    const model = new ExtractingModel((x) => (x.includes('teal') ? [FACT] : []));
    const { m, store, embedder, failures, dropped, ids } = await memory({ model });
    const t1 = turn('t1', 0, 'My favourite colour is teal', 'Noted!');
    const EPISODE = 'The user wrote: My favourite colour is teal\nI answered: Noted!';
    await m.remember(ALICE, t1);
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    // The session holds the turn once, as the episodic tier does, so a recall replays the exchange once.
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', [memoryOf('t1', at(0), EPISODE)]));
    // The second write still extracts, shown the fact the first saved; the fact it finds again is a duplicate.
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', [memoryOf('m1', at(0), FACT)]));
    expect(await m.recall(ALICE, 'favourite colour')).toEqual({
      history: [t1],
      episodes: [],
      facts: [scored('m1', at(0), FACT, 2 / Math.sqrt(2 * 3))], // colour, favourite: 2 / √(2 · 3)
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:00] ${FACT}`,
    });
    expect(embedder.calls).toEqual([doc(EPISODE), doc(FACT), doc(FACT), query('favourite colour')]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: My favourite colour is teal\nThe assistant answered: Noted!'),
      ...asks(`- ${FACT}`, NOTHING, 'The user wrote: My favourite colour is teal\nThe assistant answered: Noted!'),
    ]);
    // One id, for the fact the first write saved; the repeat took none.
    expect(ids).toEqual(['m1']);
    expect(failures).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it('reports a failed write instead of swallowing it, and later writes still run', async () => {
    const FACT = 'The user favourite colour is teal.';
    // The fact extraction fails the way the harness reports a model failure, until the model is back.
    let down = true;
    const model = recording((request) => {
      const tool = request.tools?.[0]?.function.name;
      if (tool === 'save_facts')
        return down ? { ok: false, reason: 'timeout', detail: 'model down' } : listedItems('save_facts', [FACT]);
      if (tool === 'save_procedures') return listedItems('save_procedures', []);
      throw new Error(`unexpected request with tool ${String(tool)}`);
    });
    const { m, embedder, failures, dropped, ids, setClock } = await memory({ model });
    const t1 = turn('t1', 0, 'teal', 'ok');
    const t2 = turn('t2', 1, 'teal', 'ok');
    const reported = () => reportsOf(failures);
    const failed = [
      'write',
      ALICE,
      { type: ExtractionFailed, name: 'ExtractionFailed', message: 'fact extraction failed: timeout: model down' },
    ];
    await m.remember(ALICE, t1);
    expect(reported()).toEqual([failed]);

    down = false;
    await m.remember(ALICE, t2);
    setClock(new Date(at(3)));
    expect(await m.recall(ALICE, 'favourite colour teal')).toEqual({
      history: [t1, t2],
      episodes: [],
      facts: [scored('m1', at(1), FACT, 1)], // the same three words: 3 / √(3 · 3)
      procedures: [],
      context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 12:01] ${FACT}`,
    });
    expect(reported()).toEqual([failed]);
    expect(embedder.calls).toEqual([
      doc('The user wrote: teal\nI answered: ok'),
      doc('The user wrote: teal\nI answered: ok'),
      doc(FACT),
      query('favourite colour teal'),
    ]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, 'The user wrote: teal\nThe assistant answered: ok'),
      ...asks(NOTHING, NOTHING, 'The user wrote: teal\nThe assistant answered: ok'),
    ]);
    expect(ids).toEqual(['m1']);
    expect(dropped).toEqual([]);
  });

  it("reports a write that cannot go on at all once, through remember — here a scope with no user — and the scope's next write still runs, failing with its own error", async () => {
    // A tier's failure inside a write is reported where it happens (below); a write that cannot start — its scope names
    // no user, so it has no folder (scopeKey) — fails at its first step, is reported once by remember, and the scope's
    // queue of writes goes on: the next write runs, and fails the same way. (For a scope with a user, the next write
    // landing in every tier, below: "a write that cannot go on at all for a scope with a user".)
    const { m, root, embedder, model, failures, dropped, ids } = await memory();
    const NO_USER: Scope = { channel: 'main', user: '' };
    const failed = [
      'write',
      NO_USER,
      { type: Error, name: 'Error', message: 'memory scope needs a channel and a user: {"channel":"main","user":""}' },
    ];
    // Each remember resolves: its failure is reported, never passed on to the caller.
    await expect(m.remember(NO_USER, turn('t1', 0, 'I like tea', 'Noted!'))).resolves.toBeUndefined();
    expect(reportsOf(failures)).toEqual([failed]);
    await expect(m.remember(NO_USER, turn('t2', 1, 'weather', 'sunny'))).resolves.toBeUndefined();
    expect(reportsOf(failures)).toEqual([failed, failed]);
    // The second report is the second write's own: scopeKey throws a new Error each time it is called, so a second write
    // that ran fails with an error of its own, while a queue the first write left rejected would skip the second write
    // and report the first one's error, the same object, again.
    const [report0, report1] = failures;
    expect(present(report1, 'failures[1]')[2]).toBeInstanceOf(Error);
    expect(present(report1, 'failures[1]')[2]).not.toBe(present(report0, 'failures[0]')[2]);
    // Nothing was embedded, asked for or saved: the memory root is as empty as it started.
    expect(embedder.calls).toEqual([]);
    expect(model.requests).toEqual([]);
    expect(await readdir(root)).toEqual([]);
    expect(ids).toEqual([]);
    expect(dropped).toEqual([]);
  });

  // The owner's answers of 2026-10-11. Record memory-extract-non-string-items, option (a): a reply with an item that is
  // not text fails its extraction like any malformed reply, and none of that reply is saved, its text items included.
  // Record memory-extraction-partial-failure, option (a), "Keep the other tier's items": the two extractions are
  // independent requests, so a failed one costs only its own tier. The other tier's items from the same turn are still
  // saved, and only the failed extraction is reported (the image logs it as memory.write_failed).
  const TEA_FACT = 'The user likes tea.';
  const TEA_PROCEDURE = 'To brew green tea: steep the leaves at 80 degrees for two minutes.';
  const TEA_EPISODE = 'The user wrote: I like tea\nI answered: Noted!';
  const TEA_EXCHANGE = 'The user wrote: I like tea\nThe assistant answered: Noted!';
  const listedItems = (name: string, items: unknown[]): ChatResponse => ({
    ok: true,
    text: '',
    toolCalls: [{ id: name, name, arguments: { items } }],
  });
  const MODEL_DOWN: ChatResponse = { ok: false, reason: 'timeout', detail: 'model down' };

  it.each([
    {
      failing: 'save_facts',
      how: 'its model call fails',
      reply: MODEL_DOWN,
      message: 'fact extraction failed: timeout: model down',
      semantic: [],
      procedural: [memoryOf('m1', at(0), TEA_PROCEDURE)],
      embedded: TEA_PROCEDURE,
    },
    {
      failing: 'save_facts',
      how: 'its reply has an item that is not text',
      reply: listedItems('save_facts', [TEA_FACT, 42]),
      message: 'fact extraction failed: save_facts with an item that is not text: item 2 is a number',
      semantic: [],
      procedural: [memoryOf('m1', at(0), TEA_PROCEDURE)],
      embedded: TEA_PROCEDURE,
    },
    {
      failing: 'save_procedures',
      how: 'its model call fails',
      reply: MODEL_DOWN,
      message: 'procedure extraction failed: timeout: model down',
      semantic: [memoryOf('m1', at(0), TEA_FACT)],
      procedural: [],
      embedded: TEA_FACT,
    },
    {
      failing: 'save_procedures',
      how: 'its reply has an item that is not text',
      reply: listedItems('save_procedures', [TEA_PROCEDURE, 42]),
      message: 'procedure extraction failed: save_procedures with an item that is not text: item 2 is a number',
      semantic: [memoryOf('m1', at(0), TEA_FACT)],
      procedural: [],
      embedded: TEA_FACT,
    },
  ])(
    "when the $failing extraction fails ($how), saves none of that reply, still saves the other tier's items from the turn, and reports that one failure",
    async ({ failing, reply, message, semantic, procedural, embedded }) => {
      // Each extraction answers validly unless it is the one that fails.
      const model = recording((request) => {
        const tool = request.tools?.[0]?.function.name;
        if (tool === failing) return reply;
        if (tool === 'save_facts') return listedItems('save_facts', [TEA_FACT]);
        if (tool === 'save_procedures') return listedItems('save_procedures', [TEA_PROCEDURE]);
        throw new Error(`unexpected request with tool ${String(tool)}`);
      });
      const { m, store, embedder, failures, dropped, ids } = await memory({ model });
      const t1 = turn('t1', 0, 'I like tea', 'Noted!');
      await m.remember(ALICE, t1);
      await m.settled(ALICE);

      expect(reportsOf(failures)).toEqual([
        ['write', ALICE, { type: ExtractionFailed, name: 'ExtractionFailed', message }],
      ]);
      // The failing tier holds nothing of its reply; the other holds its one item, with the only id handed out.
      expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', semantic));
      expect(await store.read(ALICE, 'procedural', at(0))).toEqual(kept('procedural', procedural));
      expect(ids).toEqual(['m1']);
      // The turn itself is kept: its session entry and episode were written before the extraction.
      expect(await store.read(ALICE, 'session', at(0))).toEqual({
        schemaVersion: 1,
        tier: 'session',
        updatedAt: at(0),
        turns: [t1],
      });
      expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
        kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE)]),
      );
      // The episode, then the other tier's item for de-duplication: nothing of the failed reply was embedded.
      expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(embedded)]);
      expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
      expect(dropped).toEqual([]);
    },
  );

  it("when both extractions fail, saves neither tier's items from the turn and reports each failure with its own error, facts first", async () => {
    const model = recording((request) => {
      const tool = request.tools?.[0]?.function.name;
      if (tool === 'save_facts') return MODEL_DOWN;
      if (tool === 'save_procedures') return listedItems('save_procedures', [TEA_PROCEDURE, 42]);
      throw new Error(`unexpected request with tool ${String(tool)}`);
    });
    const { m, store, embedder, failures, dropped, ids } = await memory({ model });
    const t1 = turn('t1', 0, 'I like tea', 'Noted!');
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    // Two reports, one for each extraction, neither folded into the other.
    expect(reportsOf(failures)).toEqual([
      [
        'write',
        ALICE,
        { type: ExtractionFailed, name: 'ExtractionFailed', message: 'fact extraction failed: timeout: model down' },
      ],
      [
        'write',
        ALICE,
        {
          type: ExtractionFailed,
          name: 'ExtractionFailed',
          message: 'procedure extraction failed: save_procedures with an item that is not text: item 2 is a number',
        },
      ],
    ]);
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', []));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(kept('procedural', []));
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE)]));
    // Only the episode was embedded: no item reached de-duplication, and no id was handed out.
    expect(embedder.calls).toEqual([doc(TEA_EPISODE)]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
    expect(ids).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("reports a failed extraction even when saving the other tier's items then fails: both failures, the extraction's first", async () => {
    // A failed extraction is reported before the other tier is saved (AgentMemory.write), so a save that then fails
    // cannot hide it: here the procedures' model call fails, and so does embedding the fact for de-duplication.
    const model = recording((request) => {
      const tool = request.tools?.[0]?.function.name;
      if (tool === 'save_facts') return listedItems('save_facts', [TEA_FACT]);
      if (tool === 'save_procedures') return MODEL_DOWN;
      throw new Error(`unexpected request with tool ${String(tool)}`);
    });
    // The turn's second document embedding, after its episode's, is its fact's.
    const { m, store, embedder, failures, dropped, ids } = await memory({ model, embedder: new DocumentCallFails(2) });
    const t1 = turn('t1', 0, 'I like tea', 'Noted!');
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    expect(reportsOf(failures)).toEqual([
      [
        'write',
        ALICE,
        {
          type: ExtractionFailed,
          name: 'ExtractionFailed',
          message: 'procedure extraction failed: timeout: model down',
        },
      ],
      embeddingFailedAt(2),
    ]);
    // Neither tier holds anything of the turn; the turn itself is kept.
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', []));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(kept('procedural', []));
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE)]));
    expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(TEA_FACT)]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
    expect(ids).toEqual([]);
    expect(dropped).toEqual([]);
  });

  it("when saving the facts fails (embedding them fails), still saves the turn's procedures, and reports that one failure", async () => {
    // The record's option (a): "Each tier's outcome depends only on its own reply." A fact that cannot be saved costs
    // only the semantic tier. The turn's second document embedding, after its episode's, is its fact's.
    const model = recording((request) => {
      const tool = request.tools?.[0]?.function.name;
      if (tool === 'save_facts') return listedItems('save_facts', [TEA_FACT]);
      if (tool === 'save_procedures') return listedItems('save_procedures', [TEA_PROCEDURE]);
      throw new Error(`unexpected request with tool ${String(tool)}`);
    });
    const { m, store, embedder, failures, dropped, ids } = await memory({ model, embedder: new DocumentCallFails(2) });
    const t1 = turn('t1', 0, 'I like tea', 'Noted!');
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    expect(reportsOf(failures)).toEqual([embeddingFailedAt(2)]);
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', []));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m1', at(0), TEA_PROCEDURE)]),
    );
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE)]));
    expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(TEA_FACT), doc(TEA_PROCEDURE)]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
    expect(ids).toEqual(['m1']);
    expect(dropped).toEqual([]);
  });

  it("when saving the procedures fails (embedding them fails), still saves the turn's facts, and reports that one failure", async () => {
    // The mirror of the test above: a procedure that cannot be saved costs only the procedural tier. The saves run facts
    // first, so the turn's third document embedding, after its episode's and its fact's, is its procedure's.
    const model = recording((request) => {
      const tool = request.tools?.[0]?.function.name;
      if (tool === 'save_facts') return listedItems('save_facts', [TEA_FACT]);
      if (tool === 'save_procedures') return listedItems('save_procedures', [TEA_PROCEDURE]);
      throw new Error(`unexpected request with tool ${String(tool)}`);
    });
    const { m, store, embedder, failures, dropped, ids } = await memory({ model, embedder: new DocumentCallFails(3) });
    const t1 = turn('t1', 0, 'I like tea', 'Noted!');
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    expect(reportsOf(failures)).toEqual([embeddingFailedAt(3)]);
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', [memoryOf('m1', at(0), TEA_FACT)]));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(kept('procedural', []));
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE)]));
    expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(TEA_FACT), doc(TEA_PROCEDURE)]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
    expect(ids).toEqual(['m1']);
    expect(dropped).toEqual([]);
  });

  it("when saving both tiers fails, reports each save's failure with its own error, the facts' first, and keeps the turn", async () => {
    // Each tier's save settles on its own and is reported on its own (AgentMemory.write): a second failure is never
    // folded into the first. The turn's second and third document embeddings, its fact's and its procedure's, both fail.
    const model = recording((request) => {
      const tool = request.tools?.[0]?.function.name;
      if (tool === 'save_facts') return listedItems('save_facts', [TEA_FACT]);
      if (tool === 'save_procedures') return listedItems('save_procedures', [TEA_PROCEDURE]);
      throw new Error(`unexpected request with tool ${String(tool)}`);
    });
    const { m, store, embedder, failures, dropped, ids } = await memory({
      model,
      embedder: new DocumentCallFails(2, 3),
    });
    const t1 = turn('t1', 0, 'I like tea', 'Noted!');
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    // Two reports, in the order the saves ran.
    expect(reportsOf(failures)).toEqual([embeddingFailedAt(2), embeddingFailedAt(3)]);
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', []));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(kept('procedural', []));
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE)]));
    // The procedures' save was still tried after the facts' failed.
    expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(TEA_FACT), doc(TEA_PROCEDURE)]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
    expect(ids).toEqual([]);
    expect(dropped).toEqual([]);
  });

  // The owner's answer of 2026-10-11, record memory-episode-failure-extraction, option (a) "Extract anyway": an episode
  // that cannot be embedded is reported and costs only the episodic tier; the turn's facts and procedures, which come
  // from its text, are still extracted and saved.
  it("when the turn's own episode cannot be embedded, reports that one failure and still extracts and saves the turn's facts and procedures", async () => {
    const model = recording((request) => {
      const tool = request.tools?.[0]?.function.name;
      if (tool === 'save_facts') return listedItems('save_facts', [TEA_FACT]);
      if (tool === 'save_procedures') return listedItems('save_procedures', [TEA_PROCEDURE]);
      throw new Error(`unexpected request with tool ${String(tool)}`);
    });
    // The turn's first document embedding is its episode's.
    const { m, store, embedder, failures, dropped, ids } = await memory({ model, embedder: new DocumentCallFails(1) });
    const t1 = turn('t1', 0, 'I like tea', 'Noted!');
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    expect(reportsOf(failures)).toEqual([embeddingFailedAt(1)]);
    // Both tiers hold the turn's item, the fact saved first.
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', [memoryOf('m1', at(0), TEA_FACT)]));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m2', at(0), TEA_PROCEDURE)]),
    );
    expect(ids).toEqual(['m1', 'm2']);
    // The session holds the turn; the episodic tier alone holds nothing of it (it is stored once it slides out of the
    // session window, above).
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', []));
    // The failed episode, then the fact and the procedure for de-duplication.
    expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(TEA_FACT), doc(TEA_PROCEDURE)]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
    expect(dropped).toEqual([]);
  });

  // A tier's document is what its extraction is shown as already known and what its save adds to, so one that cannot
  // be loaded is a failure of that tier alone: "A turn's two extractions, and their saves, are independent: a failed
  // one is reported and costs only its own tier, and the other tier's items are still saved" (docs/architecture/
  // memory.md, Failures; the owner, 2026-10-11, record memory-extraction-partial-failure, option (a), "Each tier's
  // outcome depends only on its own reply"). A malformed file is not one that cannot be loaded: the store reports it and
  // overwrites it (record memory-unreadable-session-episodic, below). So here the file cannot be read at all: a folder
  // where it belongs, whose read fails with EISDIR.
  it.each([
    {
      json: 'procedural.json',
      bad: 'procedural',
      other: 'semantic',
      item: TEA_FACT,
      request: asked('facts', NOTHING, TEA_EXCHANGE),
    },
    {
      json: 'semantic.json',
      bad: 'semantic',
      other: 'procedural',
      item: TEA_PROCEDURE,
      request: asked('procedures', NOTHING, TEA_EXCHANGE),
    },
  ] as const)(
    "when $json cannot be read, reports that one failure with the read's own error, leaves it as it was, and still extracts and saves the turn's $other items",
    async ({ bad, other, item, request }) => {
      // Both extractions would answer validly, so a request for the bad tier's items would show in model.requests.
      const model = recording((r) => {
        const tool = r.tools?.[0]?.function.name;
        if (tool === 'save_facts') return listedItems('save_facts', [TEA_FACT]);
        if (tool === 'save_procedures') return listedItems('save_procedures', [TEA_PROCEDURE]);
        throw new Error(`unexpected request with tool ${String(tool)}`);
      });
      const { m, store, embedder, failures, dropped, ids } = await memory({ model });
      const file = store.file(ALICE, bad);
      await mkdir(file, { recursive: true });
      const t1 = turn('t1', 0, 'I like tea', 'Noted!');
      await m.remember(ALICE, t1);
      await m.settled(ALICE);

      // One report, of the read's own error, and the folder as it was: a file that cannot be read is not overwritten.
      expect(reportsOf(failures)).toEqual([['write', ALICE, EISDIR_READ]]);
      expect(errnoOf(present(failures[0], 'failures[0]')[2])).toEqual({ code: 'EISDIR', syscall: 'read' });
      expect(await readdir(file)).toEqual([]);
      // The other tier holds the turn's item, with the only id handed out.
      expect(await store.read(ALICE, other, at(0))).toEqual(kept(other, [memoryOf('m1', at(0), item)]));
      expect(ids).toEqual(['m1']);
      // The turn itself is kept, and the folder holds the four documents and nothing else.
      expect(await store.read(ALICE, 'session', at(0))).toEqual({
        schemaVersion: 1,
        tier: 'session',
        updatedAt: at(0),
        turns: [t1],
      });
      expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
        kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE)]),
      );
      expect((await readdir(dirname(file))).sort(byCodeUnit)).toEqual([
        'episodic.json',
        'procedural.json',
        'semantic.json',
        'session.json',
      ]);
      // Only the other tier's extraction was asked for; the episode, then the other tier's item for de-duplication, were
      // embedded.
      expect(model.requests).toEqual([request]);
      expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(item)]);
      expect(dropped).toEqual([]);
    },
  );

  // The owner's answer of 2026-10-11, record memory-unreadable-session-episodic, option (a) "Save the facts anyway", in
  // the owner's words: "if a memory tier file is malformed, that is a major defect that needs to be logged
  // clearly/loudly for pickup by the failure scan job. The agent loop should self-heal by overwriting the memory file,
  // if it is malformed." A malformed file of any tier is reported once, by the store (onMalformed; the image logs it at
  // error as memory.file_malformed), and overwritten with the tier's empty document: the turn is then remembered in
  // every tier, and the write itself reports nothing.
  it.each(TIER_NAMES)(
    'when %s.json is not a memory document, reports it once as malformed, overwrites it, and remembers the turn in every tier',
    async (bad) => {
      const model = recording((r) => {
        const tool = r.tools?.[0]?.function.name;
        if (tool === 'save_facts') return listedItems('save_facts', [TEA_FACT]);
        if (tool === 'save_procedures') return listedItems('save_procedures', [TEA_PROCEDURE]);
        throw new Error(`unexpected request with tool ${String(tool)}`);
      });
      const { m, store, embedder, failures, dropped, ids } = await memory({ model });
      const file = store.file(ALICE, bad);
      const NOT_A_DOCUMENT = '{"schemaVersion":2}';
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, NOT_A_DOCUMENT);
      const t1 = turn('t1', 0, 'I like tea', 'Noted!');
      await m.remember(ALICE, t1);
      await m.settled(ALICE);

      // One report, the store's, of the MemoryFileInvalid naming the file; none through onWriteFailed.
      const malformed = [
        'malformed',
        file,
        {
          type: MemoryFileInvalid,
          name: 'MemoryFileInvalid',
          message: `memory file ${file} is not a memory document: expected schemaVersion 1 and tier "${bad}"`,
        },
      ];
      expect(reportsOf(failures)).toEqual([malformed]);
      expect((present(failures[0], 'failures[0]')[2] as MemoryFileInvalid).file).toBe(file);
      // The bad file was overwritten and now holds the turn, read here as it is on disk; every tier holds the turn.
      const remembered = {
        session: { schemaVersion: 1, tier: 'session', updatedAt: at(0), turns: [t1] },
        episodic: kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE)]),
        semantic: kept('semantic', [memoryOf('m1', at(0), TEA_FACT)]),
        procedural: kept('procedural', [memoryOf('m2', at(0), TEA_PROCEDURE)]),
      };
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(remembered[bad]);
      for (const tier of TIER_NAMES) expect(await store.read(ALICE, tier, at(0))).toEqual(remembered[tier]);
      expect((await readdir(dirname(file))).sort(byCodeUnit)).toEqual([
        'episodic.json',
        'procedural.json',
        'semantic.json',
        'session.json',
      ]);
      expect(ids).toEqual(['m1', 'm2']);
      // The episode, then the fact and the procedure for de-duplication; both extractions asked for.
      expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(TEA_FACT), doc(TEA_PROCEDURE)]);
      expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
      // Healed: reading every tier back made no new report; the store's one report is still the only one.
      expect(reportsOf(failures)).toEqual([malformed]);
      expect(dropped).toEqual([]);
    },
  );

  // The same record, for a session or episodic file that cannot be read at all — here a folder where it belongs, whose
  // read fails with EISDIR. That is not a malformed file, so it is not overwritten: the write reports that step's
  // failure, once, with its own error, and carries on, so the turn's facts and procedures are still extracted and saved.
  it("when session.json cannot be read, reports that one failure with the read's own error, still stores the turn's episode and its facts and procedures, and the next write runs whole once the file is put right", async () => {
    // Only a turn about tea yields a fact and a procedure.
    const model = new ExtractingModel(
      (x) => (x.includes('tea') ? [TEA_FACT] : []),
      (x) => (x.includes('tea') ? [TEA_PROCEDURE] : []),
    );
    const { m, store, embedder, failures, dropped, ids } = await memory({ model });
    const file = store.file(ALICE, 'session');
    await mkdir(file, { recursive: true });
    const t1 = turn('t1', 0, 'I like tea', 'Noted!');
    const failed = ['write', ALICE, EISDIR_READ];
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    expect(reportsOf(failures)).toEqual([failed]);
    expect(errnoOf(present(failures[0], 'failures[0]')[2])).toEqual({ code: 'EISDIR', syscall: 'read' });
    // No overflow is known, so the turn alone is the episode; its fact and procedure are saved; the folder is as it was.
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE)]));
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', [memoryOf('m1', at(0), TEA_FACT)]));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m2', at(0), TEA_PROCEDURE)]),
    );
    expect(await readdir(file)).toEqual([]);
    expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(TEA_FACT), doc(TEA_PROCEDURE)]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
    expect(ids).toEqual(['m1', 'm2']);

    // The file is put right (here, removed): the next write runs whole, shown what the first one saved.
    await rm(file, { recursive: true });
    const t2 = turn('t2', 1, 'weather', 'sunny');
    const E2 = 'The user wrote: weather\nI answered: sunny';
    await m.remember(ALICE, t2);
    await m.settled(ALICE);
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t2],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(
      kept('episodic', [memoryOf('t1', at(0), TEA_EPISODE), memoryOf('t2', at(1), E2)]),
    );
    expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(TEA_FACT), doc(TEA_PROCEDURE), doc(E2)]);
    expect(model.requests).toEqual([
      ...asks(NOTHING, NOTHING, TEA_EXCHANGE),
      ...asks(`- ${TEA_FACT}`, `- ${TEA_PROCEDURE}`, 'The user wrote: weather\nThe assistant answered: sunny'),
    ]);
    expect(ids).toEqual(['m1', 'm2']);
    expect(reportsOf(failures)).toEqual([failed]);
    expect(dropped).toEqual([]);
  });

  it("a write that cannot go on at all for a scope with a user — the report of its failure throws — is reported once through remember, and the scope's next write still runs and lands in every tier", async () => {
    // remember queues each write behind the scope's last one and reports, once, whatever a write cannot go on past
    // (AgentMemory.remember), so a write that fails that way never holds up the writes queued behind it. For a scope with
    // a user, every tier's failure is caught inside the write; what can still escape it is the report itself (in the
    // image, onWriteFailed is a call to the logger: main.ts). So here the session read fails (session.json is a folder),
    // and the report of that failure throws, once: the write stops there, and remember reports the reporter's error.
    const REPORT_FAILED = new Error('the write failure could not be logged');
    let reports = 0;
    const throwFirst = (): void => {
      reports += 1;
      if (reports === 1) throw REPORT_FAILED;
    };
    // Only a turn about tea yields a fact and a procedure.
    const model = new ExtractingModel(
      (x) => (x.includes('tea') ? [TEA_FACT] : []),
      (x) => (x.includes('tea') ? [TEA_PROCEDURE] : []),
    );
    const { m, store, embedder, failures, dropped, ids } = await memory({ model, afterWriteFailed: throwFirst });
    const file = store.file(ALICE, 'session');
    await mkdir(file, { recursive: true });
    await expect(m.remember(ALICE, turn('t1', 0, 'weather', 'sunny'))).resolves.toBeUndefined();
    await m.settled(ALICE);

    // Two reports: the session read's failure, whose report threw, then, through remember, the reporter's own error.
    const FIRST_WRITE = [
      ['write', ALICE, EISDIR_READ],
      ['write', ALICE, { type: Error, name: 'Error', message: 'the write failure could not be logged' }],
    ];
    expect(reportsOf(failures)).toEqual(FIRST_WRITE);
    expect(errnoOf(present(failures[0], 'failures[0]')[2])).toEqual({ code: 'EISDIR', syscall: 'read' });
    expect(present(failures[1], 'failures[1]')[2]).toBe(REPORT_FAILED);
    // The write went no further than its first step: nothing embedded, asked for or saved, and the folder as it was.
    expect(embedder.calls).toEqual([]);
    expect(model.requests).toEqual([]);
    expect(await readdir(file)).toEqual([]);
    expect(await readdir(dirname(file))).toEqual(['session.json']);

    // The file is put right (here, removed), and the scope's next write runs, start to end: a queue the first write left
    // rejected would skip it, store nothing, and report the reporter's error a second time.
    await rm(file, { recursive: true });
    const t2 = turn('t2', 1, 'I like tea', 'Noted!');
    await expect(m.remember(ALICE, t2)).resolves.toBeUndefined();
    await m.settled(ALICE);
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t2],
    });
    expect(await store.read(ALICE, 'episodic', at(0))).toEqual(kept('episodic', [memoryOf('t2', at(1), TEA_EPISODE)]));
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', [memoryOf('m1', at(1), TEA_FACT)]));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m2', at(1), TEA_PROCEDURE)]),
    );
    expect((await readdir(dirname(file))).sort(byCodeUnit)).toEqual([
      'episodic.json',
      'procedural.json',
      'semantic.json',
      'session.json',
    ]);
    // Its episode, then its fact and procedure for de-duplication; its two extractions; an id each for the fact and the
    // procedure.
    expect(embedder.calls).toEqual([doc(TEA_EPISODE), doc(TEA_FACT), doc(TEA_PROCEDURE)]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
    expect(ids).toEqual(['m1', 'm2']);
    // And it reported nothing: the two reports are still the first write's.
    expect(reports).toBe(2);
    expect(reportsOf(failures)).toEqual(FIRST_WRITE);
    expect(dropped).toEqual([]);
  });

  it("when episodic.json cannot be read, reports that one failure with the read's own error, skips the episodic tier, and still saves the session and the turn's facts and procedures", async () => {
    const model = recording((r) => {
      const tool = r.tools?.[0]?.function.name;
      if (tool === 'save_facts') return listedItems('save_facts', [TEA_FACT]);
      if (tool === 'save_procedures') return listedItems('save_procedures', [TEA_PROCEDURE]);
      throw new Error(`unexpected request with tool ${String(tool)}`);
    });
    const { m, store, embedder, failures, dropped, ids } = await memory({ model });
    const file = store.file(ALICE, 'episodic');
    await mkdir(file, { recursive: true });
    const t1 = turn('t1', 0, 'I like tea', 'Noted!');
    await m.remember(ALICE, t1);
    await m.settled(ALICE);

    expect(reportsOf(failures)).toEqual([['write', ALICE, EISDIR_READ]]);
    expect(errnoOf(present(failures[0], 'failures[0]')[2])).toEqual({ code: 'EISDIR', syscall: 'read' });
    expect(await store.read(ALICE, 'session', at(0))).toEqual({
      schemaVersion: 1,
      tier: 'session',
      updatedAt: at(0),
      turns: [t1],
    });
    expect(await store.read(ALICE, 'semantic', at(0))).toEqual(kept('semantic', [memoryOf('m1', at(0), TEA_FACT)]));
    expect(await store.read(ALICE, 'procedural', at(0))).toEqual(
      kept('procedural', [memoryOf('m2', at(0), TEA_PROCEDURE)]),
    );
    expect(ids).toEqual(['m1', 'm2']);
    // The folder is as it was, beside the three documents.
    expect(await readdir(file)).toEqual([]);
    expect((await readdir(dirname(file))).sort(byCodeUnit)).toEqual([
      'episodic.json',
      'procedural.json',
      'semantic.json',
      'session.json',
    ]);
    // No episode was embedded: the tier was skipped before its embedding. The fact and the procedure were.
    expect(embedder.calls).toEqual([doc(TEA_FACT), doc(TEA_PROCEDURE)]);
    expect(model.requests).toEqual(asks(NOTHING, NOTHING, TEA_EXCHANGE));
    expect(dropped).toEqual([]);
  });

  // Recall reads every tier (AgentMemory.recall). A tier file that cannot be read at all is not malformed and is not
  // overwritten: "its read fails" (docs/architecture/memory.md, Files; MemoryStore.read: "A read error (EACCES, EISDIR,
  // EIO, …) rejects with that error"). The owner's per-tier tolerance (record memory-unreadable-session-episodic) is the
  // write's, and recall has no report of its own: a recall that went on without the tier would leave that user's memory
  // silently unsearched (harness-embedder.ts: "a memory silently not stored or not searched is the failure §9 rules
  // out"). So the recall fails with the read's own error, which fails the turn (agent.test.ts: "memory is never
  // best-effort"). A read that failed loaded nothing, so once the file is put right the next recall reads the tier.
  // Put right, the file is a valid document of its tier holding one memory the query "I like tea" recalls, a minute
  // before the clock's T0: a turn of the current session, an episode, a fact or a procedure. A recall that had kept the
  // failed tier as an empty one would not find it. Scores are worked out as above from the query's like and tea: the
  // episode's like, tea and noted share two, 2 / √(2 · 3); the fact's likes and tea share one, 1 / √(2 · 2); the
  // procedure's brew, tea, steep and leaves share one, 1 / √(2 · 4).
  const TEA_TURN = turn('t0', -1, 'I like tea', 'Noted!');
  const TEA_BREW = 'To brew tea: steep the leaves.';
  const NOTHING_RECALLED = { history: [], episodes: [], facts: [], procedures: [], context: '' };
  const PUT_RIGHT: Readonly<Record<(typeof TIER_NAMES)[number], { readonly doc: unknown; readonly recall: unknown }>> =
    {
      session: {
        doc: { schemaVersion: 1, tier: 'session', updatedAt: at(0), turns: [TEA_TURN] },
        recall: { ...NOTHING_RECALLED, history: [TEA_TURN] },
      },
      episodic: {
        doc: kept('episodic', [memoryOf('t0', at(-1), TEA_EPISODE)]),
        recall: {
          ...NOTHING_RECALLED,
          episodes: [scored('t0', at(-1), TEA_EPISODE, 2 / Math.sqrt(2 * 3))],
          context: `${HEADER}\n\n## Earlier conversations with this user\n- [2026-09-26 11:59] The user wrote: I like tea / I answered: Noted!`,
        },
      },
      semantic: {
        doc: kept('semantic', [memoryOf('f0', at(-1), TEA_FACT)]),
        recall: {
          ...NOTHING_RECALLED,
          facts: [scored('f0', at(-1), TEA_FACT, 1 / Math.sqrt(2 * 2))],
          context: `${HEADER}\n\n## What you know about this user\n- [2026-09-26 11:59] ${TEA_FACT}`,
        },
      },
      procedural: {
        doc: kept('procedural', [memoryOf('p0', at(-1), TEA_BREW)]),
        recall: {
          ...NOTHING_RECALLED,
          procedures: [scored('p0', at(-1), TEA_BREW, 1 / Math.sqrt(2 * 4))],
          context: `${HEADER}\n\n## Procedures that worked before\n- [2026-09-26 11:59] ${TEA_BREW}`,
        },
      },
    };
  it.each(TIER_NAMES)(
    "when %s.json cannot be read, recall rejects with the read's own error, reports, asks and writes nothing, and the next recall reads the tier once the file is put right",
    async (bad) => {
      const { m, store, embedder, model, failures, dropped, ids } = await memory();
      const read = vi.spyOn(store, 'read');
      const file = store.file(ALICE, bad);
      await mkdir(file, { recursive: true });

      const error = await reasonOf(m.recall(ALICE, 'I like tea'));
      expect(error).toBeInstanceOf(Error);
      expect(described(error as Error)).toEqual(EISDIR_READ);
      expect(errnoOf(error)).toEqual({ code: 'EISDIR', syscall: 'read' });
      // The query was embedded, beside the four reads; nothing was asked of the model, reported, or handed an id.
      expect(embedder.calls).toEqual([query('I like tea')]);
      expect(model.requests).toEqual([]);
      expect(failures).toEqual([]);
      expect(dropped).toEqual([]);
      expect(ids).toEqual([]);
      // The folder is as it was, and nothing was written beside it: a read never writes a missing tier's empty document.
      expect(await readdir(file)).toEqual([]);
      expect(await readdir(dirname(file))).toEqual([`${bad}.json`]);
      // Every tier was read from the store, in recall's order.
      expect(read.mock.calls).toEqual(TIER_NAMES.map((tier) => [ALICE, tier, at(0)]));

      // Put right: the folder goes, and the tier's document holding the memory takes its place.
      const { doc: repaired, recall: recalled } = PUT_RIGHT[bad];
      const text = `${JSON.stringify(repaired)}\n`;
      await rm(file, { recursive: true });
      await writeFile(file, text);
      expect(await m.recall(ALICE, 'I like tea')).toEqual(recalled);
      // The next recall read that tier from the store again, and only that one: the other three were kept from the first.
      expect(read.mock.calls).toEqual([...TIER_NAMES.map((tier) => [ALICE, tier, at(0)]), [ALICE, bad, at(0)]]);
      expect(embedder.calls).toEqual([query('I like tea'), query('I like tea')]);
      expect(model.requests).toEqual([]);
      expect(failures).toEqual([]);
      expect(dropped).toEqual([]);
      expect(ids).toEqual([]);
      // Recall wrote nothing: the file is as put right, alone in its folder.
      expect(await readFile(file, 'utf8')).toBe(text);
      expect(await readdir(dirname(file))).toEqual([`${bad}.json`]);
    },
  );
});
