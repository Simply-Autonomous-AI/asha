// A launch's modules, checked before any container starts (docs/plans/extension-modules.md R9, R18b, R18c, R19, R20,
// R25, R29, R30, R34; A18, A19, A22, A27, A28's roots, A32's bounds): src/daemon/modules/launch.ts.

import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  checkLaunchModules,
  isCloudGrantedRecipe,
  ModuleRefused,
  sharedRootRefusal,
  TURN_OVERHEAD_MS,
  type InstalledModule,
} from '../../src/daemon/modules/index.js';
import type { Recipe, RootSpec } from '../../src/daemon/definitions/index.js';
import { present } from '../../src/shared/assert-present.js';
import { parseModuleManifest } from '../../src/shared/modules.js';
import { cloudToolManifest, pluginManifest, providerManifest, toolModuleManifest } from '../helpers/modules.js';

const installed = (raw: Record<string, unknown>): InstalledModule => ({
  manifest: parseModuleManifest(raw, 'module.json', String(raw['id'])),
  dir: `/m/${String(raw['id'])}`,
});

const MODULES = new Map<string, InstalledModule>(
  [
    installed(toolModuleManifest()),
    installed(cloudToolManifest()),
    installed(providerManifest()),
    installed({ ...providerManifest(), id: 'free_provider', cost: { model: 'free' } }),
    installed(pluginManifest()),
    installed({ ...pluginManifest(), id: 'unapproved_cli', cost: { model: 'external-unmetered' } }),
    installed(
      cloudToolManifest({
        id: 'metered_search',
        cost: {
          model: 'metered',
          perCall: { unit: 'credit', units: 1, unitUsd: 0.008, url: 'https://x.example/p', read: '2026-09-27' },
          approved: { by: 'the owner', date: '2026-09-27', capUsd: 25 },
        },
      }),
    ),
  ].map((m) => [m.manifest.id, m]),
);

const RECIPE: Recipe = {
  id: 'r',
  image: 'hello-world',
  description: 'x',
  prompt: 'x',
  model: 'qwen3-8b-q4_k_m',
  startupTimeoutMs: 10_000,
  messageTimeoutMs: 200_000,
  chat: {},
  embeddingModel: null,
  tools: [],
  documents: [],
  persist: [],
  modules: [],
  roots: [],
};

async function homes() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'asha-launch-')));
  const home = join(base, 'home');
  const ashaHome = join(home, '.simplyautonomous', 'harness');
  await mkdir(ashaHome, { recursive: true });
  return { base, home, ashaHome };
}

type CheckOptions = {
  teamRoots?: RootSpec[];
  keepsMemory?: boolean;
  enabled?: string[];
  corruptMeter?: boolean;
  home?: string;
  ashaHome?: string;
};

function meterState(moduleId: string, options: CheckOptions): 'enabled' | 'disabled' | 'unavailable' {
  if (options.corruptMeter === true) return 'unavailable';
  return (options.enabled ?? []).includes(moduleId) ? 'enabled' : 'disabled';
}

async function check(recipe: Partial<Recipe>, options: CheckOptions = {}) {
  const h =
    options.home === undefined
      ? await homes()
      : { home: options.home, ashaHome: present(options.ashaHome, 'options.ashaHome') };
  return checkLaunchModules(
    {
      installed: MODULES,
      meter: (m) => meterState(m, options),
      ashaHome: h.ashaHome,
      home: h.home,
    },
    { ...RECIPE, ...recipe },
    'recipes/r.json',
    options.teamRoots ?? [],
    options.keepsMemory ?? false,
    'hello-world',
  );
}

const refusal = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'launched',
    (e: unknown) => (e instanceof ModuleRefused ? e.message : `not ModuleRefused: ${String(e)}`),
  );

describe('grants (R29, A27)', () => {
  it("resolves exactly the granted tool and command, in the recipe's order, by wire name", async () => {
    const out = await check({ modules: ['fixture_cli/retry_stage', 'fixture_tool/lookup'] });
    expect(out.grants).toEqual([
      { module: 'fixture_cli', command: 'retry_stage' },
      { module: 'fixture_tool', command: 'lookup' },
    ]);
    expect([...out.tools.keys()]).toEqual(['fixture_cli__retry_stage', 'fixture_tool__lookup']);
    expect([...out.tools.values()].map((t) => [t.kind, t.classes, t.timeoutMs])).toEqual([
      ['command', ['egress', 'consequential'], 30_000],
      ['tool', [], 5_000],
    ]);
    expect(out.acquire).toEqual(['fixture_cli', 'fixture_tool']);
  });

  it('refuses a command the module does not declare, a module not installed, and a granted ModelProvider, naming both', async () => {
    expect(await refusal(check({ modules: ['fixture_cli/delete_pipeline'] }))).toBe(
      'recipes/r.json: it grants fixture_cli/delete_pipeline, and module fixture_cli declares no tool delete_pipeline',
    );
    expect(await refusal(check({ modules: ['nope/x'] }))).toBe(
      'recipes/r.json: it grants nope/x, and module nope is not installed',
    );
    expect(await refusal(check({ modules: ['fixture_provider/chat'] }))).toBe(
      'recipes/r.json: it grants fixture_provider/chat, and fixture_provider is a ModelProvider: a recipe uses one by naming its model (R29)',
    );
  });
});

describe('the message bound (R34, A32)', () => {
  it('refuses timeoutMs + 124,999 ms over messageTimeoutMs, naming both values and the rule; launches at + 125,000 ms', async () => {
    expect(TURN_OVERHEAD_MS).toBe(125_000);
    expect(await refusal(check({ modules: ['fixture_tool/lookup'], messageTimeoutMs: 5_000 + 124_999 }))).toBe(
      "recipes/r.json: it grants fixture_tool/lookup, whose timeoutMs 5000 + 125000 ms (two model calls and the SDK's margin) is over its messageTimeoutMs 129999: a turn using it would be stopped (R34)",
    );
    expect((await check({ modules: ['fixture_tool/lookup'], messageTimeoutMs: 5_000 + 125_000 })).tools.size).toBe(1);
  });

  it('launches a tool of timeoutMs 1 with messageTimeoutMs 125,001', async () => {
    const tiny = new Map(MODULES);
    const t = installed(
      toolModuleManifest({
        id: 'tiny',
        tools: [{ ...(toolModuleManifest()['tools'] as Record<string, unknown>[])[0], timeoutMs: 1 }],
      }),
    );
    tiny.set('tiny', t);
    const h = await homes();
    const out = await checkLaunchModules(
      { installed: tiny, meter: () => 'disabled', ashaHome: h.ashaHome, home: h.home },
      { ...RECIPE, modules: ['tiny/lookup'], messageTimeoutMs: 125_001 },
      'recipes/r.json',
      [],
      false,
      'hello-world',
    );
    expect(present(out.tools.get('tiny__lookup'), 'tiny__lookup tool').timeoutMs).toBe(1);
  });
});

describe('cost (R18b, R18c, A18)', () => {
  it("refuses a command plugin whose manifest lacks the owner's approval, and a metered module not enabled", async () => {
    expect(await refusal(check({ modules: ['unapproved_cli/get_state'] }))).toBe(
      "recipes/r.json: it grants unapproved_cli/get_state, and command plugin unapproved_cli has no owner's approval of its cost (cost.approved) in its manifest (R18c)",
    );
    expect(await refusal(check({ modules: ['metered_search/search'] }))).toBe(
      'recipes/r.json: it grants metered_search/search, and module metered_search is metered and not enabled: asha --enable-module id=metered_search conversation=<usd> day=<usd> month=<usd>',
    );
    expect((await check({ modules: ['metered_search/search'] }, { enabled: ['metered_search'] })).cloud).toEqual([
      'metered_search',
    ]);
    expect(
      await refusal(check({ modules: ['metered_search/search'] }, { enabled: ['metered_search'], corruptMeter: true })),
    ).toBe(
      'recipes/r.json: it grants metered_search/search, and module metered_search is metered, and metering.json does not parse: every metered call is refused until it is repaired or removed (budget_meter_unavailable)',
    );
  });
});

describe('provider models (R19, R20, A19)', () => {
  it("resolves a provider model with the recipe's chat over the model's, and marks it cloud", async () => {
    const out = await check(
      { model: 'fixture_provider/small', chat: { top_p: 0.9 } },
      { enabled: ['fixture_provider'] },
    );
    expect(out.chat).toMatchObject({ module: 'fixture_provider', settings: { temperature: 0, top_p: 0.9 } });
    expect(present(out.chat, 'out.chat').model.id).toBe('vendor.small-model-v1');
    expect(out.cloud).toEqual(['fixture_provider/small']);
    expect(out.cloudGranted).toBe(true);
    expect(out.acquire).toEqual(['fixture_provider']);
  });

  it('refuses a chat key the provider does not translate (top_k), a model not declared, and a metered provider not enabled', async () => {
    expect(
      await refusal(check({ model: 'fixture_provider/small', chat: { top_k: 40 } }, { enabled: ['fixture_provider'] })),
    ).toBe(
      'recipes/r.json: chat.top_k is not one of temperature, top_p, the settings provider fixture_provider translates (R19)',
    );
    expect(await refusal(check({ model: 'fixture_provider/large' }, { enabled: ['fixture_provider'] }))).toBe(
      'recipes/r.json: module fixture_provider declares no model large',
    );
    expect(await refusal(check({ model: 'fixture_provider/small' }))).toBe(
      'recipes/r.json: module fixture_provider is metered and not enabled: asha --enable-module id=fixture_provider conversation=<usd> day=<usd> month=<usd>',
    );
    expect(await refusal(check({ model: 'fixture_tool/small' }))).toBe(
      'recipes/r.json: fixture_tool/small names module fixture_tool, which is a ToolModule, not a ModelProvider',
    );
  });
});

describe('memory never leaves the machine (R25, A22)', () => {
  it('refuses an image that keeps memory when cloud-granted, by a module or by a hosted model, naming the image and what', async () => {
    expect(await refusal(check({ modules: ['fixture_search/search'] }, { keepsMemory: true }))).toBe(
      'recipes/r.json: its image hello-world keeps memory, and it is cloud-granted (fixture_search): memory never leaves the machine (R25)',
    );
    expect(await refusal(check({ model: 'free_provider/small' }, { keepsMemory: true }))).toBe(
      'recipes/r.json: its image hello-world keeps memory, and it is cloud-granted (free_provider/small): memory never leaves the machine (R25)',
    );
    expect(await refusal(check({ embeddingModel: 'free_provider/small' }, { keepsMemory: true }))).toBe(
      'recipes/r.json: free_provider/small is a chat model, not an embedding model',
    );
  });

  it('a module with no host is not cloud: an image that keeps memory may be granted it', async () => {
    const out = await check({ modules: ['fixture_tool/lookup'] }, { keepsMemory: true });
    expect([out.cloudGranted, out.cloud]).toEqual([false, []]);
    expect(isCloudGrantedRecipe({ ...RECIPE, modules: ['fixture_tool/lookup'] }, MODULES)).toBe(false);
    expect(isCloudGrantedRecipe({ ...RECIPE, modules: ['fixture_search/search'] }, MODULES)).toBe(true);
    expect(isCloudGrantedRecipe({ ...RECIPE, model: 'fixture_provider/small' }, MODULES)).toBe(true);
    expect(isCloudGrantedRecipe({ ...RECIPE, embeddingModel: 'fixture_provider/small' }, MODULES)).toBe(true);
    // A catalogue model's id never has a slash; a recipe naming a module not installed is not cloud (its launch fails).
    expect(isCloudGrantedRecipe({ ...RECIPE, modules: ['gone/x'] }, MODULES)).toBe(false);
  });

  it('refuses a memory recipe and a cloud-granted recipe that reach one root, naming both; allows two of one kind', () => {
    const memory = {
      file: 'recipes/memory.json',
      keepsMemory: true,
      cloudGranted: false,
      roots: [{ name: 'notes', host: '/Users/u/notes' }],
    };
    const cloudRecipe = {
      file: 'teams/t/team.json#searcher',
      keepsMemory: false,
      cloudGranted: true,
      roots: [{ name: 'n', host: '/Users/u/notes/sub' }],
    };
    const other = {
      file: 'recipes/plain.json',
      keepsMemory: false,
      cloudGranted: false,
      roots: [{ name: 'notes', host: '/Users/u/notes' }],
    };
    expect(sharedRootRefusal(cloudRecipe, [memory, other])).toBe(
      'root n (/Users/u/notes/sub) is also reached by recipes/memory.json (root notes, /Users/u/notes), and one of the two keeps memory while the other is cloud-granted: memory never leaves the machine (R25)',
    );
    expect(sharedRootRefusal(memory, [cloudRecipe])).toContain('is also reached by teams/t/team.json#searcher');
    expect(sharedRootRefusal(other, [memory, cloudRecipe])).toBeUndefined();
    expect(sharedRootRefusal(cloudRecipe, [other])).toBeUndefined();
    // Case-folded, as APFS compares.
    expect(
      sharedRootRefusal({ ...cloudRecipe, roots: [{ name: 'n', host: '/USERS/U/NOTES' }] }, [memory]),
    ).toBeDefined();
  });
});

describe('roots (R30, A28)', () => {
  it('refuses the home folder, ASHA_HOME, a folder inside it, ~/Library/x and a folder named .ssh, naming the root and the rule', async () => {
    const h = await homes();
    await mkdir(join(h.home, 'Library', 'x'), { recursive: true });
    await mkdir(join(h.home, 'work', '.ssh'), { recursive: true });
    await mkdir(join(h.ashaHome, 'inside'), { recursive: true });
    const root = (path: string): RootSpec => ({ name: 'r', path, mode: 'read' });
    const cases: [string, string][] = [
      [h.home, `it is or contains the home folder ${h.home}`],
      [h.ashaHome, `it is, contains or lies inside ASHA_HOME (${h.ashaHome})`],
      [join(h.ashaHome, 'inside'), `it is, contains or lies inside ASHA_HOME (${h.ashaHome})`],
      ['~/Library/x', 'it is or lies under ~/Library'],
      ['~/work/.ssh', 'it matches the credential deny list (a path component .ssh)'],
      ['/', 'it is /'],
    ];
    for (const [path, rule] of cases) {
      expect(await refusal(check({ roots: [root(path)] }, { home: h.home, ashaHome: h.ashaHome }))).toBe(
        `recipes/r.json: root r (${path}) is refused: ${rule}`,
      );
    }
  });

  it('resolves a root through a symbolic link before checking it: a link to the home folder is refused', async () => {
    const h = await homes();
    await symlink(h.home, join(h.base, 'innocent'));
    expect(
      await refusal(
        check(
          { roots: [{ name: 'r', path: join(h.base, 'innocent'), mode: 'read' }] },
          { home: h.home, ashaHome: h.ashaHome },
        ),
      ),
    ).toBe(
      `recipes/r.json: root r (${join(h.base, 'innocent')}) is refused: it is or contains the home folder ${h.home}`,
    );
  });

  it('allows a project folder, read or read-write, from the recipe and its team file; refuses one name used by both', async () => {
    const h = await homes();
    await mkdir(join(h.home, 'project'));
    await mkdir(join(h.home, 'shared'));
    const out = await check(
      { roots: [{ name: 'project', path: '~/project', mode: 'read' }] },
      {
        home: h.home,
        ashaHome: h.ashaHome,
        teamRoots: [{ name: 'shared', path: join(h.home, 'shared'), mode: 'read-write' }],
      },
    );
    expect(out.roots).toEqual([
      { name: 'project', host: join(h.home, 'project'), mode: 'read' },
      { name: 'shared', host: join(h.home, 'shared'), mode: 'read-write' },
    ]);
    expect(
      await refusal(
        check(
          { roots: [{ name: 'p', path: '~/project', mode: 'read' }] },
          { home: h.home, ashaHome: h.ashaHome, teamRoots: [{ name: 'p', path: '~/shared', mode: 'read' }] },
        ),
      ),
    ).toBe('recipes/r.json: root p is named by both the recipe and its team file');
    expect(
      await refusal(
        check({ roots: [{ name: 'p', path: '~/missing', mode: 'read' }] }, { home: h.home, ashaHome: h.ashaHome }),
      ),
    ).toBe('root path ~/missing does not resolve: ENOENT');
  });
});

describe('the grants come from the recipe alone (R9, M15; A9)', () => {
  it('AgentSupervisorProps has no moduleGrants', async () => {
    const { expectTypeOf } = await import('vitest');
    type Props = import('../../src/daemon/agents/index.js').AgentSupervisorProps;
    expectTypeOf<Props>().not.toHaveProperty('moduleGrants');
    expectTypeOf<Props>().toHaveProperty('modules');
  });
});
