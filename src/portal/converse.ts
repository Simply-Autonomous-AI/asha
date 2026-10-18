// Sending one message and following its conversation (docs/plans/portal.md R4; docs/plans/portal-scene-chat.md R15):
// the one implementation the send view, the watch view's message box and Run demo share. The body is the CLI's; the
// conversation is followed by the CLI's own rule (ConversationTracker) and printed by its own code; it ends in the
// state the CLI's exit code would give. Its waits are bounded and its failures shown and reported (portal R6, R18).

import {
  CONVERSATION_CLOSED,
  ConversationTracker,
  DeltaPrinter,
  EXIT,
  daemonRefusedLine,
  errorReasonOf,
  type Out,
} from '../shared/lines.js';
import { Routes, type ConversationEvent, type ConversationRequest } from '../shared/protocol.js';
import { present } from '../shared/assert-present.js';
import type { DaemonClient } from './client.js';
import { report, showFailure } from './view.js';

/** One message's state: what the CLI's exit code would say. */
export type MessageState = 'sending' | 'done' | 'failed' | 'stopping';

export interface ConverseProps {
  readonly client: DaemonClient;
  readonly request: ConversationRequest;
  /** Where the CLI's lines go: stdout, stderr (the ✗ and ⚠ lines) and the --verbose progress. */
  readonly out: Out;
  /** Uploads the message's files before it is sent: the upload's id, or 'failed' once a refusal was shown. */
  readonly attach?: (out: Out) => Promise<string>;
  /** Each conversation event, after the tracker has printed it. */
  readonly onEvent?: (streamed: ConversationEvent, out: Out) => void;
}

/**
 * The outcome: the state; the exit code the CLI would give (undefined when the conversation never settled — refused,
 * cut, failed, or the daemon stopping); and the conversation the message began (undefined when it was never posted).
 */
export interface Conversed {
  readonly state: MessageState;
  readonly code: number | undefined;
  readonly conversation: string | undefined;
}

export async function converse(props: ConverseProps): Promise<Conversed> {
  const { client, request } = props;
  const printer = new DeltaPrinter(props.out.progress);
  const out = printer.around(props.out);
  let conversation: string | undefined;
  try {
    let attachments: string | undefined;
    if (props.attach !== undefined) {
      const uploaded = await props.attach(out);
      if (uploaded === 'failed') return { state: 'failed', code: undefined, conversation };
      attachments = uploaded;
    }
    const tracker = new ConversationTracker(out, { sameBuild: true, deltas: printer });
    let code: number | undefined;
    let errorReason: string | undefined;
    const outcome = await client.stream(
      Routes.conversations,
      { method: 'POST', body: attachments === undefined ? request : { ...request, attachments } },
      (raw) => {
        const event = raw as ConversationEvent;
        errorReason ??= errorReasonOf(event);
        if (event.type === 'posted') conversation ??= event.message.conversation;
        code = tracker.handle(event);
        props.onEvent?.(event, out);
        return code !== undefined;
      },
      undefined,
      [400, 409],
    );
    printer.end();
    if (typeof outcome === 'object') {
      // The CLI's own line for a refused message (a bad request): a status the route does not answer on success.
      out.stderr(daemonRefusedLine('rejected the message', outcome.status, outcome.text));
      await report(client, 'bad_status', `${Routes.conversations} ${String(outcome.status)}`, out.stderr);
      return { state: 'failed', code: undefined, conversation };
    }
    if (outcome === 'ended') {
      out.stderr(CONVERSATION_CLOSED);
      const cut = client.cut(Routes.conversations);
      await report(client, present(cut.reason, 'cut.reason'), present(cut.detail, 'cut.detail'), out.stderr);
      return { state: 'failed', code: undefined, conversation };
    }
    if (errorReason !== undefined)
      await report(client, 'stream_error', `${Routes.conversations} ${errorReason}`, out.stderr);
    return { state: code === EXIT.ok ? 'done' : 'failed', code, conversation };
  } catch (error) {
    printer.end();
    return {
      state: (await showFailure(client, error, out.stderr)) === 'stopping' ? 'stopping' : 'failed',
      code: undefined,
      conversation,
    };
  }
}
