// A launch's modules, checked before any container starts (docs/plans/extension-modules.md R9, R18b, R18c, R19, R20,
// R25, R29, R30, R34, M13): each grant names an installed module's tool; a provider model names an installed
// provider's model; a granted tool's bound fits the recipe's message bound; an external-unmetered plugin carries the
// owner's approval and a metered module has been enabled; each named root is a folder R30 allows; and the memory rule —
// an image that keeps memory is never cloud-granted, and never shares a root with a cloud-granted recipe. Every refusal
// is a ModuleRefused, the launch's `module_refused`, naming what it refuses.

import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { present } from '../../shared/assert-present.js';
import { byCodeUnit } from '../../shared/order.js';
import { AGENT_CHAT_TIMEOUT_MS } from '../../shared/protocol.js';
import {
  isCloudModule,
  offeredTools,
  PROVIDER_CHAT_FIELDS,
  type CommandDeclaration,
  type ModuleToolDeclaration,
  type ProviderModel,
} from '../../shared/modules.js';
import { moduleToolWireName, type ToolParameters } from '../../shared/tools.js';
import {
  MODULE_GRANT,
  PROVIDER_MODEL_REF,
  type ModuleGrant,
  type Recipe,
  type RootSpec,
} from '../definitions/index.js';
import type { InstalledModule } from './images.js';
import { rootRefusal, rootsOverlap, type AllowedRoot } from './paths.js';

/** The SDK's margin over a tool's bound (R10): its bound on a module call is the tool's timeoutMs plus this. */
const SDK_MODULE_MARGIN_MS = 5_000;
/** A turn that uses a granted tool takes at least two model calls at their bound, the tool's bound and the margin (R34). */
export const TURN_OVERHEAD_MS = 2 * AGENT_CHAT_TIMEOUT_MS + SDK_MODULE_MARGIN_MS;

/** A launch's modules are refused before any container starts (`module_refused`). */
export class ModuleRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleRefused';
  }
}

/** One granted tool, as the supervisor keeps it: its wire name, its module, and its declaration. */
export interface GrantedTool {
  readonly wire: string;
  readonly module: string;
  readonly tool: string;
  readonly installed: InstalledModule;
  readonly classes: readonly string[];
  readonly timeoutMs: number;
  readonly description: string;
  readonly parameters: ToolParameters;
  /** A ToolModule's tool, or a command plugin's command. */
  readonly kind: 'tool' | 'command';
  readonly declaration: ModuleToolDeclaration | CommandDeclaration;
}

/** A recipe's provider model (R19, R20). */
export interface ProviderModelRef {
  readonly module: string;
  readonly installed: InstalledModule;
  readonly model: ProviderModel;
  /** The recipe's `chat` merged over the model's defaults, from the closed set a provider translates. */
  readonly settings: Readonly<Record<string, number>>;
}

export interface LaunchModules {
  readonly grants: readonly ModuleGrant[];
  /** By wire name, in the recipe's `modules` order. */
  readonly tools: ReadonlyMap<string, GrantedTool>;
  /** The modules whose containers or networks the launch acquires, each once. */
  readonly acquire: readonly string[];
  /** R25: a cloud module granted, or a hosted model used. */
  readonly cloudGranted: boolean;
  /** The cloud modules and hosted models it may send data to (R21): `tavily`, `bedrock/ministral`. */
  readonly cloud: readonly string[];
  readonly chat: ProviderModelRef | undefined;
  readonly embedding: ProviderModelRef | undefined;
  readonly roots: readonly AllowedRoot[];
  /** Whether any granted tool is classed untrusted-input (R15). */
  readonly untrustedInput: boolean;
}

export interface ModuleChecksProps {
  readonly installed: ReadonlyMap<string, InstalledModule>;
  /** A metered module's meter state (R18b): enabled, not, or the meter's file does not parse. */
  readonly meter: (module: string) => 'enabled' | 'disabled' | 'unavailable';
  readonly ashaHome: string;
  readonly home: string;
}

/** Throws ModuleRefused, after `what`, unless the metered module is enabled and the meter's file parses (R18b). */
function meteredRefusal(props: ModuleChecksProps, module: string, what: string): void {
  const state = props.meter(module);
  if (state === 'disabled')
    throw new ModuleRefused(
      `${what} is metered and not enabled: asha --enable-module id=${module} conversation=<usd> day=<usd> month=<usd>`,
    );
  if (state === 'unavailable')
    throw new ModuleRefused(
      `${what} is metered, and metering.json does not parse: every metered call is refused until it is repaired or removed (budget_meter_unavailable)`,
    );
}

/**
 * `model`'s chat defaults merged with the recipe's own `chat` settings, each checked against the closed set a
 * provider translates (R19; helper of {@link providerModel}, split out to keep its cognitive complexity down).
 */
function chatSettings(
  recipe: Recipe,
  kind: 'chat' | 'embedding',
  moduleId: string,
  recipeFile: string,
  model: ProviderModel,
): Record<string, number> {
  const settings: Record<string, number> = { ...model.chat };
  if (kind !== 'chat') return settings;
  for (const [key, value] of Object.entries(recipe.chat)) {
    if (!(PROVIDER_CHAT_FIELDS as readonly string[]).includes(key))
      throw new ModuleRefused(
        `${recipeFile}: chat.${key} is not one of ${PROVIDER_CHAT_FIELDS.join(', ')}, the settings provider ${moduleId} translates (R19)`,
      );
    if (typeof value !== 'number') throw new ModuleRefused(`${recipeFile}: chat.${key} must be a number`);
    settings[key] = value;
  }
  return settings;
}

/** A provider model a recipe names, or ModuleRefused naming it (R19, R20). */
function providerModel(
  props: ModuleChecksProps,
  ref: string,
  kind: 'chat' | 'embedding',
  recipe: Recipe,
  recipeFile: string,
): ProviderModelRef {
  // `ref` matched PROVIDER_MODEL_REF when the recipe was parsed (definitions/index.ts's modelRef): a module name and
  // a model name, both capture groups always present when the whole pattern matches (neither is optional in it).
  const m = present(
    PROVIDER_MODEL_REF.exec(ref),
    `${ref} (checked against PROVIDER_MODEL_REF when the recipe was parsed)`,
  );
  const moduleId = present(m[1], `${ref}'s module name (capture group 1)`);
  const modelName = present(m[2], `${ref}'s model name (capture group 2)`);
  const installed = props.installed.get(moduleId);
  if (installed === undefined)
    throw new ModuleRefused(
      `${recipeFile}: its ${kind === 'chat' ? 'model' : 'embeddingModel'} ${ref} names module ${moduleId}, which is not installed`,
    );
  if (installed.manifest.kind !== 'ModelProvider')
    throw new ModuleRefused(
      `${recipeFile}: ${ref} names module ${moduleId}, which is a ${installed.manifest.kind}, not a ModelProvider`,
    );
  const model = installed.manifest.models.find((x) => x.name === modelName);
  if (model === undefined) throw new ModuleRefused(`${recipeFile}: module ${moduleId} declares no model ${modelName}`);
  const an = (k: string): string => (k === 'embedding' ? `an ${k}` : `a ${k}`);
  if (model.kind !== kind)
    throw new ModuleRefused(`${recipeFile}: ${ref} is ${an(model.kind)} model, not ${an(kind)} model`);
  const settings = chatSettings(recipe, kind, moduleId, recipeFile, model);
  if (installed.manifest.cost.model === 'metered')
    meteredRefusal(props, installed.manifest.id, `${recipeFile}: module ${installed.manifest.id}`);
  return { module: installed.manifest.id, installed, model, settings };
}

/** Resolves a root's path: `~/` under the home folder, then realpath (it must exist). */
async function resolveRootPath(path: string, home: string): Promise<string> {
  const absolute = path.startsWith('~/') ? join(home, path.slice(2)) : path;
  if (!isAbsolute(absolute)) throw new ModuleRefused(`root path ${path} is not absolute`);
  try {
    return await realpath(absolute);
  } catch (error) {
    throw new ModuleRefused(
      `root path ${path} does not resolve: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`,
    );
  }
}

/** One grant's resolved tool, record and cloud status (helper of {@link checkLaunchModules}). */
interface ResolvedGrant {
  readonly wire: string;
  readonly tool: GrantedTool;
  readonly grant: ModuleGrant;
  readonly cloud: boolean;
}

/**
 * One grant's module, tool and refusal checks (R18c, R29, R34), resolved to what the launch records (helper of
 * {@link checkLaunchModules}, split out to keep its cognitive complexity down).
 */
function resolveGrant(props: ModuleChecksProps, recipe: Recipe, recipeFile: string, grant: string): ResolvedGrant {
  // `grant` matched MODULE_GRANT when the recipe was parsed (definitions/index.ts's moduleGrants): a module name
  // and a tool name, both capture groups always present when the whole pattern matches.
  const matched = present(
    MODULE_GRANT.exec(grant),
    `${grant} (checked against MODULE_GRANT when the recipe was parsed)`,
  );
  const module = present(matched[1], `${grant}'s module name (capture group 1)`);
  const toolName = present(matched[2], `${grant}'s tool name (capture group 2)`);
  const installed = props.installed.get(module);
  if (installed === undefined)
    throw new ModuleRefused(`${recipeFile}: it grants ${grant}, and module ${module} is not installed`);
  if (installed.manifest.kind === 'ModelProvider')
    throw new ModuleRefused(
      `${recipeFile}: it grants ${grant}, and ${module} is a ModelProvider: a recipe uses one by naming its model (R29)`,
    );
  const offered = offeredTools(installed.manifest).find((t) => t.name === toolName);
  if (offered === undefined)
    throw new ModuleRefused(`${recipeFile}: it grants ${grant}, and module ${module} declares no tool ${toolName}`);
  // R34: a turn using the tool — two model calls at their bound, the tool's bound and the SDK's margin — fits the message bound.
  if (offered.timeoutMs + TURN_OVERHEAD_MS > recipe.messageTimeoutMs)
    throw new ModuleRefused(
      `${recipeFile}: it grants ${grant}, whose timeoutMs ${String(offered.timeoutMs)} + ${String(TURN_OVERHEAD_MS)} ms (two model calls and the SDK's margin) is over its messageTimeoutMs ${String(recipe.messageTimeoutMs)}: a turn using it would be stopped (R34)`,
    );
  if (
    installed.manifest.kind === 'CommandTool' &&
    installed.manifest.cost.model === 'external-unmetered' &&
    installed.manifest.cost.approved === undefined
  )
    throw new ModuleRefused(
      `${recipeFile}: it grants ${grant}, and command plugin ${module} has no owner's approval of its cost (cost.approved) in its manifest (R18c)`,
    );
  if (installed.manifest.cost.model === 'metered')
    meteredRefusal(props, module, `${recipeFile}: it grants ${grant}, and module ${module}`);
  const wire = moduleToolWireName(module, toolName);
  const declaration =
    installed.manifest.kind === 'ToolModule'
      ? present(
          installed.manifest.tools.find((t) => t.name === toolName),
          `tool ${toolName} on module ${module} (offeredTools found it already)`,
        )
      : present(
          installed.manifest.commands.find((c) => c.name === toolName),
          `command ${toolName} on module ${module} (offeredTools found it already)`,
        );
  const tool: GrantedTool = {
    wire,
    module,
    tool: toolName,
    installed,
    classes: offered.classes,
    timeoutMs: offered.timeoutMs,
    description: offered.description,
    parameters: offered.parameters,
    kind: installed.manifest.kind === 'ToolModule' ? 'tool' : 'command',
    declaration,
  };
  return { wire, tool, grant: { module, command: toolName }, cloud: isCloudModule(installed.manifest) };
}

/** Every root the recipe or its team file names (R30), realpath'd and refused if R30 forbids it (helper of {@link checkLaunchModules}). */
async function resolveRoots(
  props: ModuleChecksProps,
  recipe: Recipe,
  teamRoots: readonly RootSpec[],
  recipeFile: string,
): Promise<AllowedRoot[]> {
  const roots: AllowedRoot[] = [];
  for (const spec of [...recipe.roots, ...teamRoots]) {
    if (roots.some((r) => r.name === spec.name))
      throw new ModuleRefused(`${recipeFile}: root ${spec.name} is named by both the recipe and its team file`);
    const host = await resolveRootPath(spec.path, props.home);
    const refusal = rootRefusal(
      { name: spec.name, path: host, mode: spec.mode },
      { home: await realpath(props.home), ashaHome: resolve(props.ashaHome) },
    );
    if (refusal !== undefined)
      throw new ModuleRefused(`${recipeFile}: root ${spec.name} (${spec.path}) is refused: ${refusal}`);
    roots.push({ name: spec.name, host, mode: spec.mode });
  }
  return roots;
}

/** Every check of a launch's modules (R9, R18b, R18c, R19, R25, R29, R30, R34). */
export async function checkLaunchModules(
  props: ModuleChecksProps,
  recipe: Recipe,
  recipeFile: string,
  teamRoots: readonly RootSpec[],
  keepsMemory: boolean,
  imageName: string,
): Promise<LaunchModules> {
  const tools = new Map<string, GrantedTool>();
  const grants: ModuleGrant[] = [];
  const acquire = new Set<string>();
  const cloud = new Set<string>();
  for (const grant of recipe.modules) {
    const resolved = resolveGrant(props, recipe, recipeFile, grant);
    tools.set(resolved.wire, resolved.tool);
    grants.push(resolved.grant);
    acquire.add(resolved.tool.module);
    if (resolved.cloud) cloud.add(resolved.tool.module);
  }
  const chat = recipe.model.includes('/') ? providerModel(props, recipe.model, 'chat', recipe, recipeFile) : undefined;
  const embedding =
    recipe.embeddingModel !== null && recipe.embeddingModel.includes('/')
      ? providerModel(props, recipe.embeddingModel, 'embedding', recipe, recipeFile)
      : undefined;
  for (const ref of [chat, embedding]) {
    if (ref === undefined) continue;
    acquire.add(ref.module);
    cloud.add(`${ref.module}/${ref.model.name}`);
  }
  const cloudGranted = cloud.size > 0;
  // R25: an image that keeps memory is never cloud-granted.
  if (keepsMemory && cloudGranted)
    throw new ModuleRefused(
      `${recipeFile}: its image ${imageName} keeps memory, and it is cloud-granted (${[...cloud].join(', ')}): memory never leaves the machine (R25)`,
    );
  const roots = await resolveRoots(props, recipe, teamRoots, recipeFile);
  const untrustedInput = [...tools.values()].some((t) => t.classes.includes('untrusted-input'));
  return {
    grants,
    tools,
    acquire: [...acquire],
    cloudGranted,
    cloud: [...cloud].sort(byCodeUnit),
    chat,
    embedding,
    roots,
    untrustedInput,
  };
}

/** Whether a recipe is cloud-granted (R25), from the recipe and the installed manifests alone; the one function deciding it. */
export function isCloudGrantedRecipe(recipe: Recipe, installed: ReadonlyMap<string, InstalledModule>): boolean {
  const viaModule = recipe.modules.some((grant) => {
    const module = MODULE_GRANT.exec(grant)?.[1];
    const m = module === undefined ? undefined : installed.get(module);
    return m !== undefined && isCloudModule(m.manifest);
  });
  const viaModel = [recipe.model, recipe.embeddingModel].some((ref) => {
    if (ref === null || !PROVIDER_MODEL_REF.test(ref)) return false;
    const m = present(PROVIDER_MODEL_REF.exec(ref), `${ref} (just tested true against PROVIDER_MODEL_REF)`);
    const moduleId = present(m[1], `${ref}'s module name (capture group 1)`);
    return installed.get(moduleId)?.manifest.kind === 'ModelProvider';
  });
  return viaModule || viaModel;
}

/** One recipe that could be launched, for R25's shared-root comparison: its file, its kind, and its roots resolved. */
export interface ComparedRecipe {
  readonly file: string;
  readonly keepsMemory: boolean;
  readonly cloudGranted: boolean;
  readonly roots: readonly { readonly name: string; readonly host: string }[];
}

/** One root of `launched`'s and one of `other`'s that overlap, the first found, or undefined (helper of {@link sharedRootRefusal}). */
function overlappingRoots(
  launched: readonly { readonly name: string; readonly host: string }[],
  other: readonly { readonly name: string; readonly host: string }[],
):
  | {
      readonly a: { readonly name: string; readonly host: string };
      readonly b: { readonly name: string; readonly host: string };
    }
  | undefined {
  for (const a of launched) for (const b of other) if (rootsOverlap(a.host, b.host)) return { a, b };
  return undefined;
}

/**
 * R25's shared-root rule: the launched recipe (or team member) refused when a root it reaches is also reached by a
 * recipe of the other kind — one keeps memory, the other is cloud-granted — anywhere in recipes/ or teams/.
 */
export function sharedRootRefusal(launched: ComparedRecipe, others: readonly ComparedRecipe[]): string | undefined {
  if (!launched.keepsMemory && !launched.cloudGranted) return undefined;
  for (const other of others) {
    if (other.file === launched.file) continue;
    const otherKind = launched.keepsMemory ? other.cloudGranted : other.keepsMemory;
    if (!otherKind) continue;
    const overlap = overlappingRoots(launched.roots, other.roots);
    if (overlap !== undefined)
      return `root ${overlap.a.name} (${overlap.a.host}) is also reached by ${other.file} (root ${overlap.b.name}, ${overlap.b.host}), and one of the two keeps memory while the other is cloud-granted: memory never leaves the machine (R25)`;
  }
  return undefined;
}

/** Resolves a root for comparison: realpath when it exists, else the path as written (a recipe that cannot launch). */
export async function comparableRoot(path: string, home: string): Promise<string> {
  const absolute = path.startsWith('~/') ? join(home, path.slice(2)) : path;
  try {
    return await realpath(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A root that does not exist: that recipe's own launch fails on it; for the comparison its path stands as written.
    if (code === 'ENOENT' || code === 'ENOTDIR') return resolve(absolute);
    throw error;
  }
}
