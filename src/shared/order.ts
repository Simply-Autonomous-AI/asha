// One shared comparator, for the `sonarjs/no-alphabetical-sort` fixes (docs/plans/lint-format.md R12): the order
// the code has today, kept everywhere. UTF-16 code-unit order for strings — never `localeCompare`, whose order
// depends on the ICU locale — and numeric order for numbers. A comparator returned by one of these functions is
// pure and total on its input type, so `Array.prototype.sort` is deterministic and stable (ES2023).

/**
 * The comparator for strings: ascending UTF-16 code-unit order, `<`'s own order. Sorting is stable, so strings
 * equal under `<` keep the order they were in.
 */
export const byCodeUnit = (a: string, b: string): number => {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
};

/**
 * The comparator for numbers: ascending numeric order. `NaN` sorts last, after every number (including the
 * infinities), rather than being left where the sort happens to put it: a `NaN` in the input is a caller's bug,
 * but its position stays deterministic.
 */
export const byNumber = (a: number, b: number): number => {
  const aNaN = Number.isNaN(a);
  const bNaN = Number.isNaN(b);
  if (aNaN || bNaN) {
    if (aNaN && bNaN) return 0;
    return aNaN ? 1 : -1;
  }
  return a - b;
};

/**
 * The comparator for objects by one string property: ascending UTF-16 code-unit order of that property's value.
 * The property is read with `Record<string, unknown>`'s access and must be a string; anything else throws,
 * naming the property — the fail-loudly rule (PRINCIPLES §9), not a silent mis-sort.
 */
export const byKey =
  <K extends string>(key: K) =>
  (a: Record<K, unknown>, b: Record<K, unknown>): number => {
    const x = a[key];
    const y = b[key];
    if (typeof x !== 'string' || typeof y !== 'string')
      throw new TypeError(
        `byKey(${JSON.stringify(key)}): both values must be strings, got ${typeof x} and ${typeof y}`,
      );
    return byCodeUnit(x, y);
  };
