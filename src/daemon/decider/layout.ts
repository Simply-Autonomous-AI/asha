// Where the decision model's parts live (docs/plans/decider-tool.md R1–R3), all in the model cache so every home that
// shares it — the agent suite's fresh homes included — shares one install: the two catalogue entries' folders
// (`sha256-<tree digest>/`, written by HuggingFaceModelStore), the Python packages' venv (`python-<12 hex of the lock's
// sha256>/`) and the checkpoint folder (`decider-checkpoint-<12 hex>/`), each promoted by one rename. And the check a
// launch makes that every part is there (R15a).

import { createHash } from 'node:crypto';
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import type { DeciderBaseEntry, DeciderEntry, Definitions } from '../definitions/index.js';
import { treeDigest } from '../model-store/index.js';

/** The catalogue id of the one decision model asha serves (R1); its base is the entry its `base` names. */
export const DECIDER_ID = 'strands-decider-2b-hobson-v19';

/** The committed lock of the 51 Python distributions (R2), relative to the repo or package root. */
export const DECIDER_LOCK = join('decider', 'requirements.lock');

/** asha's launcher of the model's own app on a Unix socket (R3), relative to the repo or package root. */
export const DECIDER_LAUNCHER = join('decider', 'launch.py');

/** Homebrew's Python 3.14, named by its path: no other python3 is tried (R2). */
export const DECIDER_PYTHON = '/opt/homebrew/bin/python3.14';
export const DECIDER_PYTHON_FORMULA = 'python@3.14';

export interface DeciderLayout {
  readonly modelsDir: string;
  readonly adapter: DeciderEntry;
  readonly base: DeciderBaseEntry;
  /** `<models>/sha256-<tree digest>/` of each entry. */
  readonly adapterDir: string;
  readonly baseDir: string;
  /** The committed lock, and its sha256. */
  readonly lockFile: string;
  readonly lockSha256: string;
  /** `<models>/python-<12 hex of the lock's sha256>/`, and its interpreter. */
  readonly venvDir: string;
  readonly python: string;
  /** `<models>/decider-checkpoint-<12 hex of the sha256 of the two tree digests>/`. */
  readonly checkpointDir: string;
  /** The launcher the daemon runs (R3). */
  readonly launcher: string;
}

/**
 * The checkpoint folder's name: the first 12 hex of the sha256 of the adapter's and the base's tree digests, each
 * followed by a newline, adapter first. A change to either entry's files is a new folder.
 */
export function checkpointName(adapterDigest: string, baseDigest: string): string {
  const input = `${adapterDigest}\n${baseDigest}\n`;
  return `decider-checkpoint-${createHash('sha256').update(input).digest('hex').slice(0, 12)}`;
}

/** The layout for this checkout or package (`root`) and model cache: the catalogue entries and the lock read now. */
export async function deciderLayout(props: {
  readonly root: string;
  readonly modelsDir: string;
  readonly definitions: Definitions;
}): Promise<DeciderLayout> {
  const { adapter, base } = await props.definitions.decider(DECIDER_ID);
  const lockFile = join(props.root, DECIDER_LOCK);
  const lockSha256 = createHash('sha256')
    .update(await readFile(lockFile))
    .digest('hex');
  const adapterDigest = treeDigest(adapter.files);
  const baseDigest = treeDigest(base.files);
  const modelsDir = resolve(props.modelsDir);
  const venvDir = join(modelsDir, `python-${lockSha256.slice(0, 12)}`);
  return {
    modelsDir,
    adapter,
    base,
    adapterDir: join(modelsDir, `sha256-${adapterDigest}`),
    baseDir: join(modelsDir, `sha256-${baseDigest}`),
    lockFile,
    lockSha256,
    venvDir,
    python: join(venvDir, 'bin', 'python'),
    checkpointDir: join(modelsDir, checkpointName(adapterDigest, baseDigest)),
    launcher: join(props.root, DECIDER_LAUNCHER),
  };
}

/** The filesystem calls the presence check makes: node's, or a test's that counts them. */
export interface PresenceFs {
  /** Whether something is at the path, links not followed. */
  present(path: string): Promise<boolean>;
  /** Whether the path resolves, links followed. */
  resolves(path: string): Promise<boolean>;
  /** A link's target, or null when the path is not a link. */
  linkTarget(path: string): Promise<string | null>;
}

const absent = (error: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

export const nodePresenceFs: PresenceFs = {
  present: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
  },
  resolves: async (path) => {
    try {
      await stat(path);
      return true;
    } catch (error) {
      if (absent(error)) return false;
      throw error;
    }
  },
  linkTarget: async (path) => {
    try {
      return await readlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EINVAL') return null;
      throw error;
    }
  },
};

/** How many links the check follows before it calls a chain a loop. */
const MAX_LINKS = 40;

/**
 * The parts of the decision model that are missing (R15a), in order: the venv's `bin/python` (followed through its
 * links: a link whose target is gone is named `<link> -> <target>`, its first missing target), each entry's folder,
 * and the checkpoint folder. Empty when every part is there.
 */
export async function missingParts(layout: DeciderLayout, fs: PresenceFs): Promise<string[]> {
  const missing: string[] = [];
  if (!(await fs.resolves(layout.python))) {
    let link = layout.python;
    let shown = layout.python;
    for (let hop = 0; hop < MAX_LINKS && (await fs.present(link)); hop++) {
      const target = await fs.linkTarget(link);
      if (target === null) break;
      const next = resolve(dirname(link), target);
      if (!(await fs.present(next))) {
        shown = `${link} -> ${next}`;
        break;
      }
      link = next;
    }
    missing.push(shown);
  }
  for (const dir of [layout.adapterDir, layout.baseDir, layout.checkpointDir])
    if (!(await fs.present(dir))) missing.push(dir);
  return missing;
}
