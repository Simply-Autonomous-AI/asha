// Files for agents (docs/plans/agent-files.md): the bounds and the name rules the CLI, the daemon and the agent
// SDK share, so the three can never disagree. Sizes are bytes (the plan's 25,000,000 and 256,000,000 exactly).

/** The largest file that can be attached or returned (R2, R12). */
export const MAX_ATTACHMENT_BYTES = 25_000_000;
/** A channel file space holds at most this many bytes of regular files (R11). */
export const SPACE_MAX_BYTES = 256_000_000;
/** …and at most this many entries — every file, directory, link and other entry below its root (R11). */
export const SPACE_MAX_ENTRIES = 1_000;
/** Files one message can attach, and one reply return (R1, R3a, R12). */
export const MAX_FILES_PER_MESSAGE = 10;
/** The upload manifest's line, its `\n` included (R3a). */
export const MANIFEST_MAX_BYTES = 8 * 1024;
/** A file name's UTF-8 bytes (R13). */
export const FILE_NAME_MAX_BYTES = 255;

/** An upload's own folder in the space: `upload-` and 64 random bits as 16 hex characters (R3a). */
export const UPLOAD_FOLDER_PATTERN = /^upload-[0-9a-f]{16}$/;

/**
 * A file name, attached or returned (R13): no `/`, NUL or other control character (C0, DEL, C1), and not `.` or
 * `..`. Its length in UTF-8 bytes is checked apart (FILE_NAME_MAX_BYTES), and NFC is checked apart (the CLI
 * normalises; the daemon refuses a name that is not).
 */
const FILE_NAME_PATTERN = /^(?!\.\.?$)[^/\p{Cc}]+$/u;
/** A returned name, which becomes a path on the user's host (R12a, R13): the same, and never beginning with `.`. */
const RETURNED_NAME_PATTERN = /^(?!\.)[^/\p{Cc}]+$/u;

/**
 * A text's length in UTF-8 bytes. Not `Buffer.byteLength`: the portal's page applies these rules too
 * (docs/plans/portal.md R8a, R15), and a browser has no `Buffer`.
 */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** What is wrong with a file name (R13), or undefined. `returned`: a name the CLI will save on the host. */
export function fileNameProblem(name: string, options: { readonly returned: boolean }): string | undefined {
  if (name === '') return 'the name is empty';
  if (utf8Bytes(name) > FILE_NAME_MAX_BYTES) return `the name is over ${String(FILE_NAME_MAX_BYTES)} bytes in UTF-8`;
  if (name.normalize('NFC') !== name) return 'the name is not in Unicode NFC';
  if (!FILE_NAME_PATTERN.test(name)) return 'the name is "." or "..", or holds "/", NUL or another control character';
  if (options.returned && !RETURNED_NAME_PATTERN.test(name)) return 'a returned name may not begin with "."';
  return undefined;
}

/**
 * The name a taken name gets (R13): `-<n>` before its last extension, or at the end when its only dot is its first
 * character (or it has none) — `a.tar.gz` → `a.tar-2.gz`, `.bashrc` → `.bashrc-2`, `notes` → `notes-2`. When the
 * result would pass 255 bytes, whole characters are removed from the end of the part before the suffix until it fits;
 * an extension so long it leaves no character before the suffix is treated as part of the name, the suffix put at the
 * end (*until the completion review, finding 12, this threw, and the upload route answered 500*).
 */
export function suffixedName(name: string, n: number): string {
  if (!Number.isInteger(n) || n < 2)
    throw new Error(`suffixedName: the suffix number must be an integer from 2, not ${String(n)}`);
  const dot = name.lastIndexOf('.');
  const suffix = `-${String(n)}`;
  const split = dot > 0 && FILE_NAME_MAX_BYTES - utf8Bytes(suffix + name.slice(dot)) >= 1;
  const [stem, extension] = split ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const room = FILE_NAME_MAX_BYTES - utf8Bytes(suffix + extension);
  const chars = Array.from(stem);
  while (utf8Bytes(chars.join('')) > room) chars.pop();
  return `${chars.join('')}${suffix}${extension}`;
}

/** Final names for one upload's files, unique within the upload by the suffix rule applied to the manifest alone (R3a). */
export function uniqueNames(names: readonly string[]): string[] {
  const taken = new Set<string>();
  return names.map((name) => {
    let final = name;
    // Not a `for`: the loop's own counter is `n`, suffixing `name` afresh each time, but what the loop tests is
    // `final` — whether the latest suffix is itself taken (sonarjs/misplaced-loop-counter, dismissed as a false
    // positive: `final` is what the loop must converge on, and it is reassigned every pass).
    let n = 2;
    while (taken.has(final)) {
      final = suffixedName(name, n);
      n += 1;
    }
    taken.add(final);
    return final;
  });
}
