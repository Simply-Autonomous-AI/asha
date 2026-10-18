// The user-ID rule and the login-name conversion (cli-interactive R16, A15; taken over from agent-persistence R15).

import { describe, expect, it } from 'vitest';

import { USER_ID_REASONS, loginNameToUserId, userIdProblem } from '../../src/shared/protocol.js';

describe('loginNameToUserId', () => {
  it.each([
    ['John.Smith', 'john-smith'],
    ['j_smith', 'j-smith'],
    ['zora', 'zora'],
    ['Olga', 'olga'],
    ['olga.k', 'olga-k'],
    ['o_k', 'o-k'],
    ['ÉMILE', 'Émile'],
    ['a..b', 'a--b'],
    ['a b', 'a b'],
    ['User.3', 'user-3'],
    ['j_smith_2', 'j-smith-2'],
    ['Asha', 'asha'],
    ['_admin', '-admin'],
  ])('converts %j to %j: ASCII lowercased, . and _ to -, nothing else', (name, converted) => {
    expect(loginNameToUserId(name)).toBe(converted);
  });
});

describe('userIdProblem: one fixed reason per rule, in order', () => {
  it('states the four reasons exactly', () => {
    expect(USER_ID_REASONS).toEqual({
      pattern: 'a user ID is 1 to 32 characters: a lowercase letter, then lowercase letters, digits or hyphens',
      issued: 'user-<n> is the form the harness issues',
      number: 'only an issued ID (user-<n>) may end in -<number>',
      harness: '"asha" is the harness\'s own name',
    });
  });

  it.each([
    ['-admin', 'pattern'],
    ['Émile', 'pattern'],
    ['a'.repeat(33), 'pattern'],
    ['a b', 'pattern'],
    ['', 'pattern'],
    ['user-3', 'issued'],
    ['bob-2', 'number'],
    ['j-smith-2', 'number'],
    ['user-0', 'number'],
    ['user-01', 'number'],
    ['asha', 'harness'],
  ] as const)('the default %j breaks rule %s', (id, rule) => {
    expect(userIdProblem(id, { isDefault: true })).toBe(USER_ID_REASONS[rule]);
  });

  it.each(['olga', 'john-smith', 'a'.repeat(32), 'a1-b'])('accepts %j', (id) => {
    expect(userIdProblem(id, { isDefault: true })).toBeUndefined();
    expect(userIdProblem(id, { isDefault: false })).toBeUndefined();
  });

  it('a typed user-<n> is allowed: rule (2) is for the default only', () => {
    expect(userIdProblem('user-3', { isDefault: false })).toBeUndefined();
    expect(userIdProblem('user-0', { isDefault: false })).toBe(USER_ID_REASONS.number);
  });
});
