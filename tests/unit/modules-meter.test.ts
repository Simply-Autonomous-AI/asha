// The meter (docs/plans/extension-modules.md R18a, R18b, R36; A18): src/daemon/modules/meter.ts on a fake clock, its
// file written through an injected writer that keeps every version.

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { enableRefusal, Meter, parseMetering, utcPeriod } from '../../src/daemon/modules/index.js';
import { present } from '../../src/shared/assert-present.js';
import { parseModuleManifest } from '../../src/shared/modules.js';
import { RecordingLogger } from '../helpers/fakes.js';
import { cloudToolManifest, providerManifest, toolModuleManifest } from '../helpers/modules.js';

const CAPS = { conversation: 1, day: 2, month: 5 };

async function meter(start = '2026-10-01T12:00:00Z') {
  const dir = await mkdtemp(join(tmpdir(), 'asha-meter-'));
  const file = join(dir, 'metering.json');
  const clock = { at: new Date(start) };
  const logger = new RecordingLogger();
  const writes: string[] = [];
  const make = () =>
    new Meter({
      file,
      logger,
      now: () => clock.at,
      write: async (path, content) => {
        writes.push(content);
        await writeFile(path, content, { mode: 0o600 });
      },
    });
  return { file, clock, logger, writes, make };
}

describe('utcPeriod', () => {
  it('is the UTC day and month, whatever the local zone', () => {
    expect(utcPeriod(new Date('2026-10-31T23:59:59.999Z'))).toEqual({ day: '2026-10-31', month: '2026-10' });
    expect(utcPeriod(new Date('2026-11-01T00:00:00.000Z'))).toEqual({ day: '2026-11-01', month: '2026-11' });
  });
});

describe('enableRefusal (R18b, R36)', () => {
  const metered = parseModuleManifest(
    cloudToolManifest({
      cost: {
        model: 'metered',
        perCall: { unit: 'credit', units: 1, unitUsd: 0.008, url: 'https://x.example/p', read: '2026-09-27' },
        approved: { by: 'the owner', date: '2026-09-27', capUsd: 25 },
      },
    }),
    'm',
    'fixture_search',
  );
  it('refuses a module not installed, one not metered, and a cap above capUsd; accepts caps at capUsd', () => {
    expect(enableRefusal(undefined, CAPS)?.reason).toBe('not_installed');
    expect(enableRefusal(parseModuleManifest(toolModuleManifest(), 'm', 'fixture_tool'), CAPS)).toEqual({
      reason: 'not_metered',
      detail: "module fixture_tool's cost model is free: there is nothing to enable",
    });
    expect(enableRefusal(metered, { conversation: 1, day: 26, month: 25.01 })).toEqual({
      reason: 'over_cap',
      detail: "day=26, month=25.01 over module fixture_search's approved cap of 25 USD",
    });
    expect(enableRefusal(metered, { conversation: 25, day: 25, month: 25 })).toBeUndefined();
  });
});

describe('Meter (R18b)', () => {
  it('is disabled before an opt-in: reserve answers not_enabled and writes nothing', async () => {
    const m = await meter();
    const meterNow = m.make();
    await meterNow.load(['fixture_search']);
    expect(meterNow.state('fixture_search')).toBe('disabled');
    expect(await meterNow.reserve('fixture_search', 'c1', 0.01)).toEqual({ ok: false, reason: 'not_enabled' });
    expect(m.writes).toEqual([]);
  });

  it('reserves under each cap and refuses budget_exceeded at each, naming the cap', async () => {
    const m = await meter();
    const meterNow = m.make();
    await meterNow.enable('fixture_search', CAPS);
    expect((await meterNow.reserve('fixture_search', 'c1', 0.6)).ok).toBe(true);
    // The conversation cap (1): 0.6 + 0.6 passes it.
    expect(await meterNow.reserve('fixture_search', 'c1', 0.6)).toEqual({
      ok: false,
      reason: 'budget_exceeded',
      cap: 'conversation',
      limit: 1,
      spent: 0.6,
    });
    // Exactly at the cap is allowed.
    expect((await meterNow.reserve('fixture_search', 'c1', 0.4)).ok).toBe(true);
    expect((await meterNow.reserve('fixture_search', 'c2', 1)).ok).toBe(true);
    // The day cap (2): 2 spent.
    expect(await meterNow.reserve('fixture_search', 'c3', 0.01)).toEqual({
      ok: false,
      reason: 'budget_exceeded',
      cap: 'day',
      limit: 2,
      spent: 2,
    });
    m.clock.at = new Date('2026-10-02T00:00:00Z');
    expect((await meterNow.reserve('fixture_search', 'c3', 1)).ok).toBe(true);
    expect((await meterNow.reserve('fixture_search', 'c4', 1)).ok).toBe(true);
    m.clock.at = new Date('2026-10-03T00:00:00Z');
    expect((await meterNow.reserve('fixture_search', 'c5', 0.5)).ok).toBe(true);
    // The month cap (5): 4.5 spent this month.
    expect(await meterNow.reserve('fixture_search', 'c6', 0.6)).toEqual({
      ok: false,
      reason: 'budget_exceeded',
      cap: 'month',
      limit: 5,
      spent: 4.5,
    });
    expect(m.logger.events('warn')).toEqual(['budget.exceeded', 'budget.exceeded', 'budget.exceeded']);
  });

  it('of two concurrent reservations that together pass the day cap, runs one and refuses the other', async () => {
    const m = await meter();
    const meterNow = m.make();
    await meterNow.enable('fixture_search', { conversation: 5, day: 1, month: 5 });
    const outcomes = await Promise.all([
      meterNow.reserve('fixture_search', 'c1', 0.7),
      meterNow.reserve('fixture_search', 'c2', 0.7),
    ]);
    expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
  });

  it('writes its file one version at a time, in order, so a slow first write never lands over a later one (review B-25)', async () => {
    const m = await meter();
    let inFlight = 0;
    let most = 0;
    const landed: string[] = [];
    const slowFirst = new Meter({
      file: m.file,
      logger: m.logger,
      now: () => m.clock.at,
      write: async (_path, content) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        // The first write is the slowest: unserialised, it would land last, holding the oldest spend.
        await new Promise((resolve) => setTimeout(resolve, landed.length === 0 ? 30 : 1));
        landed.push(content);
        inFlight -= 1;
      },
    });
    await slowFirst.enable('fixture_search', CAPS);
    landed.length = 0;
    await Promise.all([
      slowFirst.reserve('fixture_search', 'c1', 0.1),
      slowFirst.reserve('fixture_search', 'c2', 0.2),
      slowFirst.reserve('fixture_search', 'c3', 0.3),
    ]);
    expect(most).toBe(1);
    const lastLanded = present(landed.at(-1), 'the last landed write');
    const parsed = JSON.parse(lastLanded) as { modules: Record<string, { day: { usd: number } }> };
    expect(present(parsed.modules['fixture_search'], "parsed.modules['fixture_search']").day.usd).toBeCloseTo(0.6, 9);
  });

  it('logs budget.overrun when a settled usage takes a period past its cap (review B-25)', async () => {
    const m = await meter();
    const meterNow = m.make();
    await meterNow.enable('fixture_search', CAPS);
    const r = await meterNow.reserve('fixture_search', 'c1', 0.5);
    if (!r.ok) throw new Error('reserved');
    await meterNow.settle(r.reservation, 2.5);
    expect(m.logger.entries.filter((e) => e.event === 'budget.overrun').map((e) => e.fields)).toEqual([
      { module: 'fixture_search', cap: 'conversation', limit: 1, spent: 2.5, reserved: 0.5, charged: 2.5 },
      { module: 'fixture_search', cap: 'day', limit: 2, spent: 2.5, reserved: 0.5, charged: 2.5 },
    ]);
  });

  it('settles a reservation to the usage, or keeps it whole', async () => {
    const m = await meter();
    const meterNow = m.make();
    await meterNow.enable('fixture_search', CAPS);
    const r1 = await meterNow.reserve('fixture_search', 'c1', 0.5);
    if (!r1.ok) throw new Error('reserved');
    await meterNow.settle(r1.reservation, 0.1);
    expect(meterNow.status('fixture_search')).toEqual({ day: 0.1, dayCap: 2, month: 0.1, monthCap: 5 });
    const r2 = await meterNow.reserve('fixture_search', 'c1', 0.5);
    if (!r2.ok) throw new Error('reserved');
    await meterNow.settle(r2.reservation, 'full');
    expect(meterNow.status('fixture_search')).toEqual({ day: 0.6, dayCap: 2, month: 0.6, monthCap: 5 });
    // The conversation's spend is 0.6, so 0.5 more passes its cap of 1.
    expect((await meterNow.reserve('fixture_search', 'c1', 0.5)).ok).toBe(false);
  });

  it('a settle of a module the meter does not hold is a defect: it throws', async () => {
    const m = await meter();
    await expect(
      m.make().settle({ module: 'x', conversation: 'c', usd: 1, day: '2026-10-01', month: '2026-10' }, 0),
    ).rejects.toThrow('settle: module x holds no spend in the meter');
  });

  it("keeps the day's and the month's spend across a restart, and starts each conversation's at 0", async () => {
    const m = await meter();
    const first = m.make();
    await first.enable('fixture_search', CAPS);
    await first.reserve('fixture_search', 'c1', 1);
    const second = m.make();
    await second.load(['fixture_search']);
    expect(second.status('fixture_search')).toEqual({ day: 1, dayCap: 2, month: 1, monthCap: 5 });
    expect((await second.reserve('fixture_search', 'c1', 1)).ok).toBe(true);
  });

  it('rolls the month over at 00:00 UTC', async () => {
    const m = await meter('2026-10-31T23:59:59Z');
    const meterNow = m.make();
    await meterNow.enable('fixture_search', CAPS);
    await meterNow.reserve('fixture_search', 'c1', 1);
    expect(meterNow.status('fixture_search')).toEqual({ day: 1, dayCap: 2, month: 1, monthCap: 5 });
    m.clock.at = new Date('2026-11-01T00:00:00Z');
    expect(meterNow.status('fixture_search')).toEqual({ day: 0, dayCap: 2, month: 0, monthCap: 5 });
    await meterNow.reserve('fixture_search', 'c2', 0.25);
    expect(JSON.parse(await readFile(m.file, 'utf8'))).toEqual({
      modules: {
        fixture_search: { caps: CAPS, day: { date: '2026-11-01', usd: 0.25 }, month: { month: '2026-11', usd: 0.25 } },
      },
    });
  });

  it("keeps exactly R18b's keys in metering.json after a day in three conversations: no conversation id", async () => {
    const m = await meter();
    const meterNow = m.make();
    await meterNow.enable('fixture_search', { conversation: 1, day: 5, month: 5 });
    for (const conversation of ['CANARY-CONVERSATION-1', 'c2', 'c3'])
      await meterNow.reserve('fixture_search', conversation, 0.1);
    const text = await readFile(m.file, 'utf8');
    expect(text).not.toContain('CANARY');
    expect(parseMetering(text)).toBeDefined();
    expect(JSON.parse(text)).toEqual({
      modules: {
        fixture_search: {
          caps: { conversation: 1, day: 5, month: 5 },
          day: { date: '2026-10-01', usd: 0.3 },
          month: { month: '2026-10', usd: 0.3 },
        },
      },
    });
  });

  it('refuses every metered call budget_meter_unavailable on a file that does not parse, logging budget.meter_failed, never resetting it', async () => {
    const m = await meter();
    await writeFile(m.file, '{"modules": {"fixture_search": {"caps": "oops"}}}');
    const meterNow = m.make();
    await meterNow.load(['fixture_search']);
    expect(meterNow.state('fixture_search')).toBe('unavailable');
    expect(present(m.logger.entries[0], 'm.logger.entries[0]').fields).toMatchObject({
      modules: ['fixture_search'],
    });
    expect(await meterNow.reserve('fixture_search', 'c1', 0.01)).toEqual({
      ok: false,
      reason: 'budget_meter_unavailable',
    });
    await expect(meterNow.enable('fixture_search', CAPS)).rejects.toThrow(
      'does not parse: repair or remove it before enabling a module',
    );
    expect(m.logger.events('error')).toEqual(['budget.meter_failed', 'budget.meter_failed']);
    expect(await readFile(m.file, 'utf8')).toBe('{"modules": {"fixture_search": {"caps": "oops"}}}');
    expect(m.writes).toEqual([]);
  });

  it('parseMetering refuses an extra key anywhere, a negative or non-finite usd, and a bad date', () => {
    const good = {
      modules: { m: { caps: CAPS, day: { date: '2026-10-01', usd: 0 }, month: { month: '2026-10', usd: 0 } } },
    };
    expect(parseMetering(JSON.stringify(good))).toBeDefined();
    for (const bad of [
      { ...good, extra: 1 },
      { modules: { m: { ...good.modules.m, conversation: { c1: 1 } } } },
      { modules: { m: { ...good.modules.m, day: { date: '2026-10-01', usd: -1 } } } },
      { modules: { m: { ...good.modules.m, month: { month: '2026/10', usd: 0 } } } },
      { modules: { 'Bad-Id': good.modules.m } },
    ]) {
      expect(parseMetering(JSON.stringify(bad))).toBeUndefined();
    }
    expect(parseMetering('not json')).toBeUndefined();
  });
});

describe("a provider's reservation", () => {
  it('a ModelProvider manifest is metered with an approved cap', () => {
    expect(parseModuleManifest(providerManifest(), 'm', 'fixture_provider').cost).toEqual({
      model: 'metered',
      approved: { by: 'the owner', date: '2026-09-27', capUsd: 25 },
    });
  });
});
