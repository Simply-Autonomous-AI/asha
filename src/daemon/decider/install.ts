// Installing and removing the decision model (docs/plans/decider-tool.md R2, R3, R15, R15b; the owner's answers of
// 2026-10-02, record `decider-runtime-install` (b), "Only by an explicit command", and 2026-10-03, record
// `decider-remove-python` (a), "Leave Python installed"). Both run in the CLI's own process, never in the daemon: the
// daemon never runs pip or `-m venv`, nor writes the decider's folders. Every part is written to a name nobody else
// holds and promoted by one rename, holding the model cache's lock only around the rename; a removal renames each folder
// to a name no check reads before it deletes it (PRINCIPLES §13).

import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { present } from '../../shared/assert-present.js';
import { byCodeUnit } from '../../shared/order.js';
import type { DeciderBaseEntry, DeciderEntry } from '../definitions/index.js';
import { ensureHostTool } from '../host-tools/index.js';
import type { Logger } from '../log.js';
import type { ModelStore } from '../model-store/index.js';
import { CommandNotFound, tail, type CommandRunner } from '../process/index.js';
import { DeciderFailed } from './contract.js';
import { DECIDER_PYTHON, DECIDER_PYTHON_FORMULA, type DeciderLayout } from './layout.js';

/** Bound on `-m venv` (R2). */
export const VENV_TIMEOUT_MS = 60_000;
/** Bound on pip (R2): 958 MB at 5 Mbit/s is about 26 minutes. */
export const PIP_TIMEOUT_MS = 1_800_000;
/** Bound on `python3.14 --version`. */
const VERSION_TIMEOUT_MS = 30_000;

/** What the decision model holds in memory while an agent selecting `decide` is online (probe P2). */
export const DECIDER_MEMORY = '5.0–6.1 GB';
/** The Python packages' size once installed (probe P0). */
export const DECIDER_PACKAGES_SIZE = 'about 958 MB';

/** The folders the install and the removal write, by pattern (R15, R15b). */
export const STAGING_PREFIX = '.staging-decider-';
export const REMOVING_PREFIX = '.removing-decider-';
const REMOVABLE = [
  /^python-[0-9a-f]{12}$/,
  /^decider-checkpoint-[0-9a-f]{12}$/,
  /^\.staging-decider-[0-9a-f]{12}$/,
  /^\.removing-decider-[0-9a-f]{12}$/,
];

/** The removal's last line on success (R15b; the owner's answer to question 2, worded by the planning agent). */
export const PYTHON_LEFT_LINE =
  "Python 3.14 (Homebrew's python@3.14) was left in place; brew uninstall python@3.14 removes it if nothing else needs it";

/** The filesystem the install and removal act through: node's, or a test's that records or fails calls. */
export interface DeciderFs {
  /** Whether something is at the path, links not followed. */
  present(path: string): Promise<boolean>;
  /** Creates a folder that must not exist yet (and its parents). */
  makeDir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a folder and everything in it; never follows a link out of it. */
  remove(path: string): Promise<void>;
  readText(path: string): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  /** An absolute symbolic link at `path` to `target`. */
  link(target: string, path: string): Promise<void>;
  /** A folder's entries; [] when it does not exist. */
  list(dir: string): Promise<string[]>;
  /** The bytes a folder holds, links counted as themselves. */
  bytes(path: string): Promise<number>;
}

export const nodeDeciderFs: DeciderFs = {
  present: async (path) => {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  },
  makeDir: async (path) => {
    await mkdir(dirname(path), { recursive: true });
    await mkdir(path);
  },
  rename: (from, to) => rename(from, to),
  remove: (path) => rm(path, { recursive: true, force: true }),
  readText: (path) => readFile(path, 'utf8'),
  writeText: (path, text) => writeFile(path, text, { flag: 'wx' }),
  link: (target, path) => symlink(target, path),
  list: async (dir) => {
    try {
      return (await readdir(dir)).sort(byCodeUnit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  },
  bytes: (path) => folderBytes(path),
};

async function folderBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.size;
  let total = info.size;
  for (const entry of await readdir(path)) total += await folderBytes(join(path, entry));
  return total;
}

/** What the install and the removal act through (R15, R15b), chosen in the CLI's composition (src/cli/main.ts). */
export interface DeciderHost {
  readonly runner: CommandRunner;
  readonly store: ModelStore;
  /** Takes `<models>/.lock` (acquirePidLock with the CLI's pid): its release, or LockHeld naming the holder. */
  readonly lock: (file: string) => Promise<() => Promise<void>>;
  readonly fs: DeciderFs;
  /** 12 random hex characters: a staging or removing folder's name. */
  readonly randomHex: () => string;
}

export const randomHex12 = (): string => randomBytes(6).toString('hex');

/** Where the install and removal print: stdout, stderr, and `--verbose`'s progress (stderr, or nowhere). */
export interface DeciderOutput {
  stdout(text: string): void;
  stderr(text: string): void;
  progress(text: string): void;
}

/** A step of the install, as `decider.install_failed` names it. */
export type InstallStep = 'python' | 'weights' | 'packages' | 'checkpoint';

/** A step failed; its cause is the error the step met. */
export class InstallStepFailed extends Error {
  constructor(
    readonly step: InstallStep,
    readonly reason: Error,
  ) {
    super(reason.message, { cause: reason });
    this.name = 'InstallStepFailed';
  }
}

/** Whether `--version`'s output is Python 3.14.x. */
function isPython314(output: string): boolean {
  return /^Python 3\.14\.\d+$/.test(output.trim());
}

/** The interpreter's own version line, or null when it does not run. */
async function pythonVersion(runner: CommandRunner): Promise<string | null> {
  try {
    const result = await runner.run(DECIDER_PYTHON, ['--version'], { timeoutMs: VERSION_TIMEOUT_MS });
    return result.code === 0 ? `${result.stdout}${result.stderr}`.trim() : null;
  } catch (error) {
    if (error instanceof CommandNotFound) return null;
    throw error;
  }
}

/** The packages the lock pins: its lines `<name>==<version> …`. */
export function lockedPackages(lock: string): string[] {
  return lock.split('\n').flatMap((l) => {
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+?)\s*\\?$/.exec(l);
    if (m === null) return [];
    const name = present(m[1], 'the locked package name');
    const version = present(m[2], 'the locked package version');
    return [`${name}==${version}`];
  });
}

const sumBytes = (entry: DeciderEntry | DeciderBaseEntry): number => entry.files.reduce((n, f) => n + f.size, 0);

/** The summary the install prints before it asks (R15 (1)). */
export function installSummary(layout: DeciderLayout, python: 'present' | 'missing', packages: number): string {
  const pythonLine =
    python === 'present'
      ? `present at ${DECIDER_PYTHON}`
      : `not present: to be installed with brew install ${DECIDER_PYTHON_FORMULA}`;
  return [
    'asha --install-decider installs the decision model, Strands Decider 2B, for the decide tool:',
    `  Python 3.14: Homebrew's ${DECIDER_PYTHON_FORMULA}, ${pythonLine}`,
    `  Python packages: the ${String(packages)} pinned in ${layout.lockFile}, ${DECIDER_PACKAGES_SIZE}, into ${layout.venvDir}`,
    ...[layout.adapter, layout.base].map(
      (e) => `  ${e.id}: ${e.repo} at ${e.revision}, ${sumBytes(e).toLocaleString('en-US')} bytes`,
    ),
    `  memory: the decision model holds ${DECIDER_MEMORY} while an agent selecting decide is online`,
    '',
  ].join('\n');
}

export interface InstallProps {
  readonly layout: DeciderLayout;
  readonly host: DeciderHost;
  readonly logger: Logger;
  readonly out: DeciderOutput;
  /** Asks for the exact word `yes` (R15 (1)): resolves whether it was given, having printed any refusal itself. */
  readonly confirm: () => Promise<boolean>;
}

/** Step (2): the interpreter — Homebrew's formula when the probe found none, then its version. */
async function ensurePython(props: InstallProps, python: 'present' | 'missing'): Promise<void> {
  const { host, logger } = props;
  if (python === 'missing')
    await ensureHostTool(host.runner, logger, {
      binary: DECIDER_PYTHON,
      probeArgs: ['--version'],
      formula: DECIDER_PYTHON_FORMULA,
    });
  const version = await pythonVersion(host.runner);
  if (version === null || !isPython314(version))
    throw new DeciderFailed(
      `${DECIDER_PYTHON} reports ${version === null ? 'nothing (it does not run)' : JSON.stringify(version)}, not Python 3.14.x`,
    );
}

/** Step (3): the weights, through the model store — downloaded by revision, every file verified, promoted by one rename. */
async function ensureWeights(props: InstallProps, found: { adapter: boolean; base: boolean }): Promise<void> {
  const { layout, host, out } = props;
  for (const entry of [layout.adapter, layout.base]) {
    const cached = await host.store.ensure(entry);
    if (entry === layout.adapter) found.adapter = cached.status === 'cached';
    else found.base = cached.status === 'cached';
    out.progress(`› weights ${entry.id}: ${cached.status}\n`);
  }
}

/** Step (4): the packages, from the lock only. Returns whether the venv was already present. */
async function ensurePackages(props: InstallProps): Promise<boolean> {
  const { layout, host } = props;
  const wasPresent = await host.fs.present(layout.venvDir);
  if (!wasPresent) {
    await staged(props, layout.venvDir, async (staging) => {
      await run(host.runner, DECIDER_PYTHON, ['-m', 'venv', staging], VENV_TIMEOUT_MS);
      await run(
        host.runner,
        join(staging, 'bin', 'pip'),
        [
          'install',
          '--isolated',
          '--disable-pip-version-check',
          '--require-hashes',
          '--no-deps',
          '-r',
          layout.lockFile,
        ],
        PIP_TIMEOUT_MS,
      );
    });
  }
  return wasPresent;
}

/** Step (5): the checkpoint — links to the adapter's files, and its config naming the cached base folder. Returns whether it was already present. */
async function ensureCheckpoint(props: InstallProps): Promise<boolean> {
  const { layout, host } = props;
  const wasPresent = await host.fs.present(layout.checkpointDir);
  if (!wasPresent) await staged(props, layout.checkpointDir, (staging) => writeCheckpoint(layout, host.fs, staging));
  return wasPresent;
}

/**
 * `asha --install-decider` (R15), from its probe to its last line: returns its exit code (0 installed or already
 * installed, 1 not confirmed or a step failed). A failing step leaves every part promoted before it in place.
 */
export async function installDecider(props: InstallProps): Promise<number> {
  const { layout, host, logger, out } = props;
  // (1) the probe, then the summary, then the question: nothing else runs before the answer.
  const python = (await pythonVersion(host.runner)) === null ? 'missing' : 'present';
  const lock = await host.fs.readText(layout.lockFile);
  out.stdout(installSummary(layout, python, lockedPackages(lock).length));
  if (!(await props.confirm())) return 1;
  let step: InstallStep = 'python';
  const found = { python: python === 'present', adapter: false, base: false, packages: false, checkpoint: false };
  try {
    await ensurePython(props, python);
    out.progress(`› python: ${python === 'present' ? 'present' : 'installed'}\n`);
    step = 'weights';
    await ensureWeights(props, found);
    step = 'packages';
    found.packages = await ensurePackages(props);
    out.progress(`› packages: ${found.packages ? 'present' : 'installed'}\n`);
    step = 'checkpoint';
    found.checkpoint = await ensureCheckpoint(props);
    out.progress(`› checkpoint: ${found.checkpoint ? 'present' : 'written'}\n`);
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.error('decider.install_failed', { step, error: cause });
    out.stderr(`✗ ${cause.message}\n`);
    return 1;
  }
  out.stdout(
    Object.values(found).every((v) => v)
      ? 'the decision model is already installed\n'
      : 'installed the decision model\n',
  );
  return 0;
}

/** Runs one install command; a non-zero exit fails the step with its exit code and the tail of its output. */
async function run(runner: CommandRunner, command: string, args: readonly string[], timeoutMs: number): Promise<void> {
  const result = await runner.run(command, args, { timeoutMs });
  if (result.code !== 0) {
    const output = `${result.stdout}\n${result.stderr}`;
    throw new DeciderFailed(`${command} ${args.join(' ')} exited ${String(result.code)}:\n${tail(output)}`);
  }
}

/**
 * Writes a part in `<models>/.staging-decider-<12 hex>/` and promotes it to `target` by one rename, holding the model
 * cache's lock only around the rename, once it has checked that `target` is still absent (another install may have
 * promoted it meanwhile, which is then kept). The staging folder is removed on every failure.
 */
async function staged(props: InstallProps, target: string, write: (staging: string) => Promise<void>): Promise<void> {
  const { host, layout } = props;
  const staging = join(layout.modelsDir, `${STAGING_PREFIX}${host.randomHex()}`);
  try {
    await host.fs.makeDir(staging);
    await write(staging);
    const release = await host.lock(join(layout.modelsDir, '.lock'));
    try {
      if (!(await host.fs.present(target))) await host.fs.rename(staging, target);
    } finally {
      await release();
    }
  } finally {
    await host.fs.remove(staging);
  }
}

/** The checkpoint folder (R3): an absolute link to each cached adapter file, and hobson_config.json naming the base. */
async function writeCheckpoint(layout: DeciderLayout, fs: DeciderFs, staging: string): Promise<void> {
  for (const file of layout.adapter.files) {
    if (file.path === 'hobson_config.json') continue;
    const at = join(staging, file.path);
    if (dirname(at) !== staging && !(await fs.present(dirname(at)))) await fs.makeDir(dirname(at));
    await fs.link(join(layout.adapterDir, file.path), at);
  }
  await fs.writeText(
    join(staging, 'hobson_config.json'),
    checkpointConfig(await fs.readText(join(layout.adapterDir, 'hobson_config.json')), layout.baseDir),
  );
}

/** The cached hobson_config.json with `base_model` the cached base folder, every other key unchanged and in its order. */
export function checkpointConfig(cached: string, baseDir: string): string {
  const config = JSON.parse(cached) as Record<string, unknown>;
  if (typeof config['base_model'] !== 'string')
    throw new DeciderFailed('the cached hobson_config.json names no base_model');
  config['base_model'] = baseDir;
  return `${JSON.stringify(config, null, 2)}\n`;
}

// ---------------------------------------------------------------- the removal (R15b)

/** A folder the removal would remove, with its bytes. */
export interface RemovableFolder {
  readonly path: string;
  readonly bytes: number;
}

/** Every folder the removal takes (R15b), in the cache's order: the four patterns and the two entries' folders. */
export async function removableFolders(layout: DeciderLayout, fs: DeciderFs): Promise<RemovableFolder[]> {
  const entryDirs = new Set([layout.adapterDir, layout.baseDir].map((d) => d.slice(layout.modelsDir.length + 1)));
  const names = (await fs.list(layout.modelsDir)).filter((n) => entryDirs.has(n) || REMOVABLE.some((p) => p.test(n)));
  const out: RemovableFolder[] = [];
  for (const name of names)
    out.push({ path: join(layout.modelsDir, name), bytes: await fs.bytes(join(layout.modelsDir, name)) });
  return out;
}

export interface RemoveProps {
  readonly layout: DeciderLayout;
  readonly host: DeciderHost;
  readonly logger: Logger;
  readonly out: DeciderOutput;
  readonly folders: readonly RemovableFolder[];
}

/**
 * Removes the folders, holding `<models>/.lock`: each renamed to `.removing-decider-<12 hex>` by one rename, then
 * deleted, so none is ever left part-deleted under a name a check reads as complete. Returns the exit code.
 */
export async function removeFolders(props: RemoveProps): Promise<number> {
  const { layout, host, logger, out } = props;
  const left = props.folders.map((f) => f.path);
  let freed = 0;
  let removed = 0;
  try {
    const release = await host.lock(join(layout.modelsDir, '.lock'));
    try {
      for (const folder of props.folders) {
        const name = folder.path.slice(layout.modelsDir.length + 1);
        const doomed = name.startsWith(REMOVING_PREFIX)
          ? folder.path
          : join(layout.modelsDir, `${REMOVING_PREFIX}${host.randomHex()}`);
        if (doomed !== folder.path) await host.fs.rename(folder.path, doomed);
        left.splice(left.indexOf(folder.path), 1, doomed);
        await host.fs.remove(doomed);
        left.splice(left.indexOf(doomed), 1);
        freed += folder.bytes;
        removed += 1;
        out.stdout(`removed ${folder.path} (${folder.bytes.toLocaleString('en-US')} bytes)\n`);
      }
    } finally {
      await release();
    }
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    logger.error('decider.remove_failed', { folders: removed, bytes: freed, error: cause });
    const leftLine = left.length === 0 ? '' : `  left: ${left.join(', ')}\n`;
    out.stderr(`✗ ${cause.message}\n${leftLine}`);
    return 1;
  }
  logger.info('decider.removed', { folders: removed, bytes: freed });
  out.stdout(`freed ${freed.toLocaleString('en-US')} bytes\n${PYTHON_LEFT_LINE}\n`);
  return 0;
}
