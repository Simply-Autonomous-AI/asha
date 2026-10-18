// The team file (docs/plans/collaborating-agents.md R5, R11; A9): teams/<team>/
// holds team.json, every member's recipe and every document those recipes
// name; a file that breaks a rule fails naming the file, the member and the rule.

import { readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  DefinitionError,
  Definitions,
  TeamDefinitionError,
  UnknownTeam,
  loadTeam,
} from '../../src/daemon/definitions/index.js';
import { byCodeUnit } from '../../src/shared/order.js';

const recipe = (id: string) => ({
  id,
  image: 'hello-world',
  description: `The ${id}.`,
  prompt: `you are the ${id}.`,
  model: 'm-1',
  startupTimeoutMs: 1000,
  messageTimeoutMs: 2000,
  chat: { temperature: 0 },
  tools: [],
});

let root: string;
let teams: string;
let dir: string;
const file = () => join(dir, 'team.json');
const valid = () => ({
  id: 'duo',
  description: 'Two agents.',
  members: [
    { name: 'lead', recipe: 'lead.json' },
    { name: 'helper', recipe: 'helpers/helper.json' },
  ],
});
const write = (value: unknown) => writeFile(file(), typeof value === 'string' ? value : JSON.stringify(value));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'asha-root-'));
  teams = join(root, 'teams');
  dir = join(teams, 'duo');
  await mkdir(join(dir, 'helpers'), { recursive: true });
  await writeFile(join(dir, 'lead.json'), JSON.stringify(recipe('lead')));
  await writeFile(join(dir, 'helpers', 'helper.json'), JSON.stringify(recipe('helper')));
});

describe('loadTeam (R11)', () => {
  it('loads a valid team: its members in order, each with its name, its recipe file and the recipe parsed', async () => {
    await write(valid());
    const team = await loadTeam(teams, 'duo');
    expect(team).toEqual({
      id: 'duo',
      description: 'Two agents.',
      dir,
      file: file(),
      members: [
        // No topics given: none (patterns-phase-3 R20).
        {
          name: 'lead',
          topics: [],
          launchable: [],
          recipeFile: join(dir, 'lead.json'),
          recipe: { ...recipe('lead'), embeddingModel: null, documents: [], persist: [], modules: [], roots: [] },
        },
        {
          name: 'helper',
          topics: [],
          launchable: [],
          recipeFile: join(dir, 'helpers', 'helper.json'),
          recipe: { ...recipe('helper'), embeddingModel: null, documents: [], persist: [], modules: [], roots: [] },
        },
      ],
      persist: [],
      roots: [],
    });
  });

  it('exactly 10 members load (11 are refused, below)', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      name: `m${String.fromCharCode(97 + i)}`,
      recipe: 'lead.json',
    }));
    await write({ ...valid(), members: ten });
    expect((await loadTeam(teams, 'duo')).members).toHaveLength(10);
  });

  it('two members may run the same recipe', async () => {
    await write({
      ...valid(),
      members: [
        { name: 'a', recipe: 'lead.json' },
        { name: 'b', recipe: 'lead.json' },
      ],
    });
    expect((await loadTeam(teams, 'duo')).members.map((m) => [m.name, m.recipe.id])).toEqual([
      ['a', 'lead'],
      ['b', 'lead'],
    ]);
  });

  const eleven = Array.from({ length: 11 }, (_, i) => ({
    name: `m${String.fromCharCode(97 + i)}`,
    recipe: 'lead.json',
  }));
  it.each([
    ['an extra key', { ...valid(), extra: 1 }, null, 'unknown field extra'],
    ['a missing description', { id: 'duo', members: valid().members }, null, 'missing field description'],
    ['an empty description', { ...valid(), description: ' ' }, null, 'description must be a non-empty string'],
    ['id not the folder name', { ...valid(), id: 'trio' }, null, 'id "trio" must equal its folder\'s name "duo"'],
    ['no members', { ...valid(), members: [] }, null, 'members must be a list of 1 to 10 members'],
    ['11 members', { ...valid(), members: eleven }, null, 'members must be a list of 1 to 10 members'],
    [
      'a member named user',
      { ...valid(), members: [{ name: 'user', recipe: 'lead.json' }] },
      'user',
      'name must not be "user" or "asha"',
    ],
    [
      'a member named asha',
      { ...valid(), members: [{ name: 'asha', recipe: 'lead.json' }] },
      'asha',
      'name must not be "user" or "asha"',
    ],
    [
      'a member named fact-1',
      { ...valid(), members: [{ name: 'fact-1', recipe: 'lead.json' }] },
      'fact-1',
      'name must not end in -<digits>: the channel adds the number',
    ],
    [
      'a member named Red',
      { ...valid(), members: [{ name: 'Red', recipe: 'lead.json' }] },
      'Red',
      'name must match /^[a-z][a-z0-9-]{0,31}$/',
    ],
    [
      'two members with one name',
      {
        ...valid(),
        members: [
          { name: 'lead', recipe: 'lead.json' },
          { name: 'lead', recipe: 'helpers/helper.json' },
        ],
      },
      'lead',
      'name is used by two members',
    ],
    [
      'a member with an extra key',
      { ...valid(), members: [{ name: 'lead', recipe: 'lead.json', image: 'x' }] },
      'lead',
      'unknown field image',
    ],
    [
      'a recipe path outside the folder',
      { ...valid(), members: [{ name: 'lead', recipe: '../elsewhere/lead.json' }] },
      'lead',
      "recipe must be a relative path to a .json recipe file inside the team's folder",
    ],
    [
      'an absolute recipe path',
      { ...valid(), members: [{ name: 'lead', recipe: '/etc/lead.json' }] },
      'lead',
      "recipe must be a relative path to a .json recipe file inside the team's folder",
    ],
    [
      'a recipe that is not .json',
      { ...valid(), members: [{ name: 'lead', recipe: 'lead.md' }] },
      'lead',
      "recipe must be a relative path to a .json recipe file inside the team's folder",
    ],
    [
      'a recipe that does not exist',
      { ...valid(), members: [{ name: 'lead', recipe: 'gone.json' }] },
      'lead',
      'recipe "gone.json" does not exist in the team\'s folder',
    ],
  ])('refuses %s, naming the file, the member and the rule', async (_, value, member, rule) => {
    await write(value);
    const error = await loadTeam(teams, 'duo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect(error).toMatchObject({ file: file(), member, rule });
    const detail = member === null ? rule : `member "${member}": ${rule}`;
    expect((error as Error).message).toBe(`${file()}: ${detail}`);
  });

  it("refuses a recipe that links outside the team's folder", async () => {
    const outside = await mkdtemp(join(tmpdir(), 'asha-outside-'));
    await writeFile(join(outside, 'x.json'), JSON.stringify(recipe('x')));
    await symlink(join(outside, 'x.json'), join(dir, 'x.json'));
    await write({ ...valid(), members: [{ name: 'lead', recipe: 'x.json' }] });
    const error = await loadTeam(teams, 'duo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect((error as TeamDefinitionError).member).toBe('lead');
    expect((error as TeamDefinitionError).rule).toMatch(
      /^recipe "x\.json" resolves to .*x\.json, outside the team's folder$/,
    );
  });

  it('refuses a team.json that is not JSON, and one that is not an object', async () => {
    await write('{ not json');
    await expect(loadTeam(teams, 'duo')).rejects.toThrow(/team\.json: not valid JSON/);
    await write([1]);
    await expect(loadTeam(teams, 'duo')).rejects.toThrow(
      `${file()}: must be a JSON object {"id", "description", "members"}`,
    );
  });

  it('a member recipe that is not JSON fails naming the member, with the parse error as its cause', async () => {
    await writeFile(join(dir, 'lead.json'), '{ not json');
    await write(valid());
    const error = await loadTeam(teams, 'duo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect((error as TeamDefinitionError).member).toBe('lead');
    expect((error as TeamDefinitionError).rule).toMatch(/^recipe "lead\.json" is not valid JSON: /);
    expect((error as Error).cause).toBeInstanceOf(SyntaxError);
  });

  it('a member recipe that is a directory fails naming the member and EISDIR, with the read error as its cause', async () => {
    await rm(join(dir, 'lead.json'), { force: true });
    await mkdir(join(dir, 'lead.json'));
    await write(valid());
    const error = await loadTeam(teams, 'duo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect((error as TeamDefinitionError).member).toBe('lead');
    expect((error as TeamDefinitionError).rule).toBe('recipe "lead.json" cannot be read (EISDIR)');
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('EISDIR');
  });

  it("refuses a member recipe whose id is not its file's name", async () => {
    await writeFile(join(dir, 'lead.json'), JSON.stringify(recipe('boss')));
    await write(valid());
    const error = await loadTeam(teams, 'duo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect((error as Error).message).toBe(
      `${file()}: member "lead": recipe "lead.json": id "boss" does not match its file name "lead"`,
    );
  });

  it('a member recipe that breaks the recipe schema fails naming the member, its recipe and the rule', async () => {
    await writeFile(join(dir, 'lead.json'), JSON.stringify({ ...recipe('lead'), prompt: '' }));
    await write(valid());
    const error = await loadTeam(teams, 'duo').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamDefinitionError);
    expect((error as Error).message).toBe(
      `${file()}: member "lead": recipe "lead.json": prompt must be a non-empty string`,
    );
    expect((error as Error).cause).toBeInstanceOf(DefinitionError);
  });

  it.each(['nope', '../duo', 'Duo', ''])('an unknown team "%s": UnknownTeam', async (name) => {
    await write(valid());
    const error = await loadTeam(teams, name).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnknownTeam);
    expect((error as Error).message).toBe(`no team named "${name}" (no teams/${name}/team.json)`);
  });

  it("Definitions reads teams from the repo's teams/ folder", async () => {
    await write(valid());
    expect((await new Definitions(root).team('duo')).members.map((m) => m.name)).toEqual(['lead', 'helper']);
  });
});

describe('the committed team folders (teams/)', () => {
  const REPO = join(import.meta.dirname, '..', '..');
  /**
   * The agent suite's fixtures broken on purpose (collaborating-agents A4), and how loading each fails. A team whose
   * problem is a document fails at launch, not here: suite-outside-document loads, and its launch fails.
   */
  const BROKEN: Readonly<Record<string, string>> = {
    'suite-missing-recipe': 'member "ghost": recipe "ghost.json" does not exist in the team\'s folder',
  };

  it("every committed team folder loads, its members' recipes parsed, except the ones broken on purpose", async () => {
    const names = readdirSync(join(REPO, 'teams'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(byCodeUnit);
    expect(names).toEqual(
      expect.arrayContaining([
        'suite-duo',
        'suite-guided',
        'suite-memory-pair',
        'suite-missing-recipe',
        'suite-outside-document',
      ]),
    );
    const definitions = new Definitions(REPO);
    for (const name of names) {
      const loaded = await definitions.team(name).catch((e: unknown) => e);
      if (name in BROKEN) {
        expect(loaded, name).toBeInstanceOf(TeamDefinitionError);
        expect((loaded as Error).message, name).toContain(BROKEN[name]);
      } else {
        expect(loaded, `${name}: ${loaded instanceof Error ? loaded.message : ''}`).not.toBeInstanceOf(Error);
      }
    }
  });
});
