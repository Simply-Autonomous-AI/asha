// The page's credential and user ID (docs/plans/portal.md R1, R13): read once from the URL fragment `asha --portal`
// opens (`#c=<credential>&u=<user ID>`), the fragment then removed from the address, and kept only in memory and in
// the tab's sessionStorage — never in the browser's lasting storage, a cookie, a URL, a log or an error report. A reload of the tab
// keeps them; closing it drops them; a daemon restart makes the credential dead (run `asha --portal` again).

import { userIdProblem } from '../shared/protocol.js';

export interface Session {
  /** The control credential: 64 lowercase hex characters. */
  readonly credential: string;
  /** The user ID `asha --portal` chose, pre-filled in the send view; undefined when it gave none that is valid. */
  readonly user: string | undefined;
}

const KEY_CREDENTIAL = 'asha.credential';
const KEY_USER = 'asha.user';
const CREDENTIAL = /^[0-9a-f]{64}$/;

/** The session from the fragment (then removed from the address) or from this tab's storage; undefined when neither holds one. */
export function takeSession(win: Window): Session | undefined {
  const hash = win.location.hash;
  if (hash.length > 1) {
    const params = new URLSearchParams(hash.slice(1));
    // Removed whatever it holds: a credential never stays in the address bar or the tab's history entry.
    win.history.replaceState(null, '', `${win.location.pathname}${win.location.search}`);
    const credential = params.get('c');
    const user = params.get('u');
    if (credential !== null && CREDENTIAL.test(credential)) {
      win.sessionStorage.setItem(KEY_CREDENTIAL, credential);
      if (user !== null && userIdProblem(user, { isDefault: false }) === undefined)
        win.sessionStorage.setItem(KEY_USER, user);
      else win.sessionStorage.removeItem(KEY_USER);
    }
  }
  const credential = win.sessionStorage.getItem(KEY_CREDENTIAL);
  if (credential === null || !CREDENTIAL.test(credential)) return undefined;
  const user = win.sessionStorage.getItem(KEY_USER);
  return { credential, user: user ?? undefined };
}
