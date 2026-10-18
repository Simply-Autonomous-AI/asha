// The opt-in live check's logic (docs/plans/extension-modules.md R18a, R19, R20; A18, A20): src/daemon/modules/live.ts
// against a fake module host that records every call — nothing here reaches a vendor.

import { describe, expect, it } from 'vitest';

import {
  LIVE_CHANNEL,
  LIVE_TOOL,
  liveCheck,
  livePassed,
  type CallOutcome,
  type InstalledModule,
} from '../../src/daemon/modules/index.js';
import { present } from '../../src/shared/assert-present.js';
import { parseModuleManifest } from '../../src/shared/modules.js';
import { cloudToolManifest, pluginManifest, providerManifest } from '../helpers/modules.js';

const installed = (raw: Record<string, unknown>): InstalledModule => ({
  manifest: parseModuleManifest(raw, 'module.json', String(raw['id'])),
  dir: '/m',
});

function host(answers: Record<string, CallOutcome>) {
  const calls: string[] = [];
  return {
    calls,
    host: {
      acquire: (m: string, c: string): Promise<void> => {
        calls.push(`acquire ${m} ${c}`);
        return Promise.resolve();
      },
      release: (m: string, c: string): Promise<void> => {
        calls.push(`release ${m} ${c}`);
        return Promise.resolve();
      },
      provider: (r: { tool: string; arguments: unknown }): Promise<CallOutcome> => {
        calls.push(`provider ${r.tool} ${JSON.stringify(r.arguments)}`);
        return Promise.resolve(present(answers[r.tool], `answers[${r.tool}]`));
      },
      call: (r: { tool: string; arguments: unknown }): Promise<CallOutcome> => {
        calls.push(`call ${r.tool} ${JSON.stringify(r.arguments)}`);
        return Promise.resolve(present(answers[r.tool], `answers[${r.tool}]`));
      },
    },
  };
}

describe('the live check (R18a, R19, R20)', () => {
  it('refuses a metered module whose manifest lacks cost.approved before any call: the host is never touched', async () => {
    const h = host({});
    const unapproved = cloudToolManifest({
      cost: {
        model: 'metered',
        perCall: { unit: 'credit', units: 1, unitUsd: 0.008, url: 'https://x.example/p', read: '2026-09-27' },
      },
    });
    const record = await liveCheck({
      installed: installed(unapproved),
      host: h.host,
      tool: { name: 'search', arguments: {} },
    });
    expect(record).toEqual({
      ok: false,
      module: 'fixture_search',
      refused:
        "module fixture_search's manifest has no cost.approved: the owner's approval of its cost is recorded there before any live call (R18a)",
      networkCalls: 0,
    });
    expect(h.calls).toEqual([]);
  });

  it('refuses a model whose lifecycle is LEGACY before any chat call, and releases', async () => {
    const h = host({ lifecycle: { ok: true, result: { status: 'LEGACY' } } });
    const record = await liveCheck({ installed: installed(providerManifest()), host: h.host });
    expect(h.calls).toEqual([
      `acquire fixture_provider ${LIVE_CHANNEL}`,
      'provider lifecycle {"model":"vendor.small-model-v1"}',
      `release fixture_provider ${LIVE_CHANNEL}`,
    ]);
    expect(record.ok && record.steps.at(-1)).toEqual({
      step: 'refused vendor.small-model-v1',
      outcome: {
        ok: false,
        reason: 'unavailable',
        detail: 'its lifecycle status is LEGACY, not ACTIVE: no chat call is made (R20)',
      },
    });
    // Recorded, and not a pass: the live run is red (B-28).
    expect(livePassed(record)).toBe(false);
  });

  it('on ACTIVE, sends one chat requiring a tool call and records whether the vendor honoured it and reported usage', async () => {
    const h = host({
      lifecycle: { ok: true, result: { status: 'ACTIVE' } },
      chat: {
        ok: true,
        result: { text: '', toolCalls: [{ id: 'c', name: 'reply', arguments: { text: 'Hello' } }] },
        usage: { inputTokens: 12, outputTokens: 3 },
      },
    });
    const record = await liveCheck({ installed: installed(providerManifest()), host: h.host });
    expect(h.calls[2]).toBe(
      `provider chat ${JSON.stringify({ model: 'vendor.small-model-v1', messages: [{ role: 'user', content: 'Say hello to the user with the reply tool.' }], maxTokens: 64, tools: [LIVE_TOOL], requireToolCall: true, settings: { temperature: 0 } })}`,
    );
    expect(record.ok && record.steps.at(-1)).toMatchObject({
      step: 'chat vendor.small-model-v1',
      toolChoiceHonoured: true,
      usageReported: true,
    });
    expect(livePassed(record)).toBe(true);
  });

  it('is not a pass when the vendor ignored the forced tool call, or reported no usage, or a call failed (B-28)', async () => {
    const chats: CallOutcome[] = [
      { ok: true, result: { text: 'Hello', toolCalls: [] }, usage: { inputTokens: 12, outputTokens: 3 } },
      { ok: true, result: { text: '', toolCalls: [{ id: 'c', name: 'reply', arguments: { text: 'Hello' } }] } },
      { ok: false, reason: 'module_unavailable', detail: 'vendor 503' },
    ];
    for (const chat of chats) {
      const h = host({ lifecycle: { ok: true, result: { status: 'ACTIVE' } }, chat });
      const record = await liveCheck({ installed: installed(providerManifest()), host: h.host });
      expect(record.ok).toBe(true);
      expect(livePassed(record)).toBe(false);
    }
  });

  it('refuses a command plugin (D52) and a ToolModule with no tool named, before any call', async () => {
    const h = host({});
    expect((await liveCheck({ installed: installed(pluginManifest()), host: h.host })).ok).toBe(false);
    expect(
      (await liveCheck({ installed: installed(cloudToolManifest({ cost: { model: 'free' } })), host: h.host })).ok,
    ).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it("calls a ToolModule's named tool once with the arguments given", async () => {
    const h = host({ search: { ok: true, result: { results: [] }, usage: { units: 1 } } });
    const record = await liveCheck({
      installed: installed(cloudToolManifest({ cost: { model: 'free' } })),
      host: h.host,
      tool: { name: 'search', arguments: { word: 'asha' } },
    });
    expect(h.calls).toEqual([
      `acquire fixture_search ${LIVE_CHANNEL}`,
      'call search {"word":"asha"}',
      `release fixture_search ${LIVE_CHANNEL}`,
    ]);
    expect(record).toEqual({
      ok: true,
      module: 'fixture_search',
      steps: [{ step: 'call search', outcome: { ok: true, result: { results: [] }, usage: { units: 1 } } }],
    });
    expect(livePassed(record)).toBe(true);
  });
});
