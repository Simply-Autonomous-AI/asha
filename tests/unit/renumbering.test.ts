// The map between the catalogue's numbers before and after its renumbering of 2026-10-16
// (docs/plans/demo-scene-refresh.md R9), as the tests that read older records use it.

import { describe, expect, it } from 'vitest';

import { numberedBefore, renumbered, renumberIds } from '../helpers/renumbering.js';

describe('the renumbering of 2026-10-16 (demo-scene-refresh R9)', () => {
  it('moves P14 to P25 and P15–P25 down one, and keeps P1–P13 and P26', () => {
    expect(Array.from({ length: 26 }, (_, i) => renumbered(i + 1))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 25, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26,
    ]);
  });

  it('numberedBefore undoes renumbered for every number of the catalogue', () => {
    expect(Array.from({ length: 26 }, (_, i) => numberedBefore(renumbered(i + 1)))).toEqual(
      Array.from({ length: 26 }, (_, i) => i + 1),
    );
  });

  it('renumbers each id in a text, keeping its case and padding, and leaves what is not an id', () => {
    expect(
      renumberIds('P21, checkpoint and resume (p21-a; p21-b); P14 and p05; R14, MP4, p21a-timing, P140', renumbered),
    ).toBe('P20, checkpoint and resume (p20-a; p20-b); P25 and p05; R14, MP4, p20a-timing, P140');
    expect(renumberIds('p25-a/worker-first p14-a/clerk-first', numberedBefore)).toBe(
      'p14-a/worker-first p15-a/clerk-first',
    );
  });
});
