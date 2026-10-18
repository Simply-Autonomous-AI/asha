// The catalogue's renumbering of 2026-10-16 (docs/plans/demo-scene-refresh.md R9): P14, Supervisor restart, became
// P25, and P15–P25 became P14–P24; P1–P13 and P26 kept their numbers. Records made before it — probe records, decision
// records — keep the numbers they had, so a test comparing today's tree with one maps between the two here.

/** Today's number of the pattern numbered `n` before 2026-10-16. */
export function renumbered(n: number): number {
  if (n === 14) return 25;
  return n >= 15 && n <= 25 ? n - 1 : n;
}

/** The number before 2026-10-16 of the pattern numbered `n` today. */
export function numberedBefore(n: number): number {
  if (n === 25) return 14;
  return n >= 14 && n <= 24 ? n + 1 : n;
}

/**
 * `text` with every pattern id in it — `P21`, `p21-a`, `p05` — given the number `map` gives its own, keeping its case
 * and its zero padding. An id is a `P` or `p` and one or two digits, with no letter or digit before it and no digit after.
 */
export function renumberIds(text: string, map: (n: number) => number): string {
  return text.replace(
    /(?<![\dA-Za-z])([Pp])(\d{1,2})(?!\d)/g,
    (_, p: string, digits: string) => p + String(map(Number(digits))).padStart(digits.length, '0'),
  );
}
