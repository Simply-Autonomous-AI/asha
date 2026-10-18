// The state view (docs/plans/portal.md R8): `--list-state`'s lines and total, from `GET /v1/state`; and
// `--reset-state`, through `POST /v1/state/reset`: a reset of everything or of a channel, and an erase of one user
// without `name=`, first list what goes and wait for the user to type `reset`, as the CLI asks without `--yes`; with
// `user=` the erase streams each identity's outcome as the CLI prints it. Every line is the CLI's own
// (src/shared/state-lines.ts).

import { present } from '../shared/assert-present.js';
import { daemonRefusedLine, errorReasonOf } from '../shared/lines.js';
import {
  ERASE_CLOSED,
  ErasePrinter,
  listLines,
  narrowed,
  nothingMatchesLine,
  refusalLine,
  removedLines,
} from '../shared/state-lines.js';
import {
  Routes,
  type StateEraseEvent,
  type StateListResponse,
  type StateRefusalReason,
  type StateResetResponse,
  type StateSelector,
} from '../shared/protocol.js';
import type { DaemonClient } from './client.js';
import { byId, clear, show } from './dom.js';
import { Lines, report, showFailure } from './view.js';

export class StateView {
  private readonly list: Lines;
  private readonly reset: Lines;
  private readonly confirm: HTMLElement;
  private readonly typed: HTMLInputElement;
  private readonly go: HTMLButtonElement;
  private pending: { readonly selector: StateSelector; readonly user: string | undefined } | undefined;

  constructor(
    private readonly doc: Document,
    private readonly client: DaemonClient,
  ) {
    this.list = new Lines(doc, 'lines');
    byId(doc, 'state-output', HTMLElement).append(this.list.root);
    this.reset = new Lines(doc, 'lines');
    byId(doc, 'reset-output', HTMLElement).append(this.reset.root);
    this.confirm = byId(doc, 'reset-confirm', HTMLElement);
    this.typed = byId(doc, 'reset-typed', HTMLInputElement);
    this.go = byId(doc, 'reset-go', HTMLButtonElement);
    byId(doc, 'state-refresh', HTMLButtonElement).addEventListener('click', () => void this.refresh());
    this.typed.addEventListener('input', () => {
      this.go.disabled = this.typed.value.trim() !== 'reset';
    });
    byId(doc, 'reset-form', HTMLFormElement).addEventListener('submit', (e) => {
      e.preventDefault();
      void this.ask();
    });
    this.go.addEventListener('click', () => {
      const pending = this.pending;
      if (pending === undefined || this.typed.value.trim() !== 'reset') return;
      void this.run(pending.selector, pending.user);
    });
  }

  /** `--list-state`. */
  async refresh(): Promise<void> {
    this.clearLines(this.list);
    try {
      const listed = await this.client.json<StateListResponse>('GET', Routes.state);
      for (const line of listLines(listed.body)) this.list.out().stdout(`${line}\n`);
    } catch (error) {
      await showFailure(this.client, error, this.list.out().stderr);
    }
  }

  private clearLines(lines: Lines): void {
    clear(lines.replies);
    clear(lines.errors);
    clear(lines.details);
  }

  /** The form's selector and user, as `--reset-state`'s arguments name them. */
  private selector(): { readonly selector: StateSelector; readonly user: string | undefined } {
    const value = (id: string): string => byId(this.doc, id, HTMLInputElement).value.trim();
    const all = byId(this.doc, 'reset-all', HTMLInputElement).checked;
    const user = value('reset-user');
    const name = value('reset-name');
    const team = value('reset-team');
    const selector: StateSelector = all
      ? { all: true }
      : { channel: value('reset-channel'), ...(name === '' ? {} : { name }), ...(team === '' ? {} : { team }) };
    return { selector, user: user === '' ? undefined : user };
  }

  /** The reset or erase asked for: what goes listed and `reset` asked for where the CLI asks, else run at once. */
  private async ask(): Promise<void> {
    this.clearLines(this.reset);
    show(this.confirm, false);
    this.pending = undefined;
    const { selector, user } = this.selector();
    const out = this.reset.out();
    const needsConfirmation = 'all' in selector || selector.name === undefined;
    if (!needsConfirmation) {
      await this.run(selector, user);
      return;
    }
    try {
      const listed = await this.client.json<StateListResponse>('GET', Routes.state);
      const matching = narrowed(listed.body, selector, user !== undefined);
      if (matching.assets.length === 0 && matching.pending.length === 0) {
        out.stderr(`${nothingMatchesLine(selector)}\n`);
        return;
      }
      for (const line of listLines(matching)) out.stdout(`${line}\n`);
      this.pending = { selector, user };
      this.typed.value = '';
      this.go.disabled = true;
      show(this.confirm, true);
      this.typed.focus();
    } catch (error) {
      await showFailure(this.client, error, out.stderr);
    }
  }

  private async run(selector: StateSelector, user: string | undefined): Promise<void> {
    show(this.confirm, false);
    this.pending = undefined;
    const out = this.reset.out();
    try {
      if (user === undefined) {
        const answer = await this.client.json<StateResetResponse | { error: string; reason: StateRefusalReason }>(
          'POST',
          Routes.stateReset,
          selector,
          [200, 400, 409],
        );
        if (answer.status === 409) {
          const refusal = answer.body as { error: string; reason: StateRefusalReason };
          out.stderr(`${refusalLine(refusal.reason, refusal.error, selector)}\n`);
          return;
        }
        if (answer.status === 400) {
          out.stderr(daemonRefusedLine('refused the reset', 400, JSON.stringify(answer.body)));
          await report(this.client, 'bad_status', `${Routes.stateReset} 400`, out.stderr);
          return;
        }
        for (const line of removedLines((answer.body as StateResetResponse).removed)) out.stdout(`${line}\n`);
        return;
      }
      const printer = new ErasePrinter(out, user);
      let code: number | undefined;
      let errorReason: string | undefined;
      const outcome = await this.client.stream(
        Routes.stateReset,
        { method: 'POST', body: { ...selector, user } },
        (raw) => {
          errorReason ??= errorReasonOf(raw);
          code = printer.handle(raw as StateEraseEvent);
          return code !== undefined;
        },
        undefined,
        [400, 409],
      );
      if (typeof outcome === 'object') {
        if (outcome.status === 409) {
          const refusal = JSON.parse(outcome.text) as { error: string; reason: StateRefusalReason };
          out.stderr(`${refusalLine(refusal.reason, refusal.error, selector)}\n`);
          return;
        }
        out.stderr(daemonRefusedLine('refused the erase', outcome.status, outcome.text));
        await report(this.client, 'bad_status', `${Routes.stateReset} ${String(outcome.status)}`, out.stderr);
        return;
      }
      if (outcome === 'ended') {
        out.stderr(ERASE_CLOSED);
        const cut = this.client.cut(Routes.stateReset);
        await report(this.client, present(cut.reason, 'cut.reason'), present(cut.detail, 'cut.detail'), out.stderr);
        return;
      }
      if (errorReason !== undefined)
        await report(this.client, 'stream_error', `${Routes.stateReset} ${errorReason}`, out.stderr);
    } catch (error) {
      await showFailure(this.client, error, out.stderr);
    }
  }
}
