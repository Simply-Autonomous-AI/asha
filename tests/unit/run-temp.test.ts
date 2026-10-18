// Each test run's temporary files in a folder of its own, removed when the run ends (tests/helpers/run-temp.ts): this
// very run's tmpdir() is its run folder; the setup sweeps the folders of runs that died and nothing else, and its
// teardown removes its own; and every vitest config makes it its first global setup.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { byCodeUnit } from '../../src/shared/order.js';
import { RUN_TEMP_PREFIX, runTempSetup } from '../helpers/run-temp.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

describe("a test run's temporary folder", () => {
  it("is where this run's tmpdir() points, in this worker too: the unit config's first global setup made it", () => {
    expect(tmpdir()).toMatch(/\/asha-run-\d+-[A-Za-z0-9]{6}$/);
    expect(existsSync(tmpdir())).toBe(true);
  });

  it('sweeps only the run folders whose vitest process has ended, makes its own, points TMPDIR at it; the teardown puts TMPDIR back and removes it', () => {
    const base = mkdtempSync(join(tmpdir(), 'base-'));
    for (const name of [
      'asha-run-111-AbC123',
      'asha-run-222-xyz789',
      'asha-run-x-AbC123',
      'asha-home-AbC123',
      'asha-run-333-short',
    ])
      mkdirSync(join(base, name));
    writeFileSync(join(base, 'asha-run-111-AbC123', 'left.txt'), 'by a run killed before its teardown');
    const env: NodeJS.ProcessEnv = { TMPDIR: '/before' };
    const { dir, teardown } = runTempSetup({ base, pid: 444, isAlive: (pid) => pid === 222, env });
    expect(dir.startsWith(join(base, `${RUN_TEMP_PREFIX}444-`))).toBe(true);
    expect(env['TMPDIR']).toBe(dir);
    // 111's process has ended: its folder goes. 222's runs on, and the rest are no run folders: they stay.
    expect(readdirSync(base).toSorted(byCodeUnit)).toEqual(
      [
        'asha-home-AbC123',
        'asha-run-222-xyz789',
        'asha-run-333-short',
        'asha-run-x-AbC123',
        dir.slice(base.length + 1),
      ].toSorted(byCodeUnit),
    );
    writeFileSync(join(dir, 'made-by-a-test.txt'), 'x');
    teardown();
    expect(env['TMPDIR']).toBe('/before');
    expect(existsSync(dir)).toBe(false);
  });

  it('the teardown removes TMPDIR again when the run began without one', () => {
    const base = mkdtempSync(join(tmpdir(), 'base-'));
    const env: NodeJS.ProcessEnv = {};
    const { teardown } = runTempSetup({ base, pid: 555, isAlive: () => true, env });
    expect(env['TMPDIR']).toMatch(/\/asha-run-555-[A-Za-z0-9]{6}$/);
    teardown();
    expect('TMPDIR' in env).toBe(false);
  });

  it('every vitest config makes it the first global setup', () => {
    const configs = readdirSync(ROOT).filter((f) => /^vitest(\.[a-z]+)?\.config\.mts$/.test(f));
    expect(configs.length).toBeGreaterThanOrEqual(6);
    const first = configs.map((f) => [
      f,
      /globalSetup:\s*\[\s*'([^']+)'/.exec(readFileSync(join(ROOT, f), 'utf8'))?.[1] ?? null,
    ]);
    expect(first).toEqual(configs.map((f) => [f, 'tests/helpers/run-temp.global.ts']));
  });
});
