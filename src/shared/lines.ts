// What the daemon's streams say, as lines (docs/plans/portal.md R15): the one implementation of how a conversation
// settles and its outcome, and of every line the CLI prints for a conversation, a watch, a launch, a file space, an
// upload and a returned file. The CLI and the portal's page both import it, so the page shows exactly what the CLI
// prints. Browser-safe: it imports only modules that import nothing.
//
// Lines go to an Out: `stdout` (a command's output), `stderr` (✗ and ⚠ lines, always shown) and `progress` (what
// --verbose adds; the page's details area).

import {
  DEFAULT_CHANNEL,
  HARNESS_HANDLE,
  type ChannelMessage,
  type ChannelStopEvent,
  type ConversationEvent,
  type ConversationMessage,
  type LaunchEvent,
  type ModelDeltaEvent,
  type ModelDoneEvent,
  type ReturnedFile,
  type SpaceEvent,
  type WatchEvent,
} from './protocol.js';
import { SPACE_MAX_BYTES, SPACE_MAX_ENTRIES } from './files.js';

/** Where lines go. */
export interface Out {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly progress: (text: string) => void;
}

/** 130 is the conventional exit code for an interrupt (128 + SIGINT); only --interactive uses it (cli-interactive R6). */
export const EXIT = { ok: 0, failed: 1, usage: 2, interrupted: 130 } as const;

/** Indents the continuation lines of a multi-line message under its first line. */
function indent(text: string): string {
  return text.split('\n').join('\n    ');
}

/** The `✗` line of a stream's `error` event. */
export function errorLine(event: { readonly reason: string; readonly detail: string }): string {
  return `✗ ${event.reason}: ${event.detail}\n`;
}

/**
 * Prints model deltas as they arrive (docs/plans/model-streaming.md R7): a line opening with `›`, the handle and the
 * part — `thinking`, `text`, or the tool's name — whenever the call or the part changes, then each fragment as it
 * comes. The line is ended when its call's `model_done` arrives, and before any other line (`around`).
 */
export class DeltaPrinter {
  private open: { readonly call: string; readonly part: string } | undefined;

  constructor(private readonly write: (text: string) => void) {}

  delta(event: ModelDeltaEvent): void {
    const part = event.part === 'tool_args' ? `tool ${String(event.index)}` : event.part;
    if (this.open?.call !== event.call || this.open.part !== part) {
      this.end();
      this.write(`› ${event.handle} ${event.part === 'tool_args' ? event.name : event.part}: `);
      this.open = { call: event.call, part };
    }
    this.write(event.text);
  }

  done(event: ModelDoneEvent): void {
    if (this.open?.call === event.call) this.end();
  }

  /** Ends the open delta line, if any. */
  end(): void {
    if (this.open === undefined) return;
    this.open = undefined;
    this.write('\n');
  }

  /** `out` with every output ending the open delta line first: nothing else is printed mid-line. */
  around<C extends Out>(out: C): C {
    const first =
      (write: (text: string) => void) =>
      (text: string): void => {
        this.end();
        write(text);
      };
    return { ...out, stdout: first(out.stdout), stderr: first(out.stderr), progress: first(out.progress) };
  }
}

export interface ConversationTrackerProps {
  /** The daemon reported this client's own build on /v1/health. */
  readonly sameBuild: boolean;
  /** Where the models' output is printed as it streams; null when another view prints it (model-streaming R7). */
  readonly deltas: DeltaPrinter | null;
}

/**
 * Follows one conversation. It is settled once the user's message is posted
 * and no agent holds an unacknowledged delivery in it: success if an agent
 * replied to the user, failure if every agent finished without replying — in
 * which case the harness's own reply, saying what each agent did, is what was
 * printed, and the exit code alone marks the failure. A message no agent
 * received fails at once, saying so. When not even the harness replied, the
 * cause printed is the one the stream shows: agents that left, else the
 * daemon's build.
 */
export class ConversationTracker {
  private posted = false;
  private replies = 0;
  /** The harness's own reply, saying why no agent answered, has been printed. */
  private harnessReplied = false;
  /** Agents that left the channel during this conversation, with why. */
  private readonly left: string[] = [];

  constructor(
    private readonly out: Out,
    private readonly props: ConversationTrackerProps,
  ) {}

  /** The 'message' case of `handle`: a status, an output or an internal message, printed by its kind. */
  private printMessage(message: ConversationMessage): void {
    if (message.kind === 'status') {
      // A harness notice (agent-persistence R6: a save failed) is a warning: always shown.
      if (message.from === HARNESS_HANDLE && message.text.startsWith('⚠')) this.out.stderr(`${message.text}\n`);
      else this.out.progress(`› ${message.from}: ${indent(message.text)}\n`);
    } else if (message.kind === 'output') {
      // The harness's own reply says no agent could answer: printed like any reply, but not one.
      if (message.from === HARNESS_HANDLE) this.harnessReplied = true;
      else this.replies += 1;
      this.out.progress(`› output ${message.from} → ${String(message.to)}:\n`);
      this.out.stdout(`${message.text}\n`);
      // An ask (docs/plans/patterns-phase-3.md R27): the command that answers it, always shown.
      if (message.asks === true) this.out.stderr(waitingLine(message));
    } else {
      this.out.progress(`› internal ${message.from} → ${message.to ?? 'all agents'}: ${indent(message.text)}\n`);
    }
  }

  /** Prints the event. Returns an exit code once the conversation is settled. */
  handle(event: ConversationEvent): number | undefined {
    switch (event.type) {
      case 'phase':
        this.out.progress(`› ${event.phase}: ${event.detail}\n`);
        return undefined;
      case 'model_delta':
        this.props.deltas?.delta(event);
        return undefined;
      case 'model_done':
        this.props.deltas?.done(event);
        return undefined;
      case 'announced':
        this.out.progress(`› ${event.message.from}: ${indent(event.message.text)}\n`);
        if (event.resumed !== undefined)
          this.out.progress(`› ${event.message.from} resumed from state saved ${event.resumed.savedAt}\n`);
        // A cloud-granted agent brought online onto a space holding files (agent-files R7): said always.
        if (event.exposesFiles === true) this.out.stderr(cloudWarning(event.message.from, event.message.channel));
        return undefined;
      case 'posted': {
        this.posted = true;
        const { message } = event;
        const where = message.to === null ? message.channel : `${message.to} on ${message.channel}`;
        this.out.progress(`› ${message.from} → ${where}: ${indent(message.text)}\n`);
        // A message no agent received settles on the harness's reply that follows, not here.
        return event.working.length === 0 ? undefined : this.settled(event.working);
      }
      case 'message':
        this.printMessage(event.message);
        return this.settled(event.working);
      case 'status':
        return this.settled(event.working);
      case 'agent_left':
        this.out.progress(`› ${event.agent} left the channel: ${event.detail}\n`);
        this.left.push(`${event.agent} left the channel (${event.detail})`);
        return this.settled(event.working);
      case 'error':
        this.out.stderr(errorLine(event));
        return EXIT.failed;
      default: {
        const unknown: never = event;
        throw new Error(`unknown conversation event: ${JSON.stringify(unknown)}`);
      }
    }
  }

  private settled(working: readonly string[]): number | undefined {
    if (!this.posted || working.length > 0) return undefined;
    if (this.replies > 0) return EXIT.ok;
    // The harness's reply already said why nobody answered; the exit code says the command failed.
    // Without it, say the cause the stream shows, or a failure would print nothing.
    // The daemon replies when the last agent leaves, so a departure alone never explains the silence.
    if (!this.harnessReplied) {
      const left = this.left.map((line) => `${line}; `).join('');
      const cause = this.props.sameBuild
        ? 'a defect in the daemon; see its log'
        : 'the daemon runs a different build than this asha (see asha --status)';
      this.out.stderr(`✗ the conversation ended with no reply at all, not even the harness's: ${left}${cause}\n`);
    }
    return EXIT.failed;
  }
}

/**
 * The line an ask prints (docs/plans/patterns-phase-3.md R27): who waits, and the command that answers it — the
 * conversation's asker as user=, the channel only when it is not `main`, `…` where the answer goes.
 */
export function waitingLine(message: Pick<ConversationMessage, 'from' | 'channel' | 'user' | 'conversation'>): string {
  const channel = message.channel === DEFAULT_CHANNEL ? '' : `channel=${message.channel} `;
  return `? ${message.from} is waiting for your answer: asha ${channel}user=${message.user} conversation=${message.conversation} message="…"\n`;
}

/** The files a reply carries (agent-files R12): an output's, in this conversation. */
export function returnedFiles(event: ConversationEvent): readonly ReturnedFile[] {
  return event.type === 'message' && event.message.kind === 'output' ? (event.message.files ?? []) : [];
}

/** The line a conversation stream that ended or was cut before it settled ends with. */
export const CONVERSATION_CLOSED = '✗ the daemon closed the conversation before it settled; see its log\n';

/** The line a stream silent past its bound ends with (STREAM_IDLE_MS). */
export function silenceLine(ms: number): string {
  return `✗ no word from the daemon for ${String(ms)} ms; see its log\n`;
}

/** A message's time as the CLI prints it: `HH:MM:SSZ`, UTC (portal-scene-chat R8 shows it the same way). */
export function clockTime(at: string): string {
  return `${at.slice(11, 19)}Z`;
}

/**
 * One watch event as printed lines on stdout, or undefined for a model's output (printed on stderr, by a
 * DeltaPrinter, with --verbose): the UTC time, the conversation (first 8 characters of its id), the message's kind
 * (input, internal or output), sender → recipient, and the text.
 */
export function formatWatchEvent(event: Exclude<WatchEvent, { type: 'watching' | 'error' }>): string | undefined {
  switch (event.type) {
    case 'message': {
      const { message } = event;
      const time = clockTime(message.at);
      // An agent's status about itself belongs to no conversation.
      const conversation = message.conversation === null ? '--------' : message.conversation.slice(0, 8);
      if (message.kind === 'status')
        return `${time} [${conversation}] status ${message.from}: ${indent(message.text)}\n`;
      const to = message.to ?? 'all agents';
      // A user's message re-sent after a restart says so (agent-persistence R9 (e)).
      const resent = message.redelivered === undefined ? '' : ' (resent from before the restart)';
      // A reply's files: their name, size and sha256 only; a watcher fetches nothing (agent-files R12a).
      const files = (message.files ?? []).map(fileLine).join('');
      return `${time} [${conversation}] ${message.kind} ${message.from} → ${to}${resent}: ${indent(message.text)}\n${files}`;
    }
    case 'agent_joined':
      return `+ ${event.agent} joined the channel\n`;
    case 'agent_left':
      return `- ${event.agent} left the channel: ${event.detail}\n`;
    case 'model_delta':
    case 'model_done':
      return undefined;
    default: {
      const unknown: never = event;
      throw new Error(`unknown watch event: ${JSON.stringify(unknown)}`);
    }
  }
}

/** The progress line a watch opens with: the channel and its agents, and how this watch is ended (`; Ctrl-C to stop`). */
function watchingLine(event: Extract<WatchEvent, { type: 'watching' }>, howToStop: string): string {
  const agents = event.agents.length === 0 ? 'no agents yet' : `agents: ${event.agents.join(', ')}`;
  return `› watching channel "${event.channel}" (${agents})${howToStop}\n`;
}

/**
 * `--watch`'s printing of one event: the opening line as progress, the models' output to `deltas`, every other event
 * as formatWatchEvent's line on stdout, and an `error` event — the daemon ended the watch, saying why — on stderr.
 * Returns 'failed' for the error, which ends the watch.
 */
export class WatchPrinter {
  constructor(
    private readonly out: Out,
    private readonly deltas: DeltaPrinter,
    private readonly howToStop: string,
  ) {}

  handle(event: WatchEvent): 'failed' | undefined {
    switch (event.type) {
      case 'watching':
        this.out.progress(watchingLine(event, this.howToStop));
        return undefined;
      case 'model_delta':
        this.deltas.delta(event);
        return undefined;
      case 'model_done':
        this.deltas.done(event);
        return undefined;
      case 'error':
        // The daemon ended the watch, saying why: this watcher fell behind (slow_reader, model-streaming R6).
        this.out.stderr(errorLine(event));
        return 'failed';
      case 'message':
      case 'agent_joined':
      case 'agent_left': {
        const line = formatWatchEvent(event);
        if (line !== undefined) this.out.stdout(line);
        return undefined;
      }
      default: {
        const unknown: never = event;
        throw new Error(`unknown watch event: ${JSON.stringify(unknown)}`);
      }
    }
  }
}

/** What a view of a channel is told about each watch event (the portal's scene, docs/plans/portal.md R9). */
export interface WatchObserver {
  watching(channel: string, agents: readonly string[]): void;
  message(message: ChannelMessage): void;
  joined(agent: string): void;
  left(agent: string): void;
  delta(event: ModelDeltaEvent): void;
  done(event: ModelDoneEvent): void;
  error(): void;
}

/** Hands one watch event to an observer's method for its type. */
export function observeWatchEvent(event: WatchEvent, observer: WatchObserver): void {
  switch (event.type) {
    case 'watching': {
      observer.watching(event.channel, event.agents);
      return;
    }
    case 'message': {
      observer.message(event.message);
      return;
    }
    case 'agent_joined': {
      observer.joined(event.agent);
      return;
    }
    case 'agent_left': {
      observer.left(event.agent);
      return;
    }
    case 'model_delta': {
      observer.delta(event);
      return;
    }
    case 'model_done': {
      observer.done(event);
      return;
    }
    case 'error': {
      observer.error();
      return;
    }
    default: {
      const unknown: never = event;
      throw new Error(`unknown watch event: ${JSON.stringify(unknown)}`);
    }
  }
}

/**
 * A conversation's message as a launch prints it: a reply on stdout; a status, an internal message, as progress — but
 * a harness notice that opens with ⚠ (agent-persistence R6, R9 (d)) on stderr, always.
 */
function printConversationMessage(out: Out, message: ChannelMessage): void {
  if (message.kind === 'status') {
    if (message.from === HARNESS_HANDLE && message.text.startsWith('⚠')) out.stderr(`${message.text}\n`);
    else out.progress(`› ${message.from}: ${indent(message.text)}\n`);
  } else if (message.kind === 'output') {
    out.progress(`› output ${message.from} → ${String(message.to)}:\n`);
    out.stdout(`${message.text}\n`);
  } else {
    out.progress(`› ${message.kind} ${message.from} → ${message.to ?? 'all agents'}: ${indent(message.text)}\n`);
  }
}

/** The line a launch stream that ended or was cut before it finished ends with. */
export const LAUNCH_CLOSED = '✗ the daemon closed the launch before it finished; see its log\n';

/** What a channel's stop prints when no agent is on the channel (docs/plans/portal-demo-stop.md R4). */
export function noAgentOnChannelLine(channel: string): string {
  return `✗ no agent is on channel "${channel}"\n`;
}

/**
 * A channel's stop printing (docs/plans/portal-demo-stop.md R4, R5): the agents being stopped as progress, each agent
 * stopped and each model server stopped on stdout, a failure on stderr. `handle` returns an exit code once the stop is
 * over; `ended` gives it when the stream ends first. The CLI's `--stop channel=` and the portal's Stop demo share it.
 */
export class ChannelStopPrinter {
  constructor(
    private readonly out: Out,
    private readonly channel: string,
  ) {}

  handle(event: ChannelStopEvent): number | undefined {
    switch (event.type) {
      case 'stopping':
        this.out.progress(
          `› stopping ${event.handles.length === 0 ? 'the launches' : event.handles.join(', ')} on channel ${event.channel}\n`,
        );
        return undefined;
      case 'agent_stopped':
        this.out.stdout(`stopped ${event.handle}\n`);
        return undefined;
      case 'model_server_stopped':
        this.out.stdout(`stopped the model server for ${event.model}\n`);
        return undefined;
      case 'stopped':
        return EXIT.ok;
      case 'error':
        this.out.stderr(`✗ ${event.detail}\n`);
        return EXIT.failed;
    }
  }

  ended(): number {
    this.out.stderr(`✗ the daemon closed the stop of channel ${this.channel} before it was done\n`);
    return EXIT.failed;
  }
}

/**
 * A launch's printing (collaborating-agents R5, agent-persistence R9 (h), (i)): each phase and announcement as
 * progress, each new handle on stdout, re-sent conversations followed when `follow`. `handle` returns an exit code once
 * the launch is over; `ended` gives it when the stream ends first.
 */
export class LaunchPrinter {
  private launched = false;

  constructor(
    private readonly out: Out,
    private readonly deltas: DeltaPrinter,
    private readonly props: { readonly team: boolean; readonly follow: boolean },
  ) {}

  handle(event: LaunchEvent): number | undefined {
    const { out } = this;
    const { team, follow } = this.props;
    switch (event.type) {
      case 'phase':
        out.progress(`› ${event.phase}: ${event.detail}\n`);
        return undefined;
      case 'announced':
        out.progress(`› ${event.message.from}: ${event.message.text}\n`);
        if (event.resumed !== undefined)
          out.progress(`› ${event.message.from} resumed from state saved ${event.resumed.savedAt}\n`);
        return undefined;
      case 'member':
        if (!team) throw new Error(`a recipe's launch streamed a team's event: ${JSON.stringify(event)}`);
        out.progress(`› member ${event.name} (recipe ${event.recipe})\n`);
        return undefined;
      case 'launched':
        // A cloud-granted agent onto a space holding files (agent-files R7): said always.
        if (event.exposesFiles === true) out.stderr(cloudWarning(event.agent.handle, event.agent.channel));
        out.stdout(`${event.agent.handle}\n`);
        if (team) return undefined;
        if (!follow) return EXIT.ok;
        this.launched = true;
        return undefined;
      case 'team_launched':
        if (!team) throw new Error(`a recipe's launch streamed a team's event: ${JSON.stringify(event)}`);
        if (!follow) return EXIT.ok;
        this.launched = true;
        return undefined;
      case 'resending':
        // The owner's answer to resume-reply-where: always, once per re-sent message, with its own time.
        out.stderr(`› resuming your message from ${event.savedAt}\n`);
        return undefined;
      case 'message':
        printConversationMessage(out, event.message);
        return undefined;
      case 'status':
      case 'settled':
        return undefined;
      case 'agent_left':
        out.progress(`› ${event.agent} left the channel: ${event.detail}\n`);
        return undefined;
      case 'model_delta':
        this.deltas.delta(event);
        return undefined;
      case 'model_done':
        this.deltas.done(event);
        return undefined;
      case 'error':
        out.stderr(errorLine(event));
        return EXIT.failed;
      default: {
        const unknown: never = event;
        throw new Error(`unknown launch event: ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** The stream ended: the exit code, after saying why when the launch had not finished. */
  ended(): number {
    this.deltas.end();
    if (this.launched) return EXIT.ok;
    this.out.stderr(LAUNCH_CLOSED);
    return EXIT.failed;
  }
}

/** A file space's usage and the cloud-granted agents its files may reach, from `space_ready`. */
export interface SpaceReady {
  readonly bytes: number;
  readonly entries: number;
  readonly cloudAgents: readonly string[];
}

/**
 * One event of `POST /v1/channel/space` (agent-files R3a): a phase as progress; `space_ready`'s usage; an error on
 * stderr ('failed'). Undefined while the space is not yet ready.
 */
export function spaceEvent(out: Out, event: SpaceEvent): SpaceReady | 'failed' | undefined {
  // One `result`, assigned per case, and the one `return` at the end — not a `return` of a different literal shape
  // (object, string, undefined) in each branch (sonarjs/function-return-type).
  let result: SpaceReady | 'failed' | undefined;
  switch (event.type) {
    case 'phase':
      out.progress(`› ${event.phase}: ${event.detail}\n`);
      break;
    case 'space_ready':
      result = { bytes: event.bytes, entries: event.entries, cloudAgents: event.cloudAgents };
      break;
    case 'error':
      out.stderr(errorLine(event));
      result = 'failed';
      break;
    default: {
      const unknown: never = event;
      throw new Error(`unknown space event: ${JSON.stringify(unknown)}`);
    }
  }
  return result;
}

/** The line a space stream that ended before `space_ready` ends with. */
export const SPACE_CLOSED = "✗ the daemon closed the file space's stream before it was ready; see its log\n";

/** R7's warning, before any file is uploaded and when a cloud-granted agent comes onto a space holding files. */
export function cloudWarning(agent: string, channel: string): string {
  return `⚠ ${agent} is cloud-granted: files on channel ${channel} may leave this machine\n`;
}

/** One returned file's metadata, as a watcher prints it (R12a: a watcher fetches nothing). */
export function fileLine(file: ReturnedFile): string {
  return `  file ${file.name} (${String(file.size)} bytes, sha256 ${file.sha256})\n`;
}

/** An uploaded file, as --verbose says it (agent-files R8). */
export function attachedLine(shown: string, file: { readonly path: string; readonly size: number }): string {
  return `attached ${shown} as ${file.path} (${String(file.size)} bytes)\n`;
}

/** The `error` and `reason` of a refusal's body, when it is JSON carrying them; else its first 200 characters. */
export function parseRefusal(text: string): { readonly error?: string; readonly reason?: string } {
  try {
    // JSON null throws here, and so reads as text, as the CLI has always read it.
    const o = JSON.parse(text) as { error?: unknown; reason?: unknown };
    return {
      ...(typeof o.error === 'string' ? { error: o.error } : {}),
      ...(typeof o.reason === 'string' ? { reason: o.reason } : {}),
    };
  } catch {
    return { error: text.slice(0, 200) };
  }
}

/**
 * An upload's refusal, as the CLI and the page print it (agent-files R3a; portal R8a):
 * `✗ upload to channel <channel>: <status> <reason>: <error>`, from the answer's status and body.
 */
export function uploadRefusalLine(channel: string, status: number, body: string): string {
  const refusal = parseRefusal(body);
  const separator = refusal.reason === undefined ? '' : ': ';
  const error = refusal.error === undefined ? '' : `${separator}${refusal.error}`;
  return `✗ upload to channel ${channel}: ${String(status)} ${refusal.reason ?? ''}${error}\n`.replace(' \n', '\n');
}

/**
 * The space bound one more file would pass (agent-files R11), by the usage `space_ready` reported and the files already
 * kept for this upload, or undefined when it fits. The upload's folder is one entry beside its files.
 */
export function spaceBoundRule(
  channel: string,
  usage: { readonly bytes: number; readonly entries: number },
  kept: { readonly count: number; readonly bytes: number },
  size: number,
): string | undefined {
  const entries = usage.entries + 1 + kept.count + 1;
  if (entries > SPACE_MAX_ENTRIES)
    return `channel ${channel}'s file space would hold more than ${SPACE_MAX_ENTRIES.toLocaleString('en-US')} entries`;
  if (usage.bytes + kept.bytes + size > SPACE_MAX_BYTES)
    return `channel ${channel}'s file space would hold more than ${SPACE_MAX_BYTES.toLocaleString('en-US')} bytes`;
  return undefined;
}

/** The reason of a stream's `error` event, or undefined for any other event: the page reports it (docs/plans/portal.md R6). */
export function errorReasonOf(event: unknown): string | undefined {
  if (typeof event !== 'object' || event === null) return undefined;
  const { type, reason } = event as { type?: unknown; reason?: unknown };
  return type === 'error' && typeof reason === 'string' ? reason : undefined;
}

/** The line a channel stream that ended or was cut ends with. */
export const WATCH_CLOSED = '✗ the daemon closed the channel stream\n';

/**
 * The `✗` line for a route that refused a request before any stream (`the daemon refused the launch: HTTP 400: …`):
 * `what` the CLI's own words for it, `body` the answer's text. The CLI and the page print the same line.
 */
export function daemonRefusedLine(what: string, status: number, body: string): string {
  return `✗ the daemon ${what}: HTTP ${String(status)}: ${body}\n`;
}

/** The `✗` line of a stop the daemon has not finished `ms` after it was asked for (`after` names how: SIGTERM, or the stop). */
export function stillRunningLine(pid: number, ms: number, after: string): string {
  return `✗ daemon pid ${String(pid)} is still running ${String(ms)} ms after ${after}\n`;
}
