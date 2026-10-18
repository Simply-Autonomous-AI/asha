// What a recipe and a team may persist, and what an image must declare for it (docs/plans/agent-persistence.md R1,
// R12, R16; A1, A10 and A16's loader parts): `persist` on a recipe names any of "memory" and "workspace", on a team
// any of "board" (and "files", refused until the channel file space exists); "memory" needs an image whose
// image.json declares "keepsMemory": true, "eraseUser": true and a "stateSchema"; each key's value is checked, and
// every refusal names the file and the value.

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DefinitionError,
  Definitions,
  TeamDefinitionError,
  checkPersistence,
  loadTeam,
  parseRecipe,
} from '../../src/daemon/definitions/index.js';
import { ImageManifestInvalid, parseImageManifest } from '../../src/shared/tools.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

const recipe = (extra: Record<string, unknown> = {}) => ({
  id: 'keeper',
  image: 'demo',
  description: 'Keeps things.',
  prompt: 'you keep things.',
  model: 'm-1',
  startupTimeoutMs: 1000,
  messageTimeoutMs: 2000,
  chat: { temperature: 0 },
  tools: [] as string[],
  ...extra,
});

async function imageRoot(manifest: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'asha-persist-defs-'));
  await mkdir(join(root, 'images', 'demo'), { recursive: true });
  await writeFile(join(root, 'images', 'demo', 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(root, 'images', 'demo', 'image.json'), JSON.stringify(manifest));
  return root;
}

const MEMORY_IMAGE = { tools: [], keepsMemory: true, eraseUser: true, stateSchema: 1 };

describe("a recipe's persist (R1)", () => {
  it.each([[['memory']], [['workspace']], [['memory', 'workspace']], [['workspace', 'memory']], [[]]])(
    'loads persist %j',
    (persist) => {
      expect(parseRecipe(recipe({ persist }), 'recipes/keeper.json').persist).toEqual(persist);
    },
  );

  it('is [] when absent: the recipe persists nothing (off by default)', () => {
    expect(parseRecipe(recipe(), 'recipes/keeper.json').persist).toEqual([]);
  });

  it.each([
    [['board'], 'persist names "board", which a recipe cannot persist: it names any of "memory" and "workspace"'],
    [['memories'], 'persist names "memories", which a recipe cannot persist: it names any of "memory" and "workspace"'],
    [['memory', 'memory'], 'persist names "memory" twice'],
    ['memory', 'persist must be a list naming any of "memory" and "workspace"'],
    [[1], 'persist names 1, which a recipe cannot persist: it names any of "memory" and "workspace"'],
  ])('refuses persist %j, naming the file and the value', (persist, problem) => {
    expect(() => parseRecipe(recipe({ persist }), 'recipes/keeper.json')).toThrow(
      new DefinitionError('recipes/keeper.json', problem),
    );
  });
});

describe('image.json: keepsMemory, eraseUser and stateSchema (R1, R12)', () => {
  it('parses the three keys, each optional, absent as false, false and null', () => {
    expect(parseImageManifest({ tools: [] }, 'image.json')).toEqual({
      tools: [],
      answerTools: [],
      keepsMemory: false,
      eraseUser: false,
      stateSchema: null,
    });
    expect(parseImageManifest(MEMORY_IMAGE, 'image.json')).toEqual({
      tools: [],
      answerTools: [],
      keepsMemory: true,
      eraseUser: true,
      stateSchema: 1,
    });
  });

  it.each([
    [{ tools: [], eraseUser: 1 }, 'eraseUser must be true (omit it for an image with no erase mode)'],
    [{ tools: [], eraseUser: false }, 'eraseUser must be true (omit it for an image with no erase mode)'],
    [{ tools: [], keepsMemory: 'yes' }, 'keepsMemory must be true (omit it for an image that keeps no memory)'],
    [{ tools: [], stateSchema: 0 }, 'stateSchema must be a positive integer'],
    [{ tools: [], stateSchema: '1' }, 'stateSchema must be a positive integer'],
    [{ tools: [], stateSchema: 1.5 }, 'stateSchema must be a positive integer'],
  ])('refuses %j, naming the file and the key', (manifest, problem) => {
    expect(() => parseImageManifest(manifest, 'images/demo/image.json')).toThrow(
      new ImageManifestInvalid('images/demo/image.json', problem),
    );
  });

  it('the memory image declares all three, and hello-world none', () => {
    const read = (name: string) =>
      parseImageManifest(JSON.parse(readFileSync(join(REPO_ROOT, 'images', name, 'image.json'), 'utf8')), name);
    expect(read('memory')).toMatchObject({ keepsMemory: true, eraseUser: true, stateSchema: 1 });
    expect(read('hello-world')).toMatchObject({ keepsMemory: false, eraseUser: false, stateSchema: null });
  });
});

describe('checkPersistence: a recipe against its image, before any container starts (R1, R12, R16)', () => {
  const check = async (persist: string[], manifest: unknown, solo = true) => {
    const root = await imageRoot(manifest);
    const image = await new Definitions(root).image('demo');
    // checkPersistence returns void; this thunk returns unknown so a caller can capture and assert on the
    // result (always undefined) without placing a void expression inside another expression.
    return (): unknown => {
      checkPersistence({
        recipe: parseRecipe(recipe({ persist }), 'recipes/keeper.json'),
        recipeFile: 'recipes/keeper.json',
        image,
        solo,
      });
      return undefined;
    };
  };

  it('passes memory on an image declaring keepsMemory, eraseUser and stateSchema; workspace on any image; nothing on any', async () => {
    const memoryAndWorkspace = (await check(['memory', 'workspace'], MEMORY_IMAGE))();
    expect(memoryAndWorkspace).toBeUndefined();
    const workspaceOnly = (await check(['workspace'], { tools: [] }))();
    expect(workspaceOnly).toBeUndefined();
    const nothing = (await check([], { tools: [] }))();
    expect(nothing).toBeUndefined();
  });

  it.each([
    [
      { tools: [], eraseUser: true, stateSchema: 1 },
      'persists "memory", but its image "demo" does not declare "keepsMemory": true in images/demo/image.json',
    ],
    [
      { tools: [], keepsMemory: true, stateSchema: 1 },
      'persists "memory", but its image "demo" does not declare "eraseUser": true in images/demo/image.json (the per-user erase mode, R16)',
    ],
    [
      { tools: [], keepsMemory: true, eraseUser: true },
      'persists "memory", but its image "demo" does not declare a "stateSchema" in images/demo/image.json',
    ],
  ])('refuses memory on an image that lacks a key (%j), naming the recipe and the image', async (manifest, problem) => {
    expect(await check(['memory'], manifest)).toThrow(new DefinitionError('recipes/keeper.json', problem));
  });

  it('refuses a persisted recipe launched alone whose id is not a channel name (it names its saved state, R2 and R5)', async () => {
    const root = await imageRoot({ tools: [] });
    const image = await new Definitions(root).image('demo');
    const dotted = parseRecipe(recipe({ id: 'keeper.v2', persist: ['workspace'] }), 'recipes/keeper.v2.json');
    expect(() => {
      checkPersistence({ recipe: dotted, recipeFile: 'recipes/keeper.v2.json', image, solo: true });
    }).toThrow(
      new DefinitionError(
        'recipes/keeper.v2.json',
        'persists state, and a recipe launched alone names its saved state by its id, which must match /^[a-z][a-z0-9-]{0,31}$/',
      ),
    );
    // As a team member it is named by its member name, which the team file already checks.
    const callAsTeamMember = (): unknown => {
      checkPersistence({ recipe: dotted, recipeFile: 'recipes/keeper.v2.json', image, solo: false });
      return undefined;
    };
    expect(callAsTeamMember()).toBeUndefined();
  });
});

describe("a team's persist (R1, R14)", () => {
  async function team(persist: unknown): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'asha-persist-team-'));
    const dir = join(root, 'teams', 'duo');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'lead.json'), JSON.stringify({ ...recipe(), id: 'lead' }));
    await writeFile(
      join(dir, 'team.json'),
      JSON.stringify({
        id: 'duo',
        description: 'Two.',
        members: [{ name: 'lead', recipe: 'lead.json' }],
        ...(persist === undefined ? {} : { persist }),
      }),
    );
    return join(root, 'teams');
  }

  it('loads persist ["board"], and [] when absent', async () => {
    expect((await loadTeam(await team(['board']), 'duo')).persist).toEqual(['board']);
    expect((await loadTeam(await team(undefined), 'duo')).persist).toEqual([]);
    // The channel file space (docs/plans/agent-files.md R15; D43 paid): a team persists its files beside its board.
    expect((await loadTeam(await team(['files']), 'duo')).persist).toEqual(['files']);
    expect((await loadTeam(await team(['board', 'files']), 'duo')).persist).toEqual(['board', 'files']);
  });

  it.each([
    [['memory'], 'persist names "memory", which a team cannot persist: it names "board" and "files"'],
    [['board', 'board'], 'persist names "board" twice'],
    [['files', 'files'], 'persist names "files" twice'],
    ['board', 'persist must be a list naming "board" and "files"'],
  ])('refuses persist %j, naming the file and the value', async (persist, rule) => {
    const teams = await team(persist);
    await expect(loadTeam(teams, 'duo')).rejects.toThrow(
      new TeamDefinitionError(join(teams, 'duo', 'team.json'), null, rule),
    );
  });
});
