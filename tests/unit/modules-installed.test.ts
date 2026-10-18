// The daemon's start reading the installed modules (docs/plans/extension-modules.md R2, R3, R18a, R38; A2, A3, A18,
// A34): src/daemon/modules/installed.ts — manifests only, never a name beginning with ".", an interrupted upgrade
// logged, an invalid manifest failing the start naming the module and the field, and approved caps over $50 refused.

import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { APPROVED_CAP_TOTAL_USD, CapsOverApproval, loadInstalledModules } from '../../src/daemon/modules/index.js';
import { ManifestInvalid } from '../../src/shared/modules.js';
import { present } from '../../src/shared/assert-present.js';
import { RecordingLogger } from '../helpers/fakes.js';
import { cloudToolManifest, providerManifest, toolModuleManifest, writeModuleDir } from '../helpers/modules.js';

const FILES = {
  'index.mjs': 'export async function call() {}\n',
  'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}\n',
};
const metered = (id: string, capUsd: number) =>
  cloudToolManifest({
    id,
    cost: {
      model: 'metered',
      perCall: { unit: 'credit', units: 1, unitUsd: 0.008, url: 'https://x.example/p', read: '2026-09-27' },
      approved: { by: 'the owner', date: '2026-09-27', capUsd },
    },
  });

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'asha-installed-'));
}

describe('loadInstalledModules (R3, R38)', () => {
  it('with no modules directory reads, logs and creates nothing', async () => {
    const h = await home();
    const logger = new RecordingLogger();
    expect(await loadInstalledModules(join(h, 'modules'), logger)).toEqual(new Map());
    expect(logger.entries).toEqual([]);
    expect(await readdir(h)).toEqual([]);
  });

  it("loads each installed module's manifest, never a name beginning with '.', and logs which", async () => {
    const h = await home();
    const dir = join(h, 'modules');
    await writeModuleDir(toolModuleManifest(), FILES, dir);
    // A leftover staging directory and a replaced one beside its module: their (broken) manifests are never read.
    for (const name of ['.staging-1a2b', '.replaced-fixture_tool-3c4d']) {
      await mkdir(join(dir, name));
      await writeFile(join(dir, name, 'module.json'), '{ not json');
    }
    const logger = new RecordingLogger();
    const loaded = await loadInstalledModules(dir, logger);
    expect([...loaded.keys()]).toEqual(['fixture_tool']);
    expect(present(loaded.get('fixture_tool'), "loaded.get('fixture_tool')").dir).toBe(join(dir, 'fixture_tool'));
    expect(logger.entries).toEqual([{ level: 'info', event: 'modules.loaded', fields: { modules: ['fixture_tool'] } }]);
  });

  it('logs an interrupted upgrade — a .replaced-<id>-* with no <id>/ — at error, naming the id and the repair', async () => {
    const h = await home();
    const dir = join(h, 'modules');
    await mkdir(join(dir, '.replaced-fixture_tool-9f9f'), { recursive: true });
    const logger = new RecordingLogger();
    expect(await loadInstalledModules(dir, logger)).toEqual(new Map());
    expect(logger.entries.map((e) => [e.level, e.event, e.fields['module'], e.fields['leftover']])).toEqual([
      ['error', 'module.upgrade_interrupted', 'fixture_tool', '.replaced-fixture_tool-9f9f'],
    ]);
    expect((present(logger.entries[0], 'logger.entries[0]').fields['error'] as Error).message).toContain(
      'asha --install-module path=<its directory>',
    );
  });

  it('fails the start on an invalid manifest, naming the module and the field (A2)', async () => {
    const h = await home();
    const dir = join(h, 'modules');
    await writeModuleDir(toolModuleManifest({ hosts: ['*.com'] }), FILES, dir);
    const error = await loadInstalledModules(dir, new RecordingLogger()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManifestInvalid);
    expect((error as Error).message).toBe(
      'module fixture_tool: hosts: "*.com" a wildcard needs at least three labels after "*.", and "*.com" has 1',
    );
  });

  it('fails the start on a module.json that is not JSON, naming the module (B-27)', async () => {
    const h = await home();
    const dir = join(h, 'modules');
    await writeModuleDir(toolModuleManifest(), FILES, dir);
    await writeFile(join(dir, 'fixture_tool', 'module.json'), '{ not json');
    const error = await loadInstalledModules(dir, new RecordingLogger()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ManifestInvalid);
    expect((error as Error).message).toMatch(
      /^module fixture_tool: module\.json: .*fixture_tool\/module\.json does not read as JSON \(/,
    );
  });

  it('fails the start when the approved caps sum to 51, naming 51; 50 starts (R18a, A18)', async () => {
    expect(APPROVED_CAP_TOTAL_USD).toBe(50);
    const over = join(await home(), 'modules');
    await writeModuleDir(metered('one', 25), FILES, over);
    await writeModuleDir(metered('two', 26), FILES, over);
    const error = await loadInstalledModules(over, new RecordingLogger()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CapsOverApproval);
    expect((error as Error).message).toBe(
      "the installed modules' approved caps (cost.approved.capUsd) sum to 51 USD a month, over the 50 the owner approved (docs/plans/extension-modules.md R18a)",
    );
    const at = join(await home(), 'modules');
    await writeModuleDir(metered('one', 25), FILES, at);
    await writeModuleDir(
      providerManifest({ id: 'two' }),
      {
        'index.mjs': 'export async function chat() {}\n',
        'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}\n',
      },
      at,
    );
    expect([...(await loadInstalledModules(at, new RecordingLogger())).keys()]).toEqual(['one', 'two']);
  });
});
