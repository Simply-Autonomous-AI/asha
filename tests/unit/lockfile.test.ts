// The lockfile's integrity hashes are the ones npm checked when it installed node_modules (PRINCIPLES §21): on
// 2026-10-16 the renumbering's script rewrote one inside package-lock.json (`P20` in a base64 hash, the code review's
// R1-SECURITY-002), which no check saw, and a fresh `npm install` would have failed with EINTEGRITY. npm's hidden
// lockfile, node_modules/.package-lock.json, records each installed package's integrity as npm verified it.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

interface Lock {
  readonly packages: Readonly<Record<string, { readonly integrity?: string }>>;
}

const read = (path: string): Lock => JSON.parse(readFileSync(join(ROOT, path), 'utf8')) as Lock;

/** Each package of `installed` whose integrity `lock` gives otherwise, as `<path>: <lock's> ≠ <installed>`. */
function integrityDiffers(lock: Lock, installed: Lock): string[] {
  return Object.entries(installed.packages).flatMap(([path, entry]) => {
    const locked = lock.packages[path]?.integrity;
    return entry.integrity !== undefined && locked !== entry.integrity
      ? [`${path}: ${String(locked)} ≠ ${entry.integrity}`]
      : [];
  });
}

describe("package-lock.json's integrity hashes (PRINCIPLES §21; demo-scene-refresh's code review R1-SECURITY-002)", () => {
  it('every installed package has the integrity the lockfile gives it', () => {
    const installed = read('node_modules/.package-lock.json');
    expect(Object.values(installed.packages).filter((p) => p.integrity !== undefined).length).toBeGreaterThan(100);
    expect(integrityDiffers(read('package-lock.json'), installed)).toEqual([]);
  });

  it('names a package whose integrity the lockfile changed', () => {
    const installed: Lock = { packages: { 'node_modules/a': { integrity: 'sha512-P20=' }, 'node_modules/b': {} } };
    const lock: Lock = { packages: { 'node_modules/a': { integrity: 'sha512-P19=' }, 'node_modules/b': {} } };
    expect(integrityDiffers(lock, installed)).toEqual(['node_modules/a: sha512-P19= ≠ sha512-P20=']);
    expect(integrityDiffers(installed, installed)).toEqual([]);
  });
});
