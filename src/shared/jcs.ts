// RFC 8785, the JSON Canonicalization Scheme (docs/plans/extension-modules.md R12): one byte string per JSON value,
// so the CLI and the daemon hash exactly what the user was shown. Object members sorted by their names' UTF-16 code
// units, no whitespace, numbers as ECMAScript prints them, strings escaped as JSON.stringify escapes them (which is
// RFC 8785's escaping: \b \t \n \f \r \" \\ and \u00xx, lowercase, for the other controls). A lone surrogate or a
// number that is not finite has no canonical form and throws: such a value never reaches a hash.

import { byCodeUnit } from './order.js';

/** A JSON value has no RFC 8785 form: a lone surrogate, a non-finite number, or a value JSON cannot hold. */
export class NotCanonicalizable extends Error {
  constructor(detail: string) {
    super(`not canonicalizable (RFC 8785): ${detail}`);
    this.name = 'NotCanonicalizable';
  }
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** One object member, `"name":value`, both already in RFC 8785 form — its own function so the member's template
 * literal is not nested inside the object's. */
function canonicalMember(key: string, value: unknown): string {
  return `${canonicalJson(key)}:${canonicalJson(value)}`;
}

/** The RFC 8785 text of `value`. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new NotCanonicalizable(`the number ${String(value)}`);
      // ECMAScript's Number.prototype.toString is RFC 8785's number form; -0 prints as 0.
      return JSON.stringify(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new NotCanonicalizable('a string holds a lone surrogate');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
      // UTF-16 code unit order: JavaScript's default string comparison.
      entries.sort(([a], [b]) => byCodeUnit(a, b));
      return `{${entries.map(([k, v]) => canonicalMember(k, v)).join(',')}}`;
    }
    default:
      throw new NotCanonicalizable(`a ${typeof value}`);
  }
}
