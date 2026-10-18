// The checked-in definitions the daemon acts on. A recipe
// (recipes/<name>.json) is the whole specification of an agent: the one image
// it runs (images/<name>/ — its code and Dockerfile), the model it uses (a
// catalogue entry, catalogue/<id>.json — a pinned model), its system prompt,
// the tools it selects, the Markdown documents placed in its /workspace
// (documents.ts), and its bounds. A team (teams/<team>/team.json, teams.ts)
// names recipes in its own folder, launched together on one channel. Validated
// here, once, where they enter (PRINCIPLES §10); every schema is closed — an
// unknown key is an error, never ignored.

import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { byCodeUnit, byKey } from '../../shared/order.js';
import {
  AGENT_ASSETS,
  LAUNCH_MAX_PER_CONVERSATION,
  LAUNCH_MAX_RECIPES,
  NAME_PATTERN,
  type AgentAsset,
  type LaunchGrant,
} from '../../shared/protocol.js';
import type { CatalogRecipe, CatalogTeam, DefinitionProblem, DefinitionsResponse } from '../../shared/protocol.js';
import {
  DECIDE_TOOL_NAME,
  FILE_TOOL_NAMES,
  ImageManifestInvalid,
  TOOL_NAME_PATTERN,
  parseImageManifest,
  type ImageManifest,
} from '../../shared/tools.js';
import { parseDecisions, type Decision } from './decisions.js';
import { loadTeam, TeamDefinitionError, UnknownTeam, type Team } from './teams.js';

export * from './tools.js';
export * from './documents.js';
export * from './teams.js';
export * from './decisions.js';

export interface CatalogueFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

interface CatalogueEntryBase {
  readonly id: string;
  readonly repo: string;
  /** Full Hugging Face commit sha. A branch name is never a pin. */
  readonly revision: string;
  /** The file in `files` that llama-server loads. */
  readonly weights: string;
  readonly files: readonly CatalogueFile[];
  /**
   * The licence of this exact repo and revision. `source` is the licence file
   * at the revision — or, where the publisher ships none, the model card that
   * declares it (the owner's decision, 2026-09-26), which is then in `files`,
   * pinned by sha256.
   */
  readonly license: { readonly id: string; readonly source: string; readonly verified: string };
}

/** A model agents chat with. */
export interface ChatModelEntry extends CatalogueEntryBase {
  readonly kind: 'chat';
  readonly serve: { readonly contextSize: number };
  /** Sampling parameters merged into every chat request for this model. */
  readonly chat: Readonly<Record<string, unknown>>;
  /**
   * The text the model's chat template opens a tool call with (Qwen3: "<tool_call>\n"). A request
   * that requires a tool call sends the assistant turn already opened with it.
   */
  readonly toolCallStart: string;
}

/** A model that turns text into vectors, for semantic search. */
export interface EmbeddingModelEntry extends CatalogueEntryBase {
  readonly kind: 'embedding';
  readonly serve: { readonly contextSize: number; readonly pooling: 'last' | 'mean' | 'cls' };
  readonly embed: {
    /** Vector length the model returns; a response of any other length is rejected. */
    readonly dimensions: number;
    /** How a search query is written for this model, with `{text}` where the query goes. Documents are sent as they are. */
    readonly queryTemplate: string;
  };
}

/**
 * The decision model's adapter (docs/plans/decider-tool.md R1): a LoRA adapter, a pointer head and its config, served
 * by the decider (src/daemon/decider/), never by llama-server. `base` names the `decider-base` entry it is trained on.
 */
export interface DeciderEntry extends CatalogueEntryBase {
  readonly kind: 'decider';
  readonly base: string;
}

/** The base model a decider adapter is loaded onto (R1), pinned as its adapter's own provenance names it. */
export interface DeciderBaseEntry extends CatalogueEntryBase {
  readonly kind: 'decider-base';
}

export type CatalogueEntry = ChatModelEntry | EmbeddingModelEntry | DeciderEntry | DeciderBaseEntry;

/** A model llama-server serves: a chat or an embedding model. */
export type ServedEntry = ChatModelEntry | EmbeddingModelEntry;

export interface Recipe {
  readonly id: string;
  /** The image (images/<name>/) the agent runs. Exactly one per recipe. */
  readonly image: string;
  /** What this agent does, in a sentence. Other agents see it when deciding whom to delegate to. */
  readonly description: string;
  /**
   * The agent's system prompt: its role text, which the SDK puts into its instructions on every turn
   * (docs/plans/collaborating-agents.md R1). No image carries one; the welcome event hands it to the agent.
   */
  readonly prompt: string;
  /** Catalogue id of the model the agent's chat calls are served by. */
  readonly model: string;
  /** Bound on launch → the agent connected to the channel. */
  readonly startupTimeoutMs: number;
  /** Bound on one delivery → its ack. An agent that exceeds it is stopped. */
  readonly messageTimeoutMs: number;
  /** Sampling overrides for this agent, merged over the model's catalogue `chat` ({} for none). */
  readonly chat: Readonly<Record<string, unknown>>;
  /** Catalogue id of an embedding model the agent may call (`/agent/v1/model/embed`); null when it has none. */
  readonly embeddingModel: string | null;
  /**
   * The tools the agent is offered after the channel tools, by name: common tools (the SDK's) and tools its
   * image declares ([] for none). Checked at launch, before any container starts (docs/plans/agent-tools.md R1).
   */
  readonly tools: readonly string[];
  /**
   * Markdown documents (guidance, workflows) the harness places in the agent's /workspace at start, each at its
   * path relative to the recipe's folder ([] for none; docs/plans/collaborating-agents.md R2). A full-text one
   * is also in the system prompt on every turn.
   */
  readonly documents: readonly RecipeDocument[];
  /**
   * What the agent keeps across sessions (docs/plans/agent-persistence.md R1): any of "memory" and "workspace"; []
   * — the default, when absent — keeps nothing, so every lifecycle is as it was before persistence.
   */
  readonly persist: readonly AgentAsset[];
  /**
   * The module tools its agent may call, each `<module>/<tool>` — a ToolModule's tool or a command plugin's command
   * (docs/plans/extension-modules.md R29): its one allow list. [] — the default, when absent — grants none.
   */
  readonly modules: readonly string[];
  /** Host folders its command plugin calls may name, besides /channel (R30): [] — the default — names none. */
  readonly roots: readonly RootSpec[];
  /**
   * Its supervisor's restart intensity (docs/plans/patterns-phase-3.md R10, R12): an agent that exits on its own while
   * online is restarted under its handle, at most `max` times in any `withinMs`. Absent — the default — never restarts.
   */
  readonly restart?: RestartPolicy;
  /**
   * The recipes its agent may launch onto its channel, and how many per conversation (docs/plans/patterns-phase-3.md
   * R29): only in a team's folder, whose recipe files it names, each checked at the team's load. Absent — the default —
   * launches none.
   */
  readonly launch?: LaunchGrant;
  /**
   * Its call turns may consult other agents before answering (docs/plans/patterns-phase-3.md R33, R34): a nested call,
   * at most one level deep. Absent — the default — a call turn answers or passes, as agent-calls R4 says.
   */
  readonly nestedCalls?: true;
  /**
   * The decisions its agent may ask the decision model through the `decide` tool (docs/plans/decider-tool.md R10), by
   * name. Present exactly when `tools` names `decide`; absent — the default — for every other recipe.
   */
  readonly decisions?: Readonly<Record<string, Decision>>;
}

/**
 * The least `messageTimeoutMs` of a recipe selecting `decide` (R10): a call's 30,000 ms bound (R8) plus extension-modules
 * R34's 125,000 ms for the turn around a tool call (TURN_OVERHEAD_MS, src/daemon/modules/launch.ts).
 */
const DECIDE_MIN_MESSAGE_TIMEOUT_MS = 155_000;

/** A recipe's `restart` (R10): at most `max` restarts begun in any `withinMs` ms. */
export interface RestartPolicy {
  /** 1 to RESTART_MAX. */
  readonly max: number;
  /** RESTART_WITHIN_MS_MIN to RESTART_WITHIN_MS_MAX. */
  readonly withinMs: number;
}

/** A recipe's `restart` bounds (R10). */
const RESTART_MAX = 5;
const RESTART_WITHIN_MS_MIN = 1_000;
const RESTART_WITHIN_MS_MAX = 3_600_000;

/** A folder a recipe or a team file names in `roots` (extension-modules R30): its name, its path, and its mode. */
export interface RootSpec {
  readonly name: string;
  /** Absolute, or under the home folder as `~/…`; resolved (realpath) at the launch. */
  readonly path: string;
  readonly mode: 'read' | 'read-write';
}

/** A grant in a recipe's `modules` (R29): `<module>/<tool>`, each part a wire name's part. */
export const MODULE_GRANT = /^([a-z][a-z0-9_]{0,31})\/([a-z][a-z0-9_]{0,31})$/;
/** A provider model's name in a recipe's `model` or `embeddingModel` (R20): `<module>/<name>`. */
export const PROVIDER_MODEL_REF = /^([a-z][a-z0-9_]{0,31})\/([a-z0-9][a-z0-9._-]{0,63})$/;

/** One document a recipe names: its path inside the recipe's folder, and whether it is full-text (R2). */
interface RecipeDocument {
  readonly path: string;
  readonly fullText: boolean;
}

export interface ImageDefinition {
  readonly name: string;
  /** images/<name>/, holding the Dockerfile. */
  readonly dir: string;
  /** Docker repository the harness builds it in, `asha-image-<name>`; each build is tagged by its source digest (`imageTag`). */
  readonly repository: string;
  /** images/<name>/image.json: the tools the image implements (docs/plans/agent-tools.md R1). */
  readonly manifest: ImageManifest;
}

/** A definition file is malformed. Names the file and the offending field. */
export class DefinitionError extends Error {
  constructor(
    readonly file: string,
    readonly problem: string,
  ) {
    super(`${file}: ${problem}`);
    this.name = 'DefinitionError';
  }
}

/** No images/<name>/Dockerfile. */
export class UnknownImage extends Error {
  constructor(readonly image: string) {
    super(`no image named "${image}" (no images/${image}/Dockerfile)`);
    this.name = 'UnknownImage';
  }
}

/** No recipes/<name>.json. */
export class UnknownRecipe extends Error {
  constructor(readonly recipe: string) {
    super(`no recipe named "${recipe}" (no recipes/${recipe}.json)`);
    this.name = 'UnknownRecipe';
  }
}

/** The recipe names documents but does not select all four file tools, so its agent could not read or edit them (R3). */
export class DocumentsNeedFileTools extends DefinitionError {
  constructor(
    file: string,
    readonly recipe: string,
    readonly missing: readonly string[],
  ) {
    super(
      file,
      `recipe ${recipe} names documents, so it must select the four file tools; it does not select ${missing.join(', ')}`,
    );
    this.name = 'DocumentsNeedFileTools';
  }
}

const ID = /^[a-z0-9][a-z0-9._-]*$/;
const SHA1_HEX = /^[0-9a-f]{40}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PICKLE = /\.(bin|pt|pth|pkl|ckpt)$/i;

function isName(value: string): boolean {
  return ID.test(value);
}

/** A recipe's `tools`: a list of names matching TOOL_NAME_PATTERN, each at most once (part of `parseRecipe`). */
function parseTools(o: Obj, file: string): string[] {
  const raw = o['tools'];
  if (!Array.isArray(raw) || !raw.every((t): t is string => typeof t === 'string' && TOOL_NAME_PATTERN.test(t))) {
    throw new DefinitionError(
      file,
      `tools must be a list of tool names matching ${String(TOOL_NAME_PATTERN)} ([] for none)`,
    );
  }
  const twice = raw.find((t, i) => raw.indexOf(t) !== i);
  if (twice !== undefined) throw new DefinitionError(file, `tools names "${twice}" twice`);
  return raw;
}

/**
 * `decide`'s companion fields (decider-tool R10): `decide` and `decisions` come together, and the decisions
 * themselves, parsed (part of `parseRecipe`).
 */
function parseRecipeDecisions(
  o: Obj,
  file: string,
  tools: readonly string[],
): { readonly decides: boolean; readonly decisions: Readonly<Record<string, Decision>> | undefined } {
  const decides = tools.includes(DECIDE_TOOL_NAME);
  if (decides && o['decisions'] === undefined)
    throw new DefinitionError(file, `tools names ${DECIDE_TOOL_NAME}, so decisions must declare what it may decide`);
  if (!decides && o['decisions'] !== undefined)
    throw new DefinitionError(file, `decisions is declared, so tools must name ${DECIDE_TOOL_NAME}`);
  const decisions =
    o['decisions'] === undefined
      ? undefined
      : parseDecisions(o['decisions'], (problem) => new DefinitionError(file, problem));
  return { decides, decisions };
}

/** `nestedCalls` and `restart`+`persist` cannot clash (part of `parseRecipe`). */
function checkRecipeFlags(
  file: string,
  nestedCalls: unknown,
  restart: RestartPolicy | undefined,
  persist: readonly AgentAsset[],
): void {
  // R33: only true; absent is the default, and false would be a second way to say it.
  if (nestedCalls !== undefined && nestedCalls !== true)
    throw new DefinitionError(file, `nestedCalls must be true when given, not ${JSON.stringify(nestedCalls)}`);
  // A persisted agent's re-sends are agent-persistence R9's: the two never meet (patterns-phase-3 R10).
  if (restart !== undefined && persist.length > 0)
    throw new DefinitionError(
      file,
      "restart cannot be named beside persist: a persisted agent's deliveries are re-sent from its saved record (agent-persistence R9), never by a restart",
    );
}

/** decider-tool R10: a turn calling `decide` has room for the call's 30,000 ms bound (part of `parseRecipe`). */
function checkMessageTimeout(file: string, decides: boolean, messageTimeoutMs: number): void {
  if (decides && messageTimeoutMs < DECIDE_MIN_MESSAGE_TIMEOUT_MS) {
    throw new DefinitionError(
      file,
      `messageTimeoutMs ${String(messageTimeoutMs)} is under ${String(DECIDE_MIN_MESSAGE_TIMEOUT_MS)}: a recipe selecting ${DECIDE_TOOL_NAME} needs its 30,000 ms call bound plus 125,000 ms for the turn around it`,
    );
  }
}

export function parseRecipe(raw: unknown, file: string): Recipe {
  const o = closedObject(
    raw,
    file,
    '',
    [
      'id',
      'image',
      'description',
      'prompt',
      'model',
      'startupTimeoutMs',
      'messageTimeoutMs',
      'chat',
      'embeddingModel',
      'tools',
      'documents',
      'persist',
      'modules',
      'roots',
      'restart',
      'launch',
      'nestedCalls',
      'decisions',
    ],
    ['embeddingModel', 'documents', 'persist', 'modules', 'roots', 'restart', 'launch', 'nestedCalls', 'decisions'],
  );
  const tools = parseTools(o, file);
  const id = matching(o, file, 'id', ID);
  const documents = o['documents'] === undefined ? [] : recipeDocuments(o['documents'], file);
  const missing = FILE_TOOL_NAMES.filter((t) => !tools.includes(t));
  if (documents.length > 0 && missing.length > 0) throw new DocumentsNeedFileTools(file, id, missing);
  const persist = o['persist'] === undefined ? [] : persistList(o['persist'], file);
  const restart = o['restart'] === undefined ? undefined : restartPolicy(o['restart'], file);
  const launch = o['launch'] === undefined ? undefined : launchGrant(o['launch'], file);
  checkRecipeFlags(file, o['nestedCalls'], restart, persist);
  const { decides, decisions } = parseRecipeDecisions(o, file, tools);
  const messageTimeoutMs = positiveInt(o, file, 'messageTimeoutMs');
  checkMessageTimeout(file, decides, messageTimeoutMs);
  return {
    id,
    image: matching(o, file, 'image', ID),
    description: str(o, file, 'description'),
    prompt: str(o, file, 'prompt'),
    model: modelRef(o, file, 'model'),
    startupTimeoutMs: positiveInt(o, file, 'startupTimeoutMs'),
    messageTimeoutMs,
    chat: chatSettings(o, file),
    embeddingModel: o['embeddingModel'] === undefined ? null : modelRef(o, file, 'embeddingModel'),
    tools,
    documents,
    persist,
    modules: o['modules'] === undefined ? [] : moduleGrants(o['modules'], file),
    roots: o['roots'] === undefined ? [] : parseRoots(o['roots'], (problem) => new DefinitionError(file, problem)),
    ...(restart === undefined ? {} : { restart }),
    ...(launch === undefined ? {} : { launch }),
    ...(o['nestedCalls'] === true ? { nestedCalls: true as const } : {}),
    ...(decisions === undefined ? {} : { decisions }),
  };
}

/**
 * A recipe's `launch` (patterns-phase-3 R29): the closed object {"recipes": [1–3 distinct recipe ids], "maxPerConversation":
 * 1–3}. Its ids' files are checked where the folder is known: the team's load (`loadTeam`).
 */
function launchGrant(raw: unknown, file: string): LaunchGrant {
  const rule = `launch must be {"recipes": [<1–${String(LAUNCH_MAX_RECIPES)} distinct recipe ids>], "maxPerConversation": <1–${String(LAUNCH_MAX_PER_CONVERSATION)}>}`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DefinitionError(file, rule);
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes('recipes') || !keys.includes('maxPerConversation'))
    throw new DefinitionError(file, rule);
  const { recipes, maxPerConversation } = o;
  if (
    !Array.isArray(recipes) ||
    recipes.length < 1 ||
    recipes.length > LAUNCH_MAX_RECIPES ||
    !recipes.every((r) => typeof r === 'string' && ID.test(r)) ||
    new Set(recipes).size !== recipes.length
  ) {
    throw new DefinitionError(file, rule);
  }
  if (
    typeof maxPerConversation !== 'number' ||
    !Number.isInteger(maxPerConversation) ||
    maxPerConversation < 1 ||
    maxPerConversation > LAUNCH_MAX_PER_CONVERSATION
  )
    throw new DefinitionError(file, rule);
  return { recipes: recipes as string[], maxPerConversation };
}

/** A recipe's `restart` (R10): the closed object {"max": 1–5, "withinMs": 1,000–3,600,000}, each a whole number. */
function restartPolicy(raw: unknown, file: string): RestartPolicy {
  const rule = `restart must be {"max": <1–${String(RESTART_MAX)}>, "withinMs": <${String(RESTART_WITHIN_MS_MIN)}–${String(RESTART_WITHIN_MS_MAX)}>}, each a whole number`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new DefinitionError(file, rule);
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes('max') || !keys.includes('withinMs')) throw new DefinitionError(file, rule);
  const { max, withinMs } = o;
  const whole = (v: unknown, min: number, most: number): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= most;
  if (!whole(max, 1, RESTART_MAX) || !whole(withinMs, RESTART_WITHIN_MS_MIN, RESTART_WITHIN_MS_MAX))
    throw new DefinitionError(file, rule);
  return { max, withinMs };
}

/** A catalogue id, or a provider model as `<module>/<name>` (extension-modules R20). */
function modelRef(o: Obj, file: string, key: string): string {
  const v = str(o, file, key);
  if (!ID.test(v) && !PROVIDER_MODEL_REF.test(v))
    throw new DefinitionError(
      file,
      `${key} "${v}" is neither a catalogue id (${String(ID)}) nor a provider model, <module>/<name>`,
    );
  return v;
}

/** A recipe's `modules` (R29): a list of `<module>/<tool>`, each at most once. */
function moduleGrants(raw: unknown, file: string): string[] {
  if (!Array.isArray(raw) || !raw.every((g): g is string => typeof g === 'string' && MODULE_GRANT.test(g)))
    throw new DefinitionError(
      file,
      `modules must be a list of <module>/<tool> grants, each matching ${String(MODULE_GRANT)}`,
    );
  const twice = raw.find((g, i) => raw.indexOf(g) !== i);
  if (twice !== undefined) throw new DefinitionError(file, `modules names "${twice}" twice`);
  return raw;
}

/** `roots` (R30), in a recipe or a team file: a list of {name, path, mode}, names unique; the folders are checked at the launch. */
export function parseRoots(raw: unknown, fail: (problem: string) => Error): RootSpec[] {
  if (!Array.isArray(raw)) throw fail('roots must be a list of {"name", "path", "mode"}');
  const seen = new Set<string>();
  return raw.map((r: unknown, i) => {
    if (typeof r !== 'object' || r === null || Array.isArray(r))
      throw fail(`roots[${String(i)}] must be an object {"name", "path", "mode"}`);
    const o = r as Record<string, unknown>;
    for (const key of Object.keys(o))
      if (!['name', 'path', 'mode'].includes(key)) throw fail(`unknown field roots[${String(i)}].${key}`);
    const { name, path, mode } = o;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name))
      throw fail(`roots[${String(i)}].name must match ${String(NAME_PATTERN)}`);
    if (seen.has(name)) throw fail(`roots names "${name}" twice`);
    seen.add(name);
    if (typeof path !== 'string' || !(path.startsWith('/') || path.startsWith('~/')) || path.includes('\0'))
      throw fail(`roots[${String(i)}].path must be an absolute path, or one under the home folder as ~/…`);
    if (mode !== 'read' && mode !== 'read-write') throw fail(`roots[${String(i)}].mode must be "read" or "read-write"`);
    return { name, path, mode };
  });
}

/** A recipe's `persist`: a list naming each of "memory" and "workspace" at most once (R1). */
function persistList(raw: unknown, file: string): AgentAsset[] {
  const allowed = 'it names any of "memory" and "workspace"';
  if (!Array.isArray(raw))
    throw new DefinitionError(file, `persist must be a list naming any of "memory" and "workspace"`);
  const seen: AgentAsset[] = [];
  for (const value of raw) {
    if (!(AGENT_ASSETS as readonly unknown[]).includes(value))
      throw new DefinitionError(
        file,
        `persist names ${JSON.stringify(value)}, which a recipe cannot persist: ${allowed}`,
      );
    if (seen.includes(value as AgentAsset))
      throw new DefinitionError(file, `persist names ${JSON.stringify(value)} twice`);
    seen.push(value as AgentAsset);
  }
  return seen;
}

export interface CheckPersistenceProps {
  readonly recipe: Recipe;
  readonly recipeFile: string;
  readonly image: ImageDefinition;
  /** Launched alone, not as a team member: its saved state is then named by its recipe id (R2). */
  readonly solo: boolean;
}

/**
 * A recipe's `persist` checked against its image before any container starts (R1, R12, R16): "memory" only on an
 * image whose image.json declares `"keepsMemory": true`, `"eraseUser": true` (its promise of the per-user erase
 * mode) and a `stateSchema`; and a recipe launched alone that persists anything must have an id that is a channel
 * name, because its saved state is named by it (R2) and a reset names it with `name=` (R5). Throws DefinitionError
 * naming the recipe file and the image.
 */
export function checkPersistence(props: CheckPersistenceProps): void {
  const { recipe, recipeFile, image } = props;
  if (recipe.persist.length === 0) return;
  if (props.solo && !NAME_PATTERN.test(recipe.id)) {
    throw new DefinitionError(
      recipeFile,
      `persists state, and a recipe launched alone names its saved state by its id, which must match ${String(NAME_PATTERN)}`,
    );
  }
  if (!recipe.persist.includes('memory')) return;
  const manifest = `images/${image.name}/image.json`;
  if (!image.manifest.keepsMemory)
    throw new DefinitionError(
      recipeFile,
      `persists "memory", but its image "${image.name}" does not declare "keepsMemory": true in ${manifest}`,
    );
  if (!image.manifest.eraseUser)
    throw new DefinitionError(
      recipeFile,
      `persists "memory", but its image "${image.name}" does not declare "eraseUser": true in ${manifest} (the per-user erase mode, R16)`,
    );
  if (image.manifest.stateSchema === null)
    throw new DefinitionError(
      recipeFile,
      `persists "memory", but its image "${image.name}" does not declare a "stateSchema" in ${manifest}`,
    );
}

/**
 * A document's path: relative, inside the recipe's folder, each part a plain name that starts with a letter or
 * digit (so no `..`, no hidden file, no absolute path), ending in `.md`, at most 100 bytes (a tar entry's name,
 * as the documents reach the container).
 */
const DOCUMENT_PATH = /^([A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const DOCUMENT_PATH_MAX_BYTES = 100;

function recipeDocuments(raw: unknown, file: string): RecipeDocument[] {
  if (!Array.isArray(raw))
    throw new DefinitionError(file, 'documents must be a list of {"path", "fullText"} (omit it for none)');
  const documents = raw.map((d, i) => {
    const o = closedObject(d, file, `documents[${String(i)}].`, ['path', 'fullText']);
    const path = str(o, file, 'path', `documents[${String(i)}].`);
    if (!DOCUMENT_PATH.test(path) || Buffer.byteLength(path) > DOCUMENT_PATH_MAX_BYTES) {
      throw new DefinitionError(
        file,
        `documents[${String(i)}].path "${path}" must be a relative path to a .md file inside the recipe's folder, each part a name starting with a letter or digit, at most ${String(DOCUMENT_PATH_MAX_BYTES)} bytes`,
      );
    }
    if (typeof o['fullText'] !== 'boolean')
      throw new DefinitionError(file, `documents[${String(i)}].fullText must be true or false`);
    return { path, fullText: o['fullText'] };
  });
  const twice = documents.find((d, i) => documents.findIndex((e) => e.path === d.path) !== i);
  if (twice !== undefined) throw new DefinitionError(file, `documents names "${twice.path}" twice`);
  return documents;
}

/** The catalogue's kinds: models llama-server serves, and the decision model's two (docs/plans/decider-tool.md R1). */
const CATALOGUE_KINDS = ['chat', 'embedding', 'decider', 'decider-base'] as const;

/** Each kind's own keys, beside the ones every entry has. */
const KIND_KEYS: Readonly<Record<(typeof CATALOGUE_KINDS)[number], readonly string[]>> = {
  chat: ['serve', 'chat', 'toolCallStart'],
  embedding: ['serve', 'embed'],
  decider: ['base'],
  'decider-base': [],
};

export function parseCatalogueEntry(raw: unknown, file: string): CatalogueEntry {
  const kind = (raw as { kind?: unknown } | null)?.kind;
  if (!(CATALOGUE_KINDS as readonly unknown[]).includes(kind))
    throw new DefinitionError(file, 'kind must be "chat", "embedding", "decider" or "decider-base"');
  const known = kind as (typeof CATALOGUE_KINDS)[number];
  const o = closedObject(raw, file, '', [
    'kind',
    'id',
    'repo',
    'revision',
    'weights',
    'files',
    'license',
    ...KIND_KEYS[known],
  ]);
  const filesRaw = o['files'];
  if (!Array.isArray(filesRaw) || filesRaw.length === 0) {
    throw new DefinitionError(file, 'files must be a non-empty array');
  }
  const files = filesRaw.map((f, i) => {
    const fo = closedObject(f, file, `files[${String(i)}].`, ['path', 'size', 'sha256']);
    const path = str(fo, file, 'path', `files[${String(i)}].`);
    if (path.startsWith('/') || path.split('/').includes('..') || path.startsWith('.')) {
      throw new DefinitionError(file, `files[${String(i)}].path "${path}" must be a relative path inside the repo`);
    }
    if (PICKLE.test(path)) {
      throw new DefinitionError(
        file,
        `files[${String(i)}].path "${path}" is a pickle format; only GGUF or safetensors weights are allowed`,
      );
    }
    return {
      path,
      size: positiveInt(fo, file, 'size', `files[${String(i)}].`),
      sha256: matching(fo, file, 'sha256', SHA256_HEX, `files[${String(i)}].`),
    };
  });
  const paths = new Set(files.map((f) => f.path));
  if (paths.size !== files.length) throw new DefinitionError(file, 'files contains a duplicate path');
  const weights = str(o, file, 'weights');
  if (!paths.has(weights)) throw new DefinitionError(file, `weights "${weights}" is not listed in files`);

  const lo = closedObject(o['license'], file, 'license.', ['id', 'source', 'verified']);
  const base = {
    id: matching(o, file, 'id', ID),
    repo: str(o, file, 'repo'),
    revision: matching(o, file, 'revision', SHA1_HEX),
    weights,
    files,
    license: {
      id: str(lo, file, 'id', 'license.'),
      source: str(lo, file, 'source', 'license.'),
      verified: matching(lo, file, 'verified', DATE, 'license.'),
    },
  };
  if (known === 'decider') return { ...base, kind: known, base: matching(o, file, 'base', ID) };
  if (known === 'decider-base') return { ...base, kind: known };
  if (known === 'chat') {
    const so = closedObject(o['serve'], file, 'serve.', ['contextSize']);
    return {
      ...base,
      kind: known,
      serve: { contextSize: positiveInt(so, file, 'contextSize', 'serve.') },
      chat: chatSettings(o, file),
      toolCallStart: str(o, file, 'toolCallStart'),
    };
  }
  const so = closedObject(o['serve'], file, 'serve.', ['contextSize', 'pooling']);
  const pooling = so['pooling'];
  if (pooling !== 'last' && pooling !== 'mean' && pooling !== 'cls')
    throw new DefinitionError(file, 'serve.pooling must be "last", "mean" or "cls"');
  const eo = closedObject(o['embed'], file, 'embed.', ['dimensions', 'queryTemplate']);
  const queryTemplate = str(eo, file, 'queryTemplate', 'embed.');
  if (!queryTemplate.includes('{text}')) throw new DefinitionError(file, 'embed.queryTemplate must contain {text}');
  return {
    ...base,
    kind: known,
    serve: { contextSize: positiveInt(so, file, 'contextSize', 'serve.'), pooling },
    embed: { dimensions: positiveInt(eo, file, 'dimensions', 'embed.'), queryTemplate },
  };
}

/**
 * Per-request fields that change llama-server's prompt caching or slot choice (llama.cpp at the pinned
 * 7fe450e19, read 2026-09-28): `cache_prompt` and `n_cache_reuse` (tools/server/server-schema.cpp lines 31
 * and 67), `id_slot` (server-context.cpp line 4323, a request's own slot) and `message_delimiters` (line 4305,
 * where the prompt cache checkpoints). The server's cache arguments are the harness's (docs/plans/prompt-prefix.md
 * R9), so no definition may set these per request.
 */
const CACHING_FIELDS = ['cache_prompt', 'n_cache_reuse', 'id_slot', 'message_delimiters'] as const;

/** A `chat` block: sampling settings merged into chat requests. The harness owns the request's own fields. */
function chatSettings(o: Obj, file: string): Record<string, unknown> {
  const chat = o['chat'];
  if (typeof chat !== 'object' || chat === null || Array.isArray(chat)) {
    throw new DefinitionError(file, 'chat must be an object');
  }
  for (const reserved of ['model', 'messages', 'max_tokens', 'stream']) {
    if (reserved in chat) throw new DefinitionError(file, `chat.${reserved} is set by the harness, not the definition`);
  }
  for (const caching of CACHING_FIELDS) {
    if (caching in chat)
      throw new DefinitionError(
        file,
        `chat.${caching} changes the model server's prompt caching or slot choice, which the harness sets, not the definition`,
      );
  }
  return chat as Record<string, unknown>;
}

/** Loads definitions from the repo's checked-in `images/`, `recipes/` and `catalogue/`. */
export class Definitions {
  constructor(private readonly root: string) {}

  async image(name: string): Promise<ImageDefinition> {
    if (!isName(name)) throw new UnknownImage(name);
    const dir = join(this.root, 'images', name);
    try {
      await access(join(dir, 'Dockerfile'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UnknownImage(name);
      throw error;
    }
    const manifestFile = join(dir, 'image.json');
    const raw = await readJson(
      manifestFile,
      () =>
        new ImageManifestInvalid(manifestFile, 'missing: every image declares its tools here ({"tools": []} for none)'),
    );
    return { name, dir, repository: `asha-image-${name}`, manifest: parseImageManifest(raw, manifestFile) };
  }

  /** recipes/: a recipe launched alone is read from here, and its documents are relative to it. */
  get recipesDir(): string {
    return join(this.root, 'recipes');
  }

  /** teams/<name>/: the team file and every member's recipe, parsed and checked (collaborating-agents R5, R11). */
  async team(name: string): Promise<Team> {
    return loadTeam(join(this.root, 'teams'), name);
  }

  /** recipes/*.json, each with no team roots (part of `everyRecipe`); one that does not parse is left out. */
  private async soloRecipes(): Promise<{ file: string; recipe: Recipe; teamRoots: readonly RootSpec[] }[]> {
    const out: { file: string; recipe: Recipe; teamRoots: readonly RootSpec[] }[] = [];
    for (const entry of await listDir(this.recipesDir)) {
      if (!entry.endsWith('.json')) continue;
      const name = entry.slice(0, -'.json'.length);
      try {
        out.push({ file: join(this.recipesDir, entry), recipe: await this.recipe(name), teamRoots: [] });
      } catch (error) {
        if (!(error instanceof DefinitionError || error instanceof UnknownRecipe)) throw error;
      }
    }
    return out;
  }

  /** Every team member's recipe, with its team's roots (part of `everyRecipe`); a team that does not parse is left out. */
  private async teamRecipes(): Promise<{ file: string; recipe: Recipe; teamRoots: readonly RootSpec[] }[]> {
    const out: { file: string; recipe: Recipe; teamRoots: readonly RootSpec[] }[] = [];
    for (const entry of await listDir(join(this.root, 'teams'))) {
      try {
        const team = await this.team(entry);
        for (const member of team.members)
          out.push({ file: member.recipeFile, recipe: member.recipe, teamRoots: team.roots });
      } catch (error) {
        if (!(error instanceof TeamDefinitionError || error instanceof UnknownTeam)) throw error;
      }
    }
    return out;
  }

  /**
   * Every recipe that could be launched (docs/plans/extension-modules.md R25's shared-root comparison): each
   * recipes/*.json, and each member of each team under teams/ with its team file's roots. A recipe or team that does
   * not parse is left out: it cannot launch, and its own launch fails, naming why.
   */
  async everyRecipe(): Promise<
    readonly { readonly file: string; readonly recipe: Recipe; readonly teamRoots: readonly RootSpec[] }[]
  > {
    return [...(await this.soloRecipes()), ...(await this.teamRecipes())];
  }

  /** recipes/*.json, each as the portal lists it, or its own problem (part of `catalog`); test fixtures left out. */
  private async catalogRecipes(
    fixture: (id: string) => boolean,
    relative: (message: string) => string,
  ): Promise<(CatalogRecipe | DefinitionProblem)[]> {
    const recipes: (CatalogRecipe | DefinitionProblem)[] = [];
    for (const entry of await listDir(this.recipesDir)) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      if (fixture(id)) continue;
      try {
        const recipe = await this.recipe(id);
        recipes.push({ id, description: recipe.description, model: recipe.model });
      } catch (error) {
        if (!(error instanceof DefinitionError || error instanceof UnknownRecipe)) throw error;
        recipes.push({ id, problem: relative(error.message) });
      }
    }
    return recipes;
  }

  /** Every teams/ folder, each as the portal lists it, or its own problem (part of `catalog`); test fixtures left out. */
  private async catalogTeams(
    fixture: (id: string) => boolean,
    relative: (message: string) => string,
  ): Promise<(CatalogTeam | DefinitionProblem)[]> {
    const teams: (CatalogTeam | DefinitionProblem)[] = [];
    const teamsDir = join(this.root, 'teams');
    let folders: string[];
    try {
      folders = (await readdir(teamsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      folders = [];
    }
    for (const id of folders) {
      if (fixture(id)) continue;
      try {
        const team = await this.team(id);
        teams.push({
          id,
          description: team.description,
          members: team.members.map((m) => ({ name: m.name, recipe: m.recipe.id, description: m.recipe.description })),
        });
      } catch (error) {
        if (!(error instanceof TeamDefinitionError || error instanceof UnknownTeam)) throw error;
        teams.push({ id, problem: relative(error.message) });
      }
    }
    return teams;
  }

  /**
   * What the portal lists as launchable (docs/plans/portal-scene-chat.md R13): each recipes/*.json and each folder of
   * teams/, sorted by id, test fixtures (`suite-*`, which a release leaves out) left out and a file in teams/ skipped. One
   * that does not parse is listed with its problem — the error's message, its paths relative to this root — never left
   * out; any other failure (an unreadable folder) is thrown.
   */
  async catalog(): Promise<DefinitionsResponse> {
    const relative = (message: string): string => message.split(`${this.root}/`).join('');
    const fixture = (id: string): boolean => id.startsWith('suite-');
    const recipes = await this.catalogRecipes(fixture, relative);
    const teams = await this.catalogTeams(fixture, relative);
    return { recipes: recipes.toSorted(byKey('id')), teams: teams.toSorted(byKey('id')) };
  }

  async recipe(name: string): Promise<Recipe> {
    if (!isName(name)) throw new UnknownRecipe(name);
    const file = join(this.recipesDir, `${name}.json`);
    const recipe = parseRecipe(await readJson(file, () => new UnknownRecipe(name)), file);
    if (recipe.id !== name) throw new DefinitionError(file, `id "${recipe.id}" does not match its file name "${name}"`);
    // patterns-phase-3 R29: the recipes a grant names are files of a team's folder; a recipe launched alone has none.
    if (recipe.launch !== undefined)
      throw new DefinitionError(
        file,
        "launch is granted only to a recipe in a team's folder (teams/<team>/), whose recipe files it names",
      );
    return recipe;
  }

  async model(id: string): Promise<CatalogueEntry> {
    const file = join(this.root, 'catalogue', `${id}.json`);
    const raw = await readJson(file, () => new DefinitionError(file, `catalogue entry "${id}" does not exist`));
    const entry = parseCatalogueEntry(raw, file);
    if (entry.id !== id) throw new DefinitionError(file, `id "${entry.id}" does not match its file name "${id}"`);
    return entry;
  }

  /** A catalogue entry that must be a chat model: a recipe's `model`. A decider entry is refused: llama-server never serves one. */
  async chatModel(id: string): Promise<ChatModelEntry> {
    const entry = await this.model(id);
    if (entry.kind !== 'chat')
      throw new DefinitionError(
        `catalogue/${id}.json`,
        `"${id}" is ${article(entry.kind)} ${entry.kind} model, not a chat model`,
      );
    return entry;
  }

  /** A catalogue entry that must be an embedding model: a recipe's `embeddingModel`. A decider entry is refused. */
  async embeddingModel(id: string): Promise<EmbeddingModelEntry> {
    const entry = await this.model(id);
    if (entry.kind !== 'embedding')
      throw new DefinitionError(
        `catalogue/${id}.json`,
        `"${id}" is ${article(entry.kind)} ${entry.kind} model, not an embedding model`,
      );
    return entry;
  }

  /**
   * A decider entry and the `decider-base` entry its `base` names (docs/plans/decider-tool.md R1). A base that is
   * missing, or not of kind `decider-base`, fails naming both.
   */
  async decider(id: string): Promise<{ readonly adapter: DeciderEntry; readonly base: DeciderBaseEntry }> {
    const adapter = await this.model(id);
    if (adapter.kind !== 'decider')
      throw new DefinitionError(
        `catalogue/${id}.json`,
        `"${id}" is ${article(adapter.kind)} ${adapter.kind} model, not a decider`,
      );
    let base: CatalogueEntry;
    try {
      base = await this.model(adapter.base);
    } catch (error) {
      if (!(error instanceof DefinitionError)) throw error;
      throw new DefinitionError(
        `catalogue/${id}.json`,
        `decider "${id}" names base "${adapter.base}", which is no decider-base entry: ${error.message}`,
      );
    }
    if (base.kind !== 'decider-base')
      throw new DefinitionError(
        `catalogue/${id}.json`,
        `decider "${id}" names base "${adapter.base}", which is ${article(base.kind)} ${base.kind} entry, not a decider-base entry`,
      );
    return { adapter, base };
  }
}

/** "an" before a kind that starts with a vowel ("an embedding model"), "a" before any other ("a decider model"). */
function article(kind: string): string {
  return /^[aeiou]/.test(kind) ? 'an' : 'a';
}

/** A directory's entries, or [] when it does not exist. */
async function listDir(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort(byCodeUnit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function readJson(file: string, whenMissing: () => Error): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw whenMissing();
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DefinitionError(file, `not valid JSON: ${(error as Error).message}`);
  }
}

type Obj = Record<string, unknown>;

/** An object with exactly these keys; those in `optional` may be absent. */
function closedObject(
  raw: unknown,
  file: string,
  prefix: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): Obj {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new DefinitionError(file, `${prefix || 'top level'} must be an object`);
  }
  for (const key of Object.keys(raw)) {
    if (!keys.includes(key)) throw new DefinitionError(file, `unknown field ${prefix}${key}`);
  }
  for (const key of keys) {
    if (!(key in raw) && !optional.includes(key)) throw new DefinitionError(file, `missing field ${prefix}${key}`);
  }
  return raw as Obj;
}

function str(o: Obj, file: string, key: string, prefix = ''): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0)
    throw new DefinitionError(file, `${prefix}${key} must be a non-empty string`);
  return v;
}

function matching(o: Obj, file: string, key: string, pattern: RegExp, prefix = ''): string {
  const v = str(o, file, key, prefix);
  if (!pattern.test(v)) throw new DefinitionError(file, `${prefix}${key} "${v}" does not match ${String(pattern)}`);
  return v;
}

function positiveInt(o: Obj, file: string, key: string, prefix = ''): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new DefinitionError(file, `${prefix}${key} must be a positive integer`);
  }
  return v;
}
