// What reaches the model from a module or a plugin (docs/plans/extension-modules.md R10 (a), R33): at most 8,192 bytes
// of JSON, counted as the agent SDK counts a tool's result (`resultBytes`: the UTF-8 bytes of its JSON), cut by the
// harness before it answers, with a marker naming the bytes cut — never left for the SDK, which treats a larger result
// as a crash of the tool. An object's longest string fields are cut first (a plugin's stdout and stderr); anything else
// becomes {result_cut, partial}, the start of its JSON.

import { present } from '../../shared/assert-present.js';

/** The most bytes of JSON one tool result may carry (agent-tools R3). */
export const MAX_RESULT_JSON_BYTES = 8 * 1024;

/**
 * `JSON.stringify`, typed to admit the `undefined` it returns at runtime for `undefined`, a function or a symbol —
 * a gap in TypeScript's own declaration of `JSON.stringify` (it declares a bare `string`, unconditionally), which
 * would otherwise make `?? 'null'` below look like dead code to `@typescript-eslint/no-unnecessary-condition`.
 */
const stringify = JSON.stringify as (value: unknown) => string | undefined;

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(stringify(value) ?? 'null', 'utf8');
}

/** The longest prefix of `text` (whole characters) whose UTF-8 bytes are at most `bytes`. */
function prefixOf(text: string, bytes: number): string {
  if (bytes <= 0) return '';
  // Array.from, not a spread, so it is one function call reading the string's iterator (unicode code points) rather
  // than a `...` spread: same result, outside @typescript-eslint/no-misused-spread's spread-only check.
  const chars = Array.from(text);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(chars.slice(0, mid).join(''), 'utf8') <= bytes) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('');
}

/** The marker a cut string ends with. */
const cutMarker = (bytes: number): string => ` [${String(bytes)} bytes cut]`;

/**
 * Cuts one of `out`'s string fields to fit it under `MAX_RESULT_JSON_BYTES` (helper of {@link cutLongestStrings}):
 * the longest field's name, repeatedly cut and measured, since JSON escaping can make a byte of text cost more than
 * one byte of JSON.
 */
function cutOneLongestString(out: Record<string, unknown>, strings: readonly string[]): void {
  // The caller only calls this while strings is non-empty: an initial value (R12) of its first element, for
  // sonarjs/reduce-initial-value, reduces the same way a no-initial-value reduce would.
  const longest = strings.reduce(
    (a, b) => (Buffer.byteLength(out[a] as string) >= Buffer.byteLength(out[b] as string) ? a : b),
    present(strings[0], 'the longest string field (strings is non-empty here)'),
  );
  const text = out[longest] as string;
  const original = Buffer.byteLength(text, 'utf8');
  let keep = Math.max(0, original - (jsonBytes(out) - MAX_RESULT_JSON_BYTES) - 64);
  for (;;) {
    const kept = prefixOf(text, keep);
    out[longest] = `${kept}${cutMarker(original - Buffer.byteLength(kept, 'utf8'))}`;
    if (jsonBytes(out) <= MAX_RESULT_JSON_BYTES || keep === 0) return;
    keep = Math.max(0, keep - Math.max(64, jsonBytes(out) - MAX_RESULT_JSON_BYTES));
  }
}

/** Cuts `out`'s longest string fields, in place, until its JSON fits or none are left to cut (helper of {@link cutResult}). */
function cutLongestStrings(out: Record<string, unknown>): void {
  const strings = Object.keys(out).filter((k) => typeof out[k] === 'string');
  for (let round = 0; round < strings.length && jsonBytes(out) > MAX_RESULT_JSON_BYTES; round += 1)
    cutOneLongestString(out, strings);
}

/** The start of `json`, as `{result_cut, partial}`, cut until it fits `MAX_RESULT_JSON_BYTES` (helper of {@link cutResult}). */
function truncateToPartial(json: string): { readonly result_cut: string; readonly partial: string } {
  const total = Buffer.byteLength(json, 'utf8');
  let keep = MAX_RESULT_JSON_BYTES - 100;
  for (;;) {
    const partial = prefixOf(json, keep);
    const cut = { result_cut: `${String(total - Buffer.byteLength(partial, 'utf8'))} bytes cut`, partial };
    if (jsonBytes(cut) <= MAX_RESULT_JSON_BYTES || keep <= 0) return cut;
    keep -= Math.max(64, jsonBytes(cut) - MAX_RESULT_JSON_BYTES);
  }
}

/** `value` as it may reach the model: unchanged when its JSON fits, else cut to fit with a marker (R10 (a), R33). */
export function cutResult(value: unknown): unknown {
  if (jsonBytes(value) <= MAX_RESULT_JSON_BYTES) return value;
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const out: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    cutLongestStrings(out);
    if (jsonBytes(out) <= MAX_RESULT_JSON_BYTES) return out;
  }
  return truncateToPartial(stringify(value) ?? 'null');
}
