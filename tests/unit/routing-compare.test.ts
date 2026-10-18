// The routing first-request comparison (docs/plans/extension-modules.md R38; A38 (b)): evals/routing/compare.ts.

import { describe, expect, it } from 'vitest';

import { compareFirstRequests } from '../../evals/routing/compare.js';

const file = (cases: Record<string, string>, held: Record<string, string> = {}) => ({
  commit: 'c'.repeat(40),
  results: Object.entries(cases).map(([id, requestSha256]) => ({ id, requestSha256 })),
  heldOut: { results: Object.entries(held).map(([id, requestSha256]) => ({ id, requestSha256 })) },
});

describe('compareFirstRequests (A38 (b))', () => {
  it('passes when every case, held-out ones included, has the same first-request sha256', () => {
    expect(compareFirstRequests(file({ a: '1', b: '2' }, { h: '3' }), file({ b: '2', a: '1' }, { h: '3' }))).toEqual({
      ok: true,
      cases: 3,
    });
  });

  it('names the first case that differs, a case only one side has, and a held-out case', () => {
    expect(compareFirstRequests(file({ a: '1', b: '2' }), file({ a: '1', b: '9' }))).toEqual({
      ok: false,
      case: 'b',
      base: '2',
      head: '9',
    });
    expect(compareFirstRequests(file({ a: '1' }), file({ a: '1', z: '5' }))).toEqual({
      ok: false,
      case: 'z',
      base: 'absent',
      head: '5',
    });
    expect(compareFirstRequests(file({ a: '1' }, { h: '3' }), file({ a: '1' }, { h: '4' }))).toEqual({
      ok: false,
      case: 'h',
      base: '3',
      head: '4',
    });
  });

  it('finds a single changed prompt byte through the sha256 a real run records', async () => {
    const { sha256 } = await import('../../evals/routing/record.js');
    const body = '{"messages":[{"role":"system","content":"You are hewo-1."}]}';
    expect(
      compareFirstRequests(file({ solo: sha256(body) }), file({ solo: sha256(body.replace('hewo-1.', 'hewo-1!')) })).ok,
    ).toBe(false);
  });
});
