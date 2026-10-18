// Extension modules' manifest (docs/plans/extension-modules.md R2, R10 (b), R11, R18a, R20, R26, R28, R31): the one
// closed schema the installer (`asha --install-module`) and the daemon's loader both parse with this function, so the
// two can never disagree. Every name a manifest supplies that becomes a host path or part of another name is
// pattern-checked here; every failure names the module and the field.

import { PERMISSIVE_LICENCES } from './licences.js';
import { moduleToolWireName, parseToolParameters, ToolSchemaInvalid, type ToolParameters } from './tools.js';
import { hasInvisible, invisibleIn } from './visible.js';

export { PERMISSIVE_LICENCES };

/** A module's id: it names `ASHA_HOME/modules/<id>/`, and is the first part of every wire name (R2, moduleToolWireName). */
export const MODULE_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** A tool's or command's name: the second part of its wire name. */
const MODULE_TOOL_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
/** A secret's name: an environment variable of the module's container. */
export const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Variable names a module may never set — as a secret or in a command plugin's fixed environment — because the host
 * process that starts its container (the docker CLI) inherits them, or because the harness sets them itself
 * (`HTTPS_PROXY`): its program search path, home and temporary folders, its shell start-up, the dynamic linker's
 * preloads, Docker's, Node's and colima's own settings, every proxy, and asha's (review of 2026-10-02, finding H1).
 */
export function reservedVariableName(name: string): boolean {
  return (
    [
      'PATH',
      'HOME',
      'TMPDIR',
      'TMP',
      'TEMP',
      'USER',
      'LOGNAME',
      'SHELL',
      'PWD',
      'IFS',
      'ENV',
      'BASH_ENV',
      'CDPATH',
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'NO_PROXY',
    ].includes(name) ||
    /^(DOCKER|DYLD|LD|NODE|NPM|COLIMA|LIMA|BUILDKIT|COMPOSE|ASHA|GIT)_/.test(name) ||
    /_PROXY$/.test(name)
  );
}
/** A provider model's local name: what a recipe writes after `<module>/`. */
const PROVIDER_MODEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** One component of a path in a module directory: a plain name that never begins with `.` (R2). */
const PATH_COMPONENT = /^[A-Za-z0-9@_+][A-Za-z0-9@._+-]{0,127}$/;
/** A command plugin's release archive's file name (R28). */
const ARCHIVE_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The installer's own record of a command plugin's install (R28): never a manifest's file. */
export const INSTALL_RECORD = '.asha-install.json';
export const MANIFEST_FILE = 'module.json';
/** The architectures a command plugin's archive map may name, as `uname -m` names them in the colima VM (R28). */
const ARCHITECTURES = ['aarch64', 'x86_64'] as const;
export type Architecture = (typeof ARCHITECTURES)[number];

type ModuleKind = 'ToolModule' | 'ModelProvider' | 'CommandTool';

/** A tool's classes (R11): from this closed set. */
const TOOL_CLASSES = ['untrusted-input', 'egress', 'consequential'] as const;
type ToolClassName = (typeof TOOL_CLASSES)[number];

/** Bounds a manifest's tool may declare (R34): a module tool at most 60 s, a plugin command at most 600 s. */
const MAX_MODULE_TOOL_TIMEOUT_MS = 60_000;
const MAX_COMMAND_TIMEOUT_MS = 600_000;
/** A tool's description, and each parameter's, in UTF-8 bytes (R10 (b)): they enter the model's prompt. */
const MAX_TOOL_DESCRIPTION_BYTES = 512;
const MAX_PARAMETER_DESCRIPTION_BYTES = 200;

/** Where a fact was read, and when (PRINCIPLES §12). */
interface SourceRecord {
  readonly url: string;
  /** The date it was read, YYYY-MM-DD. */
  readonly read: string;
}

/** A licence: its SPDX id, the licence file's URL at the exact version, and the date it was read (R2, R26). */
interface LicenceRecord extends SourceRecord {
  readonly id: string;
}

/** The owner's approval of a vendor's spend (R18a): who, when, and the monthly cap in USD. */
interface CostApproval {
  readonly by: string;
  readonly date: string;
  readonly capUsd: number;
}

/**
 * A module's cost model (R18a). `metered`: a ToolModule names its unit and price per call (`perCallUnits` units of
 * `unitUsd` each, its source and the date read); a ModelProvider's prices are per model. `external-unmetered`: a
 * vendor the harness cannot meter (every command plugin, R18c).
 */
type CostModel =
  | { readonly model: 'free' }
  | { readonly model: 'local' }
  | {
      readonly model: 'metered';
      /** A ToolModule's per-call price; absent for a ModelProvider, whose prices are its models'. */
      readonly perCall?: { readonly unit: string; readonly units: number; readonly unitUsd: number } & SourceRecord;
      readonly approved?: CostApproval;
    }
  | { readonly model: 'external-unmetered'; readonly approved?: CostApproval };

/** One tool of a ToolModule (R2, R10, R11, R34). */
export interface ModuleToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly classes: readonly ToolClassName[];
  readonly timeoutMs: number;
  readonly parameters: ToolParameters;
}

/** One argument of a command (R31): exactly one type. `option`, when given, precedes the value (`--bucket x`). */
export type CommandArgument = (
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: 'integer'; readonly minimum: number; readonly maximum: number }
  | { readonly type: 'string'; readonly pattern: string }
  | { readonly type: 'remote'; readonly pattern: string }
  | { readonly type: 'path'; readonly mode: 'read' | 'write'; readonly recursive: boolean }
) & { readonly option?: string; readonly description: string };

/** One command of a CommandTool (R28, R31): offered to an agent as one tool. */
export interface CommandDeclaration {
  readonly name: string;
  readonly description: string;
  readonly classes: readonly ToolClassName[];
  readonly timeoutMs: number;
  /** The fixed argument prefix, e.g. ["s3", "cp"]. */
  readonly prefix: readonly string[];
  /** Options the manifest fixes, after the prefix (e.g. ["--region", "us-east-1"]). */
  readonly fixed: readonly string[];
  /** The typed arguments, in the order they are placed on the command line. */
  readonly arguments: Readonly<Record<string, CommandArgument>>;
  readonly required: readonly string[];
}

/** A provider model (R20): pinned by the vendor's exact id, with its card, prices, terms and retention, each dated. */
export interface ProviderModel {
  readonly name: string;
  readonly kind: 'chat' | 'embedding';
  readonly id: string;
  readonly card: SourceRecord;
  /** The card's launch date. */
  readonly launched: string;
  readonly prices: { readonly inputUsdPerMTok: number; readonly outputUsdPerMTok: number } & SourceRecord;
  readonly terms: SourceRecord;
  readonly retention: SourceRecord;
  /** A chat model's defaults, from the closed set its module translates (R19): `temperature`, `top_p`. */
  readonly chat: Readonly<Record<string, number>>;
  /** An embedding model's vector length. */
  readonly dimensions?: number;
}

/** A command plugin's release archive for one architecture (R28). */
export interface ArchiveEntry {
  readonly url: string;
  readonly sha256: string;
  readonly file: string;
}

/** A command plugin's executable (R28): what it is, its own licence, its archives and how their signature was checked. */
interface ExecutableDeclaration {
  readonly name: string;
  readonly version: string;
  readonly licence: LicenceRecord;
  readonly signature: {
    readonly method: string;
    readonly fingerprint: string;
    readonly verifiedBy: string;
    readonly date: string;
  };
  readonly archives: Readonly<Partial<Record<Architecture, ArchiveEntry>>>;
  /** Variables fixed on every command's container (R33: AWS_CONFIG_FILE=/dev/null for the AWS CLI). */
  readonly env: Readonly<Record<string, string>>;
}

interface ManifestBase {
  readonly id: string;
  readonly version: string;
  /** The file the module's container runs (JS kinds), or `Dockerfile` (a CommandTool). */
  readonly entry: string;
  /** The sha256 of every file in the directory but module.json, the archive and the install record (R2). */
  readonly files: Readonly<Record<string, string>>;
  /** The module's own licence. */
  readonly licence: LicenceRecord;
  /** Each lockfile package's licence and version, by its lockfile path (`node_modules/<name>`) (R4). */
  readonly dependencies: Readonly<Record<string, LicenceRecord & { readonly version: string }>>;
  /** Every network host it may reach: names, a wildcard `*.<at least three labels>` allowed (R6 (c)). */
  readonly hosts: readonly string[];
  readonly secrets: readonly string[];
  readonly cost: CostModel;
}

interface ToolModuleManifest extends ManifestBase {
  readonly kind: 'ToolModule';
  readonly tools: readonly ModuleToolDeclaration[];
}

export interface ModelProviderManifest extends ManifestBase {
  readonly kind: 'ModelProvider';
  readonly models: readonly ProviderModel[];
}

export interface CommandToolManifest extends ManifestBase {
  readonly kind: 'CommandTool';
  readonly executable: ExecutableDeclaration;
  readonly commands: readonly CommandDeclaration[];
}

export type ModuleManifest = ToolModuleManifest | ModelProviderManifest | CommandToolManifest;

/** A manifest fails the schema. Names the module (or the file, before its id is read) and the field. */
export class ManifestInvalid extends Error {
  constructor(
    readonly module: string,
    readonly field: string,
    detail: string,
  ) {
    super(`module ${module}: ${field}: ${detail}`);
    this.name = 'ManifestInvalid';
  }
}

type Obj = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `field.key`, or `key` alone when `field` is the top level (`''`) — its own function so a template literal
 * nested inside another's interpolation (sonarjs/no-nested-template-literals) is never needed to compute it. */
function at(field: string, key: string): string {
  return field === '' ? key : `${field}.${key}`;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const OPTION = /^--[a-z0-9][a-z0-9-]*$/;
const PREFIX_WORD = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** A package's path in package-lock.json: node_modules/<name>, nested, with scopes. */
const LOCK_PATH = /^node_modules\/(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+(\/node_modules\/(@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)*$/;
/** Chat defaults a provider translates (R19). */
export const PROVIDER_CHAT_FIELDS = ['temperature', 'top_p'] as const;

class Reader {
  constructor(readonly module: string) {}

  fail(field: string, detail: string): never {
    throw new ManifestInvalid(this.module, field, detail);
  }

  closed(raw: unknown, field: string, keys: readonly string[], optional: readonly string[] = []): Obj {
    if (!isObject(raw)) this.fail(field, 'must be an object');
    for (const key of Object.keys(raw)) if (!keys.includes(key)) this.fail(at(field, key), 'unknown field');
    for (const key of keys) if (!(key in raw) && !optional.includes(key)) this.fail(at(field, key), 'missing');
    return raw;
  }

  string(o: Obj, field: string, key: string, pattern?: RegExp): string {
    const v = o[key];
    const where = field === '' ? key : `${field}.${key}`;
    if (typeof v !== 'string' || v === '') this.fail(where, 'must be a non-empty string');
    if (pattern !== undefined && !pattern.test(v)) this.fail(where, `"${v}" does not match ${String(pattern)}`);
    return v;
  }

  url(o: Obj, field: string, key: string): string {
    const v = this.string(o, field, key);
    if (!/^https:\/\/[^\s]+$/.test(v)) this.fail(`${field}.${key}`, 'must be an https URL');
    return v;
  }

  number(o: Obj, field: string, key: string, check: (n: number) => boolean, rule: string): number {
    const v = o[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || !check(v)) this.fail(at(field, key), `must be ${rule}`);
    return v;
  }

  source(raw: unknown, field: string, extra: readonly string[] = []): SourceRecord & Obj {
    const o = this.closed(raw, field, ['url', 'read', ...extra]);
    return { ...o, url: this.url(o, field, 'url'), read: this.string(o, field, 'read', DATE) };
  }

  licence(raw: unknown, field: string, extra: readonly string[] = []): LicenceRecord & Obj {
    const o = this.closed(raw, field, ['id', 'url', 'read', ...extra]);
    return {
      ...o,
      id: this.string(o, field, 'id'),
      url: this.url(o, field, 'url'),
      read: this.string(o, field, 'read', DATE),
    };
  }

  /** A description that enters the prompt (R10 (b)): at most `max` bytes, printable, no invisible or direction-changing character. */
  description(o: Obj, field: string, key: string, max: number): string {
    const v = this.string(o, field, key);
    const bytes = Buffer.byteLength(v, 'utf8');
    if (bytes > max)
      this.fail(`${field}.${key}`, `is ${String(bytes)} bytes, over the ${String(max)} a description may hold`);
    if (hasInvisible(v))
      this.fail(`${field}.${key}`, `holds an invisible or direction-changing character (${invisibleIn(v).join(', ')})`);
    return v;
  }

  classes(o: Obj, field: string): ToolClassName[] {
    const raw = o['classes'];
    if (!Array.isArray(raw)) this.fail(`${field}.classes`, `must be a list from ${TOOL_CLASSES.join(', ')}`);
    const seen: ToolClassName[] = [];
    for (const c of raw) {
      if (!(TOOL_CLASSES as readonly unknown[]).includes(c))
        this.fail(`${field}.classes`, `${JSON.stringify(c)} is not one of ${TOOL_CLASSES.join(', ')}`);
      if (seen.includes(c as ToolClassName)) this.fail(`${field}.classes`, `names ${String(c)} twice`);
      seen.push(c as ToolClassName);
    }
    return seen;
  }
}

/** A path in a module's per-file list: relative, each component a plain name not beginning with `.` (R2). */
function moduleFilePathProblem(path: string): string | undefined {
  if (path.length > 1024) return 'is longer than 1,024 characters';
  const parts = path.split('/');
  for (const part of parts)
    if (!PATH_COMPONENT.test(part))
      return `component "${part}" is not a plain name (${String(PATH_COMPONENT)}; never beginning with ".")`;
  if (path === MANIFEST_FILE) return `names ${MANIFEST_FILE}, which the list never holds`;
  if (path === INSTALL_RECORD) return `names ${INSTALL_RECORD}, the installer's own record`;
  return undefined;
}

/**
 * A host entry (R6 (c)): a lowercase DNS name of at least two labels; or `*.` and at least three labels
 * (`*.s3.us-east-1.amazonaws.com`, never `*.amazonaws.com` or `*.com`). Undefined when it is valid.
 */
export function hostProblem(host: string): string | undefined {
  const wildcard = host.startsWith('*.');
  const labels = (wildcard ? host.slice(2) : host).split('.');
  if (labels.some((l) => !HOST_LABEL.test(l))) return 'is not a lowercase DNS name';
  if (host.length > 253) return 'is longer than 253 characters';
  if (wildcard && labels.length < 3)
    return `a wildcard needs at least three labels after "*.", and "${host}" has ${String(labels.length)}`;
  if (!wildcard && labels.length < 2) return 'needs at least two labels';
  if (labels.every((l) => /^\d+$/.test(l))) return 'is an address, not a name';
  return undefined;
}

/** Whether `host` (a CONNECT's host, lowercase) is allowed by `entries` (R6 (c)): equal to one, or under one wildcard by exactly one label. */
export function hostAllowed(host: string, entries: readonly string[]): boolean {
  const h = host.toLowerCase();
  return entries.some((entry) => {
    if (!entry.startsWith('*.')) return entry === h;
    const suffix = entry.slice(1);
    if (!h.endsWith(suffix)) return false;
    const label = h.slice(0, -suffix.length);
    return HOST_LABEL.test(label);
  });
}

/** Why a provider model id is not a pin (R20): an alias that moves, an inference profile, an ARN; undefined when it is one. */
export function providerModelIdProblem(id: string): string | undefined {
  if (/^arn:/i.test(id)) return 'is an ARN';
  if (/^(us|eu|apac|global)\./.test(id)) return 'is an inference-profile id (a us., eu., apac. or global. prefix)';
  if (/(^|[^a-z])latest([^a-z]|$)/i.test(id)) return 'is an alias that moves ("latest")';
  if (!/^[a-z0-9][a-z0-9._:-]*$/.test(id)) return 'is not a vendor model id';
  return undefined;
}

function toolDeclaration(r: Reader, raw: unknown, field: string): ModuleToolDeclaration {
  const o = r.closed(raw, field, ['name', 'description', 'classes', 'timeoutMs', 'parameters']);
  const name = r.string(o, field, 'name', MODULE_TOOL_PATTERN);
  const description = r.description(o, field, 'description', MAX_TOOL_DESCRIPTION_BYTES);
  const classes = r.classes(o, field);
  const timeoutMs = r.number(
    o,
    field,
    'timeoutMs',
    (n) => Number.isInteger(n) && n >= 1 && n <= MAX_MODULE_TOOL_TIMEOUT_MS,
    `an integer in 1..${String(MAX_MODULE_TOOL_TIMEOUT_MS)}`,
  );
  let parameters: ToolParameters;
  try {
    parameters = parseToolParameters(o['parameters']);
  } catch (error) {
    if (!(error instanceof ToolSchemaInvalid)) throw error;
    return r.fail(`${field}.parameters`, error.problem);
  }
  for (const [p, schema] of Object.entries(parameters.properties)) {
    if (schema.description === undefined) continue;
    const bytes = Buffer.byteLength(schema.description, 'utf8');
    if (bytes > MAX_PARAMETER_DESCRIPTION_BYTES)
      r.fail(
        `${field}.parameters.properties.${p}.description`,
        `is ${String(bytes)} bytes, over the ${String(MAX_PARAMETER_DESCRIPTION_BYTES)} a description may hold`,
      );
    if (hasInvisible(schema.description))
      r.fail(
        `${field}.parameters.properties.${p}.description`,
        `holds an invisible or direction-changing character (${invisibleIn(schema.description).join(', ')})`,
      );
  }
  return { name, description, classes, timeoutMs, parameters };
}

function commandArgument(r: Reader, raw: unknown, field: string): CommandArgument {
  if (!isObject(raw)) r.fail(field, 'must be an object');
  const type = raw['type'];
  const common = ['type', 'option', 'description'];
  const optionOf = (o: Obj): { option?: string } =>
    o['option'] === undefined ? {} : { option: r.string(o, field, 'option', OPTION) };
  const desc = (o: Obj) => r.description(o, field, 'description', MAX_PARAMETER_DESCRIPTION_BYTES);
  const pattern = (o: Obj): string => {
    const p = r.string(o, field, 'pattern');
    if (!p.startsWith('^') || !p.endsWith('$'))
      r.fail(`${field}.pattern`, 'must be anchored: begin with ^ and end with $');
    try {
      new RegExp(p, 'u');
    } catch (error) {
      r.fail(`${field}.pattern`, `is not a regular expression: ${(error as Error).message}`);
    }
    if (new RegExp(p, 'u').test('-x') || new RegExp(p, 'u').test('--x'))
      r.fail(`${field}.pattern`, 'matches a value beginning with "-" (R31)');
    return p;
  };
  switch (type) {
    case 'enum': {
      const o = r.closed(raw, field, [...common, 'values'], ['option']);
      const values = o['values'];
      if (
        !Array.isArray(values) ||
        values.length === 0 ||
        !values.every((v) => typeof v === 'string' && v !== '' && !v.startsWith('-'))
      ) {
        r.fail(`${field}.values`, 'must be a non-empty list of strings, none beginning with "-"');
      }
      return { type, values: values as string[], description: desc(o), ...optionOf(o) };
    }
    case 'integer': {
      const o = r.closed(raw, field, [...common, 'minimum', 'maximum'], ['option']);
      const minimum = r.number(o, field, 'minimum', Number.isSafeInteger, 'a safe integer');
      const maximum = r.number(
        o,
        field,
        'maximum',
        (n) => Number.isSafeInteger(n) && n >= minimum,
        `a safe integer at least ${String(minimum)}`,
      );
      if (minimum < 0) r.fail(`${field}.minimum`, 'must be at least 0, so no value begins with "-" (R31)');
      return { type, minimum, maximum, description: desc(o), ...optionOf(o) };
    }
    case 'string':
    case 'remote': {
      const o = r.closed(raw, field, [...common, 'pattern'], ['option']);
      return { type, pattern: pattern(o), description: desc(o), ...optionOf(o) };
    }
    case 'path': {
      const o = r.closed(raw, field, [...common, 'mode', 'recursive'], ['option', 'recursive']);
      const mode = o['mode'];
      if (mode !== 'read' && mode !== 'write') r.fail(`${field}.mode`, 'must be "read" or "write"');
      const recursive = o['recursive'] ?? false;
      if (typeof recursive !== 'boolean') r.fail(`${field}.recursive`, 'must be true or false');
      if (recursive && mode !== 'read') r.fail(`${field}.recursive`, 'only a read path is read recursively');
      return { type, mode, recursive, description: desc(o), ...optionOf(o) };
    }
    default:
      return r.fail(`${field}.type`, 'must be one of enum, integer, string, remote, path');
  }
}

function commandDeclaration(r: Reader, raw: unknown, field: string): CommandDeclaration {
  const o = r.closed(
    raw,
    field,
    ['name', 'description', 'classes', 'timeoutMs', 'prefix', 'fixed', 'arguments', 'required'],
    ['fixed', 'required'],
  );
  const name = r.string(o, field, 'name', MODULE_TOOL_PATTERN);
  const description = r.description(o, field, 'description', MAX_TOOL_DESCRIPTION_BYTES);
  const classes = r.classes(o, field);
  const timeoutMs = r.number(
    o,
    field,
    'timeoutMs',
    (n) => Number.isInteger(n) && n >= 1 && n <= MAX_COMMAND_TIMEOUT_MS,
    `an integer in 1..${String(MAX_COMMAND_TIMEOUT_MS)}`,
  );
  const prefix = o['prefix'];
  if (
    !Array.isArray(prefix) ||
    prefix.length === 0 ||
    !prefix.every((w) => typeof w === 'string' && PREFIX_WORD.test(w))
  )
    r.fail(`${field}.prefix`, `must be a non-empty list of words matching ${String(PREFIX_WORD)}`);
  const fixed = o['fixed'] ?? [];
  if (!Array.isArray(fixed) || !fixed.every((w) => typeof w === 'string' && w !== '' && !/[\0\n]/.test(w)))
    r.fail(`${field}.fixed`, 'must be a list of non-empty strings');
  if (fixed.length > 0 && !OPTION.test(fixed[0] as string))
    r.fail(`${field}.fixed`, `must begin with an option (${String(OPTION)})`);
  const args = o['arguments'];
  if (!isObject(args)) r.fail(`${field}.arguments`, 'must be an object of typed arguments (R31): the schema');
  const parsed: Record<string, CommandArgument> = {};
  for (const [key, value] of Object.entries(args)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/.test(key))
      r.fail(`${field}.arguments.${key}`, 'is not an argument name (^[a-z][a-z0-9_]{0,31}$)');
    parsed[key] = commandArgument(r, value, `${field}.arguments.${key}`);
  }
  const options = [
    ...Object.values(parsed).flatMap((a) => (a.option === undefined ? [] : [a.option])),
    ...(fixed as string[]).filter((w) => OPTION.test(w)),
  ];
  const twice = options.find((opt, i) => options.indexOf(opt) !== i);
  if (twice !== undefined) r.fail(`${field}.arguments`, `option ${twice} is declared twice`);
  const required = o['required'] ?? Object.keys(parsed);
  if (!Array.isArray(required) || !required.every((k) => typeof k === 'string' && k in parsed))
    r.fail(`${field}.required`, 'must list arguments it declares');
  return {
    name,
    description,
    classes,
    timeoutMs,
    prefix: prefix as string[],
    fixed: fixed as string[],
    arguments: parsed,
    required: required as string[],
  };
}

function providerModel(r: Reader, raw: unknown, field: string): ProviderModel {
  const o = r.closed(
    raw,
    field,
    ['name', 'kind', 'id', 'card', 'launched', 'prices', 'terms', 'retention', 'chat', 'dimensions'],
    ['chat', 'dimensions'],
  );
  const name = r.string(o, field, 'name', PROVIDER_MODEL_NAME_PATTERN);
  const kind = o['kind'];
  if (kind !== 'chat' && kind !== 'embedding') r.fail(`${field}.kind`, 'must be "chat" or "embedding"');
  const id = r.string(o, field, 'id');
  const idProblem = providerModelIdProblem(id);
  if (idProblem !== undefined)
    r.fail(`${field}.id`, `"${id}" ${idProblem}; a provider model is pinned by the vendor's exact id (R20)`);
  const card = r.source(o['card'], `${field}.card`);
  const launched = r.string(o, field, 'launched', DATE);
  const prices = r.closed(o['prices'], `${field}.prices`, ['inputUsdPerMTok', 'outputUsdPerMTok', 'url', 'read']);
  const priced = {
    inputUsdPerMTok: r.number(prices, `${field}.prices`, 'inputUsdPerMTok', (n) => n >= 0, 'a price, at least 0'),
    outputUsdPerMTok: r.number(prices, `${field}.prices`, 'outputUsdPerMTok', (n) => n >= 0, 'a price, at least 0'),
    url: r.url(prices, `${field}.prices`, 'url'),
    read: r.string(prices, `${field}.prices`, 'read', DATE),
  };
  const terms = r.source(o['terms'], `${field}.terms`);
  const retention = r.source(o['retention'], `${field}.retention`);
  const chatRaw = o['chat'] ?? {};
  if (!isObject(chatRaw)) r.fail(`${field}.chat`, 'must be an object');
  if (kind === 'embedding' && o['chat'] !== undefined)
    r.fail(`${field}.chat`, 'an embedding model has no chat defaults');
  const chat: Record<string, number> = {};
  for (const [key, value] of Object.entries(chatRaw)) {
    if (!(PROVIDER_CHAT_FIELDS as readonly string[]).includes(key))
      r.fail(
        `${field}.chat.${key}`,
        `is not one of ${PROVIDER_CHAT_FIELDS.join(', ')}, the fields a provider translates (R19)`,
      );
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      r.fail(`${field}.chat.${key}`, 'must be a number, at least 0');
    chat[key] = value;
  }
  let dimensions: number | undefined;
  if (kind === 'embedding')
    dimensions = r.number(o, field, 'dimensions', (n) => Number.isInteger(n) && n > 0, 'a positive integer');
  else if (o['dimensions'] !== undefined) r.fail(`${field}.dimensions`, 'only an embedding model has dimensions');
  return {
    name,
    kind,
    id,
    card: { url: card.url, read: card.read },
    launched,
    prices: priced,
    terms: { url: terms.url, read: terms.read },
    retention: { url: retention.url, read: retention.read },
    chat,
    ...(dimensions === undefined ? {} : { dimensions }),
  };
}

function costModel(r: Reader, raw: unknown, kind: ModuleKind): CostModel {
  if (!isObject(raw)) r.fail('cost', 'must be an object');
  const model = raw['model'];
  const approved = (o: Obj): { approved?: CostApproval } => {
    if (o['approved'] === undefined) return {};
    const a = r.closed(o['approved'], 'cost.approved', ['by', 'date', 'capUsd']);
    return {
      approved: {
        by: r.string(a, 'cost.approved', 'by'),
        date: r.string(a, 'cost.approved', 'date', DATE),
        capUsd: r.number(a, 'cost.approved', 'capUsd', (n) => n > 0, 'a positive number of USD'),
      },
    };
  };
  switch (model) {
    case 'free':
    case 'local':
      r.closed(raw, 'cost', ['model']);
      if (kind === 'CommandTool') r.fail('cost.model', 'a command plugin\'s cost model is "external-unmetered" (R18c)');
      return { model };
    case 'metered': {
      if (kind === 'CommandTool') r.fail('cost.model', 'a command plugin\'s cost model is "external-unmetered" (R18c)');
      const o = r.closed(raw, 'cost', ['model', 'perCall', 'approved'], ['perCall', 'approved']);
      if (kind === 'ToolModule') {
        if (o['perCall'] === undefined) r.fail('cost.perCall', 'a metered ToolModule names its price per call');
        const p = r.closed(o['perCall'], 'cost.perCall', ['unit', 'units', 'unitUsd', 'url', 'read']);
        return {
          model,
          perCall: {
            unit: r.string(p, 'cost.perCall', 'unit'),
            units: r.number(p, 'cost.perCall', 'units', (n) => n > 0, 'a positive number'),
            unitUsd: r.number(p, 'cost.perCall', 'unitUsd', (n) => n >= 0, 'a price, at least 0'),
            url: r.url(p, 'cost.perCall', 'url'),
            read: r.string(p, 'cost.perCall', 'read', DATE),
          },
          ...approved(o),
        };
      }
      if (o['perCall'] !== undefined) r.fail('cost.perCall', "a ModelProvider's prices are its models'");
      return { model, ...approved(o) };
    }
    case 'external-unmetered': {
      // Only a command plugin is billed outside the harness's meter (R18c); a tool module or a provider that spends is
      // metered, so it is enabled with caps (review of 2026-10-02, finding H4).
      if (kind !== 'CommandTool')
        r.fail('cost.model', 'only a command plugin is "external-unmetered" (R18c): a module that spends is "metered"');
      const o = r.closed(raw, 'cost', ['model', 'approved'], ['approved']);
      return { model, ...approved(o) };
    }
    default:
      return r.fail('cost.model', 'must be one of free, local, metered, external-unmetered');
  }
}

/** The field a manifest's `kind` owns besides `ManifestBase`'s, extracted out of `parseModuleManifest` so its three-way
 * choice is not a ternary nested inside another (sonarjs/no-nested-conditional). */
function ownFields(kind: ModuleKind): readonly string[] {
  switch (kind) {
    case 'ToolModule':
      return ['tools'];
    case 'ModelProvider':
      return ['models'];
    case 'CommandTool':
      return ['executable', 'commands'];
  }
}

/** The per-file list (R2), each entry's path and sha256 checked. Extracted out of `parseModuleManifest`, one of
 * the blocks that made its cognitive complexity 72 (sonarjs/cognitive-complexity). */
function validateManifestFiles(r: Reader, files: Obj): void {
  for (const [path, sha] of Object.entries(files)) {
    const problem = moduleFilePathProblem(path);
    if (problem !== undefined) r.fail(`files["${path}"]`, problem);
    if (typeof sha !== 'string' || !SHA256.test(sha)) r.fail(`files["${path}"]`, 'must be a sha256 (64 lowercase hex)');
  }
}

/** `dependencies` (R4): a command plugin declares none; each lockfile path's licence and version checked. */
function parseDependencies(
  r: Reader,
  kind: ModuleKind,
  depsRaw: unknown,
): Record<string, LicenceRecord & { version: string }> {
  if (!isObject(depsRaw)) r.fail('dependencies', 'must be an object of lockfile path → licence');
  if (kind === 'CommandTool' && Object.keys(depsRaw).length > 0)
    r.fail('dependencies', "a command plugin declares only its executable's own licence (R26)");
  const dependencies: Record<string, LicenceRecord & { version: string }> = {};
  for (const [path, value] of Object.entries(depsRaw)) {
    if (!LOCK_PATH.test(path)) r.fail(`dependencies["${path}"]`, 'must be a lockfile path, node_modules/<name>');
    const d = r.licence(value, `dependencies["${path}"]`, ['version']);
    dependencies[path] = {
      id: d.id,
      url: d.url,
      read: d.read,
      version: r.string(d, `dependencies["${path}"]`, 'version'),
    };
  }
  return dependencies;
}

/** `hosts` (R6 (c)): a list of host names, each valid, none repeated. */
function parseHosts(r: Reader, hostsRaw: unknown): string[] {
  if (!Array.isArray(hostsRaw) || !hostsRaw.every((h) => typeof h === 'string'))
    r.fail('hosts', 'must be a list of host names ([] for none)');
  for (const h of hostsRaw) {
    const problem = hostProblem(h);
    if (problem !== undefined) r.fail('hosts', `"${h}" ${problem}`);
  }
  if (new Set(hostsRaw).size !== hostsRaw.length) r.fail('hosts', 'names a host twice');
  return hostsRaw;
}

/** `secrets`: a list of variable names, each valid and not reserved, none repeated. */
function parseSecrets(r: Reader, secretsRaw: unknown): string[] {
  if (!Array.isArray(secretsRaw) || !secretsRaw.every((s) => typeof s === 'string' && SECRET_NAME_PATTERN.test(s)))
    r.fail('secrets', `must be a list of names matching ${String(SECRET_NAME_PATTERN)}`);
  // The compound `.every` predicate above (unlike `parseHosts`'s plain `typeof` check) is not one TypeScript infers a
  // type predicate for, so `secretsRaw` stays `any[]` without this cast.
  for (const name of secretsRaw as string[])
    if (reservedVariableName(name))
      r.fail(
        `secrets.${name}`,
        "is a name the host process or the harness sets (PATH, HOME, DOCKER_*, DYLD_*, LD_*, NODE_*, *_PROXY and the like): it may not be a module's variable",
      );
  if (new Set(secretsRaw).size !== secretsRaw.length) r.fail('secrets', 'names a secret twice');
  return secretsRaw as string[];
}

/** R11: every tool of a cloud module carries egress; a consequential tool belongs to a cloud module. */
function checkToolClasses(
  r: Reader,
  cloud: boolean,
  classes: readonly ToolClassName[],
  field: string,
  name: string,
): void {
  if (cloud && !classes.includes('egress'))
    r.fail(`${field}.classes`, `tool ${name} of a module that lists hosts must carry "egress" (R11)`);
  if (!cloud && classes.includes('consequential'))
    r.fail(
      `${field}.classes`,
      `tool ${name} is "consequential" but the module lists no host: a consequential tool changes something outside the machine (R11)`,
    );
}

/** A tool's or command's wire name is well formed for this module. */
function wireToolName(r: Reader, moduleId: string, name: string, field: string): void {
  try {
    moduleToolWireName(moduleId, name);
  } catch (error) {
    r.fail(field, (error as Error).message);
  }
}

/** A ToolModule's `tools` (R2, R10, R11, R34): non-empty, each checked, no name twice. */
function parseToolModuleTools(r: Reader, o: Obj, idRaw: string, cloud: boolean): readonly ModuleToolDeclaration[] {
  const tools = o['tools'];
  if (!Array.isArray(tools) || tools.length === 0) r.fail('tools', 'must be a non-empty list');
  const parsed = tools.map((t, i) => toolDeclaration(r, t, `tools[${String(i)}]`));
  parsed.forEach((t, i) => {
    checkToolClasses(r, cloud, t.classes, `tools[${String(i)}]`, t.name);
    wireToolName(r, idRaw, t.name, `tools[${String(i)}].name`);
  });
  if (new Set(parsed.map((t) => t.name)).size !== parsed.length) r.fail('tools', 'declares a name twice');
  return parsed;
}

/** A ModelProvider's `models` (R20): non-empty, each checked, no name twice, and it lists the vendor's hosts. */
function parseModelProviderModels(r: Reader, o: Obj, cloud: boolean): readonly ProviderModel[] {
  const models = o['models'];
  if (!Array.isArray(models) || models.length === 0) r.fail('models', 'must be a non-empty list');
  const parsed = models.map((m, i) => providerModel(r, m, `models[${String(i)}]`));
  if (new Set(parsed.map((m) => m.name)).size !== parsed.length) r.fail('models', 'declares a name twice');
  if (!cloud) r.fail('hosts', "a provider serves models from a vendor, so it lists the vendor's hosts");
  return parsed;
}

/** A command plugin's `executable.archives` (R28): at least one architecture, each entry's file not already named. */
function parseExecutableArchives(
  r: Reader,
  ex: Obj,
  files: Record<string, string>,
): Partial<Record<Architecture, ArchiveEntry>> {
  const archivesRaw = ex['archives'];
  if (archivesRaw === undefined) r.fail('executable.archives', 'missing');
  if (!isObject(archivesRaw) || Object.keys(archivesRaw).length === 0)
    r.fail('executable.archives', `must map at least one of ${ARCHITECTURES.join(', ')} to {url, sha256, file}`);
  const archives: Partial<Record<Architecture, ArchiveEntry>> = {};
  for (const [arch, value] of Object.entries(archivesRaw)) {
    if (!(ARCHITECTURES as readonly string[]).includes(arch))
      r.fail(`executable.archives.${arch}`, `is not one of ${ARCHITECTURES.join(', ')}`);
    const a = r.closed(value, `executable.archives.${arch}`, ['url', 'sha256', 'file']);
    const fileName = r.string(a, `executable.archives.${arch}`, 'file', ARCHIVE_FILE_PATTERN);
    if (fileName === MANIFEST_FILE || fileName === INSTALL_RECORD || Object.hasOwn(files, fileName)) {
      const already = Object.hasOwn(files, fileName)
        ? 'a path in the per-file list'
        : `${fileName}, which the module's directory holds itself`;
      r.fail(`executable.archives.${arch}.file`, `"${fileName}" is ${already}`);
    }
    archives[arch as Architecture] = {
      url: r.url(a, `executable.archives.${arch}`, 'url'),
      sha256: r.string(a, `executable.archives.${arch}`, 'sha256', SHA256),
      file: fileName,
    };
  }
  return archives;
}

/** A command plugin's `executable.env` (R33): fixed variables, none reserved, none a declared secret. */
function parseExecutableEnv(r: Reader, ex: Obj, secrets: readonly string[]): Record<string, string> {
  const envRaw = ex['env'] ?? {};
  if (!isObject(envRaw)) r.fail('executable.env', 'must be an object of name → value');
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(envRaw)) {
    if (!ENV_NAME.test(name)) r.fail(`executable.env.${name}`, `is not a variable name (${String(ENV_NAME)})`);
    if (reservedVariableName(name))
      r.fail(
        `executable.env.${name}`,
        "is a name the host process or the harness sets (PATH, HOME, DOCKER_*, DYLD_*, LD_*, NODE_*, *_PROXY and the like): it may not be a module's variable",
      );
    if (secrets.includes(name))
      r.fail(`executable.env.${name}`, 'is a secret: its value comes from the store, never the manifest');
    if (typeof value !== 'string') r.fail(`executable.env.${name}`, 'must be a string');
    env[name] = value;
  }
  return env;
}

/** A CommandTool's `commands` (R28, R31): non-empty, each checked, no name twice. */
function parseCommandToolCommands(r: Reader, o: Obj, idRaw: string, cloud: boolean): readonly CommandDeclaration[] {
  const commands = o['commands'];
  if (!Array.isArray(commands) || commands.length === 0) r.fail('commands', 'must be a non-empty list');
  const parsedCommands = commands.map((c, i) => commandDeclaration(r, c, `commands[${String(i)}]`));
  parsedCommands.forEach((c, i) => {
    checkToolClasses(r, cloud, c.classes, `commands[${String(i)}]`, c.name);
    wireToolName(r, idRaw, c.name, `commands[${String(i)}].name`);
  });
  if (new Set(parsedCommands.map((c) => c.name)).size !== parsedCommands.length)
    r.fail('commands', 'declares a name twice');
  return parsedCommands;
}

/** The CommandTool branch of `parseModuleManifest`: its `executable` and its `commands`. */
function parseCommandToolManifest(
  r: Reader,
  o: Obj,
  idRaw: string,
  cloud: boolean,
  base: ManifestBase,
  files: Record<string, string>,
  secrets: readonly string[],
): CommandToolManifest {
  const ex = r.closed(
    o['executable'],
    'executable',
    ['name', 'version', 'licence', 'signature', 'archives', 'env'],
    ['env'],
  );
  const sig = r.closed(ex['signature'], 'executable.signature', ['method', 'fingerprint', 'verifiedBy', 'date']);
  const archives = parseExecutableArchives(r, ex, files);
  const env = parseExecutableEnv(r, ex, secrets);
  const exLicence = r.licence(ex['licence'], 'executable.licence');
  const commands = parseCommandToolCommands(r, o, idRaw, cloud);
  return {
    ...base,
    kind: 'CommandTool',
    executable: {
      name: r.string(ex, 'executable', 'name', /^[a-z0-9][a-z0-9._-]{0,63}$/),
      version: r.string(ex, 'executable', 'version'),
      licence: { id: exLicence.id, url: exLicence.url, read: exLicence.read },
      signature: {
        method: r.string(sig, 'executable.signature', 'method'),
        fingerprint: r.string(sig, 'executable.signature', 'fingerprint'),
        verifiedBy: r.string(sig, 'executable.signature', 'verifiedBy'),
        date: r.string(sig, 'executable.signature', 'date', DATE),
      },
      archives,
      env,
    },
    commands,
  };
}

/**
 * Parses a module.json (R2). `expectedId`: the directory's name when the daemon loads an installed module, whose id
 * must match it. Throws ManifestInvalid naming the module and the field.
 */
export function parseModuleManifest(raw: unknown, file: string, expectedId?: string): ModuleManifest {
  const pre: Reader = new Reader(expectedId ?? file);
  if (!isObject(raw)) pre.fail('', 'top level must be an object');
  const kind = raw['kind'];
  if (kind !== 'ToolModule' && kind !== 'ModelProvider' && kind !== 'CommandTool')
    pre.fail('kind', 'must be "ToolModule", "ModelProvider" or "CommandTool"');
  const idRaw = raw['id'];
  if (typeof idRaw !== 'string' || !MODULE_ID_PATTERN.test(idRaw))
    pre.fail('id', `${JSON.stringify(idRaw)} does not match ${String(MODULE_ID_PATTERN)}`);
  if (expectedId !== undefined && idRaw !== expectedId)
    pre.fail('id', `"${idRaw}" does not match its directory's name "${expectedId}"`);
  const r: Reader = new Reader(idRaw);
  const own = ownFields(kind);
  const o = r.closed(
    raw,
    '',
    ['id', 'kind', 'version', 'entry', 'files', 'licence', 'dependencies', 'hosts', 'secrets', 'cost', ...own],
    ['dependencies'],
  );
  const version = r.string(o, '', 'version', /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/);
  const entry = r.string(o, '', 'entry');
  const files = o['files'];
  if (!isObject(files)) r.fail('files', 'must be an object of path → sha256');
  validateManifestFiles(r, files);
  if (!Object.hasOwn(files, entry)) r.fail('entry', `"${entry}" is not in files`);
  if (kind === 'CommandTool' && entry !== 'Dockerfile') r.fail('entry', "a command plugin's entry is its Dockerfile");
  if (kind !== 'CommandTool' && !/\.m?js$/.test(entry))
    r.fail('entry', 'must be a JavaScript file (.js or .mjs), run as it is');
  const licence = r.licence(o['licence'], 'licence');
  const dependencies = parseDependencies(r, kind, o['dependencies'] ?? {});
  const hosts = parseHosts(r, o['hosts']);
  const secrets = parseSecrets(r, o['secrets']);
  const cost = costModel(r, o['cost'], kind);
  const base: ManifestBase = {
    id: idRaw,
    version,
    entry,
    files: files as Record<string, string>,
    licence: { id: licence.id, url: licence.url, read: licence.read },
    dependencies,
    hosts,
    secrets,
    cost,
  };
  const cloud = hosts.length > 0;
  if (kind === 'ToolModule') return { ...base, kind, tools: parseToolModuleTools(r, o, idRaw, cloud) };
  if (kind === 'ModelProvider') return { ...base, kind, models: parseModelProviderModels(r, o, cloud) };
  return parseCommandToolManifest(r, o, idRaw, cloud, base, files as Record<string, string>, secrets);
}

/** One tool a module offers an agent, whatever its kind: a ToolModule's tool or a CommandTool's command. */
export interface OfferedTool {
  readonly name: string;
  readonly description: string;
  readonly classes: readonly ToolClassName[];
  readonly timeoutMs: number;
  /** The tool's arguments as JSON Schema, what the model is offered (R10). */
  readonly parameters: ToolParameters;
}

/** A command's typed arguments as the JSON Schema the model is offered (R10: "R31's types as JSON Schema"). */
function commandParameters(command: CommandDeclaration): ToolParameters {
  const properties: Record<string, ToolParameters['properties'][string]> = {};
  for (const [name, arg] of Object.entries(command.arguments)) {
    switch (arg.type) {
      case 'enum':
        properties[name] = { type: 'string', enum: arg.values, description: arg.description };
        break;
      case 'integer':
        properties[name] = { type: 'integer', minimum: arg.minimum, description: arg.description };
        break;
      case 'string':
      case 'remote':
        properties[name] = { type: 'string', description: arg.description };
        break;
      case 'path':
        properties[name] = { type: 'string', description: arg.description };
        break;
    }
  }
  return { type: 'object', properties, required: command.required };
}

/** The tools a module offers, by name: none for a ModelProvider, which is used by naming its model (R29). */
export function offeredTools(manifest: ModuleManifest): readonly OfferedTool[] {
  if (manifest.kind === 'ToolModule') return manifest.tools;
  if (manifest.kind === 'CommandTool')
    return manifest.commands.map((c) => ({
      name: c.name,
      description: c.description,
      classes: c.classes,
      timeoutMs: c.timeoutMs,
      parameters: commandParameters(c),
    }));
  return [];
}

/** A cloud module (R11): one whose manifest lists a host. */
export function isCloudModule(manifest: ModuleManifest): boolean {
  return manifest.hosts.length > 0;
}

/** The licence ids a manifest declares that are off the permissive allowlist (R26), each named with what it covers. */
export function licencesOffAllowlist(manifest: ModuleManifest): string[] {
  const off: string[] = [];
  const allowed = (id: string) => (PERMISSIVE_LICENCES as readonly string[]).includes(id);
  if (manifest.kind === 'CommandTool') {
    if (!allowed(manifest.executable.licence.id))
      off.push(`the executable ${manifest.executable.name}: ${manifest.executable.licence.id}`);
    if (!allowed(manifest.licence.id)) off.push(`the module ${manifest.id}: ${manifest.licence.id}`);
    return off;
  }
  if (!allowed(manifest.licence.id)) off.push(`the module ${manifest.id}: ${manifest.licence.id}`);
  for (const [path, d] of Object.entries(manifest.dependencies)) if (!allowed(d.id)) off.push(`${path}: ${d.id}`);
  return off;
}
