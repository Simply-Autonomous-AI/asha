// The watch view (docs/plans/portal.md R5, R9, R10; docs/plans/portal-scene-chat.md R5a, R7–R9, R15, R17): every event
// of `GET /v1/channel` for a named channel, as a chat thread (or, in the command-line view, each line as `--watch`
// prints it, and in the details area as `--watch --verbose` prints it); the channel drawn as a scene of robots beside
// it, one height with it; the teams and recipes on the channel above both; each online agent's telemetry, asked for
// every 1,000 ms while the watch is open; a message box under the thread; Run demo, which runs a pattern demo's
// page on a fresh channel while it is watched; and Stop demo, which stops that demo's agents once it has run, then
// the model servers no agent still needs (docs/plans/portal-demo-stop.md R5, R6).

import {
  ChannelStopPrinter,
  DeltaPrinter,
  EXIT,
  WATCH_CLOSED,
  WatchPrinter,
  errorReasonOf,
  noAgentOnChannelLine,
  observeWatchEvent,
  type Out,
} from '../shared/lines.js';
import {
  NAME_PATTERN,
  Routes,
  type ChannelStopEvent,
  type ConversationRequest,
  type Demo,
  type DemoProblem,
  type DemoScenario,
  type DemosResponse,
  type TelemetryResponse,
  type WatchEvent,
} from '../shared/protocol.js';
import { present } from '../shared/assert-present.js';
import { byCodeUnit } from '../shared/order.js';
import { ChatThread } from './chat-thread.js';
import type { DaemonClient } from './client.js';
import { converse } from './converse.js';
import { appendText, byId, clear, el, show } from './dom.js';
import { launchAgents } from './launch-view.js';
import { SceneRenderer } from './scene-draw.js';
import { SceneSim } from './scene-sim.js';
import { Lines, persistedCheckbox, report, showFailure } from './view.js';

/** The select option for one listed demo (R16, R17): disabled with its reason when it cannot be chosen. */
function demoOption(doc: Document, d: Demo | DemoProblem): HTMLOptionElement {
  if ('problem' in d)
    return el(doc, 'option', { value: d.pattern, disabled: '' }, `${d.pattern} — cannot run: ${d.problem}`);
  if (d.runnable) return el(doc, 'option', { value: d.pattern }, `${d.pattern} · ${d.title}`);
  return el(doc, 'option', { value: d.pattern, disabled: '' }, `${d.pattern} · ${d.title} — ${d.reason}`);
}

/** How often the open watch asks for telemetry (R10). */
const TELEMETRY_EVERY_MS = 1_000;

/** Where a step names its previous step's conversation (portal-scene-chat R16, R17). */
const PREVIOUS = '@previous';

/** The line the message box and Run demo show when the page holds no user ID (R15, R17). */
const NO_USER = 'This page has no user ID: type one in the send view (asha --portal user=<id> opens a page with one).';

export class WatchView {
  private watching: AbortController | undefined;
  private readonly lines: Lines;
  private readonly thread: ChatThread;
  private readonly state: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly table: HTMLTableSectionElement;
  private readonly teams: HTMLElement;
  private readonly reduced: MediaQueryList;
  private readonly composeForm: HTMLFormElement;
  private readonly composeTo: HTMLSelectElement;
  private readonly composeText: HTMLTextAreaElement;
  private readonly demoSelect: HTMLSelectElement;
  private readonly demoRun: HTMLButtonElement;
  private readonly demoStop: HTMLButtonElement;
  /** The channel the last Run demo launched its team on, until Stop demo has stopped it (portal-demo-stop R5). */
  private demoChannel: string | undefined;
  /** The channel the open watch, or the one being opened, is on. */
  private watchedChannel: string | undefined;
  private demoStopping = false;
  private sim: SceneSim | undefined;
  private renderer: SceneRenderer | undefined;
  private frame: number | undefined;
  private last: number | undefined;
  private channel = '';
  private telemetryAnswer: TelemetryResponse | undefined;
  private demoRunning = false;
  /** The open watch's run, settled when it ends. */
  private watchRun: Promise<void> | undefined;
  /** Settles true once the open watch's stream said `watching`, false if the watch ended first. */
  private watchOpened: Promise<boolean> = Promise.resolve(false);

  constructor(
    private readonly win: Window,
    private readonly client: DaemonClient,
    private readonly user: string | undefined,
  ) {
    const doc = win.document;
    this.state = byId(doc, 'watch-state', HTMLElement);
    this.button = byId(doc, 'watch-button', HTMLButtonElement);
    this.canvas = byId(doc, 'scene', HTMLCanvasElement);
    this.table = byId(doc, 'telemetry-rows', HTMLTableSectionElement);
    this.teams = byId(doc, 'watch-teams', HTMLElement);
    this.thread = new ChatThread(doc, byId(doc, 'watch-thread', HTMLElement));
    this.lines = new Lines(doc, 'lines watch-lines');
    const output = byId(doc, 'watch-output', HTMLElement);
    output.append(this.lines.root);
    this.reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    const details = byId(doc, 'watch-details', HTMLInputElement);
    details.addEventListener('change', () => this.lines.root.classList.toggle('verbose', details.checked));
    // R9: the command-line view replaces the thread; Show details applies to it alone (R8).
    persistedCheckbox(win, byId(doc, 'watch-cli', HTMLInputElement), 'asha.portal.watch-cli', (cli) => {
      show(output, cli);
      show(this.thread.root, !cli);
      details.disabled = !cli;
    });
    byId(doc, 'watch-form', HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      if (this.watching !== undefined) this.stop();
      else this.begin(byId(doc, 'watch-channel', HTMLInputElement).value.trim() || 'main');
    });
    this.composeForm = byId(doc, 'compose-form', HTMLFormElement);
    this.composeTo = byId(doc, 'compose-to', HTMLSelectElement);
    this.composeText = byId(doc, 'compose-text', HTMLTextAreaElement);
    byId(doc, 'compose-as', HTMLElement).textContent = user === undefined ? NO_USER : `as ${user}`;
    this.composeForm.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.post();
    });
    // R15: Return sends, unless an input method is composing; Shift+Return is a new line.
    this.composeText.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      void this.post();
    });
    this.demoSelect = byId(doc, 'demo-select', HTMLSelectElement);
    this.demoRun = byId(doc, 'demo-run', HTMLButtonElement);
    this.demoStop = byId(doc, 'demo-stop', HTMLButtonElement);
    this.demoStop.addEventListener('click', () => void this.stopDemo());
    this.demoSelect.addEventListener('change', () => {
      this.enableDemo();
    });
    byId(doc, 'demo-form', HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      void this.runDemo(this.demoSelect.value);
    });
    win.addEventListener('resize', () => {
      if (this.sim === undefined || this.renderer === undefined) return;
      const size = this.renderer.size(win.devicePixelRatio);
      this.sim.layout(size.width, size.height);
      if (this.frame === undefined) this.renderer.draw(false);
    });
    this.reduced.addEventListener('change', () => {
      this.animate();
    });
  }

  /** Whether a watch is open. */
  open(): boolean {
    return this.watching !== undefined;
  }

  /** R17: the demos read again, each time the view is shown. */
  async refreshDemos(): Promise<void> {
    try {
      this.fillDemos(await this.readDemos());
    } catch (error) {
      this.demoSelect.replaceChildren(el(this.win.document, 'option', { value: '' }, 'the demos could not be read'));
      this.enableDemo();
      await showFailure(this.client, error, (line) => {
        this.thread.note(line.replace(/\n$/, ''), [], 'failure');
      });
    }
  }

  private async readDemos(): Promise<DemosResponse> {
    return (await this.client.json<DemosResponse>('GET', Routes.demos)).body;
  }

  private fillDemos(answer: DemosResponse): void {
    const doc = this.win.document;
    const kept = this.demoSelect.value;
    const options = answer.demos.map((d) => demoOption(doc, d));
    const head = answer.shipped
      ? el(doc, 'option', { value: '' }, 'choose a pattern demo')
      : el(doc, 'option', { value: '' }, 'the pattern demos come with a checkout of asha (docs/patterns/)');
    this.demoSelect.replaceChildren(head, ...options);
    if ([...this.demoSelect.options].some((o) => o.value === kept && !o.disabled)) this.demoSelect.value = kept;
    this.enableDemo();
  }

  private enableDemo(): void {
    this.demoRun.disabled =
      this.demoRunning || this.demoStopping || this.user === undefined || this.demoSelect.value === '';
    this.demoRun.title = this.user === undefined ? NO_USER : '';
    // R5: shown once a demo has run, while its channel is the one watched and has an agent online; hidden while a demo runs.
    show(
      this.demoStop,
      !this.demoRunning &&
        this.demoChannel !== undefined &&
        this.watchedChannel === this.demoChannel &&
        (this.sim?.online().length ?? 0) > 0,
    );
    this.demoStop.disabled = this.demoStopping;
  }

  private stop(): void {
    // The box posts to the watched channel: gone at once, never left posting to a watch that is ending (R15).
    show(this.composeForm, false);
    this.watching?.abort();
  }

  /** Opens a watch of `channel`, its run kept so a demo can wait for it to open or end. */
  private begin(channel: string): void {
    this.watchedChannel = channel;
    this.enableDemo();
    // Assigned synchronously below, inside the Promise's executor, which runs before `new Promise` returns.
    let opened!: (value: boolean) => void;
    this.watchOpened = new Promise<boolean>((resolve) => {
      opened = resolve;
    });
    this.watchRun = this.start(channel, opened).finally(() => {
      opened(false);
    });
  }

  private async start(channel: string, opened: (value: boolean) => void): Promise<void> {
    const out = this.lines.out();
    if (!NAME_PATTERN.test(channel)) {
      out.stderr(`✗ ${JSON.stringify(channel)} is not a channel name (${String(NAME_PATTERN)})\n`);
      this.thread.note(`✗ ${JSON.stringify(channel)} is not a channel name (${String(NAME_PATTERN)})`, [], 'failure');
      return;
    }
    const controller = new AbortController();
    this.watching = controller;
    this.channel = channel;
    byId(this.win.document, 'watch-channel', HTMLInputElement).value = channel;
    this.button.textContent = 'Stop watching';
    this.state.textContent = `Watching channel ${channel}.`;
    clear(this.lines.replies);
    clear(this.lines.errors);
    clear(this.lines.details);
    clear(this.table);
    clear(this.teams);
    this.thread.clear();
    this.telemetryAnswer = undefined;
    show(this.composeForm, true);
    // A new scene for each watch: what it draws comes only from this watch's events. The previous scene's frame loop
    // ends here: left pending, its frame kept animate() from starting the new scene's, which was then never drawn.
    if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
    this.frame = undefined;
    this.renderer = undefined;
    // A canvas of the scene's own to measure text with, for each robot's personal space (portal-scene-chat R5c): the
    // scene's canvas changes its font while it draws.
    const ruler = this.win.document.createElement('canvas').getContext('2d');
    if (ruler === null) throw new Error("the browser gave no 2D context to measure the scene's text with");
    const measure = (text: string, font: string): number => {
      ruler.font = font;
      return ruler.measureText(text).width;
    };
    const sim = new SceneSim({ width: 1, height: 1, rng: Math.random, now: () => this.win.performance.now(), measure });
    this.sim = sim;
    this.fillTo();
    const renderer = new SceneRenderer(this.canvas, sim, this.win);
    this.renderer = renderer;
    const size = renderer.size(this.win.devicePixelRatio);
    sim.layout(size.width, size.height);
    this.animate();
    const deltas = new DeltaPrinter(out.progress);
    const printed = deltas.around(out);
    const printer = new WatchPrinter(printed, deltas, '; Stop watching to end it');
    let errorReason: string | undefined;
    const telemetry = this.pollTelemetry(channel, controller.signal, sim);
    try {
      const outcome = await this.client.stream(
        `${Routes.channel}?name=${encodeURIComponent(channel)}`,
        { method: 'GET' },
        (raw) => {
          const event = raw as WatchEvent;
          errorReason = errorReasonOf(event);
          this.canvas.setAttribute('data-event-at', String(this.win.performance.now()));
          // A still scene (reduced motion) shows only the latest event's speech and arcs, with every work bubble and card.
          if (this.frame === undefined) sim.settle();
          observeWatchEvent(event, sim);
          observeWatchEvent(event, this.thread);
          this.thread.setWriting(sim.writing());
          if (event.type === 'watching') opened(true);
          if (event.type === 'watching' || event.type === 'agent_joined' || event.type === 'agent_left') {
            this.fillTo();
            this.enableDemo();
          }
          if (this.frame === undefined) renderer.draw(false);
          return printer.handle(event) === 'failed';
        },
        controller.signal,
      );
      deltas.end();
      if (outcome === 'done' && errorReason !== undefined) {
        await report(this.client, 'stream_error', `${Routes.channel} ${errorReason}`, out.stderr);
      } else if (outcome === 'ended') {
        out.stderr(WATCH_CLOSED);
        this.thread.note(WATCH_CLOSED.replace(/\n$/, ''), [], 'failure');
        const cut = this.client.cut(Routes.channel);
        await report(this.client, present(cut.reason, 'cut.reason'), present(cut.detail, 'cut.detail'), out.stderr);
      }
      this.state.textContent =
        outcome === 'aborted'
          ? `Stopped watching channel ${channel}.`
          : `The watch of channel ${channel} ended; see the chat or its command-line view.`;
    } catch (error) {
      deltas.end();
      const shown = await showFailure(this.client, error, (line) => {
        out.stderr(line);
        this.thread.note(line.replace(/\n$/, ''), [], 'failure');
      });
      this.state.textContent =
        shown === 'stopping'
          ? 'The daemon is stopping.'
          : `The watch of channel ${channel} failed; see the chat or its command-line view.`;
    } finally {
      controller.abort();
      await telemetry;
      if (this.watching === controller) {
        this.watching = undefined;
        show(this.composeForm, false);
      }
      this.button.textContent = 'Watch';
    }
  }

  /** R15's To choice: everyone, then each agent online in the watch's join order. */
  private fillTo(): void {
    const doc = this.win.document;
    const kept = this.composeTo.value;
    const agents = this.sim?.online() ?? [];
    this.composeTo.replaceChildren(
      el(doc, 'option', { value: '' }, 'everyone'),
      ...agents.map((a) => el(doc, 'option', { value: a }, a)),
    );
    if (agents.includes(kept)) this.composeTo.value = kept;
  }

  /** The thread's notes for a conversation's ✗ and ⚠ lines (R15, R17); its other lines are not shown there. */
  private notes(): Out {
    const note = (text: string): void => {
      for (const line of text.split('\n'))
        if (line.startsWith('✗') || line.startsWith('⚠'))
          this.thread.note(line, [], line.startsWith('✗') ? 'failure' : 'warning');
    };
    return { stdout: () => undefined, stderr: note, progress: () => undefined };
  }

  /** R15: the message box's text posted to the watched channel, as the session's user. */
  private async post(): Promise<void> {
    const text = this.composeText.value;
    if (this.watching === undefined || text.trim() === '') return;
    if (this.user === undefined) {
      this.thread.note(NO_USER, [], 'failure');
      return;
    }
    const to = this.composeTo.value;
    const request: ConversationRequest = {
      user: this.user,
      channel: this.channel,
      ...(to === '' ? {} : { to }),
      message: text,
    };
    this.composeText.value = '';
    const conversed = await converse({ client: this.client, request, out: this.notes() });
    // Its conversation settled: whatever work in it is still drawn ends (R4).
    if (conversed.conversation !== undefined) this.sim?.concluded(conversed.conversation);
  }

  /**
   * One scenario's steps, sent in order as `user`, `@previous` replaced by the previous step's conversation; its
   * notes in the thread. Returns `'stopping'` once the daemon is stopping (its caller ends the demo on that alone),
   * else `'done'`.
   */
  private async runScenario(
    user: string,
    pattern: string,
    scenario: DemoScenario,
    bound: string,
  ): Promise<'stopping' | 'done'> {
    this.thread.note(scenario.id);
    const began = this.win.performance.now();
    let previous: string | undefined;
    const codes: string[] = [];
    let unsettled: string | undefined;
    for (const step of scenario.steps) {
      if (step.conversation === PREVIOUS && previous === undefined) {
        unsettled = 'its previous step began no conversation to answer';
        break;
      }
      const request: ConversationRequest = {
        ...step,
        user,
        ...(step.conversation === PREVIOUS ? { conversation: present(previous, 'previous') } : {}),
      };
      const conversed = await converse({ client: this.client, request, out: this.notes() });
      if (conversed.conversation !== undefined) this.sim?.concluded(conversed.conversation);
      previous = conversed.conversation;
      if (conversed.state === 'stopping') {
        this.thread.note(`✗ demo ${pattern}: the daemon is stopping`, [], 'failure');
        return 'stopping';
      }
      if (conversed.code === undefined) {
        unsettled = 'a step did not settle (its line above says why)';
        break;
      }
      codes.push(String(conversed.code));
    }
    const seconds = ((this.win.performance.now() - began) / 1_000).toFixed(1);
    const outcome = unsettled === undefined ? `exit ${codes.join(', ')}` : `stopped: ${unsettled}`;
    this.thread.note(
      `${scenario.id}: ${outcome} in ${seconds} s (bound ${bound} s)`,
      [],
      unsettled === undefined ? undefined : 'failure',
    );
    return 'done';
  }

  /**
   * R17: the chosen demo, read again for a fresh channel; that channel watched; the team launched there; each scenario's
   * steps sent in order as the session's user, `@previous` replaced by the previous step's conversation; its notes in
   * the thread; stopped at the first failure.
   */
  private async runDemo(pattern: string): Promise<void> {
    if (this.demoRunning || this.user === undefined || pattern === '') return;
    const user = this.user;
    this.demoRunning = true;
    this.enableDemo();
    try {
      const answer = await this.readDemos();
      this.fillDemos(answer);
      const demo = answer.demos.find((d): d is Demo => d.pattern === pattern && !('problem' in d));
      if (demo === undefined || !demo.runnable) {
        const reasonSuffix = demo === undefined ? '' : `: ${demo.reason}`;
        this.thread.note(`✗ ${pattern} cannot run from this page${reasonSuffix}`, [], 'failure');
        return;
      }
      if (this.watching !== undefined) {
        this.stop();
        await this.watchRun;
      }
      this.begin(demo.channel);
      // The watch is open before the launch, so the robots are seen joining; a watch that failed to open says why.
      if (!(await this.watchOpened)) return;
      this.thread.note(`demo ${demo.pattern} on channel ${demo.channel}`);
      const launched = await launchAgents(this.client, 'team', demo.team, demo.channel, this.notes());
      if (launched !== 'done') {
        this.thread.note(`✗ demo ${demo.pattern}: the launch of team ${demo.team} failed`, [], 'failure');
        return;
      }
      // From here the team is on the channel, whatever its scenarios do: Stop demo ends it (R5).
      this.demoChannel = demo.channel;
      const bound = (demo.boundMs / 1_000).toFixed(0);
      // Every scenario runs, as the agent suite runs each: a scenario's outcome is its steps' exit codes as the CLI
      // gives them (several demos pass with an exit 1); only a launch failing, the page failing or the daemon stopping
      // ends the demo.
      for (const scenario of demo.scenarios) {
        const result = await this.runScenario(user, demo.pattern, scenario, bound);
        if (result === 'stopping') return;
      }
      this.thread.note(`its agents stay online on channel ${demo.channel}; Stop demo ends them`);
    } catch (error) {
      await showFailure(this.client, error, (line) => {
        this.thread.note(line.replace(/\n$/, ''), [], 'failure');
      });
    } finally {
      this.demoRunning = false;
      this.enableDemo();
    }
  }

  /**
   * Stop demo (docs/plans/portal-demo-stop.md R5, R6): `POST /v1/channel/stop` for the last demo's channel, its lines
   * — what `asha --stop channel=` prints, by the same printer — in the thread and the command-line view; the watch
   * stays open, so the agents leave the scene as they stop. A failure is a failure note, reported to the daemon.
   */
  private async stopDemo(): Promise<void> {
    const channel = this.demoChannel;
    if (channel === undefined || this.demoStopping || this.demoRunning) return;
    this.demoStopping = true;
    this.enableDemo();
    const lines = this.lines.out();
    const noted = (text: string, kind?: 'failure'): void => {
      for (const line of text.split('\n')) if (line !== '') this.thread.note(line, [], kind);
    };
    const out: Out = {
      stdout: (text) => {
        lines.stdout(text);
        noted(text);
      },
      stderr: (text) => {
        lines.stderr(text);
        noted(text, 'failure');
      },
      progress: (text) => {
        lines.progress(text);
      },
    };
    const printer = new ChannelStopPrinter(out, channel);
    let code: number | undefined;
    let errorReason: string | undefined;
    try {
      const outcome = await this.client.stream(
        Routes.channelStop,
        { method: 'POST', body: { channel, source: 'portal' } },
        (raw) => {
          errorReason ??= errorReasonOf(raw);
          code = printer.handle(raw as ChannelStopEvent);
          return code !== undefined;
        },
        undefined,
        [404],
      );
      if (typeof outcome === 'object') {
        // Nothing left on the channel to stop (R1's 404): said, as the CLI says it, but as a plain note: nothing failed.
        lines.stderr(noAgentOnChannelLine(channel));
        noted(noAgentOnChannelLine(channel));
        code = EXIT.ok;
      } else if (outcome === 'ended') {
        code = printer.ended();
        const cut = this.client.cut(Routes.channelStop);
        await report(this.client, present(cut.reason, 'cut.reason'), present(cut.detail, 'cut.detail'), out.stderr);
      }
      if (errorReason !== undefined)
        await report(this.client, 'stream_error', `${Routes.channelStop} ${errorReason}`, out.stderr);
    } catch (error) {
      await showFailure(this.client, error, out.stderr);
    } finally {
      if (code === EXIT.ok) this.demoChannel = undefined;
      this.demoStopping = false;
      this.enableDemo();
    }
  }

  /** Starts or stops the scene's animation: a still frame with reduced motion, else one frame per display refresh. */
  private animate(): void {
    const renderer = this.renderer;
    const sim = this.sim;
    if (renderer === undefined || sim === undefined) return;
    if (this.reduced.matches) {
      if (this.frame !== undefined) this.win.cancelAnimationFrame(this.frame);
      this.frame = undefined;
      renderer.draw(false);
      return;
    }
    if (this.frame !== undefined) return;
    this.last = undefined;
    const tick = (now: number): void => {
      const dt = this.last === undefined ? 0 : Math.min(50, now - this.last);
      this.last = now;
      sim.step(dt);
      renderer.draw(true);
      this.frame = this.win.requestAnimationFrame(tick);
    };
    this.frame = this.win.requestAnimationFrame(tick);
  }

  /** R10: the channel's telemetry every TELEMETRY_EVERY_MS while the watch is open; a failure is shown and ends the polling. */
  private async pollTelemetry(channel: string, signal: AbortSignal, sim: SceneSim): Promise<void> {
    const out = this.lines.out();
    // Read through a call, never `signal.aborted` directly: a `readonly` property reads as statically unchanging
    // across an `await` to the type checker, though the signal can abort while one is in flight (the real case here).
    const aborted = (): boolean => signal.aborted;
    while (!aborted()) {
      try {
        const answer = await this.client.json<TelemetryResponse>(
          'GET',
          `${Routes.telemetry}?channel=${encodeURIComponent(channel)}`,
        );
        if (aborted()) return;
        // A still scene is redrawn for a telemetry answer only when it changed a lamp (R9).
        if (sim.telemetry(answer.body)) {
          this.thread.setWriting(sim.writing());
          if (this.frame === undefined) this.renderer?.draw(false);
        }
        this.telemetryAnswer = answer.body;
        this.showTelemetry(answer.body);
        this.showTeams();
      } catch (error) {
        if (aborted()) return;
        await showFailure(this.client, error, (line) => {
          out.stderr(line);
          this.thread.note(line.replace(/\n$/, ''), [], 'failure');
        });
        appendText(this.lines.errors, '✗ telemetry is no longer updated for this watch\n');
        this.thread.note('✗ telemetry is no longer updated for this watch', [], 'failure');
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = this.win.setTimeout(resolve, TELEMETRY_EVERY_MS);
        signal.addEventListener(
          'abort',
          () => {
            this.win.clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  /**
   * R7: one line per team with an agent online, then one per agent launched alone, from the latest telemetry answer —
   * in the watch's join order, an agent the answer names before its join event placed after the others by handle.
   */
  private showTeams(): void {
    const answer = this.telemetryAnswer;
    if (answer === undefined) return;
    const order = this.sim?.online() ?? [];
    const rank = (handle: string): number => {
      const at = order.indexOf(handle);
      return at < 0 ? order.length : at;
    };
    const agents = [...answer.agents].sort((a, b) => rank(a.handle) - rank(b.handle) || byCodeUnit(a.handle, b.handle));
    const groups: { key: string; kind: 'team' | 'recipe'; id: string; handles: string[] }[] = [];
    for (const agent of agents) {
      const key = agent.team === null ? `recipe:${agent.handle}` : `team:${agent.team}`;
      const group = groups.find((g) => g.key === key);
      if (group !== undefined) group.handles.push(agent.handle);
      else
        groups.push({
          key,
          kind: agent.team === null ? 'recipe' : 'team',
          id: agent.team ?? agent.recipe,
          handles: [agent.handle],
        });
    }
    const doc = this.win.document;
    this.teams.replaceChildren(
      ...groups.map((g) =>
        el(
          doc,
          'p',
          { 'data-kind': g.kind, 'data-id': g.id },
          el(doc, 'span', { class: 'kind' }, `${g.kind} `),
          `${g.id}: ${g.handles.join(', ')}`,
        ),
      ),
    );
  }

  private showTelemetry(answer: TelemetryResponse): void {
    const doc = this.win.document;
    const rows = answer.agents.map((a) =>
      el(
        doc,
        'tr',
        { 'data-handle': a.handle },
        el(doc, 'td', { class: 'mono', 'data-label': 'Agent' }, a.handle),
        el(doc, 'td', { 'data-label': 'Recipe' }, a.recipe),
        el(doc, 'td', { 'data-label': 'Team' }, a.team ?? '—'),
        el(doc, 'td', { class: 'mono', 'data-label': 'Model' }, a.model),
        el(doc, 'td', { class: 'num', 'data-label': 'Deliveries' }, String(a.deliveries)),
        el(doc, 'td', { class: 'num', 'data-label': 'Model calls' }, String(a.modelCalls)),
        el(
          doc,
          'td',
          { class: 'num', 'data-label': 'Last call' },
          a.lastModelCallMs === null ? '—' : `${String(a.lastModelCallMs)} ms`,
        ),
        el(doc, 'td', { class: 'num', 'data-label': 'In flight' }, String(a.modelCallsInFlight)),
        el(
          doc,
          'td',
          { 'data-label': 'Last error' },
          a.lastError === null ? '—' : `${a.lastError.span} ${a.lastError.reason} at ${a.lastError.at.slice(11, 19)}Z`,
        ),
      ),
    );
    if (rows.length === 0)
      rows.push(
        el(
          doc,
          'tr',
          {},
          el(doc, 'td', { colspan: '9', class: 'muted' }, `No agent is online on channel ${answer.channel}.`),
        ),
      );
    this.table.replaceChildren(...rows);
  }
}
