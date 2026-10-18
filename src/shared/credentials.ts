// The credential deny list (docs/plans/extension-modules.md R32): the one exported constant, used by agent-files R2
// for attachments and, once extension-modules is built, by its command plugins' paths. Created by agent-files'
// build (2026-09-30), since that plan was built first: R32's list as R32 states it, plus the one entry agent-files R2
// adds, `Library/Application Support/Microsoft Edge` (a cross-plan amendment to R32, made in this change).
//
// Compared as R32 compares: after Unicode NFC normalisation and case folding (APFS is case-insensitive by default),
// on every component of the path — the resolved path, every symbolic link resolved, so a link to `.env` matches.
// It matches names and paths only: a credential written inside any other file is not caught here (agent-files R2,
// which the CLI reference says); the daemon refuses an upload holding asha's own two secrets (docs/plans/portal.md R8b).

/** One list, in R32's three kinds of entry, and `ASHA_HOME` beside them. */
const CREDENTIAL_DENY_LIST = {
  /** Any path component equal to one of these. */
  components: ['.aws', '.ssh', '.gnupg', '.docker', '.kube', '.azure', '.terraform.d', '.password-store', '.claude'],
  /** Any run of consecutive path components equal to one of these. */
  paths: [
    '.config/gcloud',
    '.config/gh',
    'Library/Keychains',
    'Library/Application Support/Google/Chrome',
    'Library/Application Support/Firefox',
    'Library/Safari',
    'Library/Cookies',
    // Added by docs/plans/agent-files.md R2 (2026-09-30), a cross-plan amendment to extension-modules R32.
    'Library/Application Support/Microsoft Edge',
  ],
  /** A file (the last component) whose name matches one of these; `*` stands for any run of characters. */
  files: [
    'credentials',
    'credentials.*',
    '.git-credentials',
    '.netrc',
    '.npmrc',
    '.pypirc',
    '.pgpass',
    '.vault-token',
    '.env',
    '.env.*',
    'id_rsa',
    'id_dsa',
    'id_ecdsa',
    'id_ed25519',
    'id_ecdsa_sk',
    'id_ed25519_sk',
    'id_rsa.pub',
    'id_dsa.pub',
    'id_ecdsa.pub',
    'id_ed25519.pub',
    'id_ecdsa_sk.pub',
    'id_ed25519_sk.pub',
    '*.pem',
    '*.key',
    '*.p12',
    '*.pfx',
    '*.kdbx',
  ],
  /** Anything under ASHA_HOME: its secrets, daemon.json and model-server.key included. */
  ashaHome: true,
} as const;

/** NFC, then case folded (lower-cased: every entry is ASCII, and APFS's default folding agrees on ASCII). */
function fold(text: string): string {
  return text.normalize('NFC').toLowerCase();
}

const fileMatchers: readonly RegExp[] = CREDENTIAL_DENY_LIST.files.map(
  (glob) =>
    new RegExp(
      `^${fold(glob)
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')}$`,
      's',
    ),
);

/**
 * The deny-list entry an absolute, resolved path matches, or undefined. `ashaHome` is the resolved ASHA_HOME.
 */
export function deniedBy(resolvedPath: string, props: { readonly ashaHome: string }): string | undefined {
  const path = fold(resolvedPath);
  // Strip trailing slashes without a regex: an unanchored `/\/+$/` backtracks across every starting position in the
  // string, which is super-linear on a long path (sonarjs/super-linear-regex).
  let home = fold(props.ashaHome);
  while (home.endsWith('/')) home = home.slice(0, -1);
  if (path === home || path.startsWith(`${home}/`)) return 'anything under ASHA_HOME';
  const parts = path.split('/').filter((p) => p !== '');
  const component = CREDENTIAL_DENY_LIST.components.find((c) => parts.includes(fold(c)));
  if (component !== undefined) return `a path component ${component}`;
  for (const entry of CREDENTIAL_DENY_LIST.paths) {
    const run = fold(entry).split('/');
    for (let i = 0; i + run.length <= parts.length; i += 1) {
      if (run.every((p, j) => parts[i + j] === p)) return `the path ${entry}`;
    }
  }
  return deniedName(parts.at(-1) ?? '');
}

/**
 * The file-name entry (`CREDENTIAL_DENY_LIST.files`) a name alone matches, as the `✗` line says it (`a file named
 * <entry>`), or undefined. The one implementation: `deniedBy` applies it to a path's last component, and the portal's
 * page to a picked file's name, the only part of the list a browser lets a page check (docs/plans/portal.md R8a).
 */
export function deniedName(name: string): string | undefined {
  const folded = fold(name);
  const index = fileMatchers.findIndex((m) => m.test(folded));
  return index < 0 ? undefined : `a file named ${String(CREDENTIAL_DENY_LIST.files[index])}`;
}
