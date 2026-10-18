// File names (docs/plans/agent-files.md R13, A7): the name rule the CLI and the daemon each apply, the suffix rule
// for a taken name, and the names of one upload made unique.

import { describe, expect, it } from 'vitest';

import { FILE_NAME_MAX_BYTES, fileNameProblem, suffixedName, uniqueNames } from '../../src/shared/files.js';

describe('the name rule (R13, A7)', () => {
  it.each([
    ['../x', /"\/"/],
    ['a/b', /"\/"/],
    ['.', /"\." or "\.\."/],
    ['..', /"\." or "\.\."/],
    ['line\nbreak', /control character/],
    ['nul\u0000', /control character/],
    ['del\u007f', /control character/],
    ['c1\u0085', /control character/],
    ['', /empty/],
    ['x'.repeat(256), /over 255 bytes/],
    ['é'.repeat(128), /over 255 bytes/],
    ['é', /NFC/],
  ])('refuses %j', (name, rule) => {
    expect(fileNameProblem(name, { returned: false })).toMatch(rule);
  });

  it('accepts ordinary names, spaces and Unicode, at exactly 255 bytes', () => {
    for (const name of [
      'notes.txt',
      'My Report.pdf',
      '.bashrc',
      'résumé.pdf',
      'x'.repeat(255),
      'é'.repeat(127) + 'x',
    ]) {
      expect(fileNameProblem(name, { returned: false })).toBeUndefined();
    }
  });

  it('a returned name may not begin with "." (it becomes a host path); others pass as attached names do', () => {
    expect(fileNameProblem('.x', { returned: true })).toMatch(/may not begin with "\."/);
    expect(fileNameProblem('.bashrc', { returned: true })).toMatch(/may not begin with "\."/);
    expect(fileNameProblem('../x', { returned: true })).toMatch(/"\/"/);
    expect(fileNameProblem('out.txt', { returned: true })).toBeUndefined();
  });

  it('a decomposed é arrives NFC once the CLI normalises it', () => {
    const decomposed = 'café.txt';
    expect(fileNameProblem(decomposed, { returned: false })).toMatch(/NFC/);
    expect(fileNameProblem(decomposed.normalize('NFC'), { returned: false })).toBeUndefined();
    expect(decomposed.normalize('NFC')).toBe('café.txt');
  });
});

describe('the suffix rule for a taken name (R13, A7)', () => {
  it('puts -n before the last extension, or at the end when the only dot is the first character', () => {
    expect(suffixedName('a.tar.gz', 2)).toBe('a.tar-2.gz');
    expect(suffixedName('.bashrc', 2)).toBe('.bashrc-2');
    expect(suffixedName('notes', 2)).toBe('notes-2');
    expect(suffixedName('out.txt', 3)).toBe('out-3.txt');
  });

  it('a taken 255-byte name of two-byte characters becomes 255 bytes or fewer with -2, never splitting a character', () => {
    const fits = 'é'.repeat(126) + '.xa'; // 252 + 3 = 255 bytes
    expect(Buffer.byteLength(fits)).toBe(255);
    const suffixed = suffixedName(fits, 2);
    expect(Buffer.byteLength(suffixed)).toBeLessThanOrEqual(FILE_NAME_MAX_BYTES);
    expect(suffixed.endsWith('-2.xa')).toBe(true);
    // Whole characters only: the stem is still every é it kept, with no half character.
    expect(suffixed.slice(0, -'-2.xa'.length)).toMatch(/^é+$/);
    expect(Buffer.from(suffixed, 'utf8').toString('utf8')).toBe(suffixed);
  });

  it('two files of one upload with one name are <name> and <name>-2; a third is <name>-3', () => {
    expect(uniqueNames(['notes.txt', 'notes.txt', 'b.txt', 'notes.txt'])).toEqual([
      'notes.txt',
      'notes-2.txt',
      'b.txt',
      'notes-3.txt',
    ]);
  });
});

describe('an extension that leaves no room for the suffix (completion review, finding 12)', () => {
  it('is treated as part of the name: the suffix goes at the end, the name trimmed to 255 bytes; two such files of one upload get distinct names', async () => {
    const { suffixedName, uniqueNames, fileNameProblem } = await import('../../src/shared/files.js');
    const name = `a.${'e'.repeat(253)}`;
    expect(Buffer.byteLength(name)).toBe(255);
    const second = suffixedName(name, 2);
    expect(second).toBe(`a.${'e'.repeat(251)}-2`);
    expect(Buffer.byteLength(second)).toBe(255);
    expect(fileNameProblem(second, { returned: true })).toBeUndefined();
    expect(uniqueNames([name, name])).toEqual([name, second]);
  });
});
