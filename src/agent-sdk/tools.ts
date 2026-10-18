// An agent's own tools (docs/plans/agent-tools.md R1, R3–R5, R8): the tools its
// recipe selects — the SDK's common tools and its image's — offered after the
// channel tools, and run for the model inside decide()'s tool rounds. Every
// call is bounded (R5); its arguments are checked against the tool's schema
// before its handler runs (R3); an expected failure goes back to the model as
// `{error: <reason>}` and is logged as `tool.failed`, never swallowed and never
// ending the turn; an unexpected throw is logged as `tool.crashed` and fails
// the turn (R4). A turn's results carry at most 16 KiB of content (R3).

import { createHash } from 'node:crypto';

import type { ToolCall, ToolDefinition } from '../shared/protocol.js';
import {
  argumentsProblem,
  parseToolParameters,
  type CommonToolName,
  type ImageManifest,
  type ImageToolDeclaration,
  type ToolFailureReason,
  type ToolParameters,
} from '../shared/tools.js';
import { present } from '../shared/assert-present.js';
import type { AgentLog } from './log.js';

/** Content one tool result may carry (R3). */
const MAX_RESULT_BYTES = 8 * 1024;
/** Content the results of one turn may carry together (R3). */
const MAX_TURN_RESULT_BYTES = 16 * 1024;
/** Own-tool rounds per turn, counted apart from list_agents' rounds (R3). */
export const MAX_TOOL_ROUNDS = 6;

/**
 * What a handler returns: a value, sent to the model as its JSON, or an expected failure. The turn budget and
 * the 8 KiB bound count the value's JSON as sent — every byte that enters the model's context (R3; counted as
 * stored text until review finding 4, 2026-09-27).
 */
export type ToolOutcome =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: ToolFailureReason };

/** Runs one call. `signal` aborts when the call's bound passes; the handler should stop its work then. An image
 * tool's handler returns the same shape as any other: its value must serialize to at most 8 KiB. */
export type ImageToolHandler = (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<ToolOutcome>;

/** One runnable tool: what the model is offered, how its arguments are checked, its bound and its handler. */
export interface ToolImplementation {
  readonly definition: ToolDefinition;
  readonly parameters: ToolParameters;
  readonly timeoutMs: number;
  readonly run: (args: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<ToolOutcome>;
}

export const ok = (value: unknown): ToolOutcome => ({ ok: true, value });

/**
 * `JSON.stringify`'s declared type claims it always returns `string`; at runtime it returns `undefined` for a
 * value JSON cannot represent (`undefined` itself, a function, a symbol) — the hole this corrects.
 */
function stringifyMaybe(value: unknown): string | undefined {
  return JSON.stringify(value);
}

function toJsonOrNull(value: unknown): string {
  return stringifyMaybe(value) ?? 'null';
}

/** The bytes a value takes in the model's context: its JSON, as the tool message carries it. */
export function resultBytes(value: unknown): number {
  return Buffer.byteLength(toJsonOrNull(value), 'utf8');
}
export const failed = (reason: ToolFailureReason): ToolOutcome => ({ ok: false, reason });

/** A tool handler threw: the turn fails (R4). Carries the tool and the handler's error as its cause. */
export class ToolCrashed extends Error {
  constructor(
    readonly tool: string,
    options: ErrorOptions,
  ) {
    super(
      `tool ${tool} crashed: ${options.cause instanceof Error ? options.cause.message : String(options.cause)}`,
      options,
    );
    this.name = 'ToolCrashed';
  }
}

/** The image's tools and handlers do not match, or the welcome selected a tool the agent does not have: the agent cannot start (R1). */
export class AgentToolsInvalid extends Error {
  constructor(detail: string) {
    super(`the agent's tools are invalid: ${detail}`);
    this.name = 'AgentToolsInvalid';
  }
}

/** The content a turn's tool results have carried so far. One per turn. */
export class TurnBudget {
  used = 0;
}

/** The own tools of one agent, as decide() uses them. */
export interface TurnTools {
  /** The definitions offered to the model after the channel tools, in the recipe's order. */
  readonly definitions: readonly ToolDefinition[];
  /** Runs one call and returns the tool message's content: the result, or `{"error": <reason>}`. Throws ToolCrashed. */
  run(call: ToolCall, budget: TurnBudget): Promise<string>;
}

/** No own tools: every call but a channel tool is answered `unknown_tool`. decide()'s default, for the routing eval, which runs no agent. */
export const NO_OWN_TOOLS: TurnTools = {
  definitions: [],
  run: () => Promise.resolve(JSON.stringify({ error: 'unknown_tool' })),
};

/** The six common tools as the model sees them (R8–R10). */
export const COMMON_TOOL_DEFINITIONS: Readonly<Record<CommonToolName, ToolDefinition>> = {
  list_files: tool(
    'list_files',
    'List one directory of your files: /workspace (yours; a relative path is under it) or /channel (shared with every agent on the channel). Not recursive. Returns JSON {entries: [{name, type: file|dir|link|other, size}], next_after?}; pass next_after as `after` for the rest.',
    {
      path: { type: 'string', description: 'The directory, e.g. "." or "/workspace/notes"' },
      after: { type: 'string', description: 'List only names after this one (from next_after)' },
    },
    ['path'],
  ),
  read_file: tool(
    'read_file',
    'Read a text file from /workspace or /channel, at most 8 KiB at a time. Returns JSON {content, size, next_offset?}; pass next_offset as `offset` to read on.',
    {
      path: { type: 'string', description: 'The file, e.g. "notes.txt"' },
      offset: { type: 'integer', minimum: 0, description: 'Byte to start at (default 0)' },
      length: { type: 'integer', minimum: 1, description: 'Bytes to read, at most 8192 (the default)' },
    },
    ['path'],
  ),
  write_file: tool(
    'write_file',
    'Create or overwrite a text file in /workspace or /channel (at most 256 KiB), creating missing directories. Returns JSON {path, size}.',
    {
      path: { type: 'string', description: 'The file, e.g. "notes.txt"' },
      content: { type: 'string', description: 'The whole new content' },
    },
    ['path', 'content'],
  ),
  append_file: tool(
    'append_file',
    'Append text to a file in /workspace or /channel, creating it if absent (at most 256 KiB in all). Returns JSON {path, size}.',
    {
      path: { type: 'string', description: 'The file, e.g. "log.txt"' },
      content: { type: 'string', description: 'The text to add at the end' },
    },
    ['path', 'content'],
  ),
  blackboard_read: tool(
    'blackboard_read',
    "Read the channel's blackboard: notes every agent on the channel can post and read, oldest first. Returns JSON {entries: [{id, author, ts, text}], more}; pass the last id as `since` to read on.",
    { since: { type: 'integer', minimum: 0, description: 'Only entries after this id' } },
    [],
  ),
  blackboard_post: tool(
    'blackboard_post',
    "Post a note to the channel's blackboard for every agent on the channel to read (at most 8 KiB). It wakes no one. Returns the stored entry.",
    { text: { type: 'string', description: 'The note' } },
    ['text'],
  ),
};

function tool(
  name: string,
  description: string,
  properties: ToolParameters['properties'],
  required: readonly string[],
): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

/** The definition an image tool is offered with, from its manifest entry. */
function imageToolDefinition(declared: ImageToolDeclaration): ToolDefinition {
  // ToolParameters is a JSON Schema object; the wire type only knows it as a record.
  const parameters = declared.parameters as unknown as Readonly<Record<string, unknown>>;
  return { type: 'function', function: { name: declared.name, description: declared.description, parameters } };
}

/** Every declared tool has a handler and every handler a declaration; else AgentToolsInvalid naming each (R1). */
export function checkImageTools(manifest: ImageManifest, handlers: Readonly<Record<string, ImageToolHandler>>): void {
  const declared = manifest.tools.map((t) => t.name);
  const noHandler = declared.filter((name) => !Object.hasOwn(handlers, name));
  const undeclared = Object.keys(handlers).filter((name) => !declared.includes(name));
  const problems = [
    ...noHandler.map((name) => `"${name}" is declared in image.json but has no handler`),
    ...undeclared.map((name) => `a handler is registered for "${name}", which image.json does not declare`),
  ];
  if (problems.length > 0) throw new AgentToolsInvalid(problems.join('; '));
}

/** An image tool as a ToolImplementation; AgentTools bounds its result like every other tool's. */
export function imageTool(declared: ImageToolDeclaration, handler: ImageToolHandler): ToolImplementation {
  return {
    definition: imageToolDefinition(declared),
    parameters: parseToolParameters(declared.parameters),
    timeoutMs: declared.timeoutMs,
    run: handler,
  };
}

export interface AgentToolsProps {
  /** The names the welcome event carries, in order. */
  readonly selected: readonly string[];
  /** Every tool the agent could offer: the common tools and its image's. */
  readonly available: ReadonlyMap<string, ToolImplementation>;
  /**
   * The channel tools a recipe may select (docs/plans/agent-files.md R12's reply_with_files), by name: offered among
   * the selected definitions, and never run here — decide() posts them as it posts reply. Default: none.
   */
  readonly channel?: ReadonlyMap<string, ToolDefinition>;
  readonly log: AgentLog;
}

/** The selected tools of one agent; runs calls under R3–R5. */
export class AgentTools implements TurnTools {
  readonly definitions: readonly ToolDefinition[];
  private readonly offered: ReadonlyMap<string, ToolImplementation>;

  constructor(private readonly props: AgentToolsProps) {
    const channel = props.channel ?? new Map<string, ToolDefinition>();
    const missing = props.selected.filter((name) => !props.available.has(name) && !channel.has(name));
    if (missing.length > 0) {
      const quoted = missing.map((n) => `"${n}"`).join(', ');
      throw new AgentToolsInvalid(`the welcome selects ${quoted}, which this agent does not implement`);
    }
    this.offered = new Map(
      props.selected
        .filter((name) => !channel.has(name))
        .map((name) => [name, present(props.available.get(name), `available tool "${name}"`)]),
    );
    this.definitions = props.selected.map(
      (name) => channel.get(name) ?? present(props.available.get(name), `available tool "${name}"`).definition,
    );
  }

  async run(call: ToolCall, budget: TurnBudget): Promise<string> {
    // A selected channel tool is decide()'s to post: reaching here is a defect in the turn loop, not the model's mistake.
    if (this.props.channel?.has(call.name) === true)
      throw new Error(`${call.name} is a channel tool: decide() posts it, it is never run as a tool`);
    const implementation = this.offered.get(call.name);
    if (implementation === undefined) return this.fail(call.name, 'unknown_tool');
    if (argumentsProblem(implementation.parameters, call.arguments) !== null)
      return this.fail(call.name, 'invalid_arguments');

    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve('timeout');
      }, implementation.timeoutMs);
    });
    const running = implementation.run(call.arguments, controller.signal);
    let outcome: ToolOutcome | 'timeout';
    try {
      outcome = await Promise.race([running, bound]);
    } catch (error) {
      this.props.log.error('tool.crashed', { tool: call.name, error });
      throw new ToolCrashed(call.name, { cause: error });
    } finally {
      clearTimeout(timer);
    }
    if (outcome !== 'timeout' && outcome.ok) {
      // Every tool keeps its result within 8 KiB of JSON; one that does not is a defect, not an expected failure.
      const bytes = resultBytes(outcome.value);
      if (bytes > MAX_RESULT_BYTES) {
        const error = new Error(
          `its result is ${String(bytes)} bytes of JSON, over the ${String(MAX_RESULT_BYTES)} one result may carry`,
        );
        this.props.log.error('tool.crashed', { tool: call.name, error });
        throw new ToolCrashed(call.name, { cause: error });
      }
    }
    if (outcome === 'timeout') {
      // The handler was told to stop; if it throws on its way out, that is still recorded, never swallowed.
      running.catch((error: unknown) => {
        this.props.log.error('tool.crashed', { tool: call.name, afterTimeout: true, error });
      });
      return this.fail(call.name, 'timeout');
    }
    if (!outcome.ok) return this.fail(call.name, outcome.reason);
    const content = toJsonOrNull(outcome.value);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (budget.used + bytes > MAX_TURN_RESULT_BYTES) return this.fail(call.name, 'turn_budget_exceeded');
    budget.used += bytes;
    // Every call that returns a result is on record, as every failure is (tool.failed): the tool, and the result's
    // size and sha256 — never its content or the arguments (collaborating-agents A2, A3 count and compare them).
    this.props.log.info('tool.called', {
      tool: call.name,
      resultBytes: bytes,
      resultSha256: createHash('sha256').update(content).digest('hex'),
    });
    return content;
  }

  /** Never the arguments or any content: the tool and the reason. */
  private fail(tool: string, reason: ToolFailureReason): string {
    this.props.log.warn('tool.failed', { tool, reason });
    return JSON.stringify({ error: reason });
  }
}
