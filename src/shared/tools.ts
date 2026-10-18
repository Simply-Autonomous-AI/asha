// Agent tools: the contract the daemon and the agent SDK share
// (docs/plans/agent-tools.md R1–R5, R8, R12, R13). An image declares the tools
// it implements in images/<name>/image.json; a recipe selects, by name, from
// those and the SDK's common tools; the daemon checks the selection before
// any container starts and hands the names to the agent in its welcome. Both
// sides parse the manifest and check arguments with the functions here, so
// the daemon and the agent can never disagree about either.

/** The channel tools an agent may be offered, in the order it is offered them (`consult` since agent-calls R1). */
export const CHANNEL_TOOL_NAMES = ['reply', 'send_message', 'consult', 'list_agents', 'pass'] as const;

/**
 * Channel tools a recipe selects in its `tools`, as it selects a common tool (docs/plans/agent-files.md R12): offered
 * right after `reply`, in a normal turn only. `reply_with_files` answers the user with files from /channel; `ask_user`
 * asks the user and leaves the conversation waiting for their answer (docs/plans/patterns-phase-3.md R23), after
 * `reply_with_files` when both are selected.
 */
export const SELECTABLE_CHANNEL_TOOL_NAMES = ['reply_with_files', 'ask_user'] as const;

/** The tool a recipe with a launch grant is offered after its selected tools (docs/plans/patterns-phase-3.md R29). */
export const LAUNCH_AGENT_TOOL_NAME = 'launch_agent';

/**
 * The decision model's tool (docs/plans/decider-tool.md R10, R11): selected in a recipe's `tools` like a common tool, and
 * offered only to a recipe that declares `decisions`, its parameter `decision` limited to their names.
 */
export const DECIDE_TOOL_NAME = 'decide';

/** The gateway's bound on the tools of one model request. */
export const MAX_TOOLS = 16;

/** Tools of one request reserved for the channel tools: five, with `consult` (agent-calls R1; agent-tools R2). */
export const CHANNEL_TOOLS_RESERVED = 5;

/** A recipe's selected tools and granted module tools together: MAX_TOOLS less the channel tools' reservation (R2). */
export const MAX_SELECTED_AND_GRANTED = MAX_TOOLS - CHANNEL_TOOLS_RESERVED;

/** The tools the SDK implements for every image, which any recipe may select (R8). */
export const COMMON_TOOL_NAMES = [
  'list_files',
  'read_file',
  'write_file',
  'append_file',
  'blackboard_read',
  'blackboard_post',
] as const;

export type CommonToolName = (typeof COMMON_TOOL_NAMES)[number];

/** The four file tools: a recipe that names documents selects all of them (docs/plans/collaborating-agents.md R3). */
export const FILE_TOOL_NAMES = ['list_files', 'read_file', 'write_file', 'append_file'] as const;

/** /workspace's bounds (docs/plans/agent-tools.md R9): the recipe's documents count toward them (collaborating-agents R2). */
export const WORKSPACE_MAX_FILES = 256;
export const WORKSPACE_MAX_BYTES = 16 * 1024 * 1024;

/** A recipe's full-text documents together, in UTF-8 bytes: they are in the system prompt on every turn (collaborating-agents R12). */
export const FULL_TEXT_MAX_BYTES = 8 * 1024;

/** A tool name the gateway accepts (and the OpenAI tool shape allows). */
export const TOOL_NAME_PATTERN = /^[a-zA-Z_]\w{0,63}$/;

/**
 * Every reason a tool call can fail with as a tool-result error `{error: <reason>}` (R9's closed set). Nothing
 * else is returned as one: an unexpected throw fails the turn instead (R4).
 */
export const TOOL_FAILURE_REASONS = [
  'path_outside_workspace',
  'not_found',
  'not_a_file',
  'not_text',
  'file_too_large',
  'workspace_full',
  'space_full',
  'no_channel_space',
  'not_permitted',
  'entry_too_large',
  'blackboard_full',
  'invalid_arguments',
  'unknown_tool',
  'timeout',
  'turn_budget_exceeded',
  // A reply_with_files the daemon refused (docs/plans/agent-files.md R12; agent-tools R9's set, amended 2026-09-30).
  'file_refused',
  // A granted module tool's call (docs/plans/extension-modules.md M10): refused, held, or failed.
  'module_forbidden', // not a tool its recipe grants (R8, R29)
  'approval_required', // a consequential call, held for the user's approval (R12)
  'unknown_outcome', // a consequential call sent, and its outcome not known (R13)
  'budget_exceeded', // a metered call whose reservation would pass a cap (R18b)
  'budget_meter_unavailable', // metering.json does not parse (R18b)
  'module_unavailable', // the module could not be reached or failed (R34)
  'input_too_large', // a plugin call's read set over 1 GiB or 10,000 files (R30)
  'output_too_large', // a plugin call's write-back over 1 GiB or 10,000 entries (R30)
  'path_refused', // a plugin call's path outside its roots, on the deny list, a link, or unreadable (R30, R32)
  // A decide call (docs/plans/decider-tool.md R8, R11): the decision model's alone, never a module's answer.
  'decider_busy', // four calls already wait for the decision model (R8)
  'decider_unavailable', // the decision model is not running, exited, was given up, or is stopping (R7, R9)
] as const;

/** The reasons only the decision model answers with (R11): the module host refuses either from a module. */
export const DECIDER_ONLY_REASONS: readonly ToolFailureReason[] = ['decider_busy', 'decider_unavailable'];

export type ToolFailureReason = (typeof TOOL_FAILURE_REASONS)[number];

/**
 * What an image tool does (R1, R13): `files` acts only on the container's own files. `command` (runs an
 * external command) and `network` (sends a request anywhere) are never implemented by an image: such a tool is
 * a harness plugin module (docs/plans/extension-modules.md R28–R33), and a recipe selecting one fails its launch.
 */
type ToolClass = 'files' | 'command' | 'network';

/** One argument of a tool: the JSON Schema subset tools may use, so arguments are checked exactly (R3). */
interface ToolParameter {
  readonly type: 'string' | 'integer' | 'number' | 'boolean';
  readonly description?: string;
  /** For integer and number. */
  readonly minimum?: number;
  /** For string: the only values allowed. */
  readonly enum?: readonly string[];
}

/** A tool's arguments: an object with exactly these properties; any other key is invalid. */
export interface ToolParameters {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, ToolParameter>>;
  readonly required?: readonly string[];
}

/** One tool an image implements, as its manifest declares it. */
export interface ImageToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameters;
  readonly class: ToolClass;
  /** Bound on one call of the handler (R5), at most MAX_IMAGE_TOOL_TIMEOUT_MS. */
  readonly timeoutMs: number;
}

/** images/<name>/image.json. Closed: no `services` key until a plan adds harness services (R12). */
export interface ImageManifest {
  readonly tools: readonly ImageToolDeclaration[];
  /**
   * Tools the image passes only in its own model calls, to get a structured answer back (the memory image's
   * `save_facts`): never offered on the channel, never run by the SDK. The gateway admits them from this image's
   * agents. Optional in the file; [] when absent.
   */
  readonly answerTools: readonly string[];
  /**
   * The image keeps users' memory (docs/plans/extension-modules.md R25's field, added by agent-persistence R1): a
   * recipe may persist "memory" only on such an image. Optional in the file, only `true`; false when absent.
   */
  readonly keepsMemory: boolean;
  /**
   * The image implements the per-user erase mode, `erase-user --channel <c> --user <u>` (agent-persistence R1, R16);
   * the build stamps it as the label `asha.erase-user=true`. Optional in the file, only `true`; false when absent.
   */
  readonly eraseUser: boolean;
  /**
   * The layout version of the state the image keeps (agent-persistence R12), a positive integer the build stamps as
   * the label `asha.state-schema`; saved state of another schema is refused. null when absent (recorded as "none").
   */
  readonly stateSchema: number | null;
}

const MAX_IMAGE_TOOL_TIMEOUT_MS = 60_000;

/** An image manifest is missing or malformed. Names the file and the offending key. */
export class ImageManifestInvalid extends Error {
  constructor(
    readonly file: string,
    readonly problem: string,
  ) {
    super(`${file}: ${problem}`);
    this.name = 'ImageManifestInvalid';
  }
}

/** A tool's parameter schema uses something outside ToolParameters. */
export class ToolSchemaInvalid extends Error {
  constructor(readonly problem: string) {
    super(problem);
    this.name = 'ToolSchemaInvalid';
  }
}

type Obj = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `minimum` is valid on a schema of `type` (ToolParameter's rule: a number, only on an integer or
 * number). Extracted for the same reason as `isValidEnum`: one `&&` at the call site, not this `||`-and-`&&` mix. */
function isValidMinimum(type: string, minimum: unknown): minimum is number {
  return typeof minimum === 'number' && (type === 'integer' || type === 'number');
}

/** Whether `values` is a valid `enum` on a schema of `type` (ToolParameter's rule: a non-empty list of strings,
 * only on a string). Extracted so `parseToolParameterSchema`'s `if` is one `&&`, not this mixed `||`-and-`&&` chain
 * (part of what made its cognitive complexity 16, sonarjs/cognitive-complexity). */
function isValidEnum(type: string, values: unknown): values is string[] {
  return type === 'string' && Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string');
}

/** One `properties.<name>` schema, checked against the ToolParameter subset; throws ToolSchemaInvalid naming the
 * key. Extracted out of `parseToolParameters`'s loop, the largest part of its cognitive complexity
 * (sonarjs/cognitive-complexity). */
function parseToolParameterSchema(where: string, raw: unknown): ToolParameter {
  if (!isObject(raw)) throw new ToolSchemaInvalid(`${where} must be an object`);
  for (const key of Object.keys(raw)) {
    if (!['type', 'description', 'minimum', 'enum'].includes(key))
      throw new ToolSchemaInvalid(`unknown field ${where}.${key}`);
  }
  const type = raw['type'];
  if (type !== 'string' && type !== 'integer' && type !== 'number' && type !== 'boolean') {
    throw new ToolSchemaInvalid(`${where}.type must be "string", "integer", "number" or "boolean"`);
  }
  const description = raw['description'];
  if (description !== undefined && typeof description !== 'string')
    throw new ToolSchemaInvalid(`${where}.description must be a string`);
  const minimum = raw['minimum'];
  if (minimum !== undefined && !isValidMinimum(type, minimum)) {
    throw new ToolSchemaInvalid(`${where}.minimum must be a number, on an integer or number`);
  }
  const values = raw['enum'];
  if (values !== undefined && !isValidEnum(type, values)) {
    throw new ToolSchemaInvalid(`${where}.enum must be a non-empty list of strings, on a string`);
  }
  return {
    type,
    ...(description === undefined ? {} : { description }),
    ...(minimum === undefined ? {} : { minimum: minimum }),
    ...(values === undefined ? {} : { enum: values }),
  };
}

/** Checks a parameters schema is exactly the ToolParameters subset; throws ToolSchemaInvalid naming the key. */
export function parseToolParameters(raw: unknown): ToolParameters {
  if (!isObject(raw)) throw new ToolSchemaInvalid('parameters must be an object');
  for (const key of Object.keys(raw)) {
    if (!['type', 'properties', 'required'].includes(key))
      throw new ToolSchemaInvalid(`unknown field parameters.${key}`);
  }
  if (raw['type'] !== 'object') throw new ToolSchemaInvalid('parameters.type must be "object"');
  const properties = raw['properties'];
  if (!isObject(properties)) throw new ToolSchemaInvalid('parameters.properties must be an object');
  const parsed: Record<string, ToolParameter> = {};
  for (const [name, schema] of Object.entries(properties)) {
    parsed[name] = parseToolParameterSchema(`parameters.properties.${name}`, schema);
  }
  const required = raw['required'];
  if (required !== undefined) {
    if (!Array.isArray(required) || !required.every((r) => typeof r === 'string' && r in parsed)) {
      throw new ToolSchemaInvalid('parameters.required must list properties it declares');
    }
  }
  return { type: 'object', properties: parsed, ...(required === undefined ? {} : { required: required as string[] }) };
}

/** Whether `value` is of `schema`'s JSON type (R3) — extracted out of `argumentsProblem`'s nested ternary chain
 * (sonarjs/no-nested-conditional), the largest part of that function's cognitive complexity. */
function matchesType(schema: ToolParameter, value: unknown): boolean {
  switch (schema.type) {
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      // A safe integer only: 1e20 or 2**53 is an integer no file offset can take (review finding 2).
      return typeof value === 'number' && Number.isSafeInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
  }
}

/** The name `argumentsProblem` uses for a schema's type in its error message. */
function typeName(schema: ToolParameter): string {
  return schema.type === 'integer' ? 'a safe integer' : `a ${schema.type}`;
}

/**
 * Why `args` do not match `parameters` — a missing required key, an unknown key, a wrong type, a value below
 * its minimum or outside its enum — or null when they match (R3's `invalid_arguments`).
 */
export function argumentsProblem(parameters: ToolParameters, args: unknown): string | null {
  if (!isObject(args)) return 'the arguments are not a JSON object';
  for (const key of parameters.required ?? []) {
    if (!(key in args)) return `missing required argument "${key}"`;
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = parameters.properties[key];
    if (schema === undefined) return `unknown argument "${key}"`;
    if (!matchesType(schema, value)) return `argument "${key}" must be ${typeName(schema)}`;
    if (schema.minimum !== undefined && (value as number) < schema.minimum)
      return `argument "${key}" must be at least ${String(schema.minimum)}`;
    if (schema.enum !== undefined && !schema.enum.includes(value as string))
      return `argument "${key}" must be one of ${schema.enum.join(', ')}`;
  }
  return null;
}

/** A schema object `obj` has exactly `keys`: every failure names the file and `where`. */
function checkClosedKeys(file: string, where: string, obj: Obj, keys: readonly string[]): void {
  for (const key of Object.keys(obj))
    if (!keys.includes(key)) throw new ImageManifestInvalid(file, `unknown field ${where}.${key}`);
  for (const key of keys) if (!(key in obj)) throw new ImageManifestInvalid(file, `missing field ${where}.${key}`);
}

function isToolClass(value: unknown): value is ToolClass {
  return value === 'files' || value === 'command' || value === 'network';
}

function isValidImageToolTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_IMAGE_TOOL_TIMEOUT_MS;
}

/** One `tools[i]` entry of an image manifest. Extracted out of `parseImageManifest`'s `.map()` callback, whose
 * cognitive complexity this was (sonarjs/cognitive-complexity); `names` is the whole manifest's, so a name declared
 * twice across different tools is still caught. */
function parseImageTool(file: string, names: Set<string>, tool: unknown, i: number): ImageToolDeclaration {
  const where = `tools[${String(i)}]`;
  if (!isObject(tool)) throw new ImageManifestInvalid(file, `${where} must be an object`);
  checkClosedKeys(file, where, tool, ['name', 'description', 'parameters', 'class', 'timeoutMs']);
  const name = tool['name'];
  if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name))
    throw new ImageManifestInvalid(file, `${where}.name must match ${String(TOOL_NAME_PATTERN)}`);
  if (names.has(name)) throw new ImageManifestInvalid(file, `${where}.name "${name}" is declared twice`);
  names.add(name);
  const description = tool['description'];
  if (typeof description !== 'string' || description === '')
    throw new ImageManifestInvalid(file, `${where}.description must be a non-empty string`);
  const toolClass = tool['class'];
  if (!isToolClass(toolClass))
    throw new ImageManifestInvalid(file, `${where}.class must be "files", "command" or "network"`);
  const timeoutMs = tool['timeoutMs'];
  if (!isValidImageToolTimeoutMs(timeoutMs))
    throw new ImageManifestInvalid(
      file,
      `${where}.timeoutMs must be an integer in 1..${String(MAX_IMAGE_TOOL_TIMEOUT_MS)}`,
    );
  let parameters: ToolParameters;
  try {
    parameters = parseToolParameters(tool['parameters']);
  } catch (error) {
    if (!(error instanceof ToolSchemaInvalid)) throw error;
    throw new ImageManifestInvalid(file, `${where}.${error.problem}`);
  }
  return { name, description, parameters, class: toolClass, timeoutMs };
}

/** Parses images/<name>/image.json; every schema is closed, and every failure names the file and the key. */
export function parseImageManifest(raw: unknown, file: string): ImageManifest {
  if (!isObject(raw)) throw new ImageManifestInvalid(file, 'top level must be an object');
  for (const key of Object.keys(raw)) {
    if (!['tools', 'answerTools', 'keepsMemory', 'eraseUser', 'stateSchema'].includes(key))
      throw new ImageManifestInvalid(file, `unknown field ${key}`);
  }
  const tools = raw['tools'];
  if (!Array.isArray(tools))
    throw new ImageManifestInvalid(file, 'missing field tools (a list; [] for an image with no tools of its own)');
  const names = new Set<string>();
  const declared = {
    tools: tools.map((tool: unknown, i) => parseImageTool(file, names, tool, i)),
  };
  const answers = raw['answerTools'] ?? [];
  if (!Array.isArray(answers)) throw new ImageManifestInvalid(file, 'answerTools must be a list of tool names');
  answers.forEach((name: unknown, i) => {
    if (typeof name !== 'string' || !TOOL_NAME_PATTERN.test(name))
      throw new ImageManifestInvalid(file, `answerTools[${String(i)}] must match ${String(TOOL_NAME_PATTERN)}`);
    if (names.has(name)) throw new ImageManifestInvalid(file, `answerTools[${String(i)}] "${name}" is declared twice`);
    names.add(name);
  });
  const keepsMemory = raw['keepsMemory'];
  if (keepsMemory !== undefined && keepsMemory !== true)
    throw new ImageManifestInvalid(file, 'keepsMemory must be true (omit it for an image that keeps no memory)');
  const eraseUser = raw['eraseUser'];
  if (eraseUser !== undefined && eraseUser !== true)
    throw new ImageManifestInvalid(file, 'eraseUser must be true (omit it for an image with no erase mode)');
  const stateSchema = raw['stateSchema'];
  if (
    stateSchema !== undefined &&
    !(typeof stateSchema === 'number' && Number.isInteger(stateSchema) && stateSchema > 0)
  ) {
    throw new ImageManifestInvalid(file, 'stateSchema must be a positive integer');
  }
  return {
    ...declared,
    answerTools: answers as string[],
    keepsMemory: keepsMemory === true,
    eraseUser: eraseUser === true,
    stateSchema: stateSchema ?? null,
  };
}

/** A module command's name does not make a valid wire name. */
export class ModuleToolNameInvalid extends Error {
  constructor(
    readonly module: string,
    readonly command: string,
    detail: string,
  ) {
    super(`module tool ${module}/${command}: ${detail}`);
    this.name = 'ModuleToolNameInvalid';
  }
}

const MODULE_PART = /^[a-z][a-z0-9_]*$/;

/**
 * The name the model sees for a granted module command (R2): `<module>__<command>`, since the gateway's pattern
 * has no `/` (the allow list keeps `<module>/<command>`, docs/plans/extension-modules.md R29).
 */
export function moduleToolWireName(module: string, command: string): string {
  if (!MODULE_PART.test(module))
    throw new ModuleToolNameInvalid(module, command, `the module name must match ${String(MODULE_PART)}`);
  if (!MODULE_PART.test(command))
    throw new ModuleToolNameInvalid(module, command, `the command name must match ${String(MODULE_PART)}`);
  const wire = `${module}__${command}`;
  if (wire.length > 64)
    throw new ModuleToolNameInvalid(
      module,
      command,
      `its wire name ${wire} is ${String(wire.length)} characters, over 64`,
    );
  return wire;
}
