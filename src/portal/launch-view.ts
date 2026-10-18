// The launch view (docs/plans/portal.md R8; docs/plans/portal-scene-chat.md R14): `--launch recipe=` or `team=` with
// `channel=`, through `POST /v1/agents`, each new handle printed one a line as the CLI prints them, by the CLI's own
// printer. Like a CLI of the daemon's own build, it follows the conversations a persisted launch re-sends
// (agent-persistence R9 (i)). The name is picked from a drop-down of every recipe or team `GET /v1/definitions` lists,
// read each time the view is opened, with the chosen entry's details and a list of everything that can be launched.

import { DeltaPrinter, EXIT, LaunchPrinter, daemonRefusedLine, errorReasonOf, type Out } from '../shared/lines.js';
import {
  Routes,
  type CatalogRecipe,
  type CatalogTeam,
  type DefinitionProblem,
  type DefinitionsResponse,
  type LaunchEvent,
} from '../shared/protocol.js';
import { present } from '../shared/assert-present.js';
import { OTHER, chosenName, fillOptions, isProblem, readCatalog } from './catalog.js';
import type { DaemonClient } from './client.js';
import { byId, el, show } from './dom.js';
import { Lines, report, showFailure } from './view.js';

/** How a launch ended: the state its block shows. */
export type LaunchState = 'done' | 'failed' | 'stopping';

/**
 * Launches a recipe's agent or a team's members on a channel, printing what `--launch` prints into `out`: the one
 * launch the launch view and Run demo share (portal-scene-chat R17).
 */
export async function launchAgents(
  client: DaemonClient,
  kind: 'recipe' | 'team',
  name: string,
  channel: string,
  given: Out,
): Promise<LaunchState> {
  const deltas = new DeltaPrinter(given.progress);
  const out = deltas.around(given);
  if (name === '') {
    out.stderr(`✗ --launch takes recipe=<recipe> or team=<team>, and optionally channel=<name>\n`);
    return 'failed';
  }
  const printer = new LaunchPrinter(out, deltas, { team: kind === 'team', follow: true });
  let code: number | undefined;
  let errorReason: string | undefined;
  try {
    const outcome = await client.stream(
      Routes.agents,
      { method: 'POST', body: { [kind]: name, channel, followResent: true } },
      (raw) => {
        errorReason ??= errorReasonOf(raw);
        code = printer.handle(raw as LaunchEvent);
        return code !== undefined;
      },
      undefined,
      [400],
    );
    if (typeof outcome === 'object') {
      out.stderr(daemonRefusedLine('refused the launch', outcome.status, outcome.text));
      await report(client, 'bad_status', `${Routes.agents} ${String(outcome.status)}`, out.stderr);
      return 'failed';
    }
    if (outcome === 'ended') {
      code = printer.ended();
      if (code !== EXIT.ok) {
        const cut = client.cut(Routes.agents);
        await report(client, present(cut.reason, 'cut.reason'), present(cut.detail, 'cut.detail'), out.stderr);
      }
    }
    deltas.end();
    if (errorReason !== undefined) await report(client, 'stream_error', `${Routes.agents} ${errorReason}`, out.stderr);
    return code === EXIT.ok ? 'done' : 'failed';
  } catch (error) {
    deltas.end();
    return showFailure(client, error, out.stderr);
  }
}

export class LaunchView {
  private readonly log: HTMLElement;
  private readonly kind: HTMLSelectElement;
  private readonly name: HTMLSelectElement;
  private readonly other: HTMLInputElement;
  private readonly detail: HTMLElement;
  private readonly list: HTMLElement;
  private readonly form: HTMLFormElement;
  private readonly button: HTMLButtonElement;
  private catalog: DefinitionsResponse | undefined;

  constructor(
    private readonly doc: Document,
    private readonly client: DaemonClient,
  ) {
    this.log = byId(doc, 'launch-log', HTMLElement);
    this.kind = byId(doc, 'launch-kind', HTMLSelectElement);
    this.name = byId(doc, 'launch-name', HTMLSelectElement);
    this.other = byId(doc, 'launch-other', HTMLInputElement);
    this.detail = byId(doc, 'launch-detail', HTMLElement);
    this.list = byId(doc, 'launch-list', HTMLElement);
    this.form = byId(doc, 'launch-form', HTMLFormElement);
    this.button = byId(doc, 'launch-button', HTMLButtonElement);
    const details = byId(doc, 'launch-details', HTMLInputElement);
    details.addEventListener('change', () => this.log.classList.toggle('verbose', details.checked));
    this.kind.addEventListener('change', () => {
      this.fill();
    });
    this.name.addEventListener('change', () => {
      this.describe();
    });
    // A double click's second click never launches: a Choose double-clicked scrolls the form up, which can put Launch
    // under the pointer for the second click, and Choose launches nothing (R14). A keyboard's submit clicks with detail 0.
    this.button.addEventListener('click', (e) => {
      if (e.detail > 1) e.preventDefault();
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      const kind = this.kind.value === 'team' ? 'team' : 'recipe';
      const channel = byId(doc, 'launch-channel', HTMLInputElement).value.trim() || 'main';
      void this.launch(kind, chosenName(this.name, this.other), channel);
    });
  }

  /** R14: the catalogue read again, the drop-down and the list refilled; a failure shown here and reported. */
  async refresh(): Promise<void> {
    const lines = new Lines(this.doc, 'lines');
    try {
      this.catalog = await readCatalog(this.client);
    } catch (error) {
      this.list.replaceChildren(lines.root);
      await showFailure(this.client, error, lines.out().stderr);
      return;
    }
    this.fill();
    this.showList();
  }

  private entries(kind: 'recipe' | 'team'): readonly (CatalogRecipe | CatalogTeam | DefinitionProblem)[] {
    if (this.catalog === undefined) return [];
    return kind === 'team' ? this.catalog.teams : this.catalog.recipes;
  }

  private fill(): void {
    fillOptions(this.name, this.entries(this.kind.value === 'team' ? 'team' : 'recipe'));
    this.describe();
  }

  /** The chosen entry's details under the form (R14); the `other…` text box shown only for `other…`. */
  private describe(): void {
    show(byId(this.doc, 'launch-other-label', HTMLElement), this.name.value === OTHER);
    const entry = [...this.entries('recipe'), ...this.entries('team')].find((e) => e.id === this.name.value);
    this.detail.textContent = entry === undefined || isProblem(entry) ? '' : this.details(entry);
  }

  private details(entry: CatalogRecipe | CatalogTeam): string {
    if (!('members' in entry)) return `Model ${entry.model}. ${entry.description}`;
    const members = entry.members.map((m) => `${m.name} (${m.recipe})`).join(', ');
    return `${entry.description} Members: ${members}.`;
  }

  /**
   * Every recipe and team with its details; a launchable one's Choose selects it in the form, launching nothing (R14),
   * and brings the form into view with the Name drop-down focused: the list is below the form, so a choice made from it
   * would otherwise change nothing the user can see (the owner, 2026-10-09: "the Launch tab buttons to Choose don't
   * seem to actually work at all"). Name, not Launch, takes the focus: a held Return on Choose then launches nothing,
   * and a screen reader reads out what was chosen.
   */
  private showList(): void {
    const doc = this.doc;
    const card = (kind: 'recipe' | 'team', entry: CatalogRecipe | CatalogTeam | DefinitionProblem): HTMLElement => {
      if (isProblem(entry))
        return el(
          doc,
          'article',
          { 'data-kind': kind, 'data-id': entry.id },
          el(doc, 'h4', {}, `${kind} ${entry.id}`),
          el(doc, 'p', { class: 'problem' }, `cannot launch: ${entry.problem}`),
        );
      const choose = el(doc, 'button', { type: 'button', class: 'choose' }, 'Choose');
      choose.addEventListener('click', () => {
        this.kind.value = kind;
        this.fill();
        this.name.value = entry.id;
        this.describe();
        this.form.scrollIntoView({ block: 'nearest' });
        this.name.focus({ preventScroll: true });
      });
      return el(
        doc,
        'article',
        { 'data-kind': kind, 'data-id': entry.id },
        el(doc, 'h4', {}, `${kind} ${entry.id}`),
        el(doc, 'p', {}, this.details(entry)),
        choose,
      );
    };
    this.list.replaceChildren(
      ...this.entries('team').map((e) => card('team', e)),
      ...this.entries('recipe').map((e) => card('recipe', e)),
    );
  }

  private async launch(kind: 'recipe' | 'team', name: string, channel: string): Promise<void> {
    const lines = new Lines(this.doc, 'lines');
    const head = this.doc.createElement('h3');
    head.textContent = `--launch ${kind}=${name} channel=${channel}`;
    const block = this.doc.createElement('article');
    block.className = 'message';
    block.setAttribute('data-state', 'sending');
    block.append(head, lines.root);
    this.log.prepend(block);
    block.setAttribute('data-state', await launchAgents(this.client, kind, name, channel, lines.out()));
  }
}
