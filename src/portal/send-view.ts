// The send view (docs/plans/portal.md R4, R8, R8a; docs/plans/portal-scene-chat.md R9, R10, R14): a session of
// messages on a channel, each sent through `POST /v1/conversations` with the body the CLI sends (converse.ts, the one
// implementation the watch view shares), shown as a chat — your message on the right, each reply on the left, each ✗
// and ⚠ line a note — newest at the bottom, the page following it; or, in the command-line view, its replies, ✗ and ⚠
// lines and --verbose details printed by the CLI's own code (src/shared/lines.ts). Each is marked done or failed where
// the CLI's exit code would say so. Files picked go with the next message, checked as R8a says, then sent as `file=`
// sends them. The recipe is picked from a drop-down of `GET /v1/definitions`' recipes.

import { deniedName } from '../shared/credentials.js';
import { MAX_ATTACHMENT_BYTES, MAX_FILES_PER_MESSAGE, fileNameProblem } from '../shared/files.js';
import {
  attachedLine,
  clockTime,
  cloudWarning,
  daemonRefusedLine,
  errorReasonOf,
  fileLine,
  returnedFiles,
  spaceBoundRule,
  spaceEvent,
  SPACE_CLOSED,
  waitingLine,
  type Out,
  type SpaceReady,
} from '../shared/lines.js';
import {
  Routes,
  budgetOfText,
  type ConversationBudgetRequest,
  type ConversationEvent,
  type ConversationRequest,
  type ReturnedFile,
  type SpaceEvent,
} from '../shared/protocol.js';
import { present } from '../shared/assert-present.js';
import { chosenName, fillOptions, OTHER, readCatalog } from './catalog.js';
import { FOLLOW_WITHIN_PX } from './chat-thread.js';
import { DaemonClient, sha256Hex } from './client.js';
import { converse, type MessageState } from './converse.js';
import { appendText, byId, el, show } from './dom.js';
import { Lines, persistedCheckbox, report, showFailure } from './view.js';

export class SendView {
  private readonly form: HTMLFormElement;
  private readonly log: HTMLElement;
  private readonly recipe: HTMLSelectElement;
  private readonly recipeOther: HTMLInputElement;

  constructor(
    private readonly win: Window,
    private readonly client: DaemonClient,
    defaultUser: string | undefined,
  ) {
    const doc = win.document;
    this.form = byId(doc, 'send-form', HTMLFormElement);
    this.log = byId(doc, 'send-log', HTMLElement);
    this.recipe = byId(doc, 'send-recipe', HTMLSelectElement);
    this.recipeOther = byId(doc, 'send-recipe-other', HTMLInputElement);
    if (defaultUser !== undefined) byId(doc, 'send-user', HTMLInputElement).value = defaultUser;
    const details = byId(doc, 'send-details', HTMLInputElement);
    details.addEventListener('change', () => this.log.classList.toggle('verbose', details.checked));
    // R9: the command-line view shows the CLI's lines in place of the chat; Show details applies to it alone.
    persistedCheckbox(win, byId(doc, 'send-cli', HTMLInputElement), 'asha.portal.send-cli', (cli) => {
      this.log.classList.toggle('cli', cli);
      details.disabled = !cli;
    });
    this.recipe.addEventListener('change', () => {
      show(byId(doc, 'send-recipe-other-label', HTMLElement), this.recipe.value === OTHER);
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
  }

  private get doc(): Document {
    return this.win.document;
  }

  /** R14: the recipe drop-down refilled from `GET /v1/definitions`; a failure shown as a note in the session and reported. */
  async refresh(): Promise<void> {
    try {
      const catalog = await readCatalog(this.client);
      fillOptions(this.recipe, catalog.recipes, [
        el(this.doc, 'option', { value: '' }, 'none — the agents already on the channel'),
      ]);
      show(byId(this.doc, 'send-recipe-other-label', HTMLElement), this.recipe.value === OTHER);
    } catch (error) {
      const lines = new Lines(this.doc, 'lines');
      this.follow(() => {
        this.log.append(
          el(
            this.doc,
            'article',
            { class: 'message', 'data-state': 'failed' },
            el(this.doc, 'div', { class: 'exchange' }),
            lines.root,
          ),
        );
      });
      const exchange = present(this.log.lastElementChild, 'this.log.lastElementChild').firstElementChild as HTMLElement;
      await showFailure(this.client, error, (line) => {
        lines.out().stderr(line);
        exchange.append(el(this.doc, 'div', { class: 'note failure' }, el(this.doc, 'p', {}, line.replace(/\n$/, ''))));
      });
    }
  }

  /** Makes a change to the session, then scrolls the page to its newest exchange unless the user had scrolled up (R10). */
  private follow(change: () => void): void {
    const page = this.doc.scrollingElement ?? this.doc.documentElement;
    const atEnd = page.scrollHeight - page.scrollTop - page.clientHeight <= FOLLOW_WITHIN_PX;
    change();
    if (atEnd && !this.log.closest('[hidden]')) page.scrollTop = page.scrollHeight;
  }

  /**
   * The first reason the message is refused — R27's conversation= beside a new message's own keys, R21's topic=
   * beside to=, a bad budget, no user or no text — or `undefined` to send it, in the CLI's own order and words.
   */
  private refusalLine(fields: {
    readonly answers: string;
    readonly recipe: string;
    readonly to: string;
    readonly topic: string;
    readonly filesCount: number;
    readonly posts: string;
    readonly tokens: string;
    readonly budget: ConversationBudgetRequest | string | undefined;
    readonly user: string;
    readonly text: string;
  }): string | undefined {
    const { answers, recipe, to, topic, filesCount, posts, tokens, budget, user, text } = fields;
    // R27: as the CLI refuses conversation= beside the keys a new message takes, nothing sent.
    const beside =
      answers === ''
        ? []
        : (
            [
              ['recipe', recipe],
              ['to', to],
              ['topic', topic],
              ['file', filesCount > 0 ? 'x' : ''],
              ['posts', posts],
              ['tokens', tokens],
            ] as const
          )
            .filter(([, v]) => v !== '')
            .map(([k]) => `${k}=`);
    if (beside.length > 0)
      return `✗ conversation= answers what an agent asked: it takes only channel=, user= and message=, not ${beside.join(', ')}\n`;
    // patterns-phase-3 R21: as the CLI refuses topic= beside to=, nothing sent.
    if (topic !== '' && to !== '')
      return '✗ topic= and to= cannot be given together: a message goes to a topic or to one agent\n';
    if (typeof budget === 'string') return `✗ ${budget}\n`;
    if (user === '') return '✗ type a user ID: who you are on the channel (asha --portal fills in your login name)\n';
    if (text === '') return '✗ type a message\n';
    return undefined;
  }

  private async submit(): Promise<void> {
    const value = (id: string): string => byId(this.doc, id, HTMLInputElement).value.trim();
    const text = byId(this.doc, 'send-text', HTMLTextAreaElement).value;
    const picker = byId(this.doc, 'send-files', HTMLInputElement);
    const files = [...(picker.files ?? [])];
    const channel = value('send-channel') || 'main';
    const recipe = chosenName(this.recipe, this.recipeOther);
    const to = value('send-to');
    const topic = value('send-topic');
    const answers = value('send-conversation');
    const user = value('send-user');
    // The budget fields are posts= and tokens= (patterns-phase-3 R15): the same rule, the same refusal, nothing sent.
    const posts = value('send-posts');
    const tokens = value('send-tokens');
    const budget = budgetOfText({ ...(posts === '' ? {} : { posts }), ...(tokens === '' ? {} : { tokens }) });
    // An answer to an ask (patterns-phase-3 R27) is the CLI's conversation= body: channel, user, conversation and message.
    const request: ConversationRequest =
      answers !== ''
        ? { user, channel, conversation: answers, message: text }
        : {
            user,
            channel,
            ...(recipe === '' ? {} : { recipe }),
            ...(to === '' ? {} : { to }),
            ...(topic === '' ? {} : { topic }),
            message: text,
            ...(budget === undefined || typeof budget === 'string' ? {} : { budget }),
          };
    const block = this.block(request, user, files.length);
    const refusal = this.refusalLine({
      answers,
      recipe,
      to,
      topic,
      filesCount: files.length,
      posts,
      tokens,
      budget,
      user,
      text,
    });
    if (refusal !== undefined) {
      block.lines.fail(refusal);
      block.state('failed');
      return;
    }
    // The next message picks its own files, and is a new message unless an Answer button says otherwise.
    picker.value = '';
    byId(this.doc, 'send-text', HTMLTextAreaElement).value = '';
    byId(this.doc, 'send-conversation', HTMLInputElement).value = '';
    block.state(await this.converse(request, files, block));
  }

  /** The chat's view of the CLI's lines (R10): each ✗ and ⚠ line a note in the exchange, beside the command-line view's lines. */
  private chatOut(lines: Lines, exchange: HTMLElement): Out {
    const out = lines.out();
    return {
      stdout: out.stdout,
      progress: out.progress,
      stderr: (text) => {
        out.stderr(text);
        for (const line of text.split('\n')) {
          if (line.startsWith('✗') || line.startsWith('⚠'))
            this.follow(() => {
              exchange.append(
                el(
                  this.doc,
                  'div',
                  { class: `note ${line.startsWith('✗') ? 'failure' : 'warning'}` },
                  el(this.doc, 'p', {}, line),
                ),
              );
            });
        }
      },
    };
  }

  /** The "who" header's recipe note: ` (recipe <name>)`, or nothing when the message brings none online. */
  private recipeSuffix(request: ConversationRequest): string {
    return request.recipe === undefined ? '' : ` (recipe ${request.recipe})`;
  }

  /** The "who" header's file count: `, <n> file(s)`, or nothing when none are attached. */
  private filesSuffix(files: number): string {
    if (files === 0) return '';
    return `, ${String(files)} file${files === 1 ? '' : 's'}`;
  }

  /** The request's destination, in the CLI's own words: its conversation, its topic, its agent, or just its channel. */
  private whereOf(request: ConversationRequest): string {
    if (request.conversation !== undefined) return `conversation ${request.conversation} on ${request.channel}`;
    if (request.to !== undefined) return `${request.to} on ${request.channel}`;
    if (request.topic !== undefined) return `topic ${request.topic} on ${request.channel}`;
    return request.channel;
  }

  /** A message's block in the session: what was sent, its chat, its lines, its returned files and its state. */
  private block(
    request: ConversationRequest,
    user: string,
    files: number,
  ): {
    readonly lines: Lines;
    readonly exchange: HTMLElement;
    readonly files: HTMLElement;
    state(state: MessageState): void;
  } {
    const doc = this.doc;
    const state = el(doc, 'span', { class: 'state' }, 'sending');
    const where = this.whereOf(request);
    const lines = new Lines(doc, 'lines');
    const returned = el(doc, 'div', { class: 'returned' });
    // The chat (R10): your message on the right; replies and notes follow it.
    const exchange = el(
      doc,
      'div',
      { class: 'exchange' },
      el(
        doc,
        'article',
        { class: 'chat-msg from-user' },
        el(doc, 'header', {}, el(doc, 'span', { class: 'who' }, `${user} → ${where}`)),
        el(doc, 'p', { class: 'text' }, request.message),
      ),
    );
    const article = el(
      doc,
      'article',
      { class: 'message', 'data-state': 'sending' },
      el(
        doc,
        'header',
        {},
        state,
        el(doc, 'span', { class: 'who' }, `${user} → ${where}${this.recipeSuffix(request)}${this.filesSuffix(files)}`),
      ),
      el(doc, 'p', { class: 'text' }, request.message),
      exchange,
      lines.root,
      returned,
    );
    this.follow(() => {
      this.log.append(article);
    });
    return {
      lines,
      exchange,
      files: returned,
      state: (next) => {
        article.setAttribute('data-state', next);
        state.textContent = next;
      },
    };
  }

  /** The message, its files first, through the shared conversation function (R15): the state its block ends in. */
  private async converse(
    request: ConversationRequest,
    files: readonly File[],
    block: { readonly lines: Lines; readonly exchange: HTMLElement; readonly files: HTMLElement },
  ): Promise<MessageState> {
    const conversed = await converse({
      client: this.client,
      request,
      out: this.chatOut(block.lines, block.exchange),
      ...(files.length === 0 ? {} : { attach: (out: Out) => this.attach(out, request, files) }),
      onEvent: (event, out) => {
        for (const file of returnedFiles(event)) this.returned(out, request.channel, file, block.files);
        this.reply(event, block.exchange);
        // An ask (R27): the tracker printed its waiting line; the block offers the answer, as that line's command.
        if (event.type === 'message' && event.message.kind === 'output' && event.message.asks === true)
          this.offerAnswer(block.files, event.message.channel, event.message.user, event.message.conversation);
      },
    });
    return conversed.state;
  }

  /**
   * R10: a reply as a bubble on the left, naming the agent (or asha) and its time; an ask with its waiting line. Every
   * output of a conversation goes to the user who began it (the channel's rule), so each is this exchange's reply.
   */
  private reply(streamed: ConversationEvent, exchange: HTMLElement): void {
    if (streamed.type !== 'message' || streamed.message.kind !== 'output') return;
    const message = streamed.message;
    const doc = this.doc;
    this.follow(() => {
      exchange.append(
        el(
          doc,
          'article',
          { class: 'chat-msg from-agent kind-output', 'data-from': message.from },
          el(
            doc,
            'header',
            {},
            el(doc, 'span', { class: 'who' }, `${message.from} → ${String(message.to)}`),
            el(doc, 'time', { datetime: message.at }, clockTime(message.at)),
          ),
          el(doc, 'p', { class: 'text' }, message.text),
          ...(message.asks === true
            ? [el(doc, 'p', { class: 'waiting' }, waitingLine(message).replace(/\n$/, ''))]
            : []),
        ),
      );
    });
  }

  /**
   * The Answer button an ask's block carries (patterns-phase-3 R27): it fills the form with the waiting line's command —
   * its channel, its user and the conversation — leaving the message to type, so Send sends the CLI's answer body.
   */
  private offerAnswer(into: HTMLElement, channel: string, user: string, conversation: string): void {
    const button = el(
      this.doc,
      'button',
      { type: 'button', class: 'answer', 'data-conversation': conversation },
      'Answer',
    );
    button.addEventListener('click', () => {
      byId(this.doc, 'send-channel', HTMLInputElement).value = channel;
      byId(this.doc, 'send-user', HTMLInputElement).value = user;
      byId(this.doc, 'send-conversation', HTMLInputElement).value = conversation;
      byId(this.doc, 'send-text', HTMLTextAreaElement).focus();
    });
    into.append(button);
  }

  /** The first rule one of `files[i]` breaks, in the CLI's own order: its name, the deny list, its size, the count (R8a). */
  private fileNameRule(file: File, i: number): string | undefined {
    const denied = deniedName(file.name);
    return (
      fileNameProblem(file.name, { returned: false }) ??
      (denied === undefined ? undefined : `on the credential deny list (${denied})`) ??
      (file.size > MAX_ATTACHMENT_BYTES ? `over ${MAX_ATTACHMENT_BYTES.toLocaleString('en-US')} bytes` : undefined) ??
      (i >= MAX_FILES_PER_MESSAGE ? `more than ${String(MAX_FILES_PER_MESSAGE)} files` : undefined)
    );
  }

  /** Streams the channel's file space ready for `request` (R8a): its cloud warnings said here once it is, or the
   * refusal shown and 'failed' — a bad status, the stream cut, or it ending with no space ready. */
  private async openSpace(out: Out, request: ConversationRequest): Promise<SpaceReady | 'failed'> {
    let ready: SpaceReady | undefined;
    let errorReason: string | undefined;
    const outcome = await this.client.stream(
      Routes.channelSpace,
      {
        method: 'POST',
        body: { channel: request.channel, ...(request.recipe === undefined ? {} : { recipe: request.recipe }) },
      },
      (raw) => {
        errorReason ??= errorReasonOf(raw);
        const answer = spaceEvent(out, raw as SpaceEvent);
        if (answer === 'failed') return true;
        if (answer !== undefined) ready = answer;
        return answer !== undefined;
      },
      undefined,
      [400],
    );
    if (typeof outcome === 'object') {
      out.stderr(
        daemonRefusedLine(`refused the file space of channel ${request.channel}`, outcome.status, outcome.text),
      );
      await report(this.client, 'bad_status', `${Routes.channelSpace} ${String(outcome.status)}`, out.stderr);
      return 'failed';
    }
    if (outcome === 'ended') {
      out.stderr(SPACE_CLOSED);
      const cut = this.client.cut(Routes.channelSpace);
      await report(this.client, present(cut.reason, 'cut.reason'), present(cut.detail, 'cut.detail'), out.stderr);
      return 'failed';
    }
    if (ready === undefined) {
      if (errorReason !== undefined)
        await report(this.client, 'stream_error', `${Routes.channelSpace} ${errorReason}`, out.stderr);
      return 'failed';
    }
    return ready;
  }

  /**
   * R8a: every picked file checked in order — the name rules, the deny list's file-name entries, the size, the count —
   * then the space made ready, its cloud warnings said, its bounds checked; each file's sha256; one upload. The upload's
   * id, or 'failed' once a refusal is shown. The page never checks a file's bytes for secrets: the daemon does (R8b).
   */
  private async attach(out: Out, request: ConversationRequest, files: readonly File[]): Promise<string> {
    for (const [i, file] of files.entries()) {
      const rule = this.fileNameRule(file, i);
      if (rule !== undefined) {
        out.stderr(`✗ ${file.name}: ${rule}\n`);
        return 'failed';
      }
    }
    const space = await this.openSpace(out, request);
    if (space === 'failed') return 'failed';
    for (const agent of space.cloudAgents) out.stderr(cloudWarning(agent, request.channel));
    // Strict, as file= is: every file before this one is kept, or the message was refused at it.
    let keptBytes = 0;
    for (const [i, file] of files.entries()) {
      const rule = spaceBoundRule(request.channel, space, { count: i, bytes: keptBytes }, file.size);
      if (rule !== undefined) {
        out.stderr(`✗ ${file.name}: ${rule}\n`);
        return 'failed';
      }
      keptBytes += file.size;
    }
    // One file's bytes held at a time while its sha256 is taken.
    const manifest: { name: string; size: number; sha256: string }[] = [];
    for (const file of files) manifest.push({ name: file.name, size: file.size, sha256: await sha256Hex(file) });
    const answer = await this.client.upload(
      request.channel,
      present(request.user, 'request.user'),
      `${JSON.stringify(manifest)}\n`,
      files,
    );
    if (!answer.ok) {
      out.stderr(answer.line);
      return 'failed';
    }
    answer.answer.files.forEach((f, i) => {
      out.progress(attachedLine(present(files[i], 'files[i]').name, f));
    });
    return answer.answer.upload;
  }

  /** A returned file: its line as the CLI prints it, and a button that downloads it through the browser (R8). */
  private returned(out: Out, channel: string, file: ReturnedFile, into: HTMLElement): void {
    const doc = this.doc;
    const status = el(doc, 'span', { class: 'muted' });
    const button = el(doc, 'button', { type: 'button', class: 'download' }, `Download ${file.name}`);
    button.addEventListener('click', () => {
      void (async () => {
        button.disabled = true;
        status.textContent = ' downloading…';
        try {
          const got = await this.client.download(file);
          if (!got.ok) {
            status.textContent = '';
            out.stderr(`✗ file ${file.name}: ${got.rule}\n`);
            if (got.report !== undefined) await report(this.client, got.report.reason, got.report.detail, out.stderr);
            return;
          }
          const url = URL.createObjectURL(got.blob);
          const a = el(doc, 'a', { href: url, download: file.name });
          doc.body.append(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          status.textContent = ` saved through the browser (${String(file.size)} bytes, sha256 checked)`;
        } catch (error) {
          status.textContent = '';
          await showFailure(this.client, error, out.stderr);
        } finally {
          button.disabled = false;
        }
      })();
    });
    const line = el(doc, 'p', { class: 'file-line', 'data-channel': channel });
    appendText(line, fileLine(file).replace(/\n$/, ''));
    line.append(' ', button, status);
    into.append(line);
  }
}
