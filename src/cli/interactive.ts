// `asha --interactive`: a session on one channel. Each line the user types
// (or pipes) is one message, posted and followed exactly as `message=<line>`
// would be; `/quit`, `/watch on` and `/watch off` are the session's commands.
// Everything the session touches comes through the command context (the
// input, the interrupt, fetch), so the loop is unit-testable.
//
// This module and commands.ts import each other: commands.ts dispatches here,
// and this module reuses its conversation and channel readers. Neither uses the
// other's bindings while it is being evaluated, only when a command runs.

import { lstat } from 'node:fs/promises';

import { present } from '../shared/assert-present.js';
import type { ConversationRequest, ReturnedFile, WatchEvent } from '../shared/protocol.js';
import {
  DeltaPrinter,
  EXIT,
  converse,
  followChannel,
  formatWatchEvent,
  type Ctx,
  type FoundDaemon,
} from './commands.js';
import { saveReturned } from './files.js';

/** What the user types or pipes. */
export interface CliInput {
  /**
   * One string per line, without its line ending. Contract: the iterator's `return()` ends a pending `next()` at
   * once (as done), so a session interrupted at the prompt leaves no read behind (readLines keeps it).
   */
  readonly lines: AsyncIterable<string>;
  /** Input is a terminal: the prompt is shown before each line is read. */
  readonly isTerminal: boolean;
}

/** The session `--interactive` starts: who speaks (typed; else the login name, applied by runCli), where, and to whom. */
export interface InteractiveSession {
  readonly user?: string;
  readonly channel: string;
  readonly recipe?: string;
  readonly to?: string;
}

/** Shown on stderr before each line is read from a terminal. */
export const PROMPT = 'asha> ';

/** A line is a command when its first word is `/` and letters only — and not an existing path (checked apart). */
const COMMAND_WORD = /^\/[A-Za-z]+$/;

/**
 * Runs a session until `/quit` or the end of input (exit 0, or 1 if any message or command failed) or Ctrl-C
 * (exit 130, abandoning a message in flight). Lines are handled one at a time, in order; lines typed while a
 * message is worked on wait in the input until it settles.
 */
export async function interactive(ctx: Ctx, session: InteractiveSession & { readonly user: string }): Promise<number> {
  return new Session(ctx, session).run();
}

type Halt = 'interrupt';

/** Resolves 'interrupt' on Ctrl-C, or rejects if `faulted` does first (a defect, never an expected failure). */
function raceHalt(ctx: Ctx, faulted: Promise<never>): Promise<Halt> {
  return Promise.race([ctx.interrupt().then((): Halt => 'interrupt'), faulted]);
}

/**
 * `halt` and `fault`, paired: `fault` rejects the same promise `halt` races against, so the channel view can end
 * the session with a defect. Its own function, never inlined into the constructor (sonarjs/no-async-constructor):
 * a constructor never holds a Promise-constructing expression, not even one it does not await.
 */
function haltAndFault(ctx: Ctx): { readonly halt: Promise<Halt>; readonly fault: (error: unknown) => void } {
  let fault: (error: unknown) => void = () => undefined;
  const faulted = new Promise<never>((_, reject) => {
    fault = reject;
  });
  return { halt: raceHalt(ctx, faulted), fault };
}

class Session {
  private failed = false;
  /** The channel view (/watch on), while it is on. */
  private watching: { readonly controller: AbortController; readonly ended: Promise<void> } | undefined;
  /** Resolves on Ctrl-C; rejects if the channel view fails with a defect (never with an expected failure). */
  private readonly halt: Promise<Halt>;
  private fault: (error: unknown) => void = () => undefined;
  /** Replies to the user the channel view printed that no conversation has claimed yet, by text. */
  private readonly viewed: string[] = [];
  /** Called whenever the view prints a reply or ends. */
  private viewChanged: () => void = () => undefined;
  /**
   * Prints the models' output with --verbose (model-streaming R7): one for the session, shared by the channel view and
   * every message, so neither prints inside the other's open delta line.
   */
  private readonly printer: DeltaPrinter;

  /** The command context, every output of it ending an open delta line first. */
  private readonly ctx: Ctx;

  constructor(
    outer: Ctx,
    private readonly session: InteractiveSession & { readonly user: string },
  ) {
    this.printer = new DeltaPrinter(outer.progress);
    const ctx = this.printer.around(outer);
    this.ctx = ctx;
    const { halt, fault } = haltAndFault(ctx);
    this.halt = halt;
    this.fault = fault;
  }

  async run(): Promise<number> {
    const lines = this.ctx.input.lines[Symbol.asyncIterator]();
    try {
      for (;;) {
        const read = await this.readOneLine(lines);
        if (read === 'interrupt') return EXIT.interrupted;
        if (read === 'failed') return EXIT.failed;
        if (read === 'done') break;
        const handled = await this.handle(read.line);
        if (handled === 'interrupt') return EXIT.interrupted;
        if (handled === 'quit') break;
      }
      return this.failed ? EXIT.failed : EXIT.ok;
    } finally {
      await this.stopWatching();
      // Nothing after /quit is read; a finished or interrupted input is closed as well.
      await lines.return?.();
    }
  }

  /** run()'s one read: a line, 'done' at the end of input, 'failed' once an input failure is printed, or Ctrl-C. */
  private async readOneLine(
    lines: AsyncIterator<string>,
  ): Promise<Halt | 'done' | 'failed' | { readonly line: string }> {
    if (this.ctx.input.isTerminal) this.ctx.stderr(PROMPT);
    // The input failing (a terminal gone, EIO) is an expected external failure: reported, not a stack.
    const reading = lines.next().then(
      (result) => result,
      (error: unknown) => ({ failed: error }),
    );
    const read = await Promise.race([reading, this.halt]);
    if (read === 'interrupt') {
      // The input's contract: return() ends the pending read at once, so nothing is left reading.
      await lines.return?.();
      await reading;
      // The terminal shows `asha> ^C`; whatever follows starts on its own line.
      if (this.ctx.input.isTerminal) this.ctx.stderr('\n');
      return 'interrupt';
    }
    if ('failed' in read) {
      this.ctx.stderr(
        `✗ reading your input failed: ${read.failed instanceof Error ? read.failed.message : String(read.failed)}\n`,
      );
      return 'failed';
    }
    if (read.done === true) return 'done';
    return { line: read.value };
  }

  private async handle(line: string): Promise<'quit' | Halt | undefined> {
    if (line.trim() === '') return undefined;
    const words = line.trim().split(/\s+/);
    const first = present(words[0], 'the first word of a non-empty trimmed line');
    if (COMMAND_WORD.test(first) && !(await pathExists(first))) return this.command(first, words.slice(1));
    return this.send(line);
  }

  private async command(word: string, args: readonly string[]): Promise<'quit' | Halt | undefined> {
    if (word === '/quit' && args.length === 0) return 'quit';
    if (word === '/watch' && args.length === 1 && args[0] === 'on') {
      this.ctx.stderr('watching the channel\n');
      if (this.watching !== undefined) return undefined;
      // Wait until the daemon watches the channel for us: a message sent before would have its reply printed
      // nowhere, since the conversation does not print replies while the view is on.
      const opened = await Promise.race([this.startWatching(), this.halt]);
      return opened === 'interrupt' ? 'interrupt' : undefined;
    }
    if (word === '/watch' && args.length === 1 && args[0] === 'off') {
      await this.stopWatching();
      this.ctx.stderr('replies only\n');
      return undefined;
    }
    // A script with a mistyped command would otherwise end with 0, having done less than it asked.
    this.failed = true;
    this.ctx.stderr(`unknown command ${word}; type /quit to leave\n`);
    return undefined;
  }

  private async send(line: string): Promise<Halt | undefined> {
    const { user, channel, recipe, to } = this.session;
    const request: ConversationRequest = {
      user,
      channel,
      ...(recipe === undefined ? {} : { recipe }),
      ...(to === undefined ? {} : { to }),
      message: line,
    };
    const controller = new AbortController();
    // With the channel view on, the view prints the replies; the conversation decides when the message settled, and
    // hands over its replies' texts, which the session waits to see printed by the view.
    const viewing = this.watching !== undefined;
    // Only this message's replies can satisfy its wait: one shown before it was sent (another conversation of the
    // same user, say from a second terminal) must not stand in for its own.
    this.viewed.length = 0;
    const replies: string[] = [];
    const ctx = {
      ...this.ctx,
      signal: controller.signal,
      ...(viewing ? { stdout: (text: string) => replies.push(text.replace(/\n$/, '')) } : {}),
    };
    // With the view on, the view prints the models' output, as it prints the replies (model-streaming R7), and a reply's
    // files are saved once the view has printed that reply (agent-files R12a). A path in the line attaches its file (R1).
    const deferred: { readonly files: readonly ReturnedFile[]; readonly daemon: FoundDaemon }[] = [];
    const sending = converse(ctx, request, {
      printer: this.printer,
      deltas: !viewing,
      attach: { kind: 'line', line },
      ...(viewing
        ? {
            onFiles: (files: readonly ReturnedFile[], daemon: FoundDaemon) => {
              deferred.push({ files, daemon });
            },
          }
        : {}),
    });
    const outcome = await Promise.race([sending, this.halt]);
    if (outcome === 'interrupt') {
      // Hang up: the agents keep working, and their reply is lost.
      controller.abort();
      await sending;
      return 'interrupt';
    }
    if (outcome !== EXIT.ok) this.failed = true;
    if (!viewing) return undefined;
    const reported = await this.reportUnshown(replies);
    if (reported === 'interrupt') return 'interrupt';
    // The session is the CLI that sent the message: it saves the reply's files, after the view printed the reply.
    await this.saveDeferredFiles(channel, deferred);
    return undefined;
  }

  /** send()'s wait with the view on: prints anything it did not show, within streamIdleMs. */
  private async reportUnshown(replies: readonly string[]): Promise<Halt | undefined> {
    // The channel is another connection: its copy of a reply can arrive after the conversation settled, so wait
    // for it — at most streamIdleMs, since a healthy view's heartbeats say nothing about whether the reply will come.
    // A reply the view did not show (it was cut, or the bound passed) is printed from the conversation: never lost.
    const waited = await Promise.race([this.printedByView(replies), this.halt]);
    if (waited === 'interrupt') return 'interrupt';
    if (waited.unshown.length === 0) return undefined;
    if (waited.timedOut) {
      this.ctx.stderr(
        `⚠ the channel view did not show this reply within ${String(this.ctx.timing.streamIdleMs)} ms; printed from the conversation:\n`,
      );
    }
    for (const text of waited.unshown) this.ctx.stdout(`${text}\n`);
    return undefined;
  }

  /** send()'s file saving, once the view (if any) has printed the reply (agent-files R12a). */
  private async saveDeferredFiles(
    channel: string,
    deferred: readonly { readonly files: readonly ReturnedFile[]; readonly daemon: FoundDaemon }[],
  ): Promise<void> {
    for (const { files, daemon } of deferred)
      for (const file of files) if (!(await saveReturned(this.ctx, daemon, channel, file))) this.failed = true;
  }

  /**
   * Waits until the view has printed each of `texts` as a reply to the user, the view is off, or streamIdleMs has
   * passed; returns the texts it did not print, and whether the bound was what ended the wait.
   */
  private async printedByView(
    texts: readonly string[],
  ): Promise<{ readonly unshown: readonly string[]; readonly timedOut: boolean }> {
    const pending = [...texts];
    let timedOut = false;
    // Read through a closure, not the `timedOut` variable directly: TypeScript's control-flow analysis cannot see
    // that the timer callback below (invoked later) is what sets it, and would otherwise narrow a direct read in
    // this loop to the value `timedOut` held at declaration, `false`.
    const isTimedOut = (): boolean => timedOut;
    const timer = setTimeout(() => {
      timedOut = true;
      this.viewChanged();
    }, this.ctx.timing.streamIdleMs);
    try {
      for (;;) {
        for (let i = pending.length - 1; i >= 0; i -= 1) {
          const at = this.viewed.indexOf(present(pending[i], 'the pending reply at this index'));
          if (at < 0) continue;
          this.viewed.splice(at, 1);
          pending.splice(i, 1);
        }
        if (pending.length === 0 || this.watching === undefined || isTimedOut())
          return { unshown: pending, timedOut: isTimedOut() && this.watching !== undefined };
        await new Promise<void>((resolve) => {
          this.viewChanged = resolve;
        });
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Turns the channel view on; resolves once the daemon watches the channel, or the stream has already ended. */
  private startWatching(): Promise<void> {
    const controller = new AbortController();
    const { user } = this.session;
    let watched!: () => void;
    const opened = new Promise<void>((resolve) => {
      watched = resolve;
    });
    // The view prints the models' output on stderr with --verbose, as --watch does (model-streaming R7).
    const { printer } = this;
    const out = printer.around(this.ctx);
    const view = (event: Exclude<WatchEvent, { type: 'error' }>): void => {
      if (event.type === 'watching') {
        watched();
        const agents = event.agents.length === 0 ? 'no agents yet' : `agents: ${event.agents.join(', ')}`;
        out.progress(`› watching channel "${event.channel}" (${agents})\n`);
        return;
      }
      if (event.type === 'model_delta') {
        printer.delta(event);
        return;
      }
      if (event.type === 'model_done') {
        printer.done(event);
        return;
      }
      const reply = event.type === 'message' && event.message.kind === 'output' && event.message.to === user;
      if (reply) out.stdout(`» reply from ${event.message.from}:\n`);
      const printed = formatWatchEvent(event);
      if (printed !== undefined) out.stdout(printed);
      if (reply) {
        this.viewed.push(event.message.text);
        this.viewChanged();
      }
    };
    const watching = {
      controller,
      ended: followChannel({ ...out, signal: controller.signal }, this.session.channel, view).then(
        (ended) => {
          printer.end();
          watched();
          if (this.watching !== watching) return;
          this.watching = undefined;
          this.viewChanged();
          // A cut stream was reported on stderr; the view is off, and the user may turn it on again.
          if (ended === 'failed') this.failed = true;
        },
        (error: unknown) => {
          watched();
          if (this.watching === watching) this.watching = undefined;
          this.viewChanged();
          this.fault(error);
        },
      ),
    };
    this.watching = watching;
    return opened;
  }

  private async stopWatching(): Promise<void> {
    const watching = this.watching;
    if (watching === undefined) return;
    this.watching = undefined;
    this.viewed.length = 0;
    this.viewChanged();
    watching.controller.abort();
    await watching.ended;
  }
}

/** Whether `path` names an existing file or directory (a dragged-in `/Users/…` is a message, not a command). */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Lines held unread before the input is paused; it resumes once the session has read them down to half. */
const HELD_LINES = 64;

/**
 * The lines of a byte stream (stdin), decoded as UTF-8 across chunk boundaries, each without its `\n` or `\r\n`;
 * a last line without a line ending is a line too. Keeps CliInput's contract: `return()` ends a pending read.
 */
export function readLines(stream: NodeJS.ReadableStream & { destroy?: () => void }): AsyncIterable<string> {
  return { [Symbol.asyncIterator]: () => new LineIterator(stream) };
}

class LineIterator implements AsyncIterator<string> {
  private readonly decoder = new TextDecoder();
  private partial = '';
  private readonly held: string[] = [];
  private ended = false;
  private failure: Error | undefined;
  private waiting: { resolve: (result: IteratorResult<string>) => void; reject: (error: Error) => void } | undefined;

  constructor(private readonly stream: NodeJS.ReadableStream & { destroy?: () => void }) {
    stream.on('data', this.onData);
    stream.on('end', this.onEnd);
    stream.on('error', this.onError);
  }

  next(): Promise<IteratorResult<string>> {
    const line = this.held.shift();
    if (line !== undefined) {
      if (this.stream.isPaused() && !this.ended && this.held.length <= HELD_LINES / 2) this.stream.resume();
      return Promise.resolve({ done: false, value: line });
    }
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  return(): Promise<IteratorResult<string>> {
    if (!this.ended) {
      this.ended = true;
      this.held.length = 0;
      this.stream.off('data', this.onData);
      this.stream.off('end', this.onEnd);
      this.stream.off('error', this.onError);
      this.stream.destroy?.();
    }
    this.wake();
    return Promise.resolve({ done: true, value: undefined });
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.partial += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let newline = this.partial.indexOf('\n');
    while (newline >= 0) {
      this.held.push(this.partial.slice(0, newline).replace(/\r$/, ''));
      this.partial = this.partial.slice(newline + 1);
      newline = this.partial.indexOf('\n');
    }
    if (this.held.length >= HELD_LINES) this.stream.pause();
    this.wake();
  };

  private readonly onEnd = (): void => {
    this.partial += this.decoder.decode();
    if (this.partial !== '') this.held.push(this.partial.replace(/\r$/, ''));
    this.partial = '';
    this.ended = true;
    this.wake();
  };

  private readonly onError = (error: Error): void => {
    this.failure = error;
    this.wake();
  };

  private wake(): void {
    const waiting = this.waiting;
    if (waiting === undefined) return;
    this.waiting = undefined;
    const line = this.held.shift();
    if (line !== undefined) waiting.resolve({ done: false, value: line });
    else if (this.failure !== undefined) waiting.reject(this.failure);
    else if (this.ended) waiting.resolve({ done: true, value: undefined });
    else this.waiting = waiting;
  }
}
