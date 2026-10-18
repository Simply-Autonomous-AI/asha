// What can be launched, from `GET /v1/definitions` (docs/plans/portal-scene-chat.md R13, R14): read each time a view
// that offers it is shown, and laid into a drop-down — each entry `<id> — <description>`, one that does not parse
// disabled with its problem, and `other…` last for any name, as the command line takes any name.

import {
  Routes,
  type CatalogRecipe,
  type CatalogTeam,
  type DefinitionProblem,
  type DefinitionsResponse,
} from '../shared/protocol.js';
import type { DaemonClient } from './client.js';
import { el } from './dom.js';

/** The value of a drop-down's `other…` option (no recipe or team name can hold `…`): the name is then the text box's beside it. */
export const OTHER = '…other';

/** The catalogue, read now (bounded and failing as every JSON request does, portal R18). */
export async function readCatalog(client: DaemonClient): Promise<DefinitionsResponse> {
  return (await client.json<DefinitionsResponse>('GET', Routes.definitions)).body;
}

/** An entry that does not parse. */
export function isProblem(entry: CatalogRecipe | CatalogTeam | DefinitionProblem): entry is DefinitionProblem {
  return 'problem' in entry;
}

/** One option per entry, an entry with a problem disabled, then `other…`; `first` options before them. Keeps the choice when it is still listed. */
export function fillOptions(
  select: HTMLSelectElement,
  entries: readonly (CatalogRecipe | CatalogTeam | DefinitionProblem)[],
  first: readonly HTMLOptionElement[] = [],
): void {
  const doc = select.ownerDocument;
  const kept = select.value;
  const options = entries.map((entry) =>
    isProblem(entry)
      ? el(doc, 'option', { value: entry.id, disabled: '' }, `${entry.id} — cannot launch: ${entry.problem}`)
      : el(doc, 'option', { value: entry.id }, `${entry.id} — ${entry.description}`),
  );
  select.replaceChildren(...first, ...options, el(doc, 'option', { value: OTHER }, 'other…'));
  if ([...select.options].some((o) => o.value === kept && !o.disabled)) select.value = kept;
}

/** The name a drop-down with an `other…` text box stands for. */
export function chosenName(select: HTMLSelectElement, other: HTMLInputElement): string {
  return select.value === OTHER ? other.value.trim() : select.value;
}
