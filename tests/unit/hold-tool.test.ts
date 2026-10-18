// The hold tool (docs/plans/patterns-phase-2.md R7, A6): hello-world's one image
// tool, which never returns a result — P14's stalled worker. Its manifest entry,
// its handler (announces itself, waits for its signal, fails `timeout`), the
// bound AgentTools puts on it, and that only the watchdog's stuck recipe selects it.

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOLD, holdHandler } from '../../images/hello-world/src/hold.js';
import { AgentTools, TurnBudget, checkImageTools, imageTool, type AgentLog } from '../../src/agent-sdk/index.js';
import { present } from '../../src/shared/assert-present.js';
import { parseImageManifest } from '../../src/shared/tools.js';

const ROOT = resolve(import.meta.dirname, '..', '..');
const MANIFEST = join(ROOT, 'images', 'hello-world', 'image.json');

/** A log that records every line. */
function recordingLog(): AgentLog & {
  readonly lines: { level: string; event: string; fields: Record<string, unknown> }[];
} {
  const lines: { level: string; event: string; fields: Record<string, unknown> }[] = [];
  return {
    lines,
    info: (event, fields) => lines.push({ level: 'info', event, fields: { ...fields } }),
    warn: (event, fields) => lines.push({ level: 'warn', event, fields: { ...fields } }),
    error: (event, fields) => lines.push({ level: 'error', event, fields: { ...fields } }),
  };
}

const manifest = () => parseImageManifest(JSON.parse(readFileSync(MANIFEST, 'utf8')) as unknown, MANIFEST);

afterEach(() => {
  vi.useRealTimers();
});

describe('the hold tool (patterns-phase-2 R7, A6)', () => {
  it('is the one tool hello-world declares: class files, no parameters, bound 60,000 ms', () => {
    expect(manifest()).toEqual({
      tools: [
        {
          name: 'hold',
          description: 'Hold the question: this call waits until it is stopped and returns no result.',
          parameters: { type: 'object', properties: {} },
          class: 'files',
          timeoutMs: 60_000,
        },
      ],
      answerTools: [],
      // agent-persistence R1: hello-world keeps nothing (its three keys absent from image.json).
      keepsMemory: false,
      eraseUser: false,
      stateSchema: null,
    });
    expect(HOLD).toBe('hold');
    // main.ts registers exactly this handler under this name: the declared tools and the handlers match.
    expect(() => {
      checkImageTools(manifest(), { [HOLD]: holdHandler(recordingLog()) });
    }).not.toThrow();
    expect(readFileSync(join(ROOT, 'images', 'hello-world', 'src', 'main.ts'), 'utf8')).toContain(
      'handlers: { [HOLD]: holdHandler(log) }',
    );
  });

  it('imports nothing at run time, so it can reach no file, network or channel (R7)', () => {
    const imports = readFileSync(join(ROOT, 'images', 'hello-world', 'src', 'hold.ts'), 'utf8')
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((l) => !/^import type \{[^}]*\} from '[^']+';$/.test(l))).toEqual([]);
  });

  it('announces itself, returns nothing until its signal aborts, then fails timeout', async () => {
    vi.useFakeTimers();
    const log = recordingLog();
    const controller = new AbortController();
    let settled = false;
    const call = holdHandler(log)({}, controller.signal).then((outcome) => {
      settled = true;
      return outcome;
    });
    expect(log.lines).toEqual([{ level: 'info', event: 'hold.started', fields: { tool: 'hold' } }]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(settled).toBe(false);
    controller.abort();
    expect(await call).toEqual({ ok: false, reason: 'timeout' });
    expect(log.lines).toEqual([
      { level: 'info', event: 'hold.started', fields: { tool: 'hold' } },
      { level: 'info', event: 'hold.ended', fields: { tool: 'hold' } },
    ]);
  });

  it('returns at once when its signal has already aborted', async () => {
    const log = recordingLog();
    const controller = new AbortController();
    controller.abort();
    expect(await holdHandler(log)({}, controller.signal)).toEqual({ ok: false, reason: 'timeout' });
    expect(log.lines.map((l) => l.event)).toEqual(['hold.started', 'hold.ended']);
  });

  it('through AgentTools, the model gets {"error": "timeout"} only when its 60,000 ms bound passes', async () => {
    vi.useFakeTimers();
    const log = recordingLog();
    const declared = present(manifest().tools[0], 'manifest().tools[0]');
    const tools = new AgentTools({
      selected: [HOLD],
      available: new Map([[HOLD, imageTool(declared, holdHandler(log))]]),
      log,
    });
    let content: string | undefined;
    const run = tools.run({ id: 'c1', name: HOLD, arguments: {} }, new TurnBudget()).then((c) => (content = c));
    await vi.advanceTimersByTimeAsync(59_999);
    expect(content).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(content).toBe('{"error":"timeout"}');
    expect(log.lines.map((l) => `${l.level} ${l.event}`)).toEqual([
      'info hold.started',
      'info hold.ended',
      'warn tool.failed',
    ]);
    expect(present(log.lines.at(-1), 'log.lines.at(-1)').fields).toEqual({ tool: 'hold', reason: 'timeout' });
  });

  it("is selected by no committed recipe but the watchdog team's stuck", () => {
    const recipes = [
      ...readdirSync(join(ROOT, 'recipes')).map((f) => join('recipes', f)),
      ...readdirSync(join(ROOT, 'teams'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .flatMap((team) => readdirSync(join(ROOT, 'teams', team.name)).map((f) => join('teams', team.name, f))),
    ].filter((f) => f.endsWith('.json') && !f.endsWith('team.json'));
    const selecting = recipes.filter((f) => {
      const tools = (JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as { tools?: unknown }).tools;
      return Array.isArray(tools) && tools.includes(HOLD);
    });
    expect(recipes.length).toBeGreaterThan(40);
    expect(selecting).toEqual([join('teams', 'watchdog', 'stuck.json')]);
  });
});
