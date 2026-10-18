// The watch view's chat thread (docs/plans/portal-scene-chat.md R8): the channel as a messaging app shows it — each
// message a bubble or a note by its row of the plan's rendering table (a user's on the right, an agent's on the left,
// its greeting as it comes online too — and the harness's statuses for an agent, red when it is down (demo-scene-refresh
// R7, R14, R16) — a call's question and answer labelled, a gather, an agent's status in a
// conversation and the harness's words as notes), an agent joining or leaving a note, and `<handle> is writing…`
// while its lamp is amber. A WatchObserver, fed by observeWatchEvent as the scene is. Every text reaches the page as
// text (portal R13).

import { clockTime, fileLine, type WatchObserver } from '../shared/lines.js';
import {
  HARNESS_HANDLE,
  type CallMark,
  type CallRefusalReason,
  type ChannelMessage,
  type ConversationMessage,
} from '../shared/protocol.js';
import { el } from './dom.js';
import { outcomeWords } from './scene-sim.js';

/** How far the user may scroll up from the newest entry before the thread stops following it, in CSS px (R8). */
export const FOLLOW_WITHIN_PX = 40;

/** What an agent's `consult refused: <reason>` status means, in words (R8; the owner's question of 2026-10-07). */
const CONSULT_REFUSED: Partial<Readonly<Record<CallRefusalReason, string>>> = {
  not_holding_delivery: 'it was not handling a message when it asked',
  nested_call: 'a call here may not open another call',
  unknown_handle: 'it asked an agent that is not on the channel',
  self_addressed: 'it asked itself',
  duplicate_addressee: 'it asked the same agent twice',
  too_many_addressees: 'it asked more than ten agents at once',
  empty_text: 'one of its questions had no text',
  call_open: 'it already has a call open in this conversation',
  post_budget:
    'this conversation has used up its posts budget (32 agent posts unless the message set Posts budget; each agent asked takes 2)',
  pending_full: "an agent's record of unsaved messages is full",
  conversation_ended: 'the harness has already ended this conversation',
  ask_open: 'a question to the user is already waiting',
};

/** The words for a `consult refused: <reason>` status, or undefined for any other status (or a reason with no words). */
export function consultRefusedWords(from: string, text: string): string | undefined {
  const reason = /^consult refused: (\S+)$/.exec(text)?.[1];
  if (reason === undefined) return undefined;
  // The table's own keys only: an agent's `constructor` or `toString` names no reason (the code review's round 2).
  const words = Object.hasOwn(CONSULT_REFUSED, reason) ? CONSULT_REFUSED[reason as CallRefusalReason] : undefined;
  return words === undefined ? undefined : `${from} could not ask: ${words} (consult refused: ${reason})`;
}

/** A call bubble's label for its role: 'asks' for a question, 'answers' for an answer, none for a gather or no call. */
function callLabel(role: CallMark['role'] | undefined): string | undefined {
  if (role === 'question') return 'asks';
  if (role === 'answer') return 'answers';
  return undefined;
}

/**
 * The Watch view's chat (docs/portal/index.md#chat): each event of the watch stream as a bubble or a note, in order,
 * with who is writing; the scene beside it is scene-sim.ts's.
 */
export class ChatThread implements WatchObserver {
  private readonly writingLines: HTMLElement;

  constructor(
    private readonly doc: Document,
    /** The scrolling element the thread fills. */
    readonly root: HTMLElement,
  ) {
    // Not announced: it changes with every lamp, and the thread's live region would repeat it (R8).
    this.writingLines = el(doc, 'div', { class: 'writing-lines', 'aria-live': 'off' });
    root.append(this.writingLines);
  }

  /** Empties the thread for a new watch. */
  clear(): void {
    this.root.replaceChildren(this.writingLines);
    this.writingLines.replaceChildren();
  }

  watching(): void {}

  joined(agent: string): void {
    this.note(`${agent} joined`);
  }

  left(agent: string): void {
    this.note(`${agent} left`);
  }

  delta(): void {}

  done(): void {}

  error(): void {}

  message(message: ChannelMessage): void {
    const fromHarness = message.from === HARNESS_HANDLE;
    if (message.kind === 'status') {
      this.statusMessage(message, fromHarness);
      return;
    }
    if (fromHarness) {
      this.harnessMessage(message);
      return;
    }
    const classes = [
      'chat-msg',
      message.kind === 'input' ? 'from-user' : 'from-agent',
      ...(message.kind === 'input' ? [] : [`kind-${message.kind}`]),
    ];
    const role = message.call?.role;
    if (role === 'question') classes.push('call-question');
    if (role === 'answer') classes.push('call-answer');
    this.bubble(message, classes);
  }

  /** Rows M1–M3: an agent's or the harness's status (a presence, or a status within a conversation, M2). */
  private statusMessage(message: ChannelMessage, fromHarness: boolean): void {
    const refused = fromHarness ? undefined : consultRefusedWords(message.from, message.text);
    if (refused !== undefined) {
      this.note(refused, [], 'warning');
      return;
    }
    // Row M1: an agent's status outside any conversation — its `Hi` as it comes online — is a bubble, as its messages
    // are (the owner, 2026-10-08); a status in a conversation (M2) and the harness's (M3) stay notes.
    if (!fromHarness && message.conversation === null) {
      // A status the harness marks `failure` — the agent down: its failure status (R7), the supervisor's restart lines
      // while it is (R16) — is the same bubble, marked (demo-scene-refresh).
      const offline = message.failure === true ? ['agent-offline'] : [];
      this.bubble(message, ['chat-msg', 'from-agent', 'kind-status', ...offline]);
      return;
    }
    this.note(`${message.from}: ${message.text}`);
  }

  /** Rows M8, M9 and M11: the harness's own words, a gather's collected answers among them. */
  private harnessMessage(message: ConversationMessage): void {
    const call = message.call;
    if (message.kind === 'internal' && call?.role === 'gather') {
      // Row M8: collected <a>/<n> answers, then each addressee's outcome.
      this.note(
        `collected ${String(call.answers.length)}/${String(call.requests.length)} answers`,
        call.answers.map((a) => `${a.from}: ${outcomeWords(a)}`),
        'gather',
      );
      return;
    }
    // Rows M9 and M11.
    this.note(
      message.kind === 'internal' && message.to !== null
        ? `asha → ${message.to}: ${message.text}`
        : `asha: ${message.text}`,
    );
  }

  /** A message's bubble: its sender, its addressee, a call's label, its time, its text and its files' lines (R8). */
  private bubble(message: ChannelMessage, classes: readonly string[]): void {
    // A presence status (M1) carries no call, topic or files.
    const said = message.conversation === null ? undefined : message;
    const label = callLabel(said?.call?.role);
    const to = said?.topic !== undefined ? `topic ${said.topic}` : (message.to ?? 'everyone');
    const header = el(
      this.doc,
      'header',
      {},
      el(this.doc, 'span', { class: 'who' }, `${message.from} → ${to}`),
      ...(label === undefined ? [] : [el(this.doc, 'span', { class: 'chat-label' }, label)]),
      el(this.doc, 'time', { datetime: message.at }, clockTime(message.at)),
    );
    const files = (said?.files ?? []).map((f) =>
      el(this.doc, 'p', { class: 'file-line' }, fileLine(f).replace(/\n$/, '')),
    );
    this.append(
      el(
        this.doc,
        'article',
        { class: classes.join(' '), 'data-from': message.from },
        header,
        el(this.doc, 'p', { class: 'text' }, message.text),
        ...files,
      ),
    );
  }

  /** A centred note (R8, R15, R17) — a failure, a warning or a gather when `kind` says so — with its lines under it when given. */
  note(text: string, lines: readonly string[] = [], kind?: 'failure' | 'warning' | 'gather'): void {
    this.append(
      el(
        this.doc,
        'div',
        { class: kind === undefined ? 'note' : `note ${kind}` },
        el(this.doc, 'p', {}, text),
        ...lines.map((line) => el(this.doc, 'p', { class: 'note-line' }, line)),
      ),
    );
  }

  /** The agents whose lamp is amber now, one `is writing…` line each, always last in the thread (R8). */
  setWriting(handles: readonly string[]): void {
    const shown = [...this.writingLines.children].map((c) => c.getAttribute('data-handle'));
    if (shown.join(' ') === handles.join(' ')) return;
    this.follow(() => {
      this.writingLines.replaceChildren(
        ...handles.map((h) => el(this.doc, 'p', { class: 'writing', 'data-handle': h }, `${h} is writing…`)),
      );
    });
  }

  private append(node: HTMLElement): void {
    this.follow(() => this.root.insertBefore(node, this.writingLines));
  }

  /** Makes a change, then scrolls to the newest entry unless the user had scrolled up more than FOLLOW_WITHIN_PX. */
  private follow(change: () => void): void {
    const root = this.root;
    const atEnd = root.scrollHeight - root.scrollTop - root.clientHeight <= FOLLOW_WITHIN_PX;
    change();
    if (atEnd) root.scrollTop = root.scrollHeight;
  }
}
