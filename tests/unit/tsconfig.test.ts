import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';

// The compiler settings are guards too (PRINCIPLES §3). Each canary below
// breaks exactly one rule, and the real tsc, run with the repo's own
// tsconfig.json, must report exactly that error, so dropping or loosening any
// setting named in a canary's comment turns this red and names the canary.
// Two canaries pin the API ceiling: `lib` must not declare ES2025 APIs Node 22
// lacks, and @types/node must not declare Node APIs newer than engines.node's
// floor (lint-format R10 (b)). node-api.ts's own choice of API matters: this
// package's module.d.ts was checked function by function against a Node-24-
// targeted @types/node release (26.10.1) to confirm every declared @since tag
// here is <= the floor but one — node:module's findPackageJSON, @since v23.2.0
// and v22.14.0, which this package already declares despite tracking 22.13.x
// (a verified upstream @types/node inaccuracy, not a floor violation this repo
// introduced: nothing here calls it, and no other declaration in the package
// shares the problem). registerHooks (@since v22.15.0) is cleanly absent
// instead, confirmed directly against tsc.
// Not guarded here: `target` (it sets the emitted syntax; the APIs code may
// call are fixed by the explicit `lib`), `skipLibCheck`.

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const TSC = join(ROOT, 'node_modules', '.bin', 'tsc');

// file name → [source, the TS error codes tsc must report for it]
const CANARIES: Record<string, [string, string[]]> = {
  // Positive control: the ES2024 lib and the two ES2025 parts Node 22 ships.
  'allowed.ts': [
    'export const g = Object.groupBy([1, 2], (n) => (n % 2 ? "odd" : "even"));\n' +
      'export const w = Promise.withResolvers<number>();\n' +
      'export const it2 = [1, 2].values().map((n) => n * 2);\n' +
      'export const u = new Set([1]).union(new Set([2]));\n',
    [],
  ],
  // strict (noImplicitAny).
  'implicit-any.ts': ['export function f(x) { return x; }\n', ['TS7006']],
  // strict (strictNullChecks).
  'null-check.ts': ['export function f(s: string | null): number { return s.length; }\n', ['TS18047']],
  // noUnusedLocals.
  'unused-local.ts': ['export function f(): void { const x = 1; }\n', ['TS6133']],
  // noUnusedParameters.
  'unused-param.ts': ['export function f(x: number): void {}\n', ['TS6133']],
  // noImplicitReturns.
  'implicit-return.ts': ['export function f(b: boolean): number | undefined { if (b) return 1; }\n', ['TS7030']],
  // noFallthroughCasesInSwitch.
  'fallthrough.ts': [
    'export function f(n: number): number {\n  let r = 0;\n  switch (n) {\n    case 1: r = 1;\n    case 2: r = 2; break;\n  }\n  return r;\n}\n',
    ['TS7029'],
  ],
  // noUncheckedIndexedAccess: an index read may be undefined.
  'unchecked-index.ts': ['const a: number[] = [];\nexport const n: number = a[0];\n', ['TS2322']],
  // noImplicitOverride: overriding needs the `override` keyword.
  'implicit-override.ts': ['class A { m(): void {} }\nexport class B extends A { m(): void {} }\n', ['TS4114']],
  // allowUnreachableCode: false.
  'unreachable.ts': ['export function f(): number {\n  return 1;\n  console.log("never");\n}\n', ['TS7027']],
  // allowUnusedLabels: false.
  'unused-label.ts': ['export function f(): void {\n  unused: for (;;) { break; }\n}\n', ['TS7028']],
  // verbatimModuleSyntax: a type must be imported with `import type`.
  'type-import.ts': ["import { RequestOptions } from 'node:http';\nexport const o: RequestOptions = {};\n", ['TS1484']],
  // lib: no ES2025 beyond Iterator and Collection (Promise.try and
  // RegExp.escape are Node 24+).
  'promise-try.ts': ['export const p = Promise.try(() => 1);\n', ['TS2550']],
  'regexp-escape.ts': ["export const e = RegExp.escape('a');\n", ['TS2550']],
  // @types/node: no globals Node 22 lacks (Float16Array is Node 24+) ...
  'float16.ts': ['export const f = new Float16Array(1);\n', ['TS2304']],
  // ... and no Node APIs newer than the floor (registerHooks is 22.15).
  'node-api.ts': ["import { registerHooks } from 'node:module';\nexport const r = registerHooks;\n", ['TS2305']],
};

async function compileCanaries(): Promise<Record<string, string[]>> {
  // Inside the repo, so modules and @types resolve as they do for the real
  // typecheck; a fresh name per run, removed afterwards.
  const cache = join(ROOT, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  const dir = await mkdtemp(join(cache, 'tsconfig-canary-'));
  try {
    // ES modules, as this repo is ("type": "module" in package.json).
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    for (const [name, [source]] of Object.entries(CANARIES)) {
      await writeFile(join(dir, name), source);
    }
    await writeFile(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(ROOT, 'tsconfig.json'),
        compilerOptions: { noEmit: true },
        files: Object.keys(CANARIES),
        include: [],
      }),
    );
    // tsc exits 2 when it reports errors, which every canary but one must do;
    // its output is the result either way. Any other failure is re-thrown.
    // --pretty false: plain lines whatever the environment (FORCE_COLOR makes tsc colour its output, which the parse below cannot read).
    const output = await promisify(execFile)(TSC, ['--pretty', 'false', '-p', join(dir, 'tsconfig.json')], {
      timeout: 60_000,
    }).then(
      (r) => r.stdout,
      (e: unknown) => {
        if (e instanceof Error && 'code' in e && e.code === 2 && 'stdout' in e) return String(e.stdout);
        throw e;
      },
    );
    const found: Record<string, string[]> = Object.fromEntries(Object.keys(CANARIES).map((n) => [n, []]));
    for (const line of output.split('\n')) {
      if (!line.includes('error TS')) continue;
      // Anchored on the "/" that always precedes the bare filename here (the canary file always sits below
      // node_modules/.cache/, never at the reported path's start), so the match has exactly one way to begin and
      // never backtracks across start positions (sonarjs/super-linear-regex); verified byte-for-byte against the
      // unanchored form over every canary's real tsc output, 2026-10-14.
      const m = /\/([\w-]+\.ts)\(\d+,\d+\): error (TS\d+)/.exec(line);
      if (m === null) throw new Error(`tsc reported an error not tied to a canary: ${line}`);
      const codes = found[present(m[1], 'm[1]')];
      if (codes === undefined) throw new Error(`tsc reported an error not tied to a canary: ${line}`);
      codes.push(present(m[2], 'm[2]'));
    }
    return found;
  } finally {
    await rm(dir, { recursive: true });
  }
}

describe('tsconfig.json', () => {
  it('reports exactly the expected error for each canary, and none for allowed code', async () => {
    const expected = Object.fromEntries(Object.entries(CANARIES).map(([n, [, codes]]) => [n, codes]));
    expect(await compileCanaries()).toEqual(expected);
  }, 60_000);
});
