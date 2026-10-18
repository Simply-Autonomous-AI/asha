// Secret redaction (docs/plans/extension-modules.md R33, R35): every value of a module's secrets replaced by
// `[redacted]` in what the harness logs or returns from that module, and a trailing fragment that is a prefix of one —
// a capture or a line cut in the middle of a secret — of at least MIN_FRAGMENT characters, and a leading fragment
// that is a suffix of one: the second half of a secret split across two lines (review of 2026-10-02, B-8).

const REDACTED = '[redacted]';
/** The shortest trailing prefix of a secret that is redacted: a shorter one is too common to tell from text. */
const MIN_FRAGMENT = 4;

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  // Longest first, so a secret that contains another is redacted whole.
  const values = [...new Set(secrets.filter((s) => s.length > 0))].sort((a, b) => b.length - a.length);
  for (const secret of values) out = out.split(secret).join(REDACTED);
  for (const secret of values) {
    for (let n = Math.min(secret.length - 1, out.length); n >= MIN_FRAGMENT; n -= 1) {
      if (out.endsWith(secret.slice(0, n))) {
        out = `${out.slice(0, out.length - n)}${REDACTED}`;
        break;
      }
    }
    for (let n = Math.min(secret.length - 1, out.length); n >= MIN_FRAGMENT; n -= 1) {
      if (out.startsWith(secret.slice(secret.length - n))) {
        out = `${REDACTED}${out.slice(n)}`;
        break;
      }
    }
  }
  return out;
}

/** `value` with every string in it — at any depth, keys included — redacted; a module's answer as the harness passes it on (B-13). */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [redact(k, secrets), redactValue(v, secrets)]));
  return value;
}
