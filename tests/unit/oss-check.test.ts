// The published-tree check's own decisions (docs/plans/oss-release.md R16, R30; A7, A13): model weights and files over
// 5 MB named, the tarball's missing files named, and the steps run in order until the first that fails, each recorded
// with its time and detail. The whole check runs for real in step 6 (npm run oss:check), its log kept.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CLONE_COMMANDS,
  MAX_FILE_BYTES,
  TARBALL_HOLDS,
  runSteps,
  sizeProblems,
  tarballLacks,
  type StepRecord,
} from '../../tools/oss/check.mjs';

describe("oss:check's decisions (oss-release R16, R30; A7, A13)", () => {
  it("runs in the fresh clone every npm step CI runs, in CI's order, and the build", () => {
    // The first public push ran only the tests and the build in the clone, and CI failed on lint:unused (2026-10-18).
    const RUN_NPM = '- run: npm ';
    const workflow = readFileSync(join(import.meta.dirname, '..', '..', '.github', 'workflows', 'check.yml'), 'utf8');
    const ci = workflow
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith(RUN_NPM))
      .map((l) => l.slice(RUN_NPM.length))
      .filter((c) => c !== 'ci');
    const clone = CLONE_COMMANDS.map((c) => c.args.join(' '));
    expect(clone.filter((c) => c !== 'run build')).toEqual(ci);
    expect(clone).toContain('run build');
  });

  it('names each file that is model weights or over 5 MB, and passes the rest', () => {
    expect(MAX_FILE_BYTES).toBe(5_242_880);
    expect(
      sizeProblems([
        { path: 'docs/a.webm', bytes: MAX_FILE_BYTES },
        { path: 'docs/b.webm', bytes: MAX_FILE_BYTES + 1 },
        { path: 'models/x.GGUF', bytes: 10 },
        { path: 'w/model.safetensors', bytes: MAX_FILE_BYTES + 1 },
        { path: 'src/a.ts', bytes: 100 },
      ]),
    ).toEqual([
      'docs/b.webm: 5242881 bytes, over 5242880',
      'models/x.GGUF: model weights',
      'w/model.safetensors: model weights',
      'w/model.safetensors: 5242881 bytes, over 5242880',
    ]);
  });

  it("names each of R30's files the tarball lacks", () => {
    expect(TARBALL_HOLDS).toEqual(['README.md', 'LICENSE', 'THIRD_PARTY_LICENSES.md']);
    expect(tarballLacks(['asha-1.0.0/LICENSE', 'asha-1.0.0/asha', 'asha-1.0.0/README.md'], '1.0.0')).toEqual([
      'THIRD_PARTY_LICENSES.md',
    ]);
    expect(
      tarballLacks(['asha-0.9.0/README.md', 'asha-0.9.0/LICENSE', 'asha-0.9.0/THIRD_PARTY_LICENSES.md'], '1.0.0'),
    ).toEqual([...TARBALL_HOLDS]);
  });

  it('runs the steps in order, stops at the first that fails, and records each with its time and detail', () => {
    let t = 0;
    const now = (): number => (t += 5);
    const ran: string[] = [];
    const logged: StepRecord[] = [];
    const records = runSteps(
      [
        { name: 'one', run: () => (ran.push('one'), 'fine') },
        {
          name: 'two',
          run: () => {
            ran.push('two');
            throw new Error('broke');
          },
        },
        { name: 'three', run: () => (ran.push('three'), 'never') },
      ],
      (r) => logged.push(r),
      now,
    );
    expect(ran).toEqual(['one', 'two']);
    expect(records).toEqual([
      { name: 'one', ok: true, ms: 5, detail: 'fine' },
      { name: 'two', ok: false, ms: 5, detail: 'broke' },
    ]);
    expect(logged).toEqual(records);
  });
});
