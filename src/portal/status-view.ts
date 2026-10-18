// The status view (docs/plans/portal.md R8, R14): the lines `--status` prints, from `GET /v1/health`; and the stop,
// asked to be confirmed first, through `POST /v1/stop`. While the daemon stops, `/v1/health` answers 503 and the view
// says *stopping*; once a request cannot connect it says the daemon stopped serving and is finishing its stop — never
// *stopped*, since the daemon then still reclaims its containers and stops its model servers. A daemon that still
// answers SERVER_STOP_MS after the request is said as `--stop` says it.

import { stillRunningLine } from '../shared/lines.js';
import { statusLines } from '../shared/state-lines.js';
import { Routes, type HealthResponse, type StopResponse } from '../shared/protocol.js';
import { SERVER_STOP_MS } from '../shared/timing.js';
import type { DaemonClient } from './client.js';
import { byId, clear, show } from './dom.js';
import { Lines, showFailure } from './view.js';

/** How often the stop view asks the daemon's health while it stops. */
const STOP_POLL_MS = 1_000;

const STOPPED_SERVING = 'stopped serving: the daemon is finishing its stop (its agents, containers and model servers)';

export class StatusView {
  private readonly lines: Lines;
  private readonly confirm: HTMLElement;
  private readonly stopState: HTMLElement;
  private readonly stopButton: HTMLButtonElement;

  constructor(
    private readonly win: Window,
    private readonly client: DaemonClient,
  ) {
    const doc = win.document;
    this.lines = new Lines(doc, 'lines');
    byId(doc, 'status-output', HTMLElement).append(this.lines.root);
    this.confirm = byId(doc, 'stop-confirm', HTMLElement);
    this.stopState = byId(doc, 'stop-state', HTMLElement);
    this.stopButton = byId(doc, 'stop-button', HTMLButtonElement);
    byId(doc, 'status-refresh', HTMLButtonElement).addEventListener('click', () => void this.refresh());
    this.stopButton.addEventListener('click', () => {
      show(this.confirm, true);
    });
    byId(doc, 'stop-no', HTMLButtonElement).addEventListener('click', () => {
      show(this.confirm, false);
    });
    byId(doc, 'stop-yes', HTMLButtonElement).addEventListener('click', () => {
      show(this.confirm, false);
      void this.stop();
    });
  }

  /** `--status`'s lines. */
  async refresh(): Promise<void> {
    clear(this.lines.replies);
    clear(this.lines.errors);
    clear(this.lines.details);
    try {
      const answer = await this.client.json<HealthResponse>('GET', Routes.health);
      for (const line of statusLines(answer.body, Number(this.win.location.port))) this.lines.out().stdout(`${line}\n`);
    } catch (error) {
      await showFailure(this.client, error, this.lines.out().stderr);
    }
  }

  /** R14's stop, once confirmed. */
  private async stop(): Promise<void> {
    this.stopButton.disabled = true;
    const asked = this.win.performance.now();
    let pid: number;
    try {
      pid = (await this.client.json<StopResponse>('POST', Routes.stop, {}, [202])).body.pid;
    } catch (error) {
      this.stopState.textContent = '';
      const shown = await showFailure(this.client, error, this.lines.out().stderr);
      if (shown === 'stopping') this.stopState.textContent = 'stopping';
      else this.stopButton.disabled = false;
      return;
    }
    // The status lines above were the running daemon's: no longer true once it stops (never a stale view, R6).
    clear(this.lines.replies);
    this.stopState.textContent = `stopping (pid ${String(pid)})`;
    for (;;) {
      await new Promise<void>((resolve) => this.win.setTimeout(resolve, STOP_POLL_MS));
      const health = await this.client.health();
      if (health === 'unreachable') {
        this.stopState.textContent = STOPPED_SERVING;
        return;
      }
      if (this.win.performance.now() - asked >= SERVER_STOP_MS) {
        this.stopState.textContent = '';
        this.lines.out().stderr(stillRunningLine(pid, SERVER_STOP_MS, 'the stop'));
        return;
      }
      this.stopState.textContent = `stopping (pid ${String(pid)})`;
    }
  }
}
