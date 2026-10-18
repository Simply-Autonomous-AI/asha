// What the portal lists as launchable (docs/plans/portal-scene-chat.md R13, A16): Definitions.catalog() over a fixture
// root — recipes and teams sorted by id with their exact fields, test fixtures (`suite-*`) left out, a file in teams/
// skipped, each entry that does not parse listed with its problem (its paths relative, never absolute), and any other
// failure thrown. (A new file: tests/unit/definitions.test.ts holds the paused decider-tool build's uncommitted edits.)

import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { Definitions } from '../../src/daemon/definitions/index.js';
import { FIXTURE_RECIPE, fixtureRoot } from '../helpers/daemon-fakes.js';

async function write(root: string, files: Record<string, unknown>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), typeof content === 'string' ? content : JSON.stringify(content));
  }
}

const member = (id: string, description: string) => ({ ...FIXTURE_RECIPE, id, description });

async function catalogueRoot(): Promise<string> {
  const root = await fixtureRoot();
  await write(root, {
    'recipes/suite-x.json': { ...FIXTURE_RECIPE, id: 'suite-x' },
    'recipes/broken.json': { ...FIXTURE_RECIPE, id: 'broken', tools: 'not a list' },
    'teams/crew/team.json': {
      id: 'crew',
      description: 'A lead and a helper.',
      members: [
        { name: 'lead', recipe: 'lead.json' },
        { name: 'helper', recipe: 'helper.json' },
      ],
    },
    'teams/crew/lead.json': member('lead', 'Leads.'),
    'teams/crew/helper.json': member('helper', 'Helps.'),
    'teams/alpha/team.json': {
      id: 'alpha',
      description: 'One worker.',
      members: [{ name: 'worker', recipe: 'worker.json' }],
    },
    'teams/alpha/worker.json': member('worker', 'Works.'),
    'teams/missing-member/team.json': {
      id: 'missing-member',
      description: 'Its recipe is gone.',
      members: [{ name: 'ghost', recipe: 'ghost.json' }],
    },
    'teams/suite-duo/team.json': { id: 'suite-duo', description: 'A fixture.', members: [] },
    'teams/.DS_Store': 'not a team',
  });
  await mkdir(join(root, 'teams', 'empty-folder'));
  return root;
}

describe('Definitions.catalog() (portal-scene-chat R13, A16)', () => {
  it('lists recipes and teams sorted by id with their exact fields, fixtures left out and a file in teams/ skipped', async () => {
    const root = await catalogueRoot();
    const catalog = await new Definitions(root).catalog();
    expect(catalog.recipes.map((r) => r.id)).toEqual(['broken', 'greeter', 'rememberer']);
    expect(catalog.recipes.find((r) => r.id === 'greeter')).toEqual({
      id: 'greeter',
      description: 'Greets whoever asks.',
      model: 'tiny-model',
    });
    expect(catalog.teams.map((t) => t.id)).toEqual(['alpha', 'crew', 'empty-folder', 'missing-member']);
    expect(catalog.teams.find((t) => t.id === 'crew')).toEqual({
      id: 'crew',
      description: 'A lead and a helper.',
      members: [
        { name: 'lead', recipe: 'lead', description: 'Leads.' },
        { name: 'helper', recipe: 'helper', description: 'Helps.' },
      ],
    });
  });

  it('lists a recipe with a bad field, a team whose member recipe is missing and a folder with no team.json, each with its problem, no path absolute', async () => {
    const root = await catalogueRoot();
    const catalog = await new Definitions(root).catalog();
    const problem = (list: readonly { readonly id: string }[], id: string): unknown => {
      const e = list.find((x) => x.id === id);
      return e !== undefined && 'problem' in e ? e.problem : undefined;
    };
    expect(problem(catalog.recipes, 'broken')).toMatch(/^recipes\/broken\.json: .*tools/);
    expect(problem(catalog.teams, 'missing-member')).toBe(
      'teams/missing-member/team.json: member "ghost": recipe "ghost.json" does not exist in the team\'s folder',
    );
    expect(problem(catalog.teams, 'empty-folder')).toBe(
      'no team named "empty-folder" (no teams/empty-folder/team.json)',
    );
    expect(JSON.stringify(catalog)).not.toContain(root);
  });

  it('a root with no teams/ folder lists no teams', async () => {
    const root = await fixtureRoot();
    expect((await new Definitions(root).catalog()).teams).toEqual([]);
  });

  it('an unreadable folder fails the call: never an empty list', async () => {
    const root = await catalogueRoot();
    await chmod(join(root, 'teams'), 0o000);
    try {
      await expect(new Definitions(root).catalog()).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(join(root, 'teams'), 0o755);
    }
  });
});
