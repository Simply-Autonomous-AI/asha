// A team (docs/plans/collaborating-agents.md R5, R11): a folder teams/<team>/
// holding team.json, every member's recipe and every document those recipes
// name. team.json is a closed object {"id", "description", "members"}; each
// member {"name", "recipe"} is launched on one channel under its own name as
// its channel base name, so the first launch of a team on a fresh channel gives
// the handles <name>-1. A file that breaks a rule fails before any container
// starts, naming the file, the member and the rule.

import { readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import {
  CHANNEL_ASSETS,
  HARNESS_HANDLE,
  LAUNCHED_STARTUP_MAX_MS,
  NAME_PATTERN,
  USER_BASE,
  agentBaseNameProblem,
  type ChannelAsset,
} from '../../shared/protocol.js';
import { DefinitionError, parseRecipe, parseRoots, type Recipe, type RootSpec } from './index.js';

/** A team's members are at most this many (R11). */
const TEAM_MAX_MEMBERS = 10;

export interface TeamMember {
  /** Its channel base name: the member joins as `<name>-<n>` whatever name its image asks for. */
  readonly name: string;
  /**
   * The topics it subscribes to on its channel (docs/plans/patterns-phase-3.md R20): a message to one of them reaches it;
   * [] — the default, when absent — none.
   */
  readonly topics: readonly string[];
  /** The recipe file, absolute; its documents are relative to its folder. */
  readonly recipeFile: string;
  readonly recipe: Recipe;
  /**
   * The recipes its launch grant names (docs/plans/patterns-phase-3.md R29), each read from `<id>.json` in the team's
   * folder and checked; [] when its recipe has none.
   */
  readonly launchable: readonly LaunchableRecipe[];
}

/** A recipe a member's launch grant names, read and checked at the team's load (R29). */
export interface LaunchableRecipe {
  readonly recipe: Recipe;
  /** `<id>.json` in the team's folder, absolute: the launched agent's documents are relative to its folder. */
  readonly recipeFile: string;
}

export interface Team {
  readonly id: string;
  readonly description: string;
  /** teams/<id>/, absolute. */
  readonly dir: string;
  /** teams/<id>/team.json, absolute. */
  readonly file: string;
  readonly members: readonly TeamMember[];
  /**
   * What the team keeps of its channel across sessions (docs/plans/agent-persistence.md R1, R14): "board", or []
   * — the default, when absent. "files" is refused until the channel file space exists (docs/plans/agent-files.md).
   */
  readonly persist: readonly ChannelAsset[];
  /** Host folders every member's command plugin calls may name (docs/plans/extension-modules.md R30): [] when absent. */
  readonly roots: readonly RootSpec[];
}

/** No teams/<name>/team.json. */
export class UnknownTeam extends Error {
  constructor(readonly team: string) {
    super(`no team named "${team}" (no teams/${team}/team.json)`);
    this.name = 'UnknownTeam';
  }
}

/** `TeamDefinitionError`'s message, kept out of its `super()` call to avoid a nested template literal. */
function teamErrorMessage(file: string, member: string | null, rule: string): string {
  const reported = member === null ? rule : `member "${member}": ${rule}`;
  return `${file}: ${reported}`;
}

/**
 * team.json breaks a rule of R11: names the file, the member (null for the team as a whole) and the rule.
 * (It extends Error, not DefinitionError: this module is re-exported by the definitions index, and a class
 * cannot extend one that module has not yet defined.)
 */
export class TeamDefinitionError extends Error {
  constructor(
    readonly file: string,
    readonly member: string | null,
    readonly rule: string,
    options?: ErrorOptions,
  ) {
    super(teamErrorMessage(file, member, rule), options);
    this.name = 'TeamDefinitionError';
  }
}

const TEAM_ID = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * One member's recipe (part of R5, R11, within `loadTeam`): resolved inside the team's folder, read, parsed and
 * checked, with its own launchable recipes loaded in its order.
 */
async function loadMember(props: {
  readonly file: string;
  readonly dir: string;
  readonly realDir: string;
  readonly member: { name: string; recipe: string; topics: string[] };
}): Promise<TeamMember> {
  const { file, dir, realDir, member } = props;
  const recipeFile = resolve(dir, member.recipe);
  let real: string;
  try {
    real = await realpath(recipeFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new TeamDefinitionError(file, member.name, `recipe "${member.recipe}" does not exist in the team's folder`);
    throw error;
  }
  const inside = relative(realDir, real);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new TeamDefinitionError(
      file,
      member.name,
      `recipe "${member.recipe}" resolves to ${real}, outside the team's folder`,
    );
  }
  // Reading and parsing fail differently, and each keeps its cause (PRINCIPLES §11): a file the daemon may not
  // read, or a directory, is the user's to fix and is named; any other read error is not expected and rethrows.
  let text: string;
  try {
    text = await readFile(real, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EISDIR' || code === 'EACCES')
      throw new TeamDefinitionError(file, member.name, `recipe "${member.recipe}" cannot be read (${code})`, {
        cause: error,
      });
    throw error;
  }
  let recipeRaw: unknown;
  try {
    recipeRaw = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new TeamDefinitionError(
        file,
        member.name,
        `recipe "${member.recipe}" is not valid JSON: ${error.message}`,
        { cause: error },
      );
    throw error;
  }
  let recipe: Recipe;
  try {
    recipe = parseRecipe(recipeRaw, recipeFile);
  } catch (error) {
    // The recipe's own problem, named with the member it belongs to (R5: the failure names the member and why).
    if (error instanceof DefinitionError)
      throw new TeamDefinitionError(file, member.name, `recipe "${member.recipe}": ${error.problem}`, {
        cause: error,
      });
    throw error;
  }
  const expected = basename(recipeFile, '.json');
  if (recipe.id !== expected)
    throw new TeamDefinitionError(
      file,
      member.name,
      `recipe "${member.recipe}": id "${recipe.id}" does not match its file name "${expected}"`,
    );
  const launchable: LaunchableRecipe[] = [];
  for (const id of recipe.launch?.recipes ?? [])
    launchable.push(await loadLaunchable({ file, dir, realDir, member: member.name, granting: recipe, id }));
  return { name: member.name, topics: member.topics, recipeFile, recipe, launchable };
}

/** Reads, checks and returns the team in `<teamsDir>/<name>/`, with every member's recipe parsed. Starts nothing. */
export async function loadTeam(teamsDir: string, name: string): Promise<Team> {
  if (!TEAM_ID.test(name)) throw new UnknownTeam(name);
  const dir = join(teamsDir, name);
  const file = join(dir, 'team.json');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UnknownTeam(name);
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new TeamDefinitionError(file, null, `not valid JSON: ${(error as Error).message}`);
  }
  const team = parseTeam(raw, file, name);
  const realDir = await realpath(dir);
  const members: TeamMember[] = [];
  for (const member of team.members) members.push(await loadMember({ file, dir, realDir, member }));
  return { id: team.id, description: team.description, dir, file, members, persist: team.persist, roots: team.roots };
}

/** The launched recipe named `<id>.json`, read from the team's folder and parsed, inside `loadLaunchable`. */
async function readLaunchableRecipe(
  props: { readonly dir: string; readonly realDir: string },
  id: string,
  bad: (rule: string, options?: ErrorOptions) => TeamDefinitionError,
): Promise<{ recipe: Recipe; recipeFile: string }> {
  const recipeFile = resolve(props.dir, `${id}.json`);
  let real: string;
  try {
    real = await realpath(recipeFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw bad(`no ${id}.json in the team's folder`);
    throw error;
  }
  const inside = relative(props.realDir, real);
  if (inside === '' || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw bad(`${id}.json resolves to ${real}, outside the team's folder`);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(real, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw bad(`${id}.json is not valid JSON: ${error.message}`, { cause: error });
    throw error;
  }
  try {
    return { recipe: parseRecipe(raw, recipeFile), recipeFile };
  } catch (error) {
    if (error instanceof DefinitionError) throw bad(error.problem, { cause: error });
    throw error;
  }
}

/**
 * `loadLaunchable`'s rules on the recipe once read: its id is its file name, it names none of persist, restart,
 * launch, modules, roots or embedding model, it runs on the granting recipe's image and model, and its
 * startupTimeoutMs is at most LAUNCHED_STARTUP_MAX_MS.
 */
function checkLaunchable(
  recipe: Recipe,
  id: string,
  granting: Recipe,
  bad: (rule: string, options?: ErrorOptions) => TeamDefinitionError,
): void {
  if (recipe.id !== id) throw bad(`its id is "${recipe.id}", not its file name`);
  const named = [
    recipe.persist.length > 0 ? 'persist' : undefined,
    recipe.restart !== undefined ? 'restart' : undefined,
    recipe.launch !== undefined ? 'launch' : undefined,
    recipe.modules.length > 0 ? 'modules' : undefined,
    recipe.roots.length > 0 ? 'roots' : undefined,
    recipe.embeddingModel !== null ? 'embeddingModel' : undefined,
  ].filter((k) => k !== undefined);
  if (named.length > 0)
    throw bad(
      `a launched recipe names none of persist, restart, launch, modules, roots and embeddingModel; it names ${named.join(', ')}`,
    );
  if (recipe.image !== granting.image || recipe.model !== granting.model)
    throw bad(
      `a launched recipe runs on the granting recipe's image "${granting.image}" and model "${granting.model}", not "${recipe.image}" and "${recipe.model}"`,
    );
  if (recipe.startupTimeoutMs > LAUNCHED_STARTUP_MAX_MS)
    throw bad(
      `a launched recipe's startupTimeoutMs is at most ${String(LAUNCHED_STARTUP_MAX_MS)}, not ${String(recipe.startupTimeoutMs)}`,
    );
}

/**
 * A recipe a member's launch grant names (patterns-phase-3 R29): a channel base name (the launched agent's), the file
 * `<id>.json` in the team's folder, a recipe whose id is its file name, naming no persist, restart, launch, modules,
 * roots or embedding model, on the granting recipe's image and model, with a startupTimeoutMs of at most
 * LAUNCHED_STARTUP_MAX_MS. Anything else fails the team's load, naming the member, the id and the rule.
 */
async function loadLaunchable(props: {
  readonly file: string;
  readonly dir: string;
  readonly realDir: string;
  readonly member: string;
  readonly granting: Recipe;
  readonly id: string;
}): Promise<LaunchableRecipe> {
  const { file, member, granting, id } = props;
  const bad = (rule: string, options?: ErrorOptions): TeamDefinitionError =>
    new TeamDefinitionError(file, member, `launch names "${id}": ${rule}`, options);
  const notBase = agentBaseNameProblem(id);
  if (notBase !== undefined) throw bad(`it becomes the launched agent's base name, and ${notBase}`);
  const { recipe, recipeFile } = await readLaunchableRecipe(props, id, bad);
  checkLaunchable(recipe, id, granting, bad);
  return { recipe, recipeFile };
}

/** team.json's closed schema (R11), checked without touching the disk. `folder` is the name of the folder it is in. */
/** A member's topics at most (R20). */
const TEAM_MAX_TOPICS = 8;

export function parseTeam(
  raw: unknown,
  file: string,
  folder: string,
): {
  id: string;
  description: string;
  members: { name: string; recipe: string; topics: string[] }[];
  persist: ChannelAsset[];
  roots: RootSpec[];
} {
  const bad = (rule: string, member: string | null = null): TeamDefinitionError =>
    new TeamDefinitionError(file, member, rule);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw bad('must be a JSON object {"id", "description", "members"}');
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o))
    if (!['id', 'description', 'members', 'persist', 'roots'].includes(key)) throw bad(`unknown field ${key}`);
  for (const key of ['id', 'description', 'members']) if (!(key in o)) throw bad(`missing field ${key}`);
  if (o['id'] !== folder) throw bad(`id ${JSON.stringify(o['id'])} must equal its folder's name "${folder}"`);
  if (typeof o['description'] !== 'string' || o['description'].trim() === '')
    throw bad('description must be a non-empty string');
  const list = o['members'];
  if (!Array.isArray(list) || list.length < 1 || list.length > TEAM_MAX_MEMBERS)
    throw bad(`members must be a list of 1 to ${String(TEAM_MAX_MEMBERS)} members`);
  const seen = new Set<string>();
  const members = list.map((m: unknown, i) => {
    if (typeof m !== 'object' || m === null || Array.isArray(m))
      throw bad(`members[${String(i)}] must be an object {"name", "recipe"}`);
    const mo = m as Record<string, unknown>;
    const name = typeof mo['name'] === 'string' ? mo['name'] : `members[${String(i)}]`;
    for (const key of Object.keys(mo))
      if (!['name', 'recipe', 'topics'].includes(key)) throw bad(`unknown field ${key}`, name);
    for (const key of ['name', 'recipe']) if (!(key in mo)) throw bad(`missing field ${key}`, name);
    if (typeof mo['name'] !== 'string' || !NAME_PATTERN.test(mo['name']))
      throw bad(`name must match ${String(NAME_PATTERN)}`, name);
    if (name === USER_BASE || name === HARNESS_HANDLE)
      throw bad(`name must not be "${USER_BASE}" or "${HARNESS_HANDLE}"`, name);
    if (/-\d+$/.test(name)) throw bad('name must not end in -<digits>: the channel adds the number', name);
    if (seen.has(name)) throw bad('name is used by two members', name);
    seen.add(name);
    const recipe = mo['recipe'];
    if (
      typeof recipe !== 'string' ||
      isAbsolute(recipe) ||
      !recipe.endsWith('.json') ||
      recipe.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      throw bad("recipe must be a relative path to a .json recipe file inside the team's folder", name);
    }
    return {
      name,
      recipe,
      topics: mo['topics'] === undefined ? [] : memberTopics(mo['topics'], (rule) => bad(rule, name)),
    };
  });
  return {
    id: folder,
    description: o['description'],
    members,
    persist: o['persist'] === undefined ? [] : teamPersist(o['persist'], bad),
    roots: o['roots'] === undefined ? [] : parseRoots(o['roots'], (rule) => bad(rule)),
  };
}

/** A member's `topics` (patterns-phase-3 R20): 1 to TEAM_MAX_TOPICS distinct names, each matching NAME_PATTERN. */
function memberTopics(raw: unknown, bad: (rule: string) => TeamDefinitionError): string[] {
  const rule = `topics must be a list of 1 to ${String(TEAM_MAX_TOPICS)} distinct topic names, each matching ${String(NAME_PATTERN)}`;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > TEAM_MAX_TOPICS) throw bad(rule);
  for (const [i, topic] of raw.entries()) {
    if (typeof topic !== 'string' || !NAME_PATTERN.test(topic)) throw bad(rule);
    if (raw.indexOf(topic) !== i) throw bad(`${rule}: "${topic}" is named twice`);
  }
  return raw as string[];
}

/**
 * A team's `persist` (R1): "board" (the blackboard) and "files" (the channel file space, docs/plans/agent-files.md
 * R15), each at most once.
 */
function teamPersist(raw: unknown, bad: (rule: string) => TeamDefinitionError): ChannelAsset[] {
  const allowed = 'it names "board" and "files"';
  if (!Array.isArray(raw)) throw bad('persist must be a list naming "board" and "files"');
  const seen: ChannelAsset[] = [];
  for (const value of raw) {
    if (!(CHANNEL_ASSETS as readonly unknown[]).includes(value))
      throw bad(`persist names ${JSON.stringify(value)}, which a team cannot persist: ${allowed}`);
    if (seen.includes(value as ChannelAsset)) throw bad(`persist names ${JSON.stringify(value)} twice`);
    seen.push(value as ChannelAsset);
  }
  return seen;
}
