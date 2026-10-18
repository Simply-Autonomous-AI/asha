// Installing and uninstalling a module (docs/plans/extension-modules.md R1, R2, R4, R26, R28, R36), run by the CLI
// alone, never beside a daemon of the home, holding daemon.lock. Every check of R2, R4 and R26 applies alike to a
// module from this repository and to a separate package; nothing is downloaded. A command plugin's release archive is
// supplied by the user (`archive=`) and checked in R28's order before anything is written: the six pre-checks, then
// the summary and the confirmation, then a staging directory the copy is hashed in, promoted by rename — with an
// upgrade's crash-safe swap — and repaired by the next install if a run was killed. Then the image is built.

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, type FileHandle } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { present } from '../../shared/assert-present.js';
import { insideGitTree } from '../../shared/paths.js';
import {
  INSTALL_RECORD,
  MANIFEST_FILE,
  licencesOffAllowlist,
  offeredTools,
  parseModuleManifest,
  type Architecture,
  type ArchiveEntry,
  type CommandToolManifest,
  type ModelProviderManifest,
  type ModuleManifest,
} from '../../shared/modules.js';
import { byCodeUnit } from '../../shared/order.js';
import { visible } from '../../shared/visible.js';
import type { Logger } from '../log.js';
import { sha256Of } from '../images/index.js';

/** The most a command plugin's archive may hold (R28 (6)): the bound R30 puts on one call's read set. */
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;

/** A refusal of the install, before anything under ASHA_HOME/modules/ was written. `usage`: an argument error (exit 2). */
export class InstallRefused extends Error {
  constructor(
    message: string,
    readonly usage = false,
  ) {
    super(message);
    this.name = 'InstallRefused';
  }
}

/** Where an install reports: progress lines, the summary, and the user's confirmation. */
export interface InstallIo {
  /** A line of progress (shown with --verbose). */
  progress(line: string): void;
  /** A warning, always shown: a repaired leftover. */
  warn(line: string): void;
  /** Prints the summary and asks; true only when the user confirmed (or --yes was given). */
  confirm(summary: string): Promise<boolean>;
}

export interface InstallProps {
  readonly source: string;
  readonly archive: string | undefined;
  /** ASHA_HOME and its modules directory. */
  readonly home: string;
  readonly modulesDir: string;
  readonly logger: Logger;
  readonly io: InstallIo;
  /** colima up, as a launch's container_runtime phase (R28), and the VM's `uname -m`. */
  readonly vm: { ensureRunning(): Promise<'ready' | 'started' | 'installed'>; vmArchitecture(): Promise<string> };
  /** Between the archive's checks and its staging copy: a test changes the file here (A34); production does nothing. */
  readonly beforeStaging: () => Promise<void>;
  /** agent-persistence R2's check, injected so a test can see it ran. */
  readonly insideGitTree: (path: string) => Promise<boolean>;
  /** One read of the archive's descriptor (`FileHandle.read`), injected so a test counts the bytes read (A34). */
  readonly readArchive: (handle: FileHandle, buffer: Buffer, length: number, position: number) => Promise<number>;
}

/** The real read of an archive's descriptor. */
export const readHandle = async (
  handle: FileHandle,
  buffer: Buffer,
  length: number,
  position: number,
): Promise<number> => (await handle.read(buffer, 0, length, position)).bytesRead;

export interface Installed {
  readonly manifest: ModuleManifest;
  readonly dir: string;
  readonly upgraded: boolean;
}

/** Repairs what a killed install left (R28), before anything else; each repair logged at warn and said. */
export async function repairLeftovers(modulesDir: string, logger: Logger, io: Pick<InstallIo, 'warn'>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(modulesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (name.startsWith('.staging-') || name.startsWith('.removed-')) {
      await rm(join(modulesDir, name), { recursive: true, force: true });
      logger.warn('module.leftover_removed', { leftover: name });
      io.warn(`⚠ removed ${name}, which a killed install or uninstall left\n`);
      continue;
    }
    const replaced = /^\.replaced-([a-z][a-z0-9_]{0,31})-[0-9a-f]+$/.exec(name);
    if (replaced === null) continue;
    const id = present(replaced[1], 'the upgrade-interrupted id capture');
    if (names.includes(id)) {
      // Killed after the new version was promoted: the old one goes.
      await rm(join(modulesDir, name), { recursive: true, force: true });
      logger.warn('module.leftover_removed', { leftover: name, module: id });
      io.warn(`⚠ removed ${name}, the version an interrupted upgrade of ${id} replaced\n`);
    } else {
      // Killed between the two renames: the installed version is restored.
      await rename(join(modulesDir, name), join(modulesDir, id));
      await syncDir(modulesDir);
      logger.warn('module.upgrade_restored', { leftover: name, module: id });
      io.warn(`⚠ restored module ${id} from ${name}, which an interrupted upgrade left\n`);
    }
  }
}

/** fsync of a directory: its renames reach the disk before the next step (R28). */
async function syncDir(dir: string): Promise<void> {
  const handle = await open(dir, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** What a path is, for a refusal that names it (R28 (5)). */
function kindOf(mode: number): string {
  switch (mode & constants.S_IFMT) {
    case constants.S_IFLNK:
      return 'a symbolic link';
    case constants.S_IFIFO:
      return 'a FIFO';
    case constants.S_IFSOCK:
      return 'a socket';
    case constants.S_IFDIR:
      return 'a directory';
    case constants.S_IFCHR:
      return 'a character device';
    case constants.S_IFBLK:
      return 'a block device';
    default:
      return 'not a regular file';
  }
}

/** The checked archive: its descriptor, opened once without following a link, and the size fstat reported (R28 (5), (6)). */
interface CheckedArchive {
  readonly handle: FileHandle;
  readonly size: number;
  readonly entry: ArchiveEntry;
  readonly architecture: Architecture;
}

/** R28's archive checks (2)–(6), after (1) and the VM's architecture; refusals name what R28 says they name. */
async function checkArchive(props: InstallProps, manifest: CommandToolManifest): Promise<CheckedArchive> {
  props.io.progress(`› container_runtime: ${await props.vm.ensureRunning()}\n`);
  const arch = await props.vm.vmArchitecture();
  const listed = Object.keys(manifest.executable.archives);
  const entry = manifest.executable.archives[arch as Architecture];
  if (entry === undefined)
    throw new InstallRefused(
      `✗ command plugin ${manifest.id} lists no archive for this colima VM's architecture, ${arch}; it lists ${listed.join(', ')}`,
    );
  if (props.archive === undefined) {
    throw new InstallRefused(
      `✗ command plugin ${manifest.id} needs its release archive: download ${entry.url} (sha256 ${entry.sha256}) and install with archive=<the file>`,
    );
  }
  if (await props.insideGitTree(props.home)) {
    throw new InstallRefused(
      `✗ ASHA_HOME ${props.home} is inside a git working tree (it, or a directory above it, holds a .git entry): a command plugin's archive is never copied where it could be committed`,
    );
  }
  let info;
  try {
    info = await lstat(props.archive);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new InstallRefused(`✗ archive=${props.archive}: no such file`);
    throw error;
  }
  if (info.isSymbolicLink())
    throw new InstallRefused(`✗ archive=${props.archive}: it is a symbolic link, not a regular file`);
  let handle: FileHandle;
  try {
    // O_NONBLOCK: a FIFO opens at once rather than waiting for a writer, and is then refused by fstat.
    handle = await open(props.archive, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP')
      throw new InstallRefused(`✗ archive=${props.archive}: it is a symbolic link, not a regular file`);
    if (code === 'ENXIO' || code === 'EOPNOTSUPP')
      throw new InstallRefused(`✗ archive=${props.archive}: it is a socket, not a regular file`);
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile())
      throw new InstallRefused(`✗ archive=${props.archive}: it is ${kindOf(stats.mode)}, not a regular file`);
    if (stats.size > MAX_ARCHIVE_BYTES)
      throw new InstallRefused(
        `✗ archive=${props.archive}: it is ${String(stats.size)} bytes, over the cap of ${String(MAX_ARCHIVE_BYTES)} bytes (1 GiB)`,
      );
    return { handle, size: stats.size, entry, architecture: arch as Architecture };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/** Every entry of a module directory, by its path, each a regular file or a directory (R4: no link, no special file). */
async function listDirectory(dir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      const path = relative(dir, full).split(sep).join('/');
      if (entry.isSymbolicLink())
        throw new InstallRefused(
          `✗ ${path} in the module directory is a symbolic link: a module holds only regular files`,
        );
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) files.push(path);
      else throw new InstallRefused(`✗ ${path} in the module directory is not a regular file`);
    }
  };
  await walk(dir);
  return files.sort(byCodeUnit);
}

interface LockPackage {
  readonly integrity?: unknown;
  readonly hasInstallScript?: unknown;
  readonly version?: unknown;
}

/** Every lock package has an integrity hash, no install script, and a licence entry (helper of {@link checkPackages}). */
function checkLockPackages(packages: Record<string, LockPackage>, manifest: ModuleManifest): void {
  for (const [path, pkg] of Object.entries(packages)) {
    if (path === '') continue;
    if (typeof pkg.integrity !== 'string' || pkg.integrity === '')
      throw new InstallRefused(
        `✗ module ${manifest.id}: the package ${path} has no integrity hash in package-lock.json`,
      );
    if (pkg.hasInstallScript === true)
      throw new InstallRefused(
        `✗ module ${manifest.id}: the package ${path} has an install script (hasInstallScript), which a module may not carry`,
      );
    if (manifest.dependencies[path] === undefined)
      throw new InstallRefused(
        `✗ module ${manifest.id}: the package ${path} has no licence entry in module.json's dependencies`,
      );
  }
}

/** One node_modules package.json's licence field, against the manifest's entry (helper of {@link checkPackageJsonLicences}). */
async function checkPackageJsonLicence(
  source: string,
  manifest: ModuleManifest,
  file: string,
  pkgPath: string,
): Promise<void> {
  const declared = manifest.dependencies[pkgPath];
  let field: unknown;
  try {
    field = (JSON.parse((await readListed(source, file, manifest)).toString('utf8')) as { license?: unknown }).license;
  } catch (error) {
    if (error instanceof InstallRefused) throw error;
    // Named, never a bare SyntaxError (R4; review of 2026-10-02, B-27).
    throw new InstallRefused(`✗ module ${manifest.id}: ${file} does not read as JSON (${(error as Error).message})`);
  }
  if (declared === undefined)
    throw new InstallRefused(
      `✗ module ${manifest.id}: ${file} belongs to a package with no licence entry in module.json`,
    );
  if (field !== declared.id)
    throw new InstallRefused(
      `✗ module ${manifest.id}: ${file} says its licence is ${JSON.stringify(field)}, and module.json says ${declared.id}`,
    );
}

/** Every package.json the directory holds under node_modules: its licence field must be the manifest's entry's (helper of {@link checkPackages}). */
async function checkPackageJsonLicences(source: string, manifest: ModuleManifest): Promise<void> {
  for (const file of Object.keys(manifest.files)) {
    const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\/package\.json$/.exec(file);
    if (m === null) continue;
    await checkPackageJsonLicence(source, manifest, file, present(m[1], 'the node_modules package path capture'));
  }
}

/** R4's checks of a JavaScript module's lockfile and its packages' licence fields, against its manifest. */
async function checkPackages(source: string, manifest: ModuleManifest): Promise<void> {
  if (!Object.hasOwn(manifest.files, 'package-lock.json'))
    throw new InstallRefused(
      `✗ module ${manifest.id}: its package-lock.json is not in its manifest's files (R1: a module carries its lockfile)`,
    );
  let lock: unknown;
  try {
    lock = JSON.parse((await readListed(source, 'package-lock.json', manifest)).toString('utf8'));
  } catch (error) {
    throw new InstallRefused(
      `✗ module ${manifest.id}: package-lock.json does not read as JSON (${(error as Error).message})`,
    );
  }
  if (typeof lock !== 'object' || lock === null || typeof (lock as Record<string, unknown>)['packages'] !== 'object')
    throw new InstallRefused(
      `✗ module ${manifest.id}: package-lock.json has no "packages" (lockfileVersion 2 or later)`,
    );
  checkLockPackages((lock as { packages: Record<string, LockPackage> }).packages, manifest);
  await checkPackageJsonLicences(source, manifest);
}

/**
 * A command plugin's Dockerfile (R26, R28): exactly one FROM, `FROM ${ASHA_PLUGIN_BASE}` after `ARG ASHA_PLUGIN_BASE`
 * — the harness's digest-pinned glibc base — and its last instruction `USER 1000:1000`. Undefined when it passes.
 */
/**
 * Only the instructions a command plugin's Dockerfile may use, and none that reads another image or the network at
 * build: no ADD (it fetches URLs), no ONBUILD, no `--from=` (another image) and no `RUN --mount` (a bind or cache
 * from elsewhere) — helper of {@link dockerfileProblem}, split out to keep its cognitive complexity down.
 */
function instructionProblem(instructions: readonly string[]): string | undefined {
  const ALLOWED = ['ARG', 'FROM', 'COPY', 'RUN', 'ENV', 'WORKDIR', 'USER', 'LABEL'];
  for (const line of instructions) {
    const word = (/^([A-Za-z]+)/.exec(line)?.[1] ?? '').toUpperCase();
    if (!ALLOWED.includes(word))
      return `its instruction "${line.slice(0, 80)}" is not one a command plugin may use (${ALLOWED.join(', ')})`;
    if (/--from[=\s]/i.test(line)) return `its "${line.slice(0, 80)}" copies from another image or stage (--from)`;
    if (word === 'RUN' && /--mount[=\s]/i.test(line))
      return `its "${line.slice(0, 80)}" mounts from elsewhere (RUN --mount)`;
  }
  return undefined;
}

/** Exactly one `FROM ${ASHA_PLUGIN_BASE}`, declared after `ARG ASHA_PLUGIN_BASE` (helper of {@link dockerfileProblem}). */
function fromProblem(instructions: readonly string[]): string | undefined {
  const froms = instructions.filter((l) => /^FROM\s/i.test(l));
  const other = froms.find((l) => l !== 'FROM ${ASHA_PLUGIN_BASE}');
  if (other !== undefined)
    return `its ${other} names another image: a command plugin is built FROM the harness's glibc base, as FROM \${ASHA_PLUGIN_BASE}`;
  if (froms.length !== 1) return 'it has no FROM ${ASHA_PLUGIN_BASE}';
  const from = present(froms[0], 'the one FROM instruction (froms.length === 1, just checked)');
  if (
    instructions.indexOf('ARG ASHA_PLUGIN_BASE') < 0 ||
    instructions.indexOf('ARG ASHA_PLUGIN_BASE') > instructions.indexOf(from)
  )
    return 'it must declare ARG ASHA_PLUGIN_BASE before its FROM';
  return undefined;
}

export function dockerfileProblem(text: string): string | undefined {
  // A parser directive (`# syntax=` names a remote BuildKit frontend, `# escape=` changes how the rest is read) is read
  // only before the first instruction: any such line there is refused (review of 2026-10-02, H2).
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t === '') continue;
    if (!t.startsWith('#')) break;
    if (/^#\s*[A-Za-z_-]+\s*=/.test(t))
      return `it has the parser directive "${t}": a command plugin's Dockerfile names no frontend or escape`;
  }
  const instructions = text
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
  return (
    instructionProblem(instructions) ??
    fromProblem(instructions) ??
    (instructions.at(-1) === 'USER 1000:1000'
      ? undefined
      : 'its last instruction must be USER 1000:1000, the user its files are copied for (R28)')
  );
}

/** One host entry, marked if it is a wildcard (helper of {@link installSummary}; avoids a nested template literal). */
function formatHost(host: string): string {
  return host.startsWith('*.') ? `${host} (wildcard)` : host;
}

/** The summary's lines for every tool the manifest offers, and their described parameters (helper of {@link installSummary}). */
function toolSummaryLines(manifest: ModuleManifest): string[] {
  const lines: string[] = [];
  for (const tool of offeredTools(manifest)) {
    const classes = tool.classes.length === 0 ? 'no class' : tool.classes.join(', ');
    lines.push(`  tool ${manifest.id}/${tool.name} [${classes}], at most ${String(tool.timeoutMs)} ms:`);
    lines.push(`    ${visible(tool.description)}`);
    for (const [name, p] of Object.entries(tool.parameters.properties))
      if (p.description !== undefined) lines.push(`    - ${name}: ${visible(p.description)}`);
  }
  return lines;
}

/** The summary's lines for a ModelProvider's models (helper of {@link installSummary}). */
function modelSummaryLines(manifest: ModelProviderManifest): string[] {
  return manifest.models.map(
    (m) =>
      `  model ${manifest.id}/${m.name}: ${m.id} (${m.kind}), $${String(m.prices.inputUsdPerMTok)}/$${String(m.prices.outputUsdPerMTok)} per million tokens`,
  );
}

/** The summary R26 prints before anything is copied: id, version, hosts (wildcards marked), secrets, tool classes, cost, every description in full. */
export function installSummary(manifest: ModuleManifest): string {
  const lines = [`module ${manifest.id} ${manifest.version} (${manifest.kind})`];
  const hosts =
    manifest.hosts.length === 0 ? 'none (it reaches no network)' : manifest.hosts.map(formatHost).join(', ');
  lines.push(`  hosts:   ${hosts}`);
  lines.push(`  secrets: ${manifest.secrets.length === 0 ? 'none' : manifest.secrets.join(', ')}`);
  const cost = manifest.cost;
  // Every free-text string is shown with its invisible and control characters escaped, so none can rewrite the lines
  // above it before the user answers (review of 2026-10-02, B-16).
  const approved =
    'approved' in cost && cost.approved !== undefined
      ? `, approved by ${visible(cost.approved.by)} on ${cost.approved.date} up to $${String(cost.approved.capUsd)} a month`
      : '';
  lines.push(`  cost:    ${cost.model}${approved}`);
  if (manifest.kind === 'CommandTool')
    lines.push(
      `  runs:    ${manifest.executable.name} ${visible(manifest.executable.version)} (${manifest.executable.licence.id}; its bundled components are not assessed)`,
    );
  lines.push(...toolSummaryLines(manifest));
  if (manifest.kind === 'ModelProvider') lines.push(...modelSummaryLines(manifest));
  return `${lines.join('\n')}\n`;
}

/**
 * The manifest at `props.source`, parsed and validated, with its raw bytes (helper of {@link installModule}): these
 * are what is summarised, confirmed and installed — read once (review of 2026-10-02, B-7: a manifest re-read after
 * the confirmation could differ from the one confirmed).
 */
async function readManifest(
  props: InstallProps,
): Promise<{ readonly manifest: ModuleManifest; readonly manifestBytes: Buffer }> {
  let manifestBytes: Buffer;
  let raw: unknown;
  try {
    manifestBytes = await readFile(join(props.source, MANIFEST_FILE));
    raw = JSON.parse(manifestBytes.toString('utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new InstallRefused(
      code === 'ENOENT'
        ? `✗ ${props.source} holds no ${MANIFEST_FILE}`
        : `✗ ${join(props.source, MANIFEST_FILE)} does not read as JSON: ${(error as Error).message}`,
    );
  }
  try {
    return { manifest: parseModuleManifest(raw, join(props.source, MANIFEST_FILE)), manifestBytes };
  } catch (error) {
    throw new InstallRefused(`✗ ${(error as Error).message}`);
  }
}

/** R4: the directory holds exactly the files its manifest lists, each with its sha256; no link or special file (helper of {@link installModule}). */
async function checkDirectoryFiles(props: InstallProps, manifest: ModuleManifest): Promise<void> {
  const foundFiles = (await listDirectory(props.source)).filter((p) => p !== MANIFEST_FILE);
  const missing = foundFiles.find((p) => !Object.hasOwn(manifest.files, p));
  if (missing !== undefined)
    throw new InstallRefused(`✗ module ${manifest.id}: ${missing} is in its directory and not in its manifest's files`);
  for (const [path, sha] of Object.entries(manifest.files)) {
    if (!foundFiles.includes(path))
      throw new InstallRefused(`✗ module ${manifest.id}: ${path} is in its manifest's files and not in its directory`);
    const actual = await sha256Of(join(props.source, path));
    if (actual !== sha)
      throw new InstallRefused(`✗ module ${manifest.id}: ${path} has sha256 ${actual}, and its manifest says ${sha}`);
  }
}

/** The module's content, its licences and the user's confirmation (R4, R26, R28), after its files match (helper of {@link installModule}). */
async function checkModuleContent(props: InstallProps, manifest: ModuleManifest): Promise<void> {
  if (manifest.kind !== 'CommandTool') await checkPackages(props.source, manifest);
  else {
    const problem = dockerfileProblem((await readListed(props.source, 'Dockerfile', manifest)).toString('utf8'));
    if (problem !== undefined)
      throw new InstallRefused(`✗ command plugin ${manifest.id}: its Dockerfile is refused: ${problem}`);
  }
  const off = licencesOffAllowlist(manifest);
  if (off.length > 0)
    throw new InstallRefused(
      `✗ module ${manifest.id}: a licence is off the permissive allowlist (MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause, 0BSD): ${off.join('; ')}`,
    );
  if (!(await props.io.confirm(installSummary(manifest))))
    throw new InstallRefused(`✗ module ${manifest.id} was not installed: not confirmed`);
}

/**
 * Stages and promotes the checked module (R28): a fresh staging directory, every file copied and hashed, the
 * archive if any, then promoted; a failure removes the staging directory (helper of {@link installModule}).
 */
async function stageAndPromote(
  props: InstallProps,
  manifest: ModuleManifest,
  manifestBytes: Buffer,
  archive: CheckedArchive | undefined,
): Promise<Installed> {
  await props.beforeStaging();
  await mkdir(props.modulesDir, { recursive: true, mode: 0o700 });
  const staging = join(props.modulesDir, `.staging-${randomBytes(8).toString('hex')}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    await writeExclusive(join(staging, MANIFEST_FILE), manifestBytes);
    // Every other file is hashed as it is copied and refused unless it is the manifest's sha256 — the bytes checked.
    for (const path of Object.keys(manifest.files))
      await copyChecked(
        join(props.source, path),
        join(staging, path),
        present(
          manifest.files[path],
          `module ${manifest.id}'s sha256 for ${path} (path is one of manifest.files's own keys)`,
        ),
      );
    if (archive !== undefined)
      await stageArchive(
        archive,
        staging,
        present(props.archive, `module ${manifest.id}'s archive= path (checkArchive already required it)`),
        props.readArchive,
      );
    return await promote(props, manifest, staging);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Installs a module (R1, R2, R4, R26, R28): every check, the summary and the confirmation, the staged copy hashed as
 * copied, and its promotion. The caller holds daemon.lock and has checked that no daemon of the home answers.
 */
export async function installModule(props: InstallProps): Promise<Installed> {
  await repairLeftovers(props.modulesDir, props.logger, props.io);
  const { manifest, manifestBytes } = await readManifest(props);
  // R28 (1): archive= is a command plugin's alone.
  if (props.archive !== undefined && manifest.kind !== 'CommandTool')
    throw new InstallRefused(`archive= is for a command plugin; module ${manifest.id} is a ${manifest.kind}`, true);
  const archive = manifest.kind === 'CommandTool' ? await checkArchive(props, manifest) : undefined;
  try {
    await checkDirectoryFiles(props, manifest);
    await checkModuleContent(props, manifest);
    return await stageAndPromote(props, manifest, manifestBytes, archive);
  } finally {
    await archive?.handle.close();
  }
}

/**
 * A listed file's bytes, refused unless they hash to its manifest's sha256: a file checked for its content (the
 * lockfile, a package.json, the Dockerfile) is checked as the bytes later copied, which are hashed again (B-7).
 */
async function readListed(source: string, path: string, manifest: ModuleManifest): Promise<Buffer> {
  const bytes = await readFile(join(source, path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== manifest.files[path])
    throw new InstallRefused(
      `✗ module ${manifest.id}: ${path} has sha256 ${actual}, and its manifest says ${String(manifest.files[path])}`,
    );
  return bytes;
}

async function writeExclusive(to: string, bytes: Buffer): Promise<void> {
  const target = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await target.write(bytes);
    await target.sync();
  } finally {
    await target.close();
  }
}

/** Copies a file with exclusive create, hashing the copy (the bytes installed), refused when it differs from `sha`. */
async function copyChecked(from: string, to: string, sha: string): Promise<void> {
  await mkdir(join(to, '..'), { recursive: true, mode: 0o700 });
  const source = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
  const target = await open(to, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const hash = createHash('sha256');
  try {
    for await (const chunk of source.createReadStream({ autoClose: false })) {
      hash.update(chunk as Buffer);
      await target.write(chunk as Buffer);
    }
    await target.sync();
  } finally {
    await source.close();
    await target.close();
  }
  if (hash.digest('hex') !== sha) throw new InstallRefused(`✗ ${from} changed while it was copied`);
}

/**
 * R28's staged archive: read from the one descriptor checked, written with exclusive create, at most the size fstat
 * reported — a descriptor that yields more is refused — hashed as copied and compared with the manifest's sha256;
 * then the install record beside it.
 */
async function stageArchive(
  archive: CheckedArchive,
  staging: string,
  path: string,
  read: InstallProps['readArchive'],
): Promise<void> {
  const target = await open(
    join(staging, archive.entry.file),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const hash = createHash('sha256');
  let copied = 0;
  try {
    const buffer = Buffer.alloc(1 << 20);
    // At most the size fstat reported is read; a file that grew is found by a second fstat, never by reading past it.
    while (copied < archive.size) {
      const bytesRead = await read(archive.handle, buffer, Math.min(buffer.length, archive.size - copied), copied);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      await target.write(buffer.subarray(0, bytesRead));
      copied += bytesRead;
    }
    await target.sync();
  } finally {
    await target.close();
  }
  const now = (await archive.handle.stat()).size;
  if (now > archive.size)
    throw new InstallRefused(
      `✗ archive=${path}: it grew while it was copied, past the ${String(archive.size)} bytes it held when checked`,
    );
  const actual = hash.digest('hex');
  if (actual !== archive.entry.sha256)
    throw new InstallRefused(
      `✗ archive=${path}: its sha256 is ${actual}, and the manifest expects ${archive.entry.sha256}`,
    );
  const record = await open(
    join(staging, INSTALL_RECORD),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  try {
    await record.writeFile(
      `${JSON.stringify({ architecture: archive.architecture, archive: { file: archive.entry.file, sha256: archive.entry.sha256 } })}\n`,
    );
  } finally {
    await record.close();
  }
}

/** Promotes a staging directory to `<id>/` (R28): one rename, or an upgrade's three steps, each rename then an fsync. */
async function promote(props: InstallProps, manifest: ModuleManifest, staging: string): Promise<Installed> {
  const target = join(props.modulesDir, manifest.id);
  let exists = true;
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    exists = false;
  }
  if (!exists) {
    await rename(staging, target);
    await syncDir(props.modulesDir);
    props.logger.info('module.installed', { module: manifest.id, version: manifest.version, kind: manifest.kind });
    return { manifest, dir: target, upgraded: false };
  }
  const replaced = join(props.modulesDir, `.replaced-${manifest.id}-${randomBytes(6).toString('hex')}`);
  await rename(target, replaced);
  await syncDir(props.modulesDir);
  await rename(staging, target);
  await syncDir(props.modulesDir);
  await rm(replaced, { recursive: true, force: true });
  props.logger.info('module.installed', {
    module: manifest.id,
    version: manifest.version,
    kind: manifest.kind,
    upgraded: true,
  });
  return { manifest, dir: target, upgraded: true };
}

/** Removes an installed module's directory (R4): renamed aside first, so a killed uninstall leaves a `.removed-*` the next install removes. */
export async function removeModuleDirectory(modulesDir: string, id: string, logger: Logger): Promise<void> {
  const aside = join(modulesDir, `.removed-${id}-${randomBytes(6).toString('hex')}`);
  await rename(join(modulesDir, id), aside);
  await syncDir(modulesDir);
  await rm(aside, { recursive: true, force: true });
  logger.info('module.uninstalled', { module: id });
}

/** The default file reader, re-exported for the CLI's composition. */
export { insideGitTree };
