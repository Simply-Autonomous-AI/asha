// The module side of the daemon–module framing (docs/plans/extension-modules.md R34), run inside every ToolModule's
// and ModelProvider's container from the module base image: newline-delimited JSON on stdin and stdout, one request
// `{id, tool, arguments, idempotencyKey?}` per line, exactly one response `{id, ok, result | reason, detail?, usage?}`
// per request, any number of `{id, delta}` lines before a provider's response; several requests in flight, matched
// by id. The module's own code is its entry file's exports:
//
//   ToolModule:    call(tool, args, context) → {ok: true, result, usage?} | {ok: false, reason, detail?}
//   ModelProvider: chat(args, context) → {ok: true, result: {text, toolCalls}, usage} | {ok: false, reason, detail?}
//                  and, optionally, embed(args, context) and lifecycle(args, context) (the live check, R20)
//
// `context` holds the module's own declared secrets (R7), the call's idempotency key (R13) and, for a provider's
// chat, onDelta. A handler that throws is answered `module_unavailable`, and the error is one JSON line on stderr
// (which the daemon redacts and re-logs, R35).

export interface ModuleEntry {
  readonly call?: (tool: string, args: unknown, context: CallContext) => Promise<unknown>;
  readonly chat?: (args: unknown, context: CallContext) => Promise<unknown>;
  readonly embed?: (args: unknown, context: CallContext) => Promise<unknown>;
  readonly lifecycle?: (args: unknown, context: CallContext) => Promise<unknown>;
}

interface CallContext {
  readonly secrets: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  readonly onDelta: (delta: unknown) => void;
}

export interface ServeModuleProps {
  readonly kind: 'ToolModule' | 'ModelProvider';
  readonly entry: ModuleEntry;
  readonly secrets: Readonly<Record<string, string>>;
  readonly write: (line: string) => void;
  readonly log: (record: Readonly<Record<string, unknown>>) => void;
}

interface ParsedRequest {
  readonly id: string;
  readonly tool: string;
  readonly arguments: unknown;
  readonly idempotencyKey?: string;
}

/** Parses and validates one request line, logging and answering `undefined` when it is not a request. */
function parseRequest(line: string, log: ServeModuleProps['log']): ParsedRequest | undefined {
  let request: { id?: unknown; tool?: unknown; arguments?: unknown; idempotencyKey?: unknown };
  try {
    request = JSON.parse(line) as typeof request;
  } catch (error) {
    log({ event: 'module.request_invalid', detail: (error as Error).message });
    return undefined;
  }
  const { id, tool } = request;
  if (typeof id !== 'string' || typeof tool !== 'string') {
    log({ event: 'module.request_invalid', detail: 'a request has a string id and tool' });
    return undefined;
  }
  return {
    id,
    tool,
    arguments: request.arguments,
    ...(typeof request.idempotencyKey === 'string' ? { idempotencyKey: request.idempotencyKey } : {}),
  };
}

/** The ModelProvider's handler for one of its three tools, or `undefined` for anything else. */
function providerHandler(entry: ModuleEntry, tool: string): ModuleEntry['chat' | 'embed' | 'lifecycle'] {
  if (tool === 'chat') return entry.chat;
  if (tool === 'embed') return entry.embed;
  if (tool === 'lifecycle') return entry.lifecycle;
  return undefined;
}

/** The ToolModule's single handler, bound to `tool` and `context`, or `undefined` when it declares none. */
function toolModuleHandler(
  entry: ModuleEntry,
  tool: string,
  context: CallContext,
): ((args: unknown) => Promise<unknown>) | undefined {
  const call = entry.call;
  if (call === undefined) return undefined;
  return (args: unknown) => call(tool, args, context);
}

function selectHandler(
  props: ServeModuleProps,
  tool: string,
  context: CallContext,
): ((args: unknown, context: CallContext) => Promise<unknown>) | undefined {
  if (props.kind === 'ToolModule') return toolModuleHandler(props.entry, tool, context);
  return providerHandler(props.entry, tool);
}

/** Calls `handler`, answering its outcome or, on a thrown error or a malformed outcome, a failure. */
async function invokeHandler(
  handler: (args: unknown, context: CallContext) => Promise<unknown>,
  args: unknown,
  context: CallContext,
  props: ServeModuleProps,
  tool: string,
  respond: (value: Readonly<Record<string, unknown>>) => void,
): Promise<void> {
  try {
    const outcome = (await handler(args ?? {}, context)) as Readonly<Record<string, unknown>> | null;
    if (typeof outcome !== 'object' || outcome === null || typeof outcome['ok'] !== 'boolean')
      throw new Error('the handler answered neither {ok: true, …} nor {ok: false, reason}');
    respond(outcome);
  } catch (error) {
    props.log({
      event: 'module.handler_failed',
      tool,
      detail: error instanceof Error ? error.message : String(error),
    });
    // A provider's reasons are ModelFailureReasons, a tool's ToolFailureReasons: each kind's own word for "it failed".
    respond({
      ok: false,
      reason: props.kind === 'ModelProvider' ? 'unavailable' : 'module_unavailable',
      detail: 'the module failed; see the daemon log',
    });
  }
}

/** Handles one request line; resolves once its response is written. */
export async function handleLine(props: ServeModuleProps, line: string): Promise<void> {
  const parsed = parseRequest(line, props.log);
  if (parsed === undefined) return;
  const { id, tool } = parsed;
  const respond = (value: Readonly<Record<string, unknown>>): void => {
    props.write(`${JSON.stringify({ id, ...value })}\n`);
  };
  const context: CallContext = {
    secrets: props.secrets,
    ...(parsed.idempotencyKey === undefined ? {} : { idempotencyKey: parsed.idempotencyKey }),
    onDelta: (delta) => {
      props.write(`${JSON.stringify({ id, delta })}\n`);
    },
  };
  const handler = selectHandler(props, tool, context);
  if (handler === undefined) {
    respond({
      ok: false,
      reason: props.kind === 'ModelProvider' ? 'unavailable' : 'unknown_tool',
      detail: `this module has no handler for ${tool}`,
    });
    return;
  }
  await invokeHandler(handler, parsed.arguments, context, props, tool, respond);
}
