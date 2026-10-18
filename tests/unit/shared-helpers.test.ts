// The shared helpers of docs/plans/lint-format.md R12 and R13: the comparator's exact order (A10) and the
// non-null check's message naming what was missing (A10). Each test seen failing by mutating its subject:
// byCodeUnit via localeCompare's order ( Swedish 'ö' after 'z' in code-unit order, before it in sv-SE),
// byNumber via returning 0 for everything, byKey via accepting non-strings, present via not throwing.

import { describe, expect, it } from 'vitest';

import { byCodeUnit, byKey, byNumber } from '../../src/shared/order.js';
import { present } from '../../src/shared/assert-present.js';

describe("byCodeUnit (lint-format R12: UTF-16 code-unit order, not the locale's)", () => {
  it('orders mixed case by code unit: capitals before lower-case, exactly as < does', () => {
    const words = ['banana', 'Apple', 'cherry', 'apple', 'Banana'];
    expect([...words].sort(byCodeUnit)).toEqual(['Apple', 'Banana', 'apple', 'banana', 'cherry']);
  });

  it('orders accented strings by code unit, not by the ICU locale: ä before z in code units, after it in German', () => {
    // Code units: Ä U+00C4, ä U+00E4, ö U+00F6 — all above A–Z (U+0041–U+005A) and a–z (U+0061–U+007A), so
    // 'xylophon' (x, U+0078) sorts before 'Ärmel', 'äpple' and 'örn', which no locale does.
    const words = ['xylophon', 'örn', 'äpple', 'Ärmel'];
    expect([...words].sort(byCodeUnit)).toEqual(['xylophon', 'Ärmel', 'äpple', 'örn']);
    // The trap R12 names, demonstrated: in German, ä sorts as a — before z; in code-unit order it is U+00E4, after
    // z (U+007A). localeCompare would flip this order; the comparator keeps the code's today, the code-unit order.
    expect('ä'.localeCompare('z', 'de')).toBe(-1); // the locale's order
    expect(byCodeUnit('ä', 'z')).toBe(1); // code-unit order does not follow it
    expect('b'.localeCompare('Å', 'de')).toBe(1); // the locale puts Å after b…
    expect(byCodeUnit('b', 'Å')).toBe(-1); // …the code-unit order does not
  });

  it('orders digits and punctuation by code unit: "10" before "2", ";" before "A"', () => {
    expect([...['2', '10', '1', '10.5']].sort(byCodeUnit)).toEqual(['1', '10', '10.5', '2']);
    expect(byCodeUnit(';', 'A')).toBe(-1);
  });

  it('is a total order: equal strings return 0, and every pair returns exactly -1 or 1 otherwise', () => {
    expect(byCodeUnit('a', 'a')).toBe(0);
    for (const [x, y] of [
      ['a', 'b'],
      ['b', 'a'],
      ['', 'a'],
      ['a', ''],
      ['😀', 'a'], // a surrogate pair's high surrogate (U+D83D) is after 'a' (U+0061)
    ] as const) {
      const forward = byCodeUnit(x, y);
      const backward = byCodeUnit(y, x);
      expect(forward === -1 || forward === 1).toBe(true);
      expect(Math.sign(forward)).toBe(-Math.sign(backward));
    }
    expect(byCodeUnit('a', '😀')).toBe(-1);
  });
});

describe('byNumber (lint-format R12: numeric order for numbers)', () => {
  it('orders numerically, not lexically: 2 before 10, -3 before -1, 0.5 before 1', () => {
    expect([...[10, 2, 1, -3, 0.5, 0]].sort(byNumber)).toEqual([-3, 0, 0.5, 1, 2, 10]);
  });

  it('keeps a deterministic place for NaN: after every number, NaNs together', () => {
    expect([...[3, NaN, 1, NaN, 2]].sort(byNumber)).toEqual([1, 2, 3, NaN, NaN]);
    expect([...[Infinity, -Infinity, 0]].sort(byNumber)).toEqual([-Infinity, 0, Infinity]);
  });

  it('is antisymmetric and reflexive', () => {
    expect(byNumber(1, 1)).toBe(0);
    expect(Math.sign(byNumber(1, 2))).toBe(-Math.sign(byNumber(2, 1)));
  });
});

describe('byKey (lint-format R12: sort objects by one string property, in code-unit order)', () => {
  it('sorts by the named property in code-unit order', () => {
    const rows = [{ name: 'zeta' }, { name: 'Alpha' }, { name: 'mid' }];
    expect([...rows].sort(byKey('name'))).toEqual([{ name: 'Alpha' }, { name: 'mid' }, { name: 'zeta' }]);
  });

  it('is stable for equal keys', () => {
    const rows = [
      { name: 'a', n: 1 },
      { name: 'a', n: 2 },
      { name: 'a', n: 3 },
    ];
    expect([...rows].sort(byKey('name')).map((r) => r['n'])).toEqual([1, 2, 3]);
  });

  it('fails loudly naming the property when a value is not a string (PRINCIPLES §9), never silently mis-sorts', () => {
    const bad = [{ name: 'a' }, { name: 7 }];
    // Whichever of the two objects the sort's first comparison puts on which side, the pair is (string, number)
    // one way and (number, string) the other — the message names the property and both types in either order.
    expect(() => [...bad].sort(byKey('name'))).toThrow(TypeError);
    expect(() => [...bad].sort(byKey('name'))).toThrow('"name"');
    expect(() => [...bad].sort(byKey('name'))).toThrow(
      /both values must be strings, got (string and number|number and string)/,
    );
  });
});

describe('present (lint-format R13: the shared non-null check, naming what was missing)', () => {
  it('returns the value itself when it is present, including falsy values', () => {
    expect(present('x', 'the word')).toBe('x');
    expect(present(0, 'the count')).toBe(0);
    expect(present('', 'the text')).toBe('');
    expect(present(false, 'the flag')).toBe(false);
    const obj = { a: 1 };
    expect(present(obj, 'the object')).toBe(obj);
  });

  it('throws naming what was missing when it is undefined', () => {
    const check = (): void => {
      present(undefined, 'the row for key "lab"');
    };
    expect(check).toThrow('the row for key "lab" is missing');
    expect(check).toThrow('received undefined');
  });

  it('throws naming what was missing when it is null', () => {
    const check = (): void => {
      present(null, 'the parsed JSON');
    };
    expect(check).toThrow('the parsed JSON is missing');
    expect(check).toThrow('received null');
  });

  it('narrows the type: the returned value is T, not T | undefined (checked by tsc, asserted here by use)', () => {
    const maybe: string | undefined = 'value';
    const sure: string = present(maybe, 'the maybe');
    expect(sure).toHaveLength(5);
  });
});
