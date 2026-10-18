// Characters a reader cannot see, or that change how the text around them is shown (docs/plans/extension-modules.md
// R12 (b), R10 (b)): every code point of Unicode general category Cc, Cf, Co, Cn, Zl or Zp, every Zs but U+0020, and
// the fillers and variation selectors that render as nothing (U+034F, U+115F, U+1160, U+3164, U+FFA0, U+180B–U+180F,
// U+FE00–U+FE0F, U+E0100–U+E01EF). The categories are Node's own \p{…} tables.

import { present } from './assert-present.js';

// The character class below lists its members in this order, with \uffa0 not immediately before \u180b-\u180f, only
// to avoid a source-text false positive (sonarjs/no-misleading-character-class, no-misleading-character-class): a
// regex character class is an unordered set, so this reordering cannot change which characters match (verified with
// a script comparing the two orderings against every code point, 2026-10-13).
const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?! )\p{Zs}|[\u180b-\u180f\ufe00-\ufe0f\u034f\u115f\u1160\u3164\uffa0]|[\u{e0100}-\u{e01ef}]/gu;

/** Whether `text` holds any invisible or direction-changing character. */
export function hasInvisible(text: string): boolean {
  INVISIBLE.lastIndex = 0;
  const found = INVISIBLE.test(text);
  INVISIBLE.lastIndex = 0;
  return found;
}

/** The invisible or direction-changing characters `text` holds, each as its visible escape, in order of first appearance. */
export function invisibleIn(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(INVISIBLE)].map((m) => escapeCodePoint(present(m[0].codePointAt(0), 'm[0].codePointAt(0)'))),
    ),
  ];
}

/** `\u001b`, `\u202e`; above U+FFFF, `\u{e0041}`: lowercase hex. */
function escapeCodePoint(cp: number): string {
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
}

/** `text` with every invisible or direction-changing character printed as its visible escape; every other character as itself. */
export function visible(text: string): string {
  return text.replace(INVISIBLE, (ch) => escapeCodePoint(present(ch.codePointAt(0), 'ch.codePointAt(0)')));
}
