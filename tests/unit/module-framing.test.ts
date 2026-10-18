// The module side of the framing (docs/plans/extension-modules.md R34): src/module-runtime/runtime.ts `handleLine`,
// the code inside every ToolModule's and ModelProvider's container.

import { describe, expect, it } from 'vitest';

import { handleLine, type ModuleEntry, type ServeModuleProps } from '../../src/module-runtime/runtime.js';

function serve(kind: ServeModuleProps['kind'], entry: ModuleEntry, secrets: Record<string, string> = {}) {
  const written: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const props: ServeModuleProps = {
    kind,
    entry,
    secrets,
    write: (l) => written.push(l),
    log: (r) => logs.push({ ...r }),
  };
  return {
    written,
    logs,
    line: (text: string) => handleLine(props, text),
    parsed: () => written.map((l) => JSON.parse(l) as unknown),
  };
}

describe('handleLine (R34)', () => {
  it("calls a ToolModule's call(tool, args, context) with its secrets and the idempotency key, and answers one line with the id", async () => {
    const seen: unknown[] = [];
    const s = serve(
      'ToolModule',
      {
        call: (tool, args, context) => (
          seen.push([tool, args, context.secrets, context.idempotencyKey]),
          Promise.resolve({ ok: true, result: { n: 1 }, usage: { units: 2 } })
        ),
      },
      { KEY: 'v' },
    );
    await s.line(JSON.stringify({ id: 'a', tool: 'lookup', arguments: { word: 'x' }, idempotencyKey: 'k1' }));
    expect(seen).toEqual([['lookup', { word: 'x' }, { KEY: 'v' }, 'k1']]);
    expect(s.written).toEqual(['{"id":"a","ok":true,"result":{"n":1},"usage":{"units":2}}\n']);
    expect(s.logs).toEqual([]);
  });

  it('passes {} for absent arguments and no idempotency key when none was sent', async () => {
    const seen: unknown[] = [];
    const s = serve('ToolModule', {
      call: (_t, args, context) => (
        seen.push([args, 'idempotencyKey' in context]),
        Promise.resolve({ ok: false, reason: 'not_found', detail: 'no' })
      ),
    });
    await s.line(JSON.stringify({ id: 'b', tool: 't' }));
    expect(seen).toEqual([[{}, false]]);
    expect(s.parsed()).toEqual([{ id: 'b', ok: false, reason: 'not_found', detail: 'no' }]);
  });

  it("routes a provider's chat, embed and lifecycle, its deltas lines before the response", async () => {
    const s = serve('ModelProvider', {
      chat: (_a, c) => (
        c.onDelta({ part: 'text', text: 'h' }),
        c.onDelta({ part: 'text', text: 'i' }),
        Promise.resolve({ ok: true, result: { text: 'hi', toolCalls: [] } })
      ),
      embed: () => Promise.resolve({ ok: true, result: { vectors: [] } }),
      lifecycle: () => Promise.resolve({ ok: true, result: { status: 'ACTIVE' } }),
    });
    await s.line(JSON.stringify({ id: 'c', tool: 'chat', arguments: {} }));
    await s.line(JSON.stringify({ id: 'e', tool: 'embed', arguments: {} }));
    await s.line(JSON.stringify({ id: 'l', tool: 'lifecycle', arguments: {} }));
    expect(s.parsed()).toEqual([
      { id: 'c', delta: { part: 'text', text: 'h' } },
      { id: 'c', delta: { part: 'text', text: 'i' } },
      { id: 'c', ok: true, result: { text: 'hi', toolCalls: [] } },
      { id: 'e', ok: true, result: { vectors: [] } },
      { id: 'l', ok: true, result: { status: 'ACTIVE' } },
    ]);
  });

  it("answers a handler the module lacks with its kind's reason: unknown_tool for a tool, unavailable for a provider", async () => {
    const tool = serve('ToolModule', {});
    await tool.line(JSON.stringify({ id: 'x', tool: 'lookup' }));
    expect(tool.parsed()).toEqual([
      { id: 'x', ok: false, reason: 'unknown_tool', detail: 'this module has no handler for lookup' },
    ]);
    const provider = serve('ModelProvider', { chat: () => Promise.resolve({ ok: true, result: {} }) });
    await provider.line(JSON.stringify({ id: 'y', tool: 'embed' }));
    await provider.line(JSON.stringify({ id: 'z', tool: 'call' }));
    expect(provider.parsed()).toEqual([
      { id: 'y', ok: false, reason: 'unavailable', detail: 'this module has no handler for embed' },
      { id: 'z', ok: false, reason: 'unavailable', detail: 'this module has no handler for call' },
    ]);
  });

  it("answers a throwing handler with its kind's failure and logs the error, never sending its message back", async () => {
    const tool = serve('ToolModule', {
      call: () => Promise.reject(new Error('boom: secret-ish detail')),
    });
    await tool.line(JSON.stringify({ id: 'x', tool: 't' }));
    expect(tool.parsed()).toEqual([
      { id: 'x', ok: false, reason: 'module_unavailable', detail: 'the module failed; see the daemon log' },
    ]);
    expect(tool.logs).toEqual([{ event: 'module.handler_failed', tool: 't', detail: 'boom: secret-ish detail' }]);
    const provider = serve('ModelProvider', {
      chat: () => Promise.reject(new Error('nope')),
    });
    await provider.line(JSON.stringify({ id: 'y', tool: 'chat' }));
    expect(provider.parsed()).toEqual([
      { id: 'y', ok: false, reason: 'unavailable', detail: 'the module failed; see the daemon log' },
    ]);
  });

  it('answers a handler that returns neither shape as a failure, logged', async () => {
    const s = serve('ToolModule', { call: () => Promise.resolve('just text') });
    await s.line(JSON.stringify({ id: 'x', tool: 't' }));
    expect(s.parsed()).toEqual([
      { id: 'x', ok: false, reason: 'module_unavailable', detail: 'the module failed; see the daemon log' },
    ]);
    expect(s.logs).toEqual([
      {
        event: 'module.handler_failed',
        tool: 't',
        detail: 'the handler answered neither {ok: true, …} nor {ok: false, reason}',
      },
    ]);
  });

  it('logs a line that is not JSON, or has no string id and tool, and answers nothing', async () => {
    const s = serve('ToolModule', { call: () => Promise.resolve({ ok: true, result: 1 }) });
    await s.line('{not json');
    await s.line(JSON.stringify({ id: 1, tool: 't' }));
    await s.line(JSON.stringify({ id: 'a' }));
    expect(s.written).toEqual([]);
    expect(s.logs.map((l) => l['event'])).toEqual([
      'module.request_invalid',
      'module.request_invalid',
      'module.request_invalid',
    ]);
    expect(s.logs[1]).toEqual({ event: 'module.request_invalid', detail: 'a request has a string id and tool' });
  });
});
