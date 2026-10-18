// The portal's page (docs/plans/portal.md): `asha --portal` opens it with the credential in the URL fragment, which
// it reads once and removes (R13), then wires every view. Each view does what one CLI command does, through the same
// route, printing the CLI's own lines (R8). A failure anywhere — the page's own code throwing included — is shown and
// reported (R6); the page never shows a blank or stale state.

import { Routes, type HealthResponse } from '../shared/protocol.js';
import { DaemonClient, LEAVING_HOLD_MS, PageLeaving } from './client.js';
import { byId, show } from './dom.js';
import { LaunchView } from './launch-view.js';
import { SendView } from './send-view.js';
import { takeSession } from './session.js';
import { StateView } from './state-view.js';
import { StatusView } from './status-view.js';
import { showFailure } from './view.js';
import { WatchView } from './watch-view.js';

const VIEWS = ['send', 'watch', 'launch', 'status', 'state', 'help'] as const;
type ViewName = (typeof VIEWS)[number];

/** Shows one view and marks its tab. */
function select(doc: Document, view: ViewName): void {
  for (const name of VIEWS) {
    show(byId(doc, `view-${name}`, HTMLElement), name === view);
    byId(doc, `tab-${name}`, HTMLButtonElement).setAttribute('aria-selected', String(name === view));
  }
}

async function main(win: Window): Promise<void> {
  const doc = win.document;
  const banner = byId(doc, 'page-error', HTMLElement);
  const daemonLine = byId(doc, 'daemon-line', HTMLElement);
  const session = takeSession(win);
  for (const name of VIEWS)
    byId(doc, `tab-${name}`, HTMLButtonElement).addEventListener('click', () => {
      select(doc, name);
    });
  if (session === undefined) {
    daemonLine.textContent = 'This page holds no credential.';
    banner.textContent =
      '✗ this page has no credential for the daemon: run asha --portal, which opens a page that has one';
    show(banner, true);
    byId(doc, 'views', HTMLElement).classList.add('locked');
    return;
  }
  // A page leaving ends its requests; a report waits to see whether the page stays (R6, PageLeaving).
  const client = new DaemonClient({
    credential: session.credential,
    leaving: new PageLeaving({ win, holdMs: LEAVING_HOLD_MS }),
  });
  const fail = (error: unknown): void => {
    show(banner, true);
    void showFailure(client, error, (line) => {
      banner.textContent = `${banner.textContent}${line}`;
    });
  };
  // The page's own code throwing, anywhere: shown, and reported by the error's name alone (R6).
  win.addEventListener('error', (event) => {
    fail(event.error ?? new Error(event.message));
  });
  win.addEventListener('unhandledrejection', (event) => {
    fail(event.reason);
  });
  const send = new SendView(win, client, session.user);
  const watch = new WatchView(win, client, session.user);
  const launch = new LaunchView(doc, client);
  const status = new StatusView(win, client);
  const state = new StateView(doc, client);
  // Each view that lists recipes, teams or demos reads them again when it is shown (portal-scene-chat R14, R17).
  byId(doc, 'tab-send', HTMLButtonElement).addEventListener('click', () => void send.refresh());
  byId(doc, 'tab-watch', HTMLButtonElement).addEventListener('click', () => void watch.refreshDemos());
  byId(doc, 'tab-launch', HTMLButtonElement).addEventListener('click', () => void launch.refresh());
  byId(doc, 'tab-status', HTMLButtonElement).addEventListener('click', () => void status.refresh());
  byId(doc, 'tab-state', HTMLButtonElement).addEventListener('click', () => void state.refresh());
  select(doc, 'send');
  void send.refresh();
  try {
    const health = await client.json<HealthResponse>('GET', Routes.health);
    daemonLine.textContent = `daemon pid ${String(health.body.pid)}, version ${health.body.version}, started ${health.body.startedAt}`;
  } catch (error) {
    daemonLine.textContent = 'The daemon did not answer.';
    fail(error);
  }
}

main(window).catch((error: unknown) => {
  // The page could not even be wired: said on the page itself, since no view exists to say it in.
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const line = document.createElement('p');
  line.className = 'banner';
  line.textContent = `✗ the portal page failed to start: ${detail}`;
  document.body.prepend(line);
});
