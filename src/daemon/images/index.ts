// Staging an agent's docker build context. The context holds exactly what the
// image contains — the agent's Dockerfile, its tool manifest (image.json), the compiled JS it runs, and the
// runtime files of the npm packages the agent SDK imports (the OpenTelemetry
// packages, docs/plans/otel-traces.md R13) — so the source digest over the
// staged files is a true fingerprint of the image (AGENTS.md §3: a stale label
// means a rebuild, never a reuse). The packages come from dist/agent-packages/,
// which `npm run build` makes from a clean offline install of package-lock.json
// (tools/agent-packages/build.mts; docs/plans/debt-paydown.md R10, R11): an image
// build never runs npm or reaches the network, and never copies the checkout's
// node_modules.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';

import type { ImageSpec } from '../container-runtime/index.js';
import type { ImageDefinition } from '../definitions/index.js';
import { present } from '../../shared/assert-present.js';
import { byCodeUnit } from '../../shared/order.js';

/** The label an image implementing the per-user erase mode carries (docs/plans/agent-persistence.md R1, R16). */
export const ERASE_USER_LABEL = 'asha.erase-user';
/** The label naming the layout version of the state an image keeps (R12). */
export const STATE_SCHEMA_LABEL = 'asha.state-schema';

/** The labels the build stamps from image.json, besides asha.source: `asha.erase-user=true` and `asha.state-schema=<n>`, each only when declared. */
export function imageLabels(image: Pick<ImageDefinition, 'manifest'>): Record<string, string> {
  return {
    ...(image.manifest.eraseUser ? { [ERASE_USER_LABEL]: 'true' } : {}),
    ...(image.manifest.stateSchema === null ? {} : { [STATE_SCHEMA_LABEL]: String(image.manifest.stateSchema) }),
  };
}

export interface StagedImage {
  readonly spec: ImageSpec;
  /** Removes the staged context. */
  cleanup(): Promise<void>;
}

/** A compiled input the image needs does not exist. */
export class ImageSourceMissing extends Error {
  // A plain field, not a parameter property: tools/release/pack.mts loads this file with Node's type stripping.
  readonly path: string;
  constructor(path: string) {
    super(
      `${path} does not exist: this asha installation is incomplete; reinstall it (brew reinstall asha) or, in a checkout, run \`npm run build\`; if this daemon was started by an earlier asha (after brew upgrade asha), run asha --stop and retry`,
    );
    this.name = 'ImageSourceMissing';
    this.path = path;
  }
}

/** package-lock.json cannot say what the agent packages are: a dependency it does not hold, or one marked dev. */
export class AgentPackagesInvalid extends Error {
  constructor(message: string) {
    super(`package-lock.json: ${message}`);
    this.name = 'AgentPackagesInvalid';
  }
}

interface LockEntry {
  readonly version?: string;
  readonly dev?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
}

/**
 * The production closure of package.json's `dependencies`, as the lockfile's
 * paths (`node_modules/@opentelemetry/api`, …), sorted: each dependency, and
 * everything it reaches through `dependencies` and non-optional
 * `peerDependencies`, resolved the way Node does (nearest node_modules up the
 * tree). Throws AgentPackagesInvalid for a package the lockfile does not
 * hold, or one it marks dev.
 */
export async function agentPackagePaths(root: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, LockEntry>;
  };
  const packages = lock.packages;
  if (packages === undefined)
    throw new AgentPackagesInvalid('has no "packages" (lockfileVersion 2 or later is required)');
  const resolve = (from: string, name: string): string => {
    for (let base = from; ;) {
      const prefix = base === '' ? '' : `${base}/`;
      const candidate = `${prefix}node_modules/${name}`;
      if (packages[candidate] !== undefined) return candidate;
      if (base === '')
        throw new AgentPackagesInvalid(`${name}, needed by ${from === '' ? 'package.json' : from}, is not in it`);
      const cut = base.lastIndexOf('/node_modules/');
      base = cut < 0 ? '' : base.slice(0, cut);
    }
  };
  const found = new Set<string>();
  const visit = (path: string): void => {
    if (found.has(path)) return;
    const entry = present(packages[path], `packages[${JSON.stringify(path)}]`);
    if (entry.dev === true)
      throw new AgentPackagesInvalid(`${path} is marked dev, but an agent image needs it at run time`);
    found.add(path);
    const peers = Object.keys(entry.peerDependencies ?? {}).filter(
      (name) => entry.peerDependenciesMeta?.[name]?.optional !== true,
    );
    for (const name of [...Object.keys(entry.dependencies ?? {}), ...peers]) visit(resolve(path, name));
  };
  for (const name of Object.keys(manifest.dependencies ?? {})) visit(resolve('', name));
  return [...found].sort(byCodeUnit);
}

/** Only what runs: no source maps, no type declarations, no ESM builds (Node loads each package's CommonJS build). */
function isRuntimeFile(source: string): boolean {
  const name = basename(source);
  // A nested node_modules is not copied whole: its packages in the closure are copied at their own paths.
  return (
    !name.endsWith('.map') && !name.endsWith('.d.ts') && name !== 'esm' && name !== 'esnext' && name !== 'node_modules'
  );
}

/**
 * Copies the runtime files of agentPackagePaths(root) from root's node_modules to the same paths under destRoot:
 * what an agent image holds, and what a release ships (tools/release/pack.mts), from this one function. Refuses a
 * package whose installed version is not the lockfile's, so a stale node_modules never reaches an image.
 */
export async function copyAgentPackages(root: string, destRoot: string): Promise<readonly string[]> {
  for (const file of ['package.json', 'package-lock.json']) await requireSource(join(root, file));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, LockEntry>;
  };
  const paths = await agentPackagePaths(root);
  for (const path of paths) {
    await requireSource(join(root, path));
    await requireSource(join(root, path, 'package.json'));
    const installed = (JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')) as { version?: unknown })
      .version;
    const locked = present(lock.packages[path], `lock.packages[${JSON.stringify(path)}]`).version;
    if (installed !== locked) {
      throw new AgentPackagesInvalid(
        `${path} is installed at ${String(installed)} but locked at ${String(locked)}; run npm ci`,
      );
    }
    await cp(join(root, path), join(destRoot, path), { recursive: true, filter: isRuntimeFile });
  }
  return paths;
}

export interface StageAgentImageProps {
  /** Repo root: holds dist/. */
  readonly root: string;
  readonly image: Pick<ImageDefinition, 'name' | 'dir' | 'repository' | 'manifest'>;
  /** Parent directory for the per-build context directory. */
  readonly stagingParent: string;
}

export async function stageAgentImage(props: StageAgentImageProps): Promise<StagedImage> {
  const { root, image } = props;
  const contextDir = join(props.stagingParent, `${image.name}-${randomBytes(6).toString('hex')}`);
  const copies: readonly (readonly [string, string])[] = [
    [join(image.dir, 'Dockerfile'), join(contextDir, 'Dockerfile')],
    [join(root, 'dist', 'src', 'shared'), join(contextDir, 'app', 'src', 'shared')],
    [join(root, 'dist', 'src', 'agent-sdk'), join(contextDir, 'app', 'src', 'agent-sdk')],
    [join(root, 'dist', 'images', image.name), join(contextDir, 'app', 'images', image.name)],
    // The manifest: the agent checks at start that it implements exactly the tools declared (agent-tools R1).
    [join(image.dir, 'image.json'), join(contextDir, 'app', 'images', image.name, 'image.json')],
  ];
  try {
    await mkdir(contextDir, { recursive: true });
    for (const [from, to] of copies) {
      await requireSource(from);
      await cp(from, to, { recursive: true });
    }
    // The agent packages from the build's clean install of the lockfile (tools/agent-packages/build.mts), never the
    // checkout's node_modules, where a stray or edited file would reach the image (debt-paydown R11, D22).
    const agentPackages = join(root, 'dist', 'agent-packages');
    await requireSource(agentPackages);
    await copyAgentPackages(agentPackages, join(contextDir, 'app'));
    return {
      spec: {
        repository: image.repository,
        contextDir,
        sourceDigest: await directoryDigest(contextDir),
        labels: imageLabels(image),
      },
      cleanup: () => rm(contextDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(contextDir, { recursive: true, force: true });
    throw error;
  }
}

async function requireSource(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ImageSourceMissing(path);
    throw error;
  }
}

/** Reads a file as a stream of chunks: what every hash here reads through, so a test can count the reads (A35). */
export type FileReader = (path: string) => AsyncIterable<Buffer>;

/** The real reader: a stream, never the whole file in memory (docs/plans/extension-modules.md R28, M18). */
export const streamFile: FileReader = (path) => createReadStream(path, { highWaterMark: 1 << 20 });

/** The sha256 of a file, read once as a stream. */
export async function sha256Of(path: string, read: FileReader = streamFile): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of read(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Every file's sha256 in a directory, each file read once, by its path relative to it (`/`-separated). */
export async function hashDirectory(dir: string, read: FileReader = streamFile): Promise<ReadonlyMap<string, string>> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath, entry.name);
    files.set(relative(dir, full).split(sep).join('/'), await sha256Of(full, read));
  }
  return files;
}

/**
 * The source digest of a build context: sha256 over the sorted `relative path\0sha256(content)\n` lines of every file,
 * then — only when there are build arguments, so every digest without them is what it always was — one
 * `\0arg\0NAME=value\n` line per argument, sorted (extension-modules R28, E3: a changed argument is a new digest).
 */
export function contextDigest(
  files: ReadonlyMap<string, string>,
  buildArgs: Readonly<Record<string, string>> = {},
): string {
  const lines = [...files].map(([path, sha]) => `${path}\0${sha}\n`).sort(byCodeUnit);
  const args = Object.entries(buildArgs)
    .map(([name, value]) => `\0arg\0${name}=${value}\n`)
    .sort(byCodeUnit);
  return `sha256:${createHash('sha256')
    .update([...lines, ...args].join(''))
    .digest('hex')}`;
}

/** sha256 over the sorted `relative path\0sha256(content)\n` lines of every file, each streamed (and the build arguments, R28). */
export async function directoryDigest(dir: string, buildArgs: Readonly<Record<string, string>> = {}): Promise<string> {
  return contextDigest(await hashDirectory(dir), buildArgs);
}
