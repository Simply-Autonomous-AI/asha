// The page's own lines for what only a page meets (docs/plans/portal.md R6, R14): a refused credential, a daemon gone,
// a daemon stopping. Constants only, with no access to the page, so the tests compare the page's text with them.

/** The line the page shows when the daemon refuses its credential. */
export const UNAUTHORIZED_LINE =
  "✗ the daemon refused this page's credential (HTTP 401): run asha --portal to open a page that works\n";
/** The line the page shows when the daemon cannot be reached. */
export const UNREACHABLE_LINE =
  '✗ the daemon is unreachable: it is not running, or has stopped; run asha --portal to start it and open a new page\n';
/** The line the page shows while the daemon stops (R14). */
export const STOPPING_LINE = 'stopping: the daemon is stopping, and takes no new work\n';
