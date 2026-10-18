// A command plugin's arguments (docs/plans/extension-modules.md R31): the agent supplies a JSON object its command's
// schema validates, with no unknown field; the harness builds the argument list — the fixed prefix, the options the
// manifest fixes, then each typed value in the schema's order, after its option when it declares one — as an array,
// run with no shell. A value beginning with `-` is refused for every type, so no value can add an option; a string or
// remote value beginning with `file://`, `fileb://` or `@`, by which such tools read a local file, is refused.

import type { CommandArgument, CommandDeclaration } from '../../shared/modules.js';
import { normalPluginPath } from './paths.js';

/** A path argument of one call: its name, its value as the agent gave it, its mode, and whether it is read recursively. */
export interface PathArgument {
  readonly name: string;
  readonly value: string;
  readonly mode: 'read' | 'write';
  readonly recursive: boolean;
}

export type BuiltArguments =
  | { readonly ok: true; readonly argv: readonly string[]; readonly paths: readonly PathArgument[] }
  | { readonly ok: false; readonly field: string; readonly problem: string };

const LOCAL_FILE_FORMS = /^(file:\/\/|fileb:\/\/|@)/i;

/** An `enum` argument's problem (helper of {@link valueProblem}, split out to keep its complexity down). */
function enumProblem(arg: { readonly values: readonly string[] }, value: unknown): string | undefined {
  return typeof value === 'string' && arg.values.includes(value)
    ? undefined
    : `must be one of ${arg.values.join(', ')}`;
}

/** An `integer` argument's problem (helper of {@link valueProblem}). */
function integerProblem(
  arg: { readonly minimum: number; readonly maximum: number },
  value: unknown,
): string | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'must be a safe integer';
  return value < arg.minimum || value > arg.maximum
    ? `must be in ${String(arg.minimum)}..${String(arg.maximum)}`
    : undefined;
}

/** A `string` or `remote` argument's problem (helper of {@link valueProblem}). */
function stringOrRemoteProblem(arg: { readonly pattern: string }, value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return 'must be a non-empty string';
  if (LOCAL_FILE_FORMS.test(value))
    return 'a value beginning with file://, fileb:// or @ (a form that reads a local file) is refused';
  if (/\0/.test(value)) return 'must not hold a NUL character';
  return new RegExp(arg.pattern, 'u').test(value) ? undefined : `must match ${arg.pattern}`;
}

/** A `path` argument's problem (helper of {@link valueProblem}). */
function pathProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return 'must be a path';
  if (/\0/.test(value)) return 'must not hold a NUL character';
  return value.startsWith('/') ? undefined : 'must be an absolute path in /channel or /roots/<name>';
}

/** Why one value does not fit its typed argument (R31); undefined when it does. */
function valueProblem(arg: CommandArgument, value: unknown): string | undefined {
  if (typeof value === 'string' && value.startsWith('-')) return 'a value may not begin with "-"';
  switch (arg.type) {
    case 'enum':
      return enumProblem(arg, value);
    case 'integer':
      return integerProblem(arg, value);
    case 'string':
    case 'remote':
      return stringOrRemoteProblem(arg, value);
    case 'path':
      return pathProblem(value);
  }
}

/** One argument's tokens and (for a path) its {@link PathArgument}, or why its value does not fit (R31, R32). */
type OneArgument =
  | { readonly ok: false; readonly problem: string }
  | { readonly ok: true; readonly tokens: readonly string[]; readonly path?: PathArgument };

/** Builds one argument's command-line tokens, after it is checked to fit its schema (helper of {@link buildArguments}). */
function buildOneArgument(name: string, arg: CommandArgument, value: unknown): OneArgument {
  const problem = valueProblem(arg, value);
  if (problem !== undefined) return { ok: false, problem };
  const tokens: string[] = [];
  if (arg.option !== undefined) tokens.push(arg.option);
  // A path is given to the command exactly as it was checked (R32), never the agent's spelling of it (B-22).
  tokens.push(arg.type === 'path' ? normalPluginPath(value as string) : String(value));
  if (arg.type !== 'path') return { ok: true, tokens };
  return { ok: true, tokens, path: { name, value: value as string, mode: arg.mode, recursive: arg.recursive } };
}

/** Validates the agent's arguments against the command's schema and builds the argument array (R31). */
export function buildArguments(command: CommandDeclaration, args: unknown): BuiltArguments {
  if (typeof args !== 'object' || args === null || Array.isArray(args))
    return { ok: false, field: '', problem: 'the arguments are not a JSON object' };
  const given = args as Record<string, unknown>;
  for (const key of Object.keys(given))
    if (!Object.hasOwn(command.arguments, key))
      return { ok: false, field: key, problem: 'is not an argument this command declares' };
  for (const key of command.required)
    if (!Object.hasOwn(given, key)) return { ok: false, field: key, problem: 'is required' };
  const argv: string[] = [...command.prefix, ...command.fixed];
  const paths: PathArgument[] = [];
  for (const [name, arg] of Object.entries(command.arguments)) {
    if (!Object.hasOwn(given, name)) continue;
    const built = buildOneArgument(name, arg, given[name]);
    if (!built.ok) return { ok: false, field: name, problem: built.problem };
    argv.push(...built.tokens);
    if (built.path !== undefined) paths.push(built.path);
  }
  return { ok: true, argv, paths };
}

/** A command's schema as the model is offered it (R10), re-exported for the route's own use. */
