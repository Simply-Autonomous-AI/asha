// The archive that carries a recipe's documents into an agent's /workspace
// (docs/plans/collaborating-agents.md R2): a POSIX ustar stream, fed to
// `docker cp -a - <container>:/workspace` between `docker create` and
// `docker start`. Written here rather than with a dependency (PRINCIPLES §7):
// regular files and the directories above them, nothing else — no links, no
// devices — each owned by the user the agent runs as, so its file tools can
// overwrite and append to them (R3), and each directory entry before its files.

/** A file for the workspace: its path relative to /workspace, and its bytes. */
export interface WorkspaceFile {
  readonly path: string;
  readonly content: Uint8Array;
}

/** Who owns every entry: the uid and gid the agent's image runs as. */
export interface ArchiveOwner {
  readonly uid: number;
  readonly gid: number;
}

const BLOCK = 512;
const NAME_MAX = 100;

/**
 * The ustar archive of `files`, each directory on their paths first (mode 0755), then each file (mode 0644),
 * all owned by `owner` and dated `mtime` (seconds since the epoch). A path must be relative, plain, and at most
 * 100 bytes (the recipe schema's DOCUMENT_PATH already ensures it); anything else is a defect and throws.
 */
export function workspaceArchive(files: readonly WorkspaceFile[], owner: ArchiveOwner, mtime: number): Buffer {
  const blocks: Buffer[] = [];
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.path.split('/');
    if (
      file.path.startsWith('/') ||
      parts.some((p) => p === '' || p === '.' || p === '..') ||
      Buffer.byteLength(file.path) > NAME_MAX
    ) {
      throw new Error(
        `workspace archive: "${file.path}" is not a plain relative path of at most ${String(NAME_MAX)} bytes`,
      );
    }
    for (let i = 1; i < parts.length; i += 1) {
      const dir = `${parts.slice(0, i).join('/')}/`;
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      blocks.push(header({ name: dir, mode: 0o755, size: 0, type: '5', owner, mtime }));
    }
    blocks.push(header({ name: file.path, mode: 0o644, size: file.content.byteLength, type: '0', owner, mtime }));
    blocks.push(Buffer.from(file.content));
    const pad = (BLOCK - (file.content.byteLength % BLOCK)) % BLOCK;
    if (pad > 0) blocks.push(Buffer.alloc(pad));
  }
  // The end of the archive: two zero blocks.
  blocks.push(Buffer.alloc(2 * BLOCK));
  return Buffer.concat(blocks);
}

interface HeaderProps {
  readonly name: string;
  readonly mode: number;
  readonly size: number;
  readonly type: '0' | '5';
  readonly owner: ArchiveOwner;
  readonly mtime: number;
}

/** One 512-byte ustar header. Numeric fields are zero-padded octal, NUL-terminated. */
function header(props: HeaderProps): Buffer {
  const h = Buffer.alloc(BLOCK);
  const octal = (value: number, offset: number, length: number): void => {
    h.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  };
  h.write(props.name, 0, NAME_MAX, 'utf8');
  octal(props.mode, 100, 8);
  octal(props.owner.uid, 108, 8);
  octal(props.owner.gid, 116, 8);
  octal(props.size, 124, 12);
  octal(props.mtime, 136, 12);
  // The checksum is computed with its own field as eight spaces.
  h.write('        ', 148, 8, 'ascii');
  h.write(props.type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}
