// A failed agent exits at once (found by agent-persistence's agent suite, 2026-09-29): exitOnFailure reports the
// error and exits 1, and every image's main runs serveAgent through it — setting only process.exitCode left a
// failed agent connected, and looking alive, until the harness's delivery bound killed it.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { exitOnFailure, type AgentProcess } from '../../src/agent-sdk/index.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

function fakeProcess(): AgentProcess & { readonly exits: number[] } {
  const exits: number[] = [];
  return {
    exits,
    onTerminate: () => () => undefined,
    exit: (code) => {
      exits.push(code);
    },
  };
}

describe('exitOnFailure', () => {
  it('reports a failure, then exits 1, once', async () => {
    const process = fakeProcess();
    const reported: unknown[] = [];
    const error = new Error('still calling tools after 6 rounds');
    await exitOnFailure(
      async () => Promise.reject(error),
      process,
      (e) => reported.push(e),
    );
    expect(reported).toEqual([error]);
    expect(process.exits).toEqual([1]);
  });

  it('neither reports nor exits when the agent ends normally', async () => {
    const process = fakeProcess();
    const reported: unknown[] = [];
    await exitOnFailure(
      () => Promise.resolve(undefined),
      process,
      (e) => reported.push(e),
    );
    expect([reported, process.exits]).toEqual([[], []]);
  });

  it("every image's main runs serveAgent through exitOnFailure, and never sets only process.exitCode after it", () => {
    const mains = readdirSync(join(ROOT, 'images'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(ROOT, 'images', e.name, 'src', 'main.ts'));
    expect(mains.length).toBeGreaterThan(2);
    for (const main of mains) {
      const source = readFileSync(main, 'utf8');
      if (!source.includes('serveAgent(')) continue;
      expect(source, main).toMatch(/exitOnFailure\(\s*async \(\) => \{\s*await serveAgent\(/);
      expect(source.slice(source.indexOf('await serveAgent(')), main).not.toContain('process.exitCode = 1');
    }
  });
});
