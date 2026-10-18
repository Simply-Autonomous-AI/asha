// What every view shares: a block of lines laid out as the CLI prints them, and how a failure is shown in the view
// where it happened and reported (docs/plans/portal.md R6). A view never shows a blank or stale state on a failure.

import type { Out } from '../shared/lines.js';
import { present } from '../shared/assert-present.js';
import { DaemonClient, PortalFailure, UNREACHABLE_LINE, detailOf, nameOf, type FailureReason } from './client.js';
import { appendText, el } from './dom.js';

/**
 * One command's output, as the CLI prints it: `replies` is its stdout, `errors` its stderr without --verbose (the ✗
 * and ⚠ lines), and `details` its stderr with --verbose (progress, the models' output, and the ✗ and ⚠ lines in
 * order), shown when the user asks.
 */
export class Lines {
  readonly root: HTMLElement;
  readonly replies: HTMLPreElement;
  readonly errors: HTMLPreElement;
  readonly details: HTMLPreElement;

  constructor(doc: Document, className: string) {
    this.replies = el(doc, 'pre', { class: 'replies' });
    this.errors = el(doc, 'pre', { class: 'errors' });
    this.details = el(doc, 'pre', { class: 'details' });
    this.root = el(doc, 'div', { class: className }, this.replies, this.errors, this.details);
  }

  /** Where the shared printers write. */
  out(): Out {
    return {
      stdout: (text) => {
        appendText(this.replies, text);
      },
      stderr: (text) => {
        appendText(this.errors, text);
        appendText(this.details, text);
      },
      progress: (text) => {
        appendText(this.details, text);
      },
    };
  }

  /** A failure's line: on stderr, as the CLI says its own. */
  fail(line: string): void {
    this.out().stderr(line);
  }
}

/**
 * Shows a failure where it happened and reports it as R6 says: a 401 ("run asha --portal") and a stopping daemon are
 * shown and never reported; any other PortalFailure is shown and reported once; anything else the page's code threw is
 * an `exception`, shown with its message here and reported by its name alone. Returns 'stopping' for a stopping daemon,
 * else 'failed'.
 */
export async function showFailure(
  client: DaemonClient,
  error: unknown,
  write: (line: string) => void,
): Promise<'failed' | 'stopping'> {
  if (error instanceof PortalFailure) {
    write(error.line);
    if (error.kind === 'unauthorized') return 'failed';
    if (error.kind === 'stopping') return 'stopping';
    await report(client, present(error.reason, 'error.reason'), present(error.detail, 'error.detail'), write);
    return 'failed';
  }
  const name = nameOf(error);
  write(`✗ exception: ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
  await report(client, 'exception', detailOf({ errorName: name }), write);
  return 'failed';
}

/** Reports a failure already shown (R6): once, never retried; a report that fails is shown, and not reported. */
export async function report(
  client: DaemonClient,
  reason: FailureReason,
  detail: string,
  write: (line: string) => void,
): Promise<void> {
  const outcome = await client.report(reason, detail);
  if (outcome === 'reported') return;
  write(outcome === 'unreachable' ? UNREACHABLE_LINE : outcome.line);
}

/**
 * A checkbox whose state lasts for the tab (portal-scene-chat R9): restored from sessionStorage, written there on each
 * change, never to the browser's lasting storage; `apply` runs with the state now and on each change.
 */
export function persistedCheckbox(
  win: Window,
  box: HTMLInputElement,
  key: string,
  apply: (checked: boolean) => void,
): void {
  box.checked = win.sessionStorage.getItem(key) === '1';
  apply(box.checked);
  box.addEventListener('change', () => {
    // The view follows the box first: a storage that refuses the write (full, or turned off) fails after it, shown.
    apply(box.checked);
    win.sessionStorage.setItem(key, box.checked ? '1' : '0');
  });
}
