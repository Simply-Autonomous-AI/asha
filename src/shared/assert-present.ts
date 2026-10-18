// One shared non-null check, for the `@typescript-eslint/no-non-null-assertion` fixes (docs/plans/lint-format.md
// R13): the value must be there, and when it is not, the error names what was missing — the fail-loudly rule
// (PRINCIPLES §9) — instead of a bare TypeError("Cannot read properties of undefined") from a `!` that lied.

/**
 * The value, asserted present: `value` when it is not `undefined` and not `null`, and otherwise an `Error` whose
 * message names `what` was missing. The message reads `<what> is missing`, with the received value quoted, so a
 * crash log says what to look for rather than a line number alone.
 */
export function present<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new Error(
      `${what} is missing (received ${value === undefined ? 'undefined' : 'null'}); the caller's invariant does not hold`,
    );
  }
  return value;
}
