import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileUserLedger, UserLedgerCorrupt } from '../../src/daemon/channel/index.js';

async function file(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'asha-ledger-')), 'users.json');
}

describe('FileUserLedger', () => {
  it('issues increasing numbers per channel and writes them down', async () => {
    const f = await file();
    const ledger = new FileUserLedger(f);
    expect([ledger.issue('main'), ledger.issue('main'), ledger.issue('lab')]).toEqual([1, 2, 1]);
    expect(JSON.parse(await readFile(f, 'utf8'))).toEqual({ main: 2, lab: 1 });
  });

  it('carries on from the file after a restart, so no number is issued twice', async () => {
    const f = await file();
    new FileUserLedger(f).issue('main');
    new FileUserLedger(f).issue('main');
    expect(new FileUserLedger(f).issue('main')).toBe(3);
  });

  it('observe moves the counter past a number a user named, and never back', async () => {
    const f = await file();
    const ledger = new FileUserLedger(f);
    ledger.observe('main', 7);
    ledger.observe('main', 3);
    expect(ledger.issue('main')).toBe(8);
  });

  it('leaves no temporary file behind', async () => {
    const f = await file();
    new FileUserLedger(f).issue('main');
    expect(await readdir(join(f, '..'))).toEqual(['users.json']);
  });

  it.each([
    ['not JSON', '{', 'is not a valid user ledger'],
    ['not an object', '[1]', 'not an object'],
    ['a bad number', '{"main":-1}', 'channel "main" has -1'],
  ])('refuses a ledger that is %s', async (_, content, detail) => {
    const f = await file();
    await writeFile(f, content);
    expect(() => new FileUserLedger(f)).toThrow(UserLedgerCorrupt);
    expect(() => new FileUserLedger(f)).toThrow(detail);
  });
});
