// blackboard_read and blackboard_post (docs/plans/agent-tools.md R10): the
// channel's shared blackboard through the harness's agent API. The routes'
// three refusals come back as tool-result errors; any other refusal throws
// HarnessRequestError and fails the turn. Each call is bounded by the SDK's
// request timeout (R5), and gets no span (docs/plans/otel-traces.md R1).

import type { BlackboardEntry, BlackboardReadResponse, BlackboardRefusal } from '../shared/protocol.js';
import { parseToolParameters } from '../shared/tools.js';
import { COMMON_TOOL_DEFINITIONS, failed, ok, type ToolImplementation, type ToolOutcome } from './tools.js';

export type BlackboardAnswer<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: BlackboardRefusal };

/** The blackboard routes, as the SDK's HarnessClient implements them. */
export interface BlackboardClient {
  /** Bound on one call: the SDK's request timeout. */
  readonly requestTimeoutMs: number;
  blackboardRead(since: number | undefined, signal: AbortSignal): Promise<BlackboardAnswer<BlackboardReadResponse>>;
  blackboardPost(text: string, signal: AbortSignal): Promise<BlackboardAnswer<BlackboardEntry>>;
}

/** Whether a fetch ended because its signal aborted (the call's bound). */
function aborted(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function bounded<T>(
  call: () => Promise<BlackboardAnswer<T>>,
  onOk: (value: T) => ToolOutcome,
): Promise<ToolOutcome> {
  let answer: BlackboardAnswer<T>;
  try {
    answer = await call();
  } catch (error) {
    if (aborted(error)) return failed('timeout');
    throw error;
  }
  return answer.ok ? onOk(answer.value) : failed(answer.reason);
}

/** The two blackboard tools, keyed by name. */
export function blackboardTools(client: BlackboardClient): Map<string, ToolImplementation> {
  return new Map<string, ToolImplementation>([
    [
      'blackboard_read',
      {
        definition: COMMON_TOOL_DEFINITIONS.blackboard_read,
        parameters: parseToolParameters(COMMON_TOOL_DEFINITIONS.blackboard_read.function.parameters),
        timeoutMs: client.requestTimeoutMs,
        // The route keeps a read's JSON within 8 KiB, and a posted entry within one read.
        run: (args, signal) =>
          bounded(
            () => client.blackboardRead(args['since'] as number | undefined, signal),
            (read) => ok(read),
          ),
      },
    ],
    [
      'blackboard_post',
      {
        definition: COMMON_TOOL_DEFINITIONS.blackboard_post,
        parameters: parseToolParameters(COMMON_TOOL_DEFINITIONS.blackboard_post.function.parameters),
        timeoutMs: client.requestTimeoutMs,
        run: (args, signal) =>
          bounded(
            () => client.blackboardPost(String(args['text']), signal),
            (entry) => ok(entry),
          ),
      },
    ],
  ]);
}
