// The module secret store (docs/plans/extension-modules.md R7, R32, R35): src/daemon/secrets/index.ts's every value
// for redaction and the content scan, and its refusal of a file that is not one it wrote (review of 2026-10-02, B-26).

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileSecretStore, SecretStoreCorrupt } from '../../src/daemon/secrets/index.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { RecordingLogger } from '../helpers/fakes.js';

async function store() {
  const home = await mkdtemp(join(tmpdir(), 'asha-secrets-'));
  const dir = join(home, 'secrets');
  const secrets = new FileSecretStore({
    home,
    dir,
    logger: new RecordingLogger(),
    pid: process.pid,
    isAlive: () => false,
    insideGitTree: () => Promise.resolve(false),
  });
  return { dir, secrets };
}

describe('FileSecretStore.allValues', () => {
  it("is empty with no secrets directory, and every module file's every value once one is written, other files left out", async () => {
    const s = await store();
    expect(await s.secrets.allValues()).toEqual([]);
    await s.secrets.set('fixture_search', 'SEARCH_KEY', 'v-search');
    await s.secrets.set('fixture_search', 'OTHER_KEY', 'v-other');
    await s.secrets.set('bedrock', 'AWS_BEARER_TOKEN_BEDROCK', 'v-bedrock');
    await writeFile(join(s.dir, 'notes.txt'), 'not a module file');
    await writeFile(join(s.dir, 'Not_A_Module.json'), '{"X":"y"}');
    expect([...(await s.secrets.allValues())].sort(byCodeUnit)).toEqual(['v-bedrock', 'v-other', 'v-search']);
  });

  it('throws SecretStoreCorrupt, naming the file, for a module file that is not JSON, not an object, or holds a non-string', async () => {
    for (const [text, detail] of [
      ['{not json', 'it is not JSON'],
      ['["a"]', 'it is not a JSON object'],
      ['{"SEARCH_KEY": 1}', 'an entry is not a secret name with a string value'],
      ['{"lower": "x"}', 'an entry is not a secret name with a string value'],
    ] as const) {
      const s = await store();
      await mkdir(s.dir, { recursive: true });
      await writeFile(join(s.dir, 'fixture_search.json'), text);
      const error = await s.secrets.allValues().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SecretStoreCorrupt);
      expect((error as Error).message).toBe(
        `${join(s.dir, 'fixture_search.json')}: ${detail}; remove it and set the module's secrets again with asha --set-secret`,
      );
      await expect(s.secrets.get('fixture_search')).rejects.toBeInstanceOf(SecretStoreCorrupt);
    }
  });
});
