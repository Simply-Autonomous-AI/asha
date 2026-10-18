// The harness's meter (docs/plans/extension-modules.md R18b, R36): a metered module stays disabled until the user opts
// in with three caps — per conversation, per UTC day, per UTC month — none above its approved capUsd. The opt-in and
// the spend live in one file, `ASHA_HOME/metering.json`, written only with writePrivateFile, by the daemon (one write
// at a time) or by `--enable-module` holding daemon.lock when no daemon answers. Its fields are exactly
// {modules: {<id>: {caps: {conversation, day, month}, day: {date, usd}, month: {month, usd}}}}: no conversation, user
// or argument. Each conversation's spend is kept in memory only. Before each call its worst case is reserved, one
// reservation at a time, and refused `budget_exceeded` when it would pass a cap; after it, settled to the vendor's
// reported usage — or charged in full when the call ended unknown_outcome or timeout, or reported no usage. A file
// that exists and does not parse makes every metered call `budget_meter_unavailable`, logged at error, never a reset.

import { readFile } from 'node:fs/promises';

import type { ModuleManifest } from '../../shared/modules.js';
import { byCodeUnit } from '../../shared/order.js';
import type { Logger } from '../log.js';

export interface Caps {
  readonly conversation: number;
  readonly day: number;
  readonly month: number;
}

interface ModuleSpend {
  caps: Caps;
  day: { date: string; usd: number };
  month: { month: string; usd: number };
}

/** Why an opt-in was refused (R36's 409 reasons). */
export type EnableRefusal = 'not_installed' | 'not_metered' | 'over_cap';

/** A reservation, settled once. */
export interface Reservation {
  readonly module: string;
  readonly conversation: string;
  readonly usd: number;
  readonly day: string;
  readonly month: string;
}

export type ReserveOutcome =
  | { readonly ok: true; readonly reservation: Reservation }
  | {
      readonly ok: false;
      readonly reason: 'budget_exceeded';
      readonly cap: 'conversation' | 'day' | 'month';
      readonly limit: number;
      readonly spent: number;
    }
  | { readonly ok: false; readonly reason: 'budget_meter_unavailable' }
  | { readonly ok: false; readonly reason: 'not_enabled' };

export interface MeterProps {
  readonly file: string;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly write: (file: string, content: string) => Promise<void>;
}

const round = (usd: number): number => Math.round(usd * 1e9) / 1e9;

/** The UTC day and month of an instant (R18b): `YYYY-MM-DD`, `YYYY-MM`. */
export function utcPeriod(at: Date): { readonly day: string; readonly month: string } {
  const iso = at.toISOString();
  return { day: iso.slice(0, 10), month: iso.slice(0, 7) };
}

/** metering.json parsed exactly, or undefined when it is not the meter's shape. */
export function parseMetering(text: string): Map<string, ModuleSpend> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const keys = (v: Record<string, unknown>, k: readonly string[]) =>
    Object.keys(v).sort(byCodeUnit).join() === [...k].sort(byCodeUnit).join();
  const usd = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (!isObj(raw) || !keys(raw, ['modules']) || !isObj(raw['modules'])) return undefined;
  const out = new Map<string, ModuleSpend>();
  for (const [id, entry] of Object.entries(raw['modules'])) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(id) || !isObj(entry) || !keys(entry, ['caps', 'day', 'month'])) return undefined;
    const { caps, day, month } = entry;
    if (
      !isObj(caps) ||
      !keys(caps, ['conversation', 'day', 'month']) ||
      !usd(caps['conversation']) ||
      !usd(caps['day']) ||
      !usd(caps['month'])
    )
      return undefined;
    if (
      !isObj(day) ||
      !keys(day, ['date', 'usd']) ||
      typeof day['date'] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day['date']) ||
      !usd(day['usd'])
    )
      return undefined;
    if (
      !isObj(month) ||
      !keys(month, ['month', 'usd']) ||
      typeof month['month'] !== 'string' ||
      !/^\d{4}-\d{2}$/.test(month['month']) ||
      !usd(month['usd'])
    )
      return undefined;
    out.set(id, {
      caps: caps as unknown as Caps,
      day: { date: day['date'], usd: day['usd'] as number },
      month: { month: month['month'], usd: month['usd'] as number },
    });
  }
  return out;
}

/** Why an opt-in would be refused for this manifest and these caps; undefined when it is allowed (R18b, R36). */
export function enableRefusal(
  manifest: ModuleManifest | undefined,
  caps: Caps,
): { readonly reason: EnableRefusal; readonly detail: string } | undefined {
  if (manifest === undefined) return { reason: 'not_installed', detail: 'no such module is installed' };
  if (manifest.cost.model !== 'metered')
    return {
      reason: 'not_metered',
      detail: `module ${manifest.id}'s cost model is ${manifest.cost.model}: there is nothing to enable`,
    };
  const approved = manifest.cost.approved;
  if (approved === undefined)
    return { reason: 'over_cap', detail: `module ${manifest.id} has no approved cap (cost.approved) in its manifest` };
  const over = (['conversation', 'day', 'month'] as const).filter((k) => caps[k] > approved.capUsd);
  if (over.length > 0) {
    const overCaps = over.map((k) => `${k}=${String(caps[k])}`).join(', ');
    return {
      reason: 'over_cap',
      detail: `${overCaps} over module ${manifest.id}'s approved cap of ${String(approved.capUsd)} USD`,
    };
  }
  return undefined;
}

export class Meter {
  private spend = new Map<string, ModuleSpend>();
  private corrupt = false;
  private readonly conversations = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly props: MeterProps) {}

  /**
   * Reads metering.json: absent, no module enabled; unreadable as the meter's shape, every metered module refused (never
   * a reset), logged once naming `metered`, the installed metered modules it stops.
   */
  async load(metered: readonly string[]): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.props.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parsed = parseMetering(text);
    if (parsed === undefined) {
      this.corrupt = true;
      this.props.logger.error('budget.meter_failed', {
        modules: metered,
        file: this.props.file,
        error: new Error(
          `${this.props.file} does not parse as the meter's file: every metered call is refused until it is repaired or removed`,
        ),
      });
      return;
    }
    this.spend = parsed;
  }

  /** A metered module's state for a launch (R18b): opted in, not, or the meter's file does not parse. */
  state(module: string): 'enabled' | 'disabled' | 'unavailable' {
    if (this.corrupt) return 'unavailable';
    return this.spend.has(module) ? 'enabled' : 'disabled';
  }

  /** A module's spend line for --status (R21), or undefined when it is not enabled. */
  status(
    module: string,
  ): { readonly day: number; readonly dayCap: number; readonly month: number; readonly monthCap: number } | undefined {
    const s = this.spend.get(module);
    if (s === undefined) return undefined;
    const { day, month } = utcPeriod(this.props.now());
    return {
      day: s.day.date === day ? s.day.usd : 0,
      dayCap: s.caps.day,
      month: s.month.month === month ? s.month.usd : 0,
      monthCap: s.caps.month,
    };
  }

  /** Enables, or changes the caps of, a module (R18b), written at once; its spend is kept. */
  enable(module: string, caps: Caps): Promise<void> {
    return this.serial(async () => {
      if (this.corrupt)
        throw new Error(`${this.props.file} does not parse: repair or remove it before enabling a module`);
      const { day, month } = utcPeriod(this.props.now());
      const current = this.spend.get(module) ?? { caps, day: { date: day, usd: 0 }, month: { month, usd: 0 } };
      this.spend.set(module, { ...current, caps });
      await this.persist();
    });
  }

  /** Reserves a call's worst case, one reservation at a time; refused before any vendor call when it would pass a cap. */
  reserve(module: string, conversation: string, usd: number): Promise<ReserveOutcome> {
    return this.serial(async (): Promise<ReserveOutcome> => {
      if (this.corrupt) {
        this.props.logger.error('budget.meter_failed', {
          module,
          error: new Error(`${this.props.file} does not parse: the call is refused`),
        });
        return { ok: false, reason: 'budget_meter_unavailable' };
      }
      const s = this.spend.get(module);
      if (s === undefined) return { ok: false, reason: 'not_enabled' };
      const { day, month } = utcPeriod(this.props.now());
      if (s.day.date !== day) s.day = { date: day, usd: 0 };
      if (s.month.month !== month) s.month = { month, usd: 0 };
      const key = `${module}\0${conversation}`;
      const spentConversation = this.conversations.get(key) ?? 0;
      const checks = [
        ['conversation', spentConversation, s.caps.conversation],
        ['day', s.day.usd, s.caps.day],
        ['month', s.month.usd, s.caps.month],
      ] as const;
      for (const [cap, spent, limit] of checks) {
        if (round(spent + usd) > limit) {
          this.props.logger.warn('budget.exceeded', { module, cap, limit, spent, reservation: usd });
          return { ok: false, reason: 'budget_exceeded', cap, limit, spent };
        }
      }
      this.conversations.set(key, round(spentConversation + usd));
      s.day.usd = round(s.day.usd + usd);
      s.month.usd = round(s.month.usd + usd);
      await this.persist();
      return { ok: true, reservation: { module, conversation, usd, day, month } };
    });
  }

  /** Settles a reservation to `usd` (the vendor-reported usage × the manifest's price), or keeps it whole (`full`). */
  settle(reservation: Reservation, usd: number | 'full'): Promise<void> {
    return this.serial(async () => {
      const charged = usd === 'full' ? reservation.usd : usd;
      const delta = round(charged - reservation.usd);
      if (delta === 0) return;
      const s = this.spend.get(reservation.module);
      // A module is never disabled once enabled: a reservation of one the meter does not hold is a defect.
      if (s === undefined) throw new Error(`settle: module ${reservation.module} holds no spend in the meter`);
      const key = `${reservation.module}\0${reservation.conversation}`;
      this.conversations.set(key, Math.max(0, round((this.conversations.get(key) ?? 0) + delta)));
      if (s.day.date === reservation.day) s.day.usd = Math.max(0, round(s.day.usd + delta));
      if (s.month.month === reservation.month) s.month.usd = Math.max(0, round(s.month.usd + delta));
      // A vendor that reported more than was reserved has taken a period past its cap: recorded, never silent (B-25).
      const after = [
        ['conversation', this.conversations.get(key) ?? 0, s.caps.conversation],
        ['day', s.day.usd, s.caps.day],
        ['month', s.month.usd, s.caps.month],
      ] as const;
      for (const [cap, spent, limit] of after) {
        if (delta > 0 && spent > limit)
          this.props.logger.warn('budget.overrun', {
            module: reservation.module,
            cap,
            limit,
            spent,
            reserved: reservation.usd,
            charged,
          });
      }
      await this.persist();
    });
  }

  private persist(): Promise<void> {
    const modules = Object.fromEntries(
      [...this.spend].map(([id, s]) => [
        id,
        {
          caps: { conversation: s.caps.conversation, day: s.caps.day, month: s.caps.month },
          day: { date: s.day.date, usd: s.day.usd },
          month: { month: s.month.month, usd: s.month.usd },
        },
      ]),
    );
    return this.props.write(this.props.file, `${JSON.stringify({ modules })}\n`);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
