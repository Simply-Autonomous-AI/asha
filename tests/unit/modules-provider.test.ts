// The gateway's provider path (docs/plans/extension-modules.md R18b, R19; A18, A19): src/daemon/modules/provider.ts
// with a fake host and a fake meter — the provider's container never llama.cpp's means: the request names
// `requireToolCall`, never a prefill; deltas pass on in order; the vendor's usage settles the meter.

import { describe, expect, it } from 'vitest';

import {
  providerChat,
  providerEmbed,
  providerReservation,
  type CallOutcome,
  type InstalledModule,
  type ProviderModelRef,
  type Reservation,
} from '../../src/daemon/modules/index.js';
import type { ChatRequest } from '../../src/shared/protocol.js';
import { present } from '../../src/shared/assert-present.js';
import { parseModuleManifest } from '../../src/shared/modules.js';
import { RecordingLogger } from '../helpers/fakes.js';
import { providerManifest, PROVIDER_MODEL } from '../helpers/modules.js';

const INSTALLED: InstalledModule = {
  manifest: parseModuleManifest(
    providerManifest({
      models: [
        PROVIDER_MODEL,
        { ...PROVIDER_MODEL, name: 'embed', kind: 'embedding', id: 'vendor.embed-v1', dimensions: 3, chat: undefined },
      ],
    }),
    'm',
    'fixture_provider',
  ),
  dir: '/m',
};
const MODEL = present(
  (INSTALLED.manifest as unknown as { models: ProviderModelRef['model'][] }).models[0],
  'models[0]',
);
const EMBED = present(
  (INSTALLED.manifest as unknown as { models: ProviderModelRef['model'][] }).models[1],
  'models[1]',
);
const REF: ProviderModelRef = {
  module: 'fixture_provider',
  installed: INSTALLED,
  model: MODEL,
  settings: { temperature: 0 },
};

function fakes(
  answer: (request: { tool: string; arguments: unknown; onDelta: (d: unknown) => void }) => Promise<CallOutcome>,
  reserve: 'ok' | 'budget' | 'corrupt' = 'ok',
) {
  const calls: { tool: string; arguments: unknown }[] = [];
  const reserved: number[] = [];
  const settled: (number | 'full')[] = [];
  const logger = new RecordingLogger();
  let t = 0;
  const props = {
    host: {
      provider: async (request: { tool: string; arguments: unknown; onDelta: (d: unknown) => void }) => {
        calls.push({ tool: request.tool, arguments: request.arguments });
        return answer(request);
      },
    } as never,
    meter: {
      reserve: (_m: string, _c: string, usd: number) => {
        reserved.push(usd);
        if (reserve === 'budget')
          return Promise.resolve({
            ok: false as const,
            reason: 'budget_exceeded' as const,
            cap: 'day' as const,
            limit: 2,
            spent: 2,
          });
        if (reserve === 'corrupt')
          return Promise.resolve({ ok: false as const, reason: 'budget_meter_unavailable' as const });
        return Promise.resolve({
          ok: true as const,
          reservation: {
            module: 'fixture_provider',
            conversation: 'c',
            usd,
            day: '2026-10-01',
            month: '2026-10',
          } satisfies Reservation,
        });
      },
      settle: (_r: Reservation, usd: number | 'full') => {
        settled.push(usd);
        return Promise.resolve();
      },
    },
    logger,
    ref: REF,
    channel: 'main',
    conversation: 'c',
    abandon: new AbortController().signal,
    now: () => (t += 10),
  };
  return { props, calls, reserved, settled, logger };
}

const REQUEST: ChatRequest = { messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 };
const TOOLS = [
  { type: 'function' as const, function: { name: 'search', description: 'Search.', parameters: { type: 'object' } } },
];

describe('providerChat (R19)', () => {
  it("sends the model's exact id, the messages, the bound and the settings — no prefill message — and passes deltas on in order", async () => {
    const f = fakes((r) => {
      r.onDelta({ part: 'text', text: 'he' });
      r.onDelta({ part: 'text', text: 'llo' });
      return Promise.resolve({
        ok: true,
        result: { text: 'hello', toolCalls: [] },
        usage: { inputTokens: 10, outputTokens: 2 },
      });
    });
    const deltas: unknown[] = [];
    const out = await providerChat(f.props, REQUEST, (d) => deltas.push(d));
    expect(f.calls).toEqual([
      {
        tool: 'chat',
        arguments: {
          model: 'vendor.small-model-v1',
          messages: REQUEST.messages,
          maxTokens: 100,
          settings: { temperature: 0 },
        },
      },
    ]);
    expect(deltas).toEqual([
      { part: 'text', text: 'he' },
      { part: 'text', text: 'llo' },
    ]);
    expect(out.response).toEqual({ ok: true, text: 'hello', toolCalls: [] });
    expect(out.stats).toEqual({ ttfcMs: 10, chunks: 2, promptTokens: 10, completionTokens: 2, cachedTokens: null });
  });

  it('names requireToolCall and the tools when a tool call is required, and answers truncated when none came', async () => {
    const f = fakes(() =>
      Promise.resolve({
        ok: true,
        result: { text: 'no', toolCalls: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    const out = await providerChat(f.props, { ...REQUEST, tools: TOOLS, requireToolCall: true }, () => undefined);
    expect(present(f.calls[0], 'f.calls[0]').arguments).toEqual({
      model: 'vendor.small-model-v1',
      messages: REQUEST.messages,
      maxTokens: 100,
      tools: TOOLS,
      requireToolCall: true,
      settings: { temperature: 0 },
    });
    expect(out.response).toEqual({
      ok: false,
      reason: 'truncated',
      detail: 'a tool call was required and the provider answered with none',
    });
  });

  it('reserves the worst case before the call and settles it to the vendor usage × the price', async () => {
    const f = fakes(() =>
      Promise.resolve({
        ok: true,
        result: { text: 'x', toolCalls: [] },
        usage: { inputTokens: 1_000_000, outputTokens: 2_000_000 },
      }),
    );
    await providerChat(f.props, REQUEST, () => undefined);
    expect(f.reserved).toEqual([providerReservation(REF, REQUEST)]);
    expect(providerReservation(REF, REQUEST)).toBeCloseTo(
      (Buffer.byteLength(JSON.stringify(REQUEST.messages)) * 0.15 + 100 * 0.15) / 1_000_000,
      12,
    );
    expect(f.settled).toEqual([0.45]);
  });

  it('charges the whole reservation, logged module.failed, when the vendor reports no usage, and when the call fails', async () => {
    const none = fakes(() => Promise.resolve({ ok: true, result: { text: 'x', toolCalls: [] } }));
    await providerChat(none.props, REQUEST, () => undefined);
    expect(none.settled).toEqual(['full']);
    expect(none.logger.entries.map((e) => [e.event, e.fields['reason']])).toEqual([['module.failed', 'no_usage']]);
    const failed = fakes(() => Promise.resolve({ ok: false, reason: 'timeout', detail: 'no chunk within 22000 ms' }));
    const out = await providerChat(failed.props, REQUEST, () => undefined);
    expect(out.response).toEqual({ ok: false, reason: 'timeout', detail: 'no chunk within 22000 ms' });
    expect(failed.settled).toEqual(['full']);
  });

  it('answers budget_exceeded and budget_meter_unavailable as ModelFailureReasons, calling no provider', async () => {
    const over = fakes(() => Promise.resolve({ ok: true, result: {} }), 'budget');
    expect((await providerChat(over.props, REQUEST, () => undefined)).response).toEqual({
      ok: false,
      reason: 'budget_exceeded',
      detail: 'the day cap of 2 USD would be passed (2 USD spent)',
    });
    const corrupt = fakes(() => Promise.resolve({ ok: true, result: {} }), 'corrupt');
    expect((await providerChat(corrupt.props, REQUEST, () => undefined)).response).toEqual({
      ok: false,
      reason: 'budget_meter_unavailable',
      detail: 'metering.json does not parse',
    });
    expect([...over.calls, ...corrupt.calls]).toEqual([]);
  });

  it('logs a delta that is not a model-streaming piece and passes it on no further; answers bad_response for a result without {text, toolCalls}', async () => {
    const f = fakes((r) => {
      r.onDelta({ part: 'image', data: 'x' });
      return Promise.resolve({ ok: true, result: { text: 'x' }, usage: { inputTokens: 1, outputTokens: 1 } });
    });
    const deltas: unknown[] = [];
    const out = await providerChat(f.props, REQUEST, (d) => deltas.push(d));
    expect(deltas).toEqual([]);
    expect(f.logger.entries.map((e) => e.fields['reason'])).toEqual(['bad_delta']);
    expect(out.response).toEqual({
      ok: false,
      reason: 'bad_response',
      detail: 'the provider answered with no {text, toolCalls}',
    });
  });

  it("passes a provider's tool calls through when each has an id, a name and an object of arguments", async () => {
    const f = fakes(() =>
      Promise.resolve({
        ok: true,
        result: { text: '', toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'x' } }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    expect(
      (await providerChat(f.props, { ...REQUEST, tools: TOOLS, requireToolCall: true }, () => undefined)).response,
    ).toEqual({ ok: true, text: '', toolCalls: [{ id: 'c1', name: 'search', arguments: { q: 'x' } }] });
    const bad = fakes(() =>
      Promise.resolve({
        ok: true,
        result: { text: '', toolCalls: [{ id: 'c1', name: 'search', arguments: '{"q":"x"}' }] },
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    );
    expect((await providerChat(bad.props, REQUEST, () => undefined)).response.ok).toBe(false);
  });
});

describe('providerEmbed (R19)', () => {
  const ref: ProviderModelRef = { ...REF, model: EMBED, settings: {} };
  it("sends the texts and the purpose, and checks one vector of the model's dimensions per text", async () => {
    const f = fakes(() =>
      Promise.resolve({
        ok: true,
        result: {
          vectors: [
            [1, 2, 3],
            [4, 5, 6],
          ],
        },
        usage: { inputTokens: 4, outputTokens: 0 },
      }),
    );
    const out = await providerEmbed({ ...f.props, ref }, { texts: ['a', 'b'], purpose: 'document' } as never);
    expect(f.calls).toEqual([
      { tool: 'embed', arguments: { model: 'vendor.embed-v1', texts: ['a', 'b'], purpose: 'document' } },
    ]);
    expect(out).toEqual({
      ok: true,
      vectors: [
        [1, 2, 3],
        [4, 5, 6],
      ],
    });
    const short = fakes(() =>
      Promise.resolve({
        ok: true,
        result: { vectors: [[1, 2]] },
        usage: { inputTokens: 1, outputTokens: 0 },
      }),
    );
    expect(await providerEmbed({ ...short.props, ref }, { texts: ['a'], purpose: 'query' } as never)).toEqual({
      ok: false,
      reason: 'bad_response',
      detail: 'the provider answered with no 1 vectors of 3 numbers',
    });
  });
});
