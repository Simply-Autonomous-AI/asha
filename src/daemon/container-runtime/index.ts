// Where agent containers run. The contract is ContainerRuntime; the one
// implementation is colima + the docker CLI.
//
// Confinement (docs/plans/control-api-auth.md R10, R12–R14; docs/plans/agent-tools.md
// R14): a container the harness starts can open a connection to the daemon's
// port on the host gateway and to nothing else — no other host port, not the
// VM, not the LAN, not the internet. ColimaRuntime runs each home's containers
// on its own Docker network (`asha-<homeId>`, bridge `asha<homeId>`) and keeps
// iptables rules in the colima VM: jumps from DOCKER-USER (traffic the VM
// forwards) and from INPUT (traffic to the VM itself), for interfaces `asha+`
// only, to the chain ASHA-AGENTS, which holds per home one RETURN for its
// daemon's port and, right after it, one REJECT of everything else from its
// bridge (both tagged `asha:<homeId>`), above two shared rejects for the host
// gateway.

import { reservedVariableName } from '../../shared/modules.js';
import { present } from '../../shared/assert-present.js';
import { byCodeUnit, byNumber } from '../../shared/order.js';
import { ensureHostTool } from '../host-tools/index.js';
import type { Logger } from '../log.js';
import {
  CommandNotFound,
  CommandTimedOut,
  tail,
  type CommandResult,
  type CommandRunner,
  type InteractiveLauncher,
  type ProcessLauncher,
  type StreamResult,
} from '../process/index.js';
import { workspaceArchive, type ArchiveOwner, type WorkspaceFile } from './archive.js';

/** An image to build or find (debt D23): its repository, its build context, and the source digest that names its tag. */
export interface ImageSpec {
  /** The image's repository name, `asha-image-<name>`; its tag is `imageTag` of this and the digest. */
  readonly repository: string;
  /** A directory holding the Dockerfile and everything it copies. */
  readonly contextDir: string;
  /** Digest of every file in the context, `sha256:<64 hex>`; stored as the `asha.source` label and named by the tag. */
  readonly sourceDigest: string;
  /**
   * Labels the build stamps besides `asha.source`, from the image's image.json (docs/plans/agent-persistence.md R1,
   * R12): `asha.erase-user=true` and `asha.state-schema=<n>`. image.json is in the context, so the tag names them too.
   */
  readonly labels: Readonly<Record<string, string>>;
  /**
   * Build arguments (`--build-arg NAME=value`, docs/plans/extension-modules.md R28's ASHA_ARCHIVE): each one's name and
   * value are in `sourceDigest` (R28, E3), so a changed argument is a new tag and a build. Absent: none.
   */
  readonly buildArgs?: Readonly<Record<string, string>>;
}

/** An image `ensureImage` made sure of: the exact tag `start` runs, whether it was built now, and its labels as the image carries them. */
export interface EnsuredImage {
  readonly tag: string;
  readonly status: 'current' | 'built';
  readonly labels: Readonly<Record<string, string>>;
}

/** The label every container the harness creates carries: its home's id (agent-persistence R10), found by it after a crash. */
const HOME_LABEL = 'asha.home';

/** `tail` of a command's combined stdout and stderr, for an error message (kept out of the message's own template). */
function tailCombined(result: { readonly stdout: string; readonly stderr: string }): string {
  return tail(`${result.stdout}\n${result.stderr}`);
}

/** A copy out of a container (`docker cp <c>:<path> -`), streamed to the caller; a failed copy is data (R6's copy_failed). */
export type CopyOutcome = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/**
 * A container run once to completion (agent-persistence R16's erase): created without `--rm`, so what it leaves can
 * be copied out after it exits, on no network, with no environment, carrying the home's label; given its root
 * archive; run attached, its standard output captured (at most `maxStdoutBytes` kept) and its standard error only in
 * its log file; killed at `timeoutMs`.
 */
export interface OneShotSpec {
  readonly name: string;
  readonly image: string;
  readonly args: readonly string[];
  readonly logFile: string;
  readonly archive: () => AsyncIterable<Uint8Array>;
  readonly timeoutMs: number;
  readonly maxStdoutBytes: number;
}

/** How a one-shot container's run ended: its exit code and captured stdout, or its bound passed and it was killed. */
export type OneShotRun =
  | { readonly kind: 'exited'; readonly code: number; readonly stdout: string; readonly overflow: boolean }
  | { readonly kind: 'timeout' };

/** A one-shot container (agent-persistence R16's erase): created, given its archive, run once to its exit, read back, removed. */
export interface OneShot {
  /** Creates, restores, starts and waits for it, bounded; a runtime failure before it runs throws. */
  run(): Promise<OneShotRun>;
  /** Copies `path` out of the exited container. */
  copyOut(path: string, onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>): Promise<CopyOutcome>;
  /** `docker rm --force`: on every path, success or failure (R16). */
  remove(): Promise<void>;
}

/**
 * The one tag an image of this source is built and run as: `<repository>:<digest hex>`.
 * One tag per source digest, so a build never replaces a tag another image holds
 * (debt D23: replacing the tag let containerd's garbage collector delete a layer
 * snapshot mid-unpack, "parent snapshot … does not exist").
 */
export function imageTag(spec: Pick<ImageSpec, 'repository' | 'sourceDigest'>): string {
  const hex = /^sha256:([0-9a-f]{64})$/.exec(spec.sourceDigest)?.[1];
  if (hex === undefined)
    throw new Error(`sourceDigest must be sha256:<64 hex>, not ${JSON.stringify(spec.sourceDigest)}`);
  return `${spec.repository}:${hex}`;
}

/** An agent container to start (R12): its name, image, environment, log file, documents or restore archive, and its channel's volume. */
export interface ContainerSpec {
  readonly name: string;
  readonly image: string;
  /** Passed by name (`-e KEY`), so values never appear in a process listing. */
  readonly env: Readonly<Record<string, string>>;
  /** The container's stdout and stderr are appended here. */
  readonly logFile: string;
  /**
   * Files placed in the container's /workspace before it starts, owned by the user the agent runs as: its
   * recipe's documents ([] for none; docs/plans/collaborating-agents.md R2). `docker run` alone copies nothing,
   * so a container is created, given these, then started.
   */
  readonly files: readonly WorkspaceFile[];
  /**
   * A persisted agent's restore (docs/plans/agent-persistence.md R11), in place of `files`: one tar streamed into the
   * container's `/` between create and start — its saved /memory and /workspace, and the recipe documents R13 adds —
   * read from the stored files as it is sent. `files` is then [].
   */
  readonly archive?: () => AsyncIterable<Uint8Array>;
  /**
   * The channel file space's volume (docs/plans/agent-files.md R4, R10), mounted at /channel: `-v <volume>:/channel`,
   * the only mount a container gets. Every agent container is on a channel, and every channel's space exists before
   * its first agent starts.
   */
  readonly channelVolume: string;
}

/** A copy into a container, or a rollback one-shot: its exit status (data), or its bound passed and it was killed. */
export type DockerOutcome =
  { readonly kind: 'exited'; readonly code: number; readonly stderr: string } | { readonly kind: 'timeout' };

/** The holder of a channel's space (agent-files R10): created from an agent image's exact tag, never started. */
export interface HolderSpec {
  readonly name: string;
  readonly image: string;
  readonly volume: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** An upload's rollback (agent-files R3a): its folder removed from the volume as root, by a one-shot of the holder's image. */
export interface RollbackSpec {
  readonly volume: string;
  readonly image: string;
  /** `upload-<16 hex>`: nothing else is ever passed to rm. */
  readonly folder: string;
}

/** A space emptied after a failed fill (agent-files R15): every entry under /channel removed as root, by a one-shot of the holder's image. */
export interface EmptySpaceSpec {
  readonly volume: string;
  readonly image: string;
}

/** What a reclaim removed that the daemon reports beyond its own log line: the home's volumes (agent-files R10a). */
export interface Reclaimed {
  readonly volumes: number;
}

/** A network the module host creates (docs/plans/extension-modules.md R5, R6), carrying the home's label. */
export interface NetworkSpec {
  readonly name: string;
  /** `--internal`: no route out of it — a module's network, whose one other member is the egress proxy (R6 (a)). */
  readonly internal: boolean;
  /**
   * The bridge interface's name, when rules must name it: the egress bridge `ashae<homeId>` (R6 (d)), or a module
   * network's `asham<10 hex>`, which the `asha+` jumps reach and MODULE_LOCAL_REJECT closes to the VM (D53).
   */
  readonly bridge?: string;
  /** Labels besides `asha.home`, which every network carries. */
  readonly labels: Readonly<Record<string, string>>;
}

/**
 * A container run attached (R5, R34): a module's, or the egress proxy. Created with the limits every module, proxy
 * and plugin container gets (`--cap-drop ALL`, `no-new-privileges`, `--pids-limit 256`, `--cpus 1`, its memory), and
 * `--read-only` with a 64 MiB /tmp; its environment passed by name; stdout handed over in chunks, stderr in lines.
 */
export interface AttachedSpec {
  readonly name: string;
  readonly image: string;
  readonly network: string;
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
  readonly onStdout: (chunk: Buffer) => void;
  readonly onStderrLine: (line: string) => void;
}

/** A started module or proxy container (extension-modules R5, R34): its exit, its standard input, and its removal. */
export interface AttachedContainer {
  /** Settles with its exit code (null when killed by a signal); rejects when it could not be started. */
  readonly exited: Promise<number | null>;
  /** One line to its standard input; false once it has exited. */
  write(line: string): boolean;
  /** `docker rm --force`: stopped at once and removed, bounded by DOCKER_TIMEOUT_MS. */
  remove(): Promise<void>;
}

/**
 * One command plugin call's container (R30): created and never reused — on its (plugin, channel) network, the call's
 * secrets and the plugin's fixed variables in its environment, its executable the entrypoint — given its files by a
 * tar stream before it starts, run attached, its writes copied out after it exits, and removed on every path.
 */
export interface PluginSpec {
  readonly name: string;
  readonly image: string;
  readonly network: string;
  readonly entrypoint: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
}

/** How a command plugin's run ended (extension-modules R30): its exit and bounded output, or its bound passed. */
export type PluginRun =
  | {
      readonly kind: 'exited';
      readonly code: number;
      readonly stdout: Buffer;
      readonly stderr: Buffer;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
    }
  | { readonly kind: 'timeout' };

/** A command plugin's container for one call (extension-modules R30): created, given its files, run, read back, removed. */
export interface PluginContainer {
  /** `docker create`; throws ContainerRuntimeError when it fails. */
  create(signal: AbortSignal): Promise<void>;
  /** One tar into `/` (`docker cp -a - <c>:/`), bounded by `timeoutMs` and `signal`. */
  copyIn(archive: AsyncIterable<Uint8Array>, timeoutMs: number, signal: AbortSignal): Promise<DockerOutcome>;
  /** `docker start --attach`, stdout and stderr each kept up to `maxBytes`, bounded by `timeoutMs` (then killed). */
  run(timeoutMs: number, maxBytes: number, signal: AbortSignal): Promise<PluginRun>;
  /** `docker cp <c>:<path> -`, each chunk to `onChunk`, bounded by `timeoutMs` and `signal`. */
  copyOut(
    path: string,
    onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<CopyOutcome>;
  /** `docker rm --force`; a container already gone is not a failure. */
  remove(): Promise<void>;
}

/** What `ensureReady`/`ensureRunning` found: already ready, or the state it just reached to become so. */
export type RuntimeReadiness = 'ready' | 'started' | 'installed';

/**
 * The container runtime contract the supervisor, the file spaces and the module host depend on (PRINCIPLES §10):
 * readiness and confinement, images, agent, module, plugin and one-shot containers, copies, the file spaces' volumes,
 * and the reclaim. ColimaRuntime is its one adapter; tests give a fake.
 */
export interface ContainerRuntime {
  /** How a container addresses the host's loopback interface. */
  readonly hostAddress: string;
  /**
   * Installs and starts the runtime if needed, and confines containers: once it
   * resolves, every container `start` then runs can open a connection to the
   * host's loopback on `hostPort` (the daemon's port), and to no other port or
   * address (agent-tools R14).
   * An adapter that cannot confine its containers MUST throw here, and no
   * container may then be started. Call before every launch.
   */
  ensureReady(hostPort: number): Promise<RuntimeReadiness>;
  /**
   * Makes sure the image `imageTag(spec)` exists, building it only when that
   * tag is missing, and resolves with the tag `start` must run. An existing
   * tag is never replaced: a build of another source gets its own tag.
   */
  ensureImage(spec: ImageSpec): Promise<EnsuredImage>;
  /**
   * Starts a container: creates it, places `files` in its /workspace, then starts it. Agents are long-lived,
   * so this does not wait for it: `exited` settles with the exit code whenever the container stops, and rejects
   * if it could not be created, given its files, or started.
   */
  start(spec: ContainerSpec): { readonly exited: Promise<number> };
  /**
   * Stops a container if it exists, and resolves when it has stopped (a
   * container started by `start` is removed as it exits). `drain`: SIGTERM,
   * then SIGKILL once `graceS` whole seconds have passed — AGENT_STOP_GRACE_MS
   * for an agent that does not persist, longer than the agent SDK's drain bound,
   * so it finishes or reports its started work first; for a persisted agent the
   * seconds left until its stop's container deadline (agent-persistence R10).
   * `kill`: SIGKILL at once, for an agent whose own work is what overran
   * (docs/architecture/channel.md#stop). The call is bounded at the grace plus
   * DOCKER_TIMEOUT_MS.
   */
  stop(name: string, mode: 'drain', graceS: number): Promise<void>;
  stop(name: string, mode: 'kill'): Promise<void>;
  /**
   * Copies `path` out of a running container as a tar stream (`docker cp <c>:<path> -`), each chunk to `onChunk`,
   * which may stop it; bounded by DOCKER_TIMEOUT_MS and by `signal`. A failed copy is data.
   */
  copyOut(
    name: string,
    path: string,
    onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>,
    signal?: AbortSignal,
  ): Promise<CopyOutcome>;
  /** A one-shot container (agent-persistence R16): see OneShotSpec. */
  oneShot(spec: OneShotSpec): OneShot;
  /**
   * Removes everything the runtime set up for this home — the confinement,
   * the containers' network and any container still on it or carrying the home's
   * label, then every volume carrying the home's label (agent-files R10a) — including what a daemon of this home
   * that died left behind. Called at daemon start, and at a clean stop once every agent is stopped. Resolves with
   * how many volumes it removed.
   */
  reclaim(): Promise<Reclaimed>;
  /**
   * Removes asha's own old image versions (debt-paydown-2 R1–R4): those `selectPrunable` picks, at most 50, the oldest
   * first, under the VM's images lock taken exclusively without waiting, bounded at 10 s in all. Called once at every
   * daemon start, before the server listens. Never throws: a prune skipped (colima not installed or not running, a
   * build holding the lock) or failed is logged (`image.prune_skipped`, `image.prune_failed`), and the start goes on.
   */
  pruneImages(): Promise<void>;

  // The channel file spaces (docs/plans/agent-files.md R3a, R10, R12): each a Docker volume, filled and read through a
  // holder container that is created and never started. Each call is bounded by DOCKER_TIMEOUT_MS.
  /** `docker volume create` with these labels. A taken name is not refused by Docker (probe P5): the caller reads a label back. */
  createVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void>;
  /** One label of a volume as `docker volume inspect` reads it ('' when the volume carries none); a failed inspect throws. */
  volumeLabel(name: string, key: string): Promise<string>;
  /** The space's holder: `--pull never --network none --entrypoint true`, the volume at /channel; never started. */
  createHolder(spec: HolderSpec): Promise<void>;
  /** `docker rm --force`; a container already gone is not a failure. */
  removeContainer(name: string): Promise<void>;
  /** `docker volume rm`; a volume already gone is not a failure. */
  removeVolume(name: string): Promise<void>;
  /**
   * Streams a tar into a container's / (`docker cp - <c>:/`). The archive ending is how a caller ends the copy's
   * input early; `signal` aborting kills it (and rejects with its reason).
   */
  copyIn(name: string, archive: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<DockerOutcome>;
  /** agent-files R3a's rollback one-shot, exactly; `signal` aborting kills its client (and rejects with its reason). */
  rollback(spec: RollbackSpec, signal?: AbortSignal): Promise<DockerOutcome>;
  /**
   * Removes every entry under a space's /channel as root, its root kept (a failed fill's undoing, agent-files R15):
   * a one-shot like the rollback's, running one fixed command; `signal` aborting kills its client.
   */
  emptySpace(spec: EmptySpaceSpec, signal?: AbortSignal): Promise<DockerOutcome>;

  // Extension modules (docs/plans/extension-modules.md R5, R6, R28, R30, R34). Each call is bounded by DOCKER_TIMEOUT_MS
  // or SSH_TIMEOUT_MS unless it says otherwise.
  /** Installs and starts the runtime if needed, confining nothing: what an install needs (R28). */
  ensureRunning(): Promise<RuntimeReadiness>;
  /** `uname -m` in the VM (R28): `aarch64`, `x86_64`, … */
  vmArchitecture(): Promise<string>;
  /** The VM's Docker Engine version, `docker version --format '{{.Server.Version}}'` (R6 (a)). */
  engineVersion(): Promise<string>;
  /** `docker network create`, carrying `asha.home=<homeId>` and the spec's labels (R5). */
  createNetwork(spec: NetworkSpec): Promise<void>;
  /** `docker network rm`; a network already gone is not a failure. */
  removeNetwork(name: string): Promise<void>;
  /** The egress bridge's rejects (R6 (d)), installed where missing and verified, tagged `asha:<homeId>`. */
  installEgressRules(bridge: string): Promise<void>;
  /** Checks every egress reject is in place (R6 (d)); throws ContainerIsolationFailed naming the one missing. */
  verifyEgressRules(bridge: string): Promise<void>;
  /** A module's or the proxy's container, run attached (R5, R34). */
  runAttached(spec: AttachedSpec): AttachedContainer;
  /** `docker network connect --alias <alias>`; resolves with the container's IPv4 address on that network. */
  connectNetwork(network: string, container: string, alias: string): Promise<string>;
  /** `docker network disconnect --force`; a container or network already gone is not a failure. */
  disconnectNetwork(network: string, container: string): Promise<void>;
  /** One command plugin call's container (R30). */
  pluginContainer(spec: PluginSpec): PluginContainer;
}

/**
 * A container was stopped while it was being created or given its files: it is removed and never started. Not a
 * failure of the runtime: whoever stopped it wanted it gone.
 */
export class ContainerStoppedBeforeStart extends Error {
  constructor(readonly container: string) {
    super(`container ${container} was stopped before it started, and removed`);
    this.name = 'ContainerStoppedBeforeStart';
  }
}

/** How a container is stopped: given its grace to finish its started work, or killed at once. */
export type StopMode = 'drain' | 'kill';

/** colima or docker failed. Carries the command's own output. */
export class ContainerRuntimeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ContainerRuntimeError';
  }
}

/** How to recover when this daemon's network changed or vanished while it ran (completion review F5). */
const RECREATE_HINT = 'asha --stop, then any command, starts a daemon that recreates it';

/**
 * A docker command passed its bound: names the command (`docker network create`), never its arguments — and carries
 * no cause, since CommandTimedOut's message is the whole command line.
 */
class DockerTimedOut extends ContainerRuntimeError {
  constructor(command: string, timeoutMs: number) {
    super(`docker ${command} did not finish within ${String(timeoutMs)} ms`);
    this.name = 'DockerTimedOut';
  }
}

/**
 * Containers could not be confined, or their confinement could not be
 * checked or removed. Names the rule, network or check, and carries the
 * command's output. No container is started after it.
 */
export class ContainerIsolationFailed extends ContainerRuntimeError {
  constructor(
    readonly what: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`container isolation failed: ${what}: ${detail}`, options);
    this.name = 'ContainerIsolationFailed';
  }
}

/** `docker build` failed, passed its bound, or its VM build lock was not taken. Carries the build output's tail, or why. */
export class ImageBuildFailed extends Error {
  constructor(
    readonly tag: string,
    readonly output: string,
    options?: ErrorOptions,
  ) {
    super(`docker build of ${tag} failed:\n${output}`, options);
    this.name = 'ImageBuildFailed';
  }
}

/**
 * A tag `ensureImage` returned was gone when its container was created (debt-paydown-2 R5): an image prune of another
 * asha server removed it in between. Created with `--pull never`, so no registry is ever asked for it. Not retried: the
 * next launch's `ensureImage` finds the tag missing and builds it (R6's residual, debt D63).
 */
export class ImageGone extends ContainerRuntimeError {
  constructor(readonly tag: string) {
    super(
      `image ${tag} was removed while this launch was starting (an image prune of another asha server); launch again to rebuild it`,
    );
    this.name = 'ImageGone';
  }
}

/** The label every image asha builds carries: the source digest it was built from (D23), checked before any reuse. */
export const SOURCE_LABEL = 'asha.source';

/**
 * The VM-wide image lock (debt-paydown-2 R3): every build's session holds it shared, an image prune exclusively, so a
 * prune never removes a tag while any build — of any home or checkout of this version — is running (D23's failure).
 */
export const IMAGES_LOCK_FILE = '/run/asha-images.lock';

/** The VM lock of one image tag's build (debt-paydown R18): a few bytes in /run, gone at the VM's restart. */
export function imageLockFile(hex: string): string {
  return `/run/asha-image-${hex}.lock`;
}

/**
 * A build's lock script, exactly (debt-paydown R18, debt-paydown-2 R3): takes the images lock shared (30 s at most —
 * a prune holds it exclusively for at most 10 s — else exit 6), then the tag's lock (600 s at most, else exit 4), says
 * so, and holds both until stdin closes.
 */
export function imageLockScript(hex: string): string {
  return `exec 8>${IMAGES_LOCK_FILE}; flock -s -w 30 8 || exit 6; exec 9>${imageLockFile(hex)}; flock -w 600 9 || exit 4; echo locked; read _ || true`;
}

/**
 * The image prune's lock script, exactly (debt-paydown-2 R3): the images lock taken exclusively without waiting —
 * `busy` and exit 5 when any build holds it shared — then `locked`, held until stdin closes.
 */
export const PRUNE_LOCK_SCRIPT = `exec 8>${IMAGES_LOCK_FILE}; flock -x -n 8 || { echo busy; exit 5; }; echo locked; read _ || true`;

/**
 * The exit status of the command `colima ssh` ran in the VM. colima 0.10.3 exits 1 for every non-zero status and
 * names the real one only on its standard error, `level=fatal msg="exit status N"` (probe Q4, 2026-10-03); a session
 * that ends 1 without that line is reported as 1.
 */
export function remoteExitStatus(result: { readonly code: number; readonly stderr: string }): number {
  if (result.code !== 1) return result.code;
  const named = /level=fatal msg="exit status (\d+)"/.exec(result.stderr)?.[1];
  return named === undefined ? 1 : Number(named);
}

/** A stream session once it has settled: its result, or the error that rejected it. */
type StreamEnd = { readonly result: StreamResult } | { readonly error: unknown };

/** A `colima ssh` stream session that settled: its exit (by `remoteExitStatus`) or the error that failed it. */
function describeStreamEnd(end: StreamEnd): string {
  if ('result' in end) return `colima ssh exited ${String(remoteExitStatus(end.result))}: ${tail(end.result.stderr)}`;
  return `colima ssh failed: ${(end.error as Error).message}`;
}

/** Why a tag's build lock was not taken (debt-paydown R18): the 600 s wait passed, or the session itself ended. */
function lockNotTakenReason(timedOut: boolean, end: StreamEnd): string {
  if (timedOut) return `colima ssh printed no "locked" within ${String(IMAGE_LOCK_TAKEN_MS)} ms`;
  if ('result' in end) {
    const code = remoteExitStatus(end.result);
    const flockNote = code === 4 ? ' (flock waited 600 s)' : '';
    return `colima ssh exited ${String(code)}${flockNote}: ${tail(end.result.stderr)}`;
  }
  return `colima ssh failed: ${(end.error as Error).message}`;
}

/** The prune's lock session itself failed, if it did (debt-paydown-2 R4): its error, or a non-zero exit. */
function sessionFailureReason(end: StreamEnd): string | undefined {
  if ('error' in end) return `the image prune's lock session failed: ${(end.error as Error).message}`;
  if (end.result.code !== 0)
    return `the image prune's lock session exited ${String(remoteExitStatus(end.result))}: ${tail(end.result.stderr)}`;
  return undefined;
}

/** The repositories asha builds (debt-paydown-2 R2 (a)): agents, harness images, modules and plugins. */
const ASHA_REPOSITORY = /^asha-(image|harness|module|plugin)-[a-z0-9][a-z0-9._-]*$/;
/** How old a version must be before a prune may remove it (R2 (e), the owner's "older than 24 hours"). */
const PRUNE_AGE_MS = 86_400_000;
/** The prune's whole bound (R4). */
const PRUNE_BOUND_MS = 10_000;
/** At most this many versions removed per start, the oldest first (R2; the owner's record `debt-image-prune`). */
const PRUNE_MAX_PER_START = 50;
/** At most this many tags per `docker image rm` (R2). */
const PRUNE_RM_BATCH = 20;

/** One tagged image version as `docker image inspect` reads it (R2). */
export interface ImageVersion {
  readonly repository: string;
  readonly tag: string;
  /** The image id, `sha256:<64 hex>`. */
  readonly id: string;
  /** `.Created`, in ms since the epoch. */
  readonly created: number;
  /** The `asha.source` label ('' when it carries none). */
  readonly source: string;
}

/**
 * The listing's rows old enough to inspect (debt-paydown-2 R2 (d)–(e)): `old` is those whose row is earlier than
 * another row's of the same repository (the newest, and every row tied with it, kept) and more than 24 h and one
 * second before `now` (the listing's one-second resolution never drops a row this way); `candidates` adds, for each
 * repository `old` names, the newest row too, so `selectPrunable` can compare it against the ones to prune.
 */
function selectOldAndCandidates(
  rows: readonly ListedVersion[],
  now: number,
): { readonly old: ListedVersion[]; readonly candidates: ListedVersion[] } {
  const newestSecond = new Map<string, number>();
  for (const row of rows)
    newestSecond.set(row.repository, Math.max(newestSecond.get(row.repository) ?? -Infinity, row.createdS));
  const old = rows.filter(
    (row) =>
      row.createdS < present(newestSecond.get(row.repository), "newestSecond, set above for every row's repository") &&
      now - row.createdS * 1000 > PRUNE_AGE_MS + 1000,
  );
  const oldRepositories = new Set(old.map((row) => row.repository));
  const candidates = [
    ...rows.filter((row) => oldRepositories.has(row.repository) && row.createdS === newestSecond.get(row.repository)),
    ...old,
  ];
  return { old, candidates };
}

/**
 * The versions an image prune removes (debt-paydown-2 R2), the oldest first: those whose (a) repository is asha's, (b)
 * tag is 64 lowercase hex, (c) `asha.source` label is `sha256:<that tag>`, (d) `.Created` is earlier than another
 * version's of the same repository (the newest, and every version tied with it, kept), (e) `.Created` is more than
 * 24 hours before `now`, and (f) id is no container's image.
 */
export function selectPrunable(
  images: readonly ImageVersion[],
  usedImageIds: ReadonlySet<string>,
  now: number,
): ImageVersion[] {
  const newest = new Map<string, number>();
  for (const image of images)
    newest.set(image.repository, Math.max(newest.get(image.repository) ?? -Infinity, image.created));
  return images
    .filter(
      (image) =>
        ASHA_REPOSITORY.test(image.repository) &&
        /^[0-9a-f]{64}$/.test(image.tag) &&
        image.source === `sha256:${image.tag}` &&
        image.created < present(newest.get(image.repository), `newest, set above for every image's repository`) &&
        now - image.created > PRUNE_AGE_MS &&
        !usedImageIds.has(image.id),
    )
    .sort(
      (a, b) => byNumber(a.created, b.created) || byCodeUnit(a.repository, b.repository) || byCodeUnit(a.tag, b.tag),
    );
}

/** An existing tag, reused when its label names this source; any other label is not asha's build, and refused. */
function current(tag: string, spec: ImageSpec, found: Readonly<Record<string, string>>): EnsuredImage {
  // The tag names the digest, so a different label means something other than asha wrote the tag: never reuse or replace it.
  const label = found[SOURCE_LABEL] ?? '';
  if (label !== spec.sourceDigest) {
    throw new ContainerRuntimeError(
      `image ${tag} carries ${SOURCE_LABEL}=${JSON.stringify(label)}, not ${spec.sourceDigest}: asha did not build it from this source; remove it (docker image rm ${tag})`,
    );
  }
  return { tag, status: 'current', labels: found };
}

/** What ColimaRuntime is built with, at the daemon's composition root: its runner, launchers, logger, profile, home and clock. */
export interface ColimaRuntimeProps {
  readonly runner: CommandRunner;
  readonly launcher: ProcessLauncher;
  /** Starts a module's or the proxy's container attached, its stdin and stdout piped (extension-modules R5, R34). */
  readonly interactive: InteractiveLauncher;
  readonly logger: Logger;
  /** colima profile. The harness uses it and never stops it. */
  readonly profile: string;
  /** The home's id (`HarnessPaths.homeId`, 8 hex characters): names its network and tags its rules. */
  readonly homeId: string;
  /** Dates the files placed in a container's /workspace, and is the image prune's "now" (debt-paydown-2 R2 (e)). */
  readonly clock: () => Date;
  /**
   * Tests only (debt-paydown-2 A6): the prune considers only repositories this matches, besides R2 (a)'s pattern, so a
   * probe whose clock is ahead removes nothing it did not build. Absent — as the composition root leaves it — every
   * repository R2 (a) names is considered.
   */
  readonly pruneRepository?: RegExp;
}

/** The host's loopback as the colima VM routes to it: `host.docker.internal`, `host.lima.internal`. */
export const HOST_GATEWAY = '192.168.5.2';
/**
 * The resolver every agent container is given (debt-paydown R1, D18): a TEST-NET-1 address (RFC 5737), never a real
 * resolver. With `--dns` set, Docker's embedded resolver forwards a query for an outside name from the container's own
 * namespace, where the home's REJECT refuses it inside the VM, so no outside name resolves by any path (probe P1);
 * without it, the resolver forwards from the VM's namespace, which no rule on the bridge sees.
 */
export const AGENT_DNS_SERVER = '192.0.2.1';
const STATUS_TIMEOUT_MS = 30_000;
/** Bound on one `colima ssh` round trip (measured 0.20–0.34 s on 2026-09-27). */
const SSH_TIMEOUT_MS = 30_000;
/** Bound on waiting for another daemon's rule change, inside the ssh bound. */
const LOCK_WAIT_S = 20;
const START_TIMEOUT_MS = 10 * 60_000;
const BUILD_TIMEOUT_MS = 10 * 60_000;
/** How long a build waits for another daemon's build of the same tag: one build of it (debt-paydown R18). */
const IMAGE_LOCK_WAIT_MS = BUILD_TIMEOUT_MS;
/** How long a build waits for the images lock an image prune holds (debt-paydown-2 R3, R4): the script's `flock -s -w 30`. */
const IMAGES_LOCK_WAIT_MS = 30_000;
/** Bound on the lock session's exit once its stdin is closed (R18; P3b: 155 ms). */
const IMAGE_LOCK_RELEASE_MS = 30_000;
/** Bound on a build's wait for `locked`: the images lock, then the tag's, then one ssh round trip (660 s, debt-paydown-2 R4). */
const IMAGE_LOCK_TAKEN_MS = IMAGES_LOCK_WAIT_MS + IMAGE_LOCK_WAIT_MS + SSH_TIMEOUT_MS;
/** Bound on the whole lock session: both waits, then two inspects and a build, then the release (1,410 s, R4). */
const IMAGE_LOCK_SESSION_MS =
  IMAGES_LOCK_WAIT_MS + IMAGE_LOCK_WAIT_MS + SSH_TIMEOUT_MS + 2 * 60_000 + BUILD_TIMEOUT_MS + IMAGE_LOCK_RELEASE_MS;
const DOCKER_TIMEOUT_MS = 60_000;
/** The agent's workspace in its container (agent-tools R9): where a recipe's documents go (collaborating-agents R2). */
const WORKSPACE_DIR = '/workspace';
/**
 * The user every agent image runs as: `node` of the pinned node:22-alpine base (USER node in each Dockerfile),
 * uid and gid 1000 — assumed, not read from the image: debt D34 (docs/plans/debt.md). An agent-suite append to a
 * placed document (collaborating-agents A2, A3) proves it end to end.
 */
const AGENT_WORKSPACE_OWNER: ArchiveOwner = { uid: 1000, gid: 1000 };

/**
 * The ContainerRuntime on colima (docs/architecture/index.md#host-inference): docker against colima's socket, every
 * root step in the VM by `colima ssh`, each command bounded, and every container confined to the home's network.
 */
export class ColimaRuntime implements ContainerRuntime {
  readonly hostAddress = 'host.docker.internal';
  private dockerHost: string | undefined;
  /** The subnets Docker allocated to this home's network when this daemon created it; undefined until then. */
  private subnets: readonly string[] | undefined;
  /** ensureReady and reclaim run one at a time: rule changes within a daemon are serialized. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The ensureImage in flight for each tag. */
  private readonly imageBuilds = new Map<string, Promise<EnsuredImage>>();
  /**
   * Containers between `docker create` and `docker start`, by name, and whether a stop has arrived for one: `docker
   * stop` does nothing to a container not yet started, so start checks this before each step instead.
   */
  private readonly starting = new Map<string, { stopped: boolean }>();

  constructor(private readonly props: ColimaRuntimeProps) {
    // Both are written into a script run as root in the VM: only exactly this shape is accepted.
    if (!/^[0-9a-f]{8}$/.test(props.homeId))
      throw new Error(`homeId must be 8 hex characters, not ${JSON.stringify(props.homeId)}`);
  }

  private get network(): string {
    return `asha-${this.props.homeId}`;
  }

  private get bridge(): string {
    return `asha${this.props.homeId}`;
  }

  ensureReady(hostPort: number): Promise<RuntimeReadiness> {
    if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65_535)
      throw new Error(`hostPort must be a TCP port, not ${String(hostPort)}`);
    return this.serialized(() => this.ready(hostPort));
  }

  reclaim(): Promise<Reclaimed> {
    return this.serialized(() => this.reclaimHome());
  }

  async pruneImages(): Promise<void> {
    const started = Date.now();
    const removed: string[] = [];
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const work = this.prune(started + PRUNE_BOUND_MS, abort.signal, removed).then(
      (outcome) => ({ outcome }),
      (error: unknown) => ({ error }),
    );
    const settled = await Promise.race([
      work,
      new Promise<'timeout'>(
        (resolve) =>
          (timer = setTimeout(() => {
            resolve('timeout');
          }, PRUNE_BOUND_MS)),
      ),
    ]);
    clearTimeout(timer);
    if (settled === 'timeout') {
      // The session killed with its client, which releases the images lock (Q2 (e)); every command is bounded by the
      // time that was left, so none outlives this.
      abort.abort(new Error(`the image prune passed its ${String(PRUNE_BOUND_MS)} ms bound`));
      this.props.logger.error('image.prune_failed', {
        reason: 'timeout',
        removed: [...removed],
        error: new ContainerRuntimeError(`the image prune did not finish within ${String(PRUNE_BOUND_MS)} ms`),
      });
      return;
    }
    if ('error' in settled) {
      // A command killed at the time left is the prune's own bound reached (review finding 10): logged as the timeout.
      if (settled.error instanceof CommandTimedOut)
        this.props.logger.error('image.prune_failed', {
          reason: 'timeout',
          removed: [...removed],
          error: settled.error,
        });
      else this.props.logger.error('image.prune_failed', { removed: [...removed], error: settled.error });
      return;
    }
    if (settled.outcome.kind === 'skipped') {
      this.props.logger.info('image.prune_skipped', { reason: settled.outcome.reason });
      return;
    }
    this.props.logger.info('image.pruned', {
      removed: [...removed],
      kept: settled.outcome.kept,
      ms: Date.now() - started,
    });
  }

  /**
   * The prune's work (debt-paydown-2 R1–R4): `colima status`, the lock session, the filtered listing, every container's
   * image id, `docker image inspect` of the candidates only, then `docker image rm` in calls of at most 20 tags; the
   * session closed on every path. Each tag Docker removes is pushed onto `removed` as it is confirmed.
   */
  private async prune(
    deadline: number,
    signal: AbortSignal,
    removed: string[],
  ): Promise<
    { readonly kind: 'skipped'; readonly reason: string } | { readonly kind: 'pruned'; readonly kept: number }
  > {
    const { runner, profile } = this.props;
    const left = (): number => {
      if (signal.aborted) throw signal.reason;
      return Math.max(1, deadline - Date.now());
    };
    // colima's state first, so a stopped or absent colima costs one status and opens no session (R1).
    let status;
    try {
      status = await runner.run('colima', ['status', '--profile', profile, '--json'], {
        timeoutMs: Math.min(STATUS_TIMEOUT_MS, left()),
      });
    } catch (error) {
      if (!(error instanceof CommandNotFound)) throw error;
      return { kind: 'skipped', reason: 'colima is not installed' };
    }
    if (status.code !== 0) return { kind: 'skipped', reason: `colima profile ${profile} is not running` };
    const dockerHost = parseDockerSocket(status.stdout);
    const docker = async (args: readonly string[]) =>
      runner.run('docker', args, { timeoutMs: left(), env: { DOCKER_HOST: dockerHost } });

    const lock = await this.awaitImagesLock(profile, signal, left);
    if (lock.kind === 'skipped') return lock;
    const { release, ended } = lock;
    let work: { readonly kept: number } | { readonly error: unknown };
    try {
      work = { kept: await this.removeOldVersions(docker, removed) };
    } catch (error) {
      work = { error };
    }
    // The release: stdin closed, the session's exit awaited (bounded by its own timeout, the time left).
    release();
    const end = await ended;
    const sessionFailure = sessionFailureReason(end);
    if ('error' in work) {
      if (sessionFailure === undefined) throw work.error;
      throw new ContainerRuntimeError(`${(work.error as Error).message}; and ${sessionFailure}`, { cause: work.error });
    }
    if (sessionFailure !== undefined)
      throw new ContainerRuntimeError(sessionFailure, 'error' in end ? { cause: end.error } : undefined);
    return { kind: 'pruned', kept: work.kept };
  }

  /**
   * The images lock, exclusive, taken without waiting (debt-paydown-2 R3): held from `locked` until the caller
   * releases it. Resolves `skipped` when a build already holds it (colima ssh exits 5); otherwise throws if the
   * session ends before "locked" for any other reason.
   */
  private async awaitImagesLock(
    profile: string,
    signal: AbortSignal,
    left: () => number,
  ): Promise<
    | { readonly kind: 'locked'; readonly release: () => void; readonly ended: Promise<StreamEnd> }
    | { readonly kind: 'skipped'; readonly reason: string }
  > {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // Empty stdin that stays open until `release()`: not a generator (it never yields a chunk), so its own
    // AsyncIterator, whose one `next()` awaits the release and ends with no value.
    const stdin: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await released;
          return { done: true as const, value: undefined };
        },
      }),
    };
    let out = '';
    let answered!: (word: 'locked' | 'busy') => void;
    const answer = new Promise<'locked' | 'busy'>((resolve) => (answered = resolve));
    const session = this.props.runner.stream(
      'colima',
      ['ssh', '--profile', profile, '--', 'sudo', 'sh', '-c', PRUNE_LOCK_SCRIPT],
      {
        timeoutMs: left(),
        stdin,
        signal,
        onStdout: (chunk) => {
          out += chunk.toString('utf8');
          const word = /^(locked|busy)$/m.exec(out)?.[1];
          if (word === 'locked' || word === 'busy') answered(word);
          return Promise.resolve('more');
        },
      },
    );
    const ended: Promise<StreamEnd> = session.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    const first = await Promise.race([answer, ended]);
    if (first === 'locked') return { kind: 'locked', release, ended };
    release();
    const end = first === 'busy' ? await ended : first;
    if (first === 'busy' && 'result' in end && remoteExitStatus(end.result) === 5)
      return { kind: 'skipped', reason: 'a build holds the image lock' };
    throw new ContainerRuntimeError(
      `the image prune's lock session ended before "locked": ${describeStreamEnd(end)}`,
      'error' in end ? { cause: end.error } : undefined,
    );
  }

  /** Under the images lock: lists, selects and removes (R2); resolves with the count of asha versions left. */
  private async removeOldVersions(
    docker: (args: readonly string[]) => Promise<CommandResultLike>,
    removed: string[],
  ): Promise<number> {
    const rows = await this.listPrunableRows(docker);
    const now = this.props.clock().getTime();
    const { old, candidates } = selectOldAndCandidates(rows, now);
    if (old.length === 0) return rows.length;
    const used = await this.usedImageIds(docker);
    const versions = await this.inspectCandidates(docker, candidates);
    const chosen = selectPrunable(versions, used, now).slice(0, PRUNE_MAX_PER_START);
    await this.removeChosen(docker, chosen, removed);
    return rows.length - removed.length;
  }

  /** `docker image ls`, parsed and filtered to asha's repositories (and the configured filter, if any) (R2). */
  private async listPrunableRows(
    docker: (args: readonly string[]) => Promise<CommandResultLike>,
  ): Promise<ListedVersion[]> {
    const listed = await docker([
      'image',
      'ls',
      '--no-trunc',
      '--filter',
      'reference=asha-*',
      '--format',
      '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}',
    ]);
    if (listed.code !== 0) throw new ContainerRuntimeError(`docker image ls failed:\n${tailCombined(listed)}`);
    const only = this.props.pruneRepository;
    return parseImageListing(listed.stdout).filter(
      (row) => ASHA_REPOSITORY.test(row.repository) && (only === undefined || only.test(row.repository)),
    );
  }

  /** Image ids a container currently uses (R2 (f)): `docker ps` then `docker container inspect` of what it lists. */
  private async usedImageIds(docker: (args: readonly string[]) => Promise<CommandResultLike>): Promise<Set<string>> {
    const used = new Set<string>();
    const ps = await docker(['ps', '--all', '--quiet', '--no-trunc']);
    if (ps.code !== 0) throw new ContainerRuntimeError(`docker ps failed:\n${tail(ps.stderr)}`);
    const containers = ps.stdout.split('\n').filter((id) => id !== '');
    if (containers.length === 0) return used;
    const inspected = await docker(['container', 'inspect', '--format', '{{.Image}}', ...containers]);
    // A container removed since `docker ps` (one of another project's, coming and going) uses no image: Docker answers
    // exactly "No such container: <its id>" for it, and the others' images are still printed (A6's first trial). Any
    // other answer fails the prune.
    const listed = new Set(containers);
    const other = inspected.stderr
      .split('\n')
      .filter((line) => line.trim() !== '')
      .filter(
        (line) =>
          !listed.has(/^Error(?: response from daemon)?: No such container: (\S+)$/.exec(line.trim())?.[1] ?? ''),
      );
    if (inspected.code !== 0 && (other.length > 0 || inspected.stderr.trim() === '')) {
      throw new ContainerRuntimeError(
        `docker container inspect of ${String(containers.length)} container(s) failed:\n${tail(inspected.stderr)}`,
      );
    }
    for (const id of inspected.stdout.split('\n')) if (id !== '') used.add(id);
    return used;
  }

  /** `docker image inspect` of the candidates only, parsed into versions (R2). */
  private async inspectCandidates(
    docker: (args: readonly string[]) => Promise<CommandResultLike>,
    candidates: readonly ListedVersion[],
  ): Promise<ImageVersion[]> {
    const refs = candidates.map((row) => `${row.repository}:${row.tag}`);
    const inspect = await docker([
      'image',
      'inspect',
      '--format',
      '{{.Id}}\t{{.Created}}\t{{json .Config.Labels}}',
      ...refs,
    ]);
    if (inspect.code !== 0)
      throw new ContainerRuntimeError(
        `docker image inspect of ${String(refs.length)} version(s) failed:\n${tail(inspect.stderr)}`,
      );
    return parseImageInspect(inspect.stdout, candidates);
  }

  /** `docker image rm` of `chosen`, in batches of at most PRUNE_RM_BATCH; each tag Docker removes joins `removed` (R2). */
  private async removeChosen(
    docker: (args: readonly string[]) => Promise<CommandResultLike>,
    chosen: readonly ImageVersion[],
    removed: string[],
  ): Promise<void> {
    for (let i = 0; i < chosen.length; i += PRUNE_RM_BATCH) {
      const batch = chosen.slice(i, i + PRUNE_RM_BATCH).map((v) => `${v.repository}:${v.tag}`);
      // Never --force: Docker refuses a version a container uses (Q1 (c)), the backstop for one created since the listing.
      await this.removeBatch(docker, batch, removed);
    }
  }

  /** `docker image rm` of one batch: confirmed removals join `removed`; anything Docker did not report removing throws. */
  private async removeBatch(
    docker: (args: readonly string[]) => Promise<CommandResultLike>,
    batch: readonly string[],
    removed: string[],
  ): Promise<void> {
    const rm = await docker(['image', 'rm', ...batch]);
    const untagged = new Set(
      [...rm.stdout.matchAll(/^Untagged: (\S+)$/gm)].map((m) => present(m[1], "the Untagged line's capture group")),
    );
    for (const tag of batch) if (untagged.has(tag)) removed.push(tag);
    if (rm.code === 0) {
      const missing = batch.filter((tag) => !untagged.has(tag));
      if (missing.length > 0)
        throw new ContainerRuntimeError(`docker image rm exited 0 and did not report removing ${missing.join(', ')}`);
      return;
    }
    const errors = rm.stderr.split('\n').filter((line) => line.trim() !== '');
    const other = this.logRefusedAndCollectOther(errors, batch);
    if (other.length > 0)
      throw new ContainerRuntimeError(
        `docker image rm of ${String(batch.length)} version(s) exited ${String(rm.code)}:\n${tail(other.join('\n'))}`,
      );
  }

  /**
   * Classifies one batch's stderr lines (R2): each "conflict: unable to delete <tag> (must be forced)" of a tag in
   * `batch` is logged `image.prune_refused` and consumed; every other line is returned, to fail the batch.
   */
  private logRefusedAndCollectOther(errors: readonly string[], batch: readonly string[]): string[] {
    const other: string[] = [];
    for (const line of errors) {
      const conflict = /conflict: unable to delete (\S+) \(must be forced\)/.exec(line);
      const tag = conflict === null ? undefined : present(conflict[1], "the conflict regex's capture group");
      if (tag !== undefined && batch.includes(tag)) {
        this.props.logger.warn('image.prune_refused', { tag, message: line.trim() });
      } else other.push(line);
    }
    return other;
  }

  /** Runs `task` after every earlier one has settled; its own outcome goes to its caller. */
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task);
    // The queue only orders the next task; each failure is delivered to its caller through `run`.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  ensureRunning(): Promise<RuntimeReadiness> {
    return this.serialized(() => this.running());
  }

  private async ready(hostPort: number): Promise<RuntimeReadiness> {
    const outcome = await this.running();
    await this.confine(hostPort);
    return outcome;
  }

  /** colima and docker installed, colima running, the docker socket known: everything ensureReady does but confine. */
  private async running(): Promise<RuntimeReadiness> {
    const { runner, logger } = this.props;
    const colima = await ensureHostTool(runner, logger, {
      binary: 'colima',
      probeArgs: ['version'],
      formula: 'colima',
    });
    const docker = await ensureHostTool(runner, logger, {
      binary: 'docker',
      probeArgs: ['--version'],
      formula: 'docker',
    });

    let status = await this.status();
    let started = false;
    if (status.code !== 0) {
      logger.info('colima.starting', { profile: this.props.profile });
      const start = await this.colima(['start', '--profile', this.props.profile], START_TIMEOUT_MS);
      if (start.code !== 0) {
        throw new ContainerRuntimeError(`colima start --profile ${this.props.profile} failed:\n${tailCombined(start)}`);
      }
      started = true;
      status = await this.status();
      if (status.code !== 0) {
        throw new ContainerRuntimeError(`colima started but its status still fails:\n${tail(status.stderr)}`);
      }
    }
    this.dockerHost = parseDockerSocket(status.stdout);
    logger.info('colima.ready', { profile: this.props.profile, dockerHost: this.dockerHost, started });
    if (colima === 'installed' || docker === 'installed') return 'installed';
    return started ? 'started' : 'ready';
  }

  /**
   * The home's network, checked against what this daemon created (R13), and
   * one `colima ssh` that checks the VM's host address and verifies — and
   * where missing installs — the chain, the jump, the shared rejects and this
   * home's allow for `hostPort` (R12, R14).
   */
  private async confine(hostPort: number): Promise<void> {
    const started = Date.now();
    try {
      await this.confineNetwork();
    } catch (error) {
      // A docker call of the network's that passed its bound fails the confinement, naming the network (R12, R13).
      if (error instanceof ContainerIsolationFailed || !(error instanceof DockerTimedOut)) throw error;
      throw new ContainerIsolationFailed(`network ${this.network}`, error.message, { cause: error });
    }
    const result = await this.ssh(installScript(this.props.homeId, hostPort), 'rule install');
    const summary = /asha-isolation: ready jump_fixed=([01]) input_jump_fixed=([01]) home_rules_replaced=([01])/.exec(
      result,
    );
    if (summary === null)
      throw new ContainerIsolationFailed('rule install', `the script did not report its result:\n${tail(result)}`);
    this.props.logger.info('agent.isolation_ready', {
      homeId: this.props.homeId,
      network: this.network,
      hostPort,
      jumpFixed: summary[1] === '1',
      inputJumpFixed: summary[2] === '1',
      homeRulesReplaced: summary[3] === '1',
      durationMs: Date.now() - started,
    });
  }

  /** Every container of this home a dead daemon left, whatever its network — a one-shot on none included (agent-persistence R10). */
  private async removeStaleContainers(): Promise<void> {
    const labelled = await this.docker(
      ['ps', '--all', '--quiet', '--filter', `label=${HOME_LABEL}=${this.props.homeId}`],
      DOCKER_TIMEOUT_MS,
    );
    if (labelled.code !== 0)
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `docker ps of this home's containers failed:\n${tail(labelled.stderr)}`,
      );
    const leftover = labelled.stdout.split('\n').filter((id) => id !== '');
    if (leftover.length === 0) return;
    const removed = await this.docker(['rm', '--force', ...leftover], DOCKER_TIMEOUT_MS);
    if (removed.code !== 0)
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `docker rm of a dead daemon's containers failed:\n${tail(removed.stderr)}`,
      );
    this.props.logger.warn('isolation.stale_containers_removed', {
      homeId: this.props.homeId,
      containers: leftover.length,
    });
  }

  /**
   * Every volume of this home a dead daemon left (agent-files R10a): a VM stop drops containers but keeps volumes,
   * and the start's reclaim is skipped when it found colima stopped, so this sweep is the one that runs then.
   */
  private async removeStaleVolumes(): Promise<void> {
    const volumes = await this.docker(
      ['volume', 'ls', '--quiet', '--filter', `label=${HOME_LABEL}=${this.props.homeId}`],
      DOCKER_TIMEOUT_MS,
    );
    if (volumes.code !== 0)
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `docker volume ls of this home's volumes failed:\n${tail(volumes.stderr)}`,
      );
    const staleVolumes = volumes.stdout.split('\n').filter((v) => v !== '');
    if (staleVolumes.length === 0) return;
    const removed = await this.docker(['volume', 'rm', ...staleVolumes], DOCKER_TIMEOUT_MS);
    if (removed.code !== 0)
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `docker volume rm of a dead daemon's volumes failed:\n${tail(removed.stderr)}`,
      );
    this.props.logger.warn('files.stale_space_removed', { volumes: staleVolumes.length });
  }

  /** A network of this home's name a dead daemon left, with any container still on it (agent-persistence R10). */
  private async removeStaleNetwork(): Promise<void> {
    const listed = await this.docker(
      ['network', 'ls', '--filter', `name=^${this.network}$`, '--format', '{{.Name}}'],
      DOCKER_TIMEOUT_MS,
    );
    if (listed.code !== 0)
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `docker network ls failed:\n${tailCombined(listed)}`,
      );
    if (listed.stdout.trim() !== this.network) return;
    const attached = await this.docker(
      ['ps', '--all', '--quiet', '--filter', `network=${this.network}`],
      DOCKER_TIMEOUT_MS,
    );
    if (attached.code !== 0)
      throw new ContainerIsolationFailed(`network ${this.network}`, `docker ps failed:\n${tail(attached.stderr)}`);
    const ids = attached.stdout.split('\n').filter((id) => id !== '');
    if (ids.length > 0) {
      const removed = await this.docker(['rm', '--force', ...ids], DOCKER_TIMEOUT_MS);
      if (removed.code !== 0)
        throw new ContainerIsolationFailed(
          `network ${this.network}`,
          `docker rm of a dead daemon's containers failed:\n${tail(removed.stderr)}`,
        );
    }
    const gone = await this.docker(['network', 'rm', this.network], DOCKER_TIMEOUT_MS);
    if (gone.code !== 0)
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `docker network rm of a dead daemon's network failed:\n${tail(gone.stderr)}`,
      );
    this.props.logger.warn('isolation.stale_network_removed', { network: this.network, containers: ids.length });
  }

  /**
   * Creates the home's network, first removing one a dead daemon of this home
   * left (with any container on it), and records the subnet Docker allocated.
   */
  private async createHomeNetwork(): Promise<void> {
    await this.removeStaleContainers();
    await this.removeStaleVolumes();
    await this.removeStaleNetwork();
    const created = await this.docker(
      // enable_icc=false: containers on the network cannot reach each other (agent-tools completion review, finding 5);
      // without it, traffic between two containers on one bridge is never seen by an iptables rule in this VM.
      [
        'network',
        'create',
        '--driver',
        'bridge',
        '--opt',
        `com.docker.network.bridge.name=${this.bridge}`,
        '--opt',
        'com.docker.network.bridge.enable_icc=false',
        '--ipv6=false',
        this.network,
      ],
      DOCKER_TIMEOUT_MS,
    );
    if (created.code !== 0)
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `docker network create failed:\n${tailCombined(created)}`,
      );
    const network = await this.inspectNetwork();
    const mismatches = describeMismatches(network, { bridge: this.bridge, subnets: network.subnets });
    if (mismatches.length > 0 || network.subnets.length === 0) {
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `not created as asked: ${[...mismatches, ...(network.subnets.length === 0 ? ['no subnet'] : [])].join('; ')}`,
      );
    }
    this.subnets = network.subnets;
    this.props.logger.info('isolation.network_created', {
      network: this.network,
      bridge: this.bridge,
      subnets: network.subnets,
    });
  }

  private async inspectNetwork(): Promise<InspectedNetwork> {
    const inspect = await this.docker(
      ['network', 'inspect', '--format', '{{json .}}', this.network],
      DOCKER_TIMEOUT_MS,
    );
    if (inspect.code !== 0) {
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `docker network inspect failed (${RECREATE_HINT}):\n${tailCombined(inspect)}`,
      );
    }
    return parseNetworkInspect(this.network, inspect.stdout);
  }

  /**
   * Removes this home's rules, containers and network (R12, "Lifecycle"). When
   * colima is not installed or the profile is not running there is nothing to
   * remove: a VM stop drops the rules and the containers, and the network a
   * stopped VM keeps is removed before the next one is created.
   */
  private async reclaimHome(): Promise<Reclaimed> {
    let status;
    try {
      status = await this.status();
    } catch (error) {
      if (!(error instanceof CommandNotFound)) throw error;
      this.props.logger.info('isolation.reclaim_skipped', {
        homeId: this.props.homeId,
        reason: 'colima is not installed',
      });
      return { volumes: 0 };
    }
    if (status.code !== 0) {
      this.subnets = undefined;
      this.props.logger.info('isolation.reclaim_skipped', {
        homeId: this.props.homeId,
        reason: `colima profile ${this.props.profile} is not running`,
      });
      return { volumes: 0 };
    }
    const result = await this.ssh(reclaimScript(this.props.homeId), 'reclaim');
    const summary =
      /asha-isolation: reclaimed rules=(\d+) containers=(\d+) network=([01]) volumes=(\d+) networks=(\d+)/.exec(result);
    if (summary === null)
      throw new ContainerIsolationFailed('reclaim', `the script did not report its result:\n${tail(result)}`);
    this.subnets = undefined;
    const volumes = Number(summary[4]);
    this.props.logger.info('isolation.reclaimed', {
      homeId: this.props.homeId,
      rules: Number(summary[1]),
      containers: Number(summary[2]),
      network: summary[3] === '1',
      volumes,
      networks: Number(summary[5]),
    });
    return { volumes };
  }

  /** The home's network: created at the first confinement, else checked against what this daemon created (R13). */
  private async confineNetwork(): Promise<void> {
    if (this.subnets === undefined) {
      await this.createHomeNetwork();
      return;
    }
    const mismatches = describeMismatches(await this.inspectNetwork(), {
      bridge: this.bridge,
      subnets: this.subnets,
    });
    if (mismatches.length > 0) {
      throw new ContainerIsolationFailed(
        `network ${this.network}`,
        `no longer what this daemon created: ${mismatches.join('; ')}; ${RECREATE_HINT}`,
      );
    }
  }

  /**
   * Runs a script as root in the VM, sent on standard input; a non-zero exit, or the round trip passing its
   * SSH_TIMEOUT_MS bound, is ContainerIsolationFailed naming `what`.
   */
  private async ssh(script: string, what: string): Promise<string> {
    let result;
    try {
      result = await this.props.runner.run(
        'colima',
        ['ssh', '--profile', this.props.profile, '--', 'sudo', 'sh', '-s'],
        {
          timeoutMs: SSH_TIMEOUT_MS,
          stdin: script,
        },
      );
    } catch (error) {
      if (!(error instanceof CommandTimedOut)) throw error;
      throw new ContainerIsolationFailed(what, `colima ssh did not finish within ${String(SSH_TIMEOUT_MS)} ms`, {
        cause: error,
      });
    }
    const output = [result.stdout, result.stderr].filter((part) => part.trim() !== '').join('\n');
    if (result.code !== 0) {
      const named = /asha-isolation: (.*)/.exec(result.stderr)?.[1] ?? `exit ${String(result.code)}`;
      throw new ContainerIsolationFailed(what, `${named}\n${tail(output)}`);
    }
    return output;
  }

  async ensureImage(spec: ImageSpec): Promise<EnsuredImage> {
    const tag = imageTag(spec);
    // Concurrent launches of one image in this daemon share one build: a second
    // build to the same tag would replace the first's (D23).
    const inFlight = this.imageBuilds.get(tag);
    // A caller that joins another's ensureImage built nothing itself: for it, the image is current.
    if (inFlight !== undefined) {
      const joined = await inFlight;
      return { tag: joined.tag, status: 'current', labels: joined.labels };
    }
    const ensured = this.ensureTag(tag, spec).finally(() => this.imageBuilds.delete(tag));
    this.imageBuilds.set(tag, ensured);
    return ensured;
  }

  private async ensureTag(tag: string, spec: ImageSpec): Promise<EnsuredImage> {
    const found = await this.labelsOf(tag);
    // An existing tag opens no session (debt-paydown R18): the lock is only for a build.
    if (found !== undefined) return current(tag, spec, found);
    // Another daemon — of another home, or another checkout — may be building this tag now (D28): the build is made
    // under the tag's VM lock, and only if the tag is still missing once the lock is held.
    return this.underTagLock(tag, async () => {
      const again = await this.labelsOf(tag);
      if (again !== undefined) return current(tag, spec, again);
      return this.build(tag, spec);
    });
  }

  /**
   * Runs `work` holding the VM lock `/run/asha-image-<the tag's 64 hex>.lock` (debt-paydown R18, D28), through one
   * `colima ssh` session whose script takes the lock (flock -w 600), prints `locked`, and holds it until its standard
   * input closes (probe P3b: a lock held this way is released when stdin closes, or when the client dies). One lock per
   * tag, so builds of different tags never wait for each other. A lock not taken within 600 s is ImageBuildFailed
   * naming the lock; the release closes stdin and waits for the session, bounded at 30 s.
   */
  private async underTagLock<T>(tag: string, work: () => Promise<T>): Promise<T> {
    const hex = /:([0-9a-f]{64})$/.exec(tag)?.[1];
    if (hex === undefined)
      throw new Error(`image tag ${tag} does not end in a 64-hex source digest: it names no build lock`);
    const lock = imageLockFile(hex);
    const { release, ended, abort } = await this.acquireTagLock(tag, hex, lock);
    let outcome: { readonly value: T } | { readonly error: unknown };
    try {
      outcome = { value: await work() };
    } catch (error) {
      outcome = { error };
    }
    // The release: stdin closed, the session's exit awaited, bounded.
    release();
    const releaseFailure = await this.releaseTagLock(lock, ended, abort);
    if ('error' in outcome) {
      // The build's own failure is the one the caller sees; a release that failed too is recorded, never dropped.
      if (releaseFailure !== undefined)
        this.props.logger.error('image.lock_release_failed', { tag, lock, error: releaseFailure });
      throw outcome.error;
    }
    if (releaseFailure !== undefined) throw releaseFailure;
    return outcome.value;
  }

  /**
   * Takes the tag's build lock (debt-paydown R18, D28): one `colima ssh` session whose script takes the VM lock
   * (flock -w 600), prints `locked`, and holds it until its standard input closes. Resolves once "locked" is seen,
   * with the means to release it later; otherwise throws ImageBuildFailed naming why (not taken within 600 s, or
   * the session itself ending or failing first).
   */
  private async acquireTagLock(
    tag: string,
    hex: string,
    lock: string,
  ): Promise<{ readonly release: () => void; readonly ended: Promise<StreamEnd>; readonly abort: AbortController }> {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    // Empty stdin that stays open until `release()`: not a generator (it never yields a chunk), so its own
    // AsyncIterator, whose one `next()` awaits the release and ends with no value.
    const stdin: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          await released;
          return { done: true as const, value: undefined };
        },
      }),
    };
    let out = '';
    let lockedNow!: () => void;
    const locked = new Promise<void>((resolve) => (lockedNow = resolve));
    const abort = new AbortController();
    const session = this.props.runner.stream(
      'colima',
      ['ssh', '--profile', this.props.profile, '--', 'sudo', 'sh', '-c', imageLockScript(hex)],
      {
        timeoutMs: IMAGE_LOCK_SESSION_MS,
        stdin,
        signal: abort.signal,
        onStdout: (chunk) => {
          out += chunk.toString('utf8');
          if (/^locked$/m.test(out)) lockedNow();
          return Promise.resolve('more');
        },
      },
    );
    // Seen whatever the outcome: a session that ends or fails before `locked` is the lock not taken.
    const ended: Promise<StreamEnd> = session.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    let lockTimer: NodeJS.Timeout | undefined;
    const taken = await Promise.race([
      locked.then(() => 'locked' as const),
      ended.then((end) => ({ end })),
      new Promise<'timeout'>(
        (resolve) =>
          (lockTimer = setTimeout(() => {
            resolve('timeout');
          }, IMAGE_LOCK_TAKEN_MS)),
      ),
    ]);
    clearTimeout(lockTimer);
    if (taken === 'locked') return { release, ended, abort };
    release();
    abort.abort(new Error('the build lock was not taken'));
    const end = taken === 'timeout' ? await ended : taken.end;
    // Exit 6: the images lock (an image prune held it, debt-paydown-2 R3); any other end names the tag's lock.
    if (taken !== 'timeout' && 'result' in end && remoteExitStatus(end.result) === 6) {
      throw new ImageBuildFailed(
        tag,
        `the build lock ${IMAGES_LOCK_FILE} was not taken: colima ssh exited 6 (an image prune held it for 30 s): ${tail(end.result.stderr)}`,
      );
    }
    throw new ImageBuildFailed(
      tag,
      `the build lock ${lock} was not taken: ${lockNotTakenReason(taken === 'timeout', end)}`,
    );
  }

  /** Awaits the lock session's end, bounded; the failure to report, if the release or the session itself failed. */
  private async releaseTagLock(
    lock: string,
    ended: Promise<StreamEnd>,
    abort: AbortController,
  ): Promise<Error | undefined> {
    let releaseTimer: NodeJS.Timeout | undefined;
    const end = await Promise.race([
      ended,
      new Promise<'timeout'>(
        (resolve) =>
          (releaseTimer = setTimeout(() => {
            resolve('timeout');
          }, IMAGE_LOCK_RELEASE_MS)),
      ),
    ]);
    clearTimeout(releaseTimer);
    if (end === 'timeout') {
      abort.abort(new Error('the build lock session did not end'));
      await ended;
      return new ContainerRuntimeError(
        `the build lock ${lock}'s colima ssh session did not end within ${String(IMAGE_LOCK_RELEASE_MS)} ms of its release; killed`,
      );
    }
    if ('error' in end)
      return new ContainerRuntimeError(
        `the build lock ${lock}'s colima ssh session failed: ${(end.error as Error).message}`,
        {
          cause: end.error,
        },
      );
    if (end.result.code !== 0)
      return new ContainerRuntimeError(
        `the build lock ${lock}'s colima ssh session exited ${String(end.result.code)}: ${tail(end.result.stderr)}`,
      );
    return undefined;
  }

  /** Builds a missing tag (under its lock). */
  private async build(tag: string, spec: ImageSpec): Promise<EnsuredImage> {
    this.props.logger.info('image.building', { tag, sourceDigest: spec.sourceDigest });
    // --network=none: a build step reaches no network (docs/plans/otel-traces.md R8); the images only copy
    // what staging put in the context. Pulling the pinned base image is the daemon's, not a step's.
    const labels = Object.entries(spec.labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
    // Build arguments (extension-modules R28): each one's name and value are in the source digest, hence the tag.
    const buildArgs = Object.entries(spec.buildArgs ?? {}).flatMap(([key, value]) => [
      '--build-arg',
      `${key}=${value}`,
    ]);
    let build;
    try {
      build = await this.docker(
        [
          'build',
          '--network=none',
          '--label',
          `${SOURCE_LABEL}=${spec.sourceDigest}`,
          ...labels,
          ...buildArgs,
          '--tag',
          tag,
          spec.contextDir,
        ],
        BUILD_TIMEOUT_MS,
      );
    } catch (error) {
      if (!(error instanceof DockerTimedOut)) throw error;
      throw new ImageBuildFailed(tag, `docker build did not finish within ${String(BUILD_TIMEOUT_MS)} ms`, {
        cause: error,
      });
    }
    if (build.code !== 0) throw new ImageBuildFailed(tag, tail(`${build.stdout}\n${build.stderr}`, 40));
    // The labels as the built image carries them: what an erase re-checks (R16) is the image's word, not the spec's.
    const built = await this.labelsOf(tag);
    if (built === undefined)
      throw new ContainerRuntimeError(`docker build of ${tag} exited 0, and the image is not there`);
    return { tag, status: 'built', labels: built };
  }

  /** An image's labels, or undefined when there is no such image; any other inspect failure throws. */
  private async labelsOf(tag: string): Promise<Record<string, string> | undefined> {
    const inspect = await this.docker(
      ['image', 'inspect', '--format', '{{ json .Config.Labels }}', tag],
      DOCKER_TIMEOUT_MS,
    );
    if (inspect.code !== 0) {
      if (/No such image/i.test(inspect.stderr)) return undefined;
      throw new ContainerRuntimeError(`docker image inspect ${tag} failed:\n${tailCombined(inspect)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(inspect.stdout);
    } catch (error) {
      throw new ContainerRuntimeError(
        `docker image inspect ${tag} printed labels that are not JSON: ${inspect.stdout.slice(0, 200)}`,
        { cause: error },
      );
    }
    // An image built with no label at all prints null.
    if (parsed === null) return {};
    if (
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !Object.values(parsed).every((v) => typeof v === 'string')
    ) {
      throw new ContainerRuntimeError(
        `docker image inspect ${tag} printed labels that are not an object of strings: ${inspect.stdout.slice(0, 200)}`,
      );
    }
    return parsed as Record<string, string>;
  }

  start(spec: ContainerSpec): { readonly exited: Promise<number> } {
    if (this.subnets === undefined) throw new Error('ColimaRuntime.start before ensureReady confined its containers');
    const dockerHost = this.requireDockerHost();
    const envArgs = Object.keys(spec.env).flatMap((key) => ['-e', key]);
    const state = { stopped: false };
    this.starting.set(spec.name, state);
    /** A stop that arrived while creating or copying: the created container is removed and never started. */
    const removeIfStopped = async (): Promise<void> => {
      if (!state.stopped) return;
      const removed = await this.props.runner.run('docker', ['rm', '--force', spec.name], {
        timeoutMs: DOCKER_TIMEOUT_MS,
        env: { DOCKER_HOST: dockerHost },
      });
      if (removed.code !== 0)
        throw new ContainerRuntimeError(
          `${spec.name} was stopped before it started, and docker rm --force failed: ${removed.stderr.trim()}`,
        );
      throw new ContainerStoppedBeforeStart(spec.name);
    };
    if (spec.archive !== undefined && spec.files.length > 0)
      throw new Error(`start ${spec.name}: a restore archive carries the documents itself; files must be []`);
    const exited = (async (): Promise<number> => {
      // The home's network, and nothing that widens a container's reach: no --ip, --cap-add, --privileged or
      // host network. --rm: removed as it exits. `-e KEY` takes its value from this command's environment. The home's
      // label: a clean-up finds it whatever its network (agent-persistence R10).
      // The channel's file space at /channel (agent-files R10): the only mount. --dns and --add-host (debt-paydown R1,
      // D18): no outside name resolves, and host.docker.internal, which then no DNS answers, comes from /etc/hosts.
      // --pull never (debt-paydown-2 R5): a tag another server's prune removed fails here, never asks a registry.
      const created = await this.props.runner.run(
        'docker',
        [
          'create',
          '--pull',
          'never',
          '--rm',
          '--name',
          spec.name,
          '--network',
          this.network,
          '--dns',
          AGENT_DNS_SERVER,
          '--add-host',
          `host.docker.internal:${HOST_GATEWAY}`,
          '--label',
          `${HOME_LABEL}=${this.props.homeId}`,
          '-v',
          `${spec.channelVolume}:/channel`,
          ...envArgs,
          spec.image,
        ],
        {
          timeoutMs: DOCKER_TIMEOUT_MS,
          env: { ...spec.env, DOCKER_HOST: dockerHost },
        },
      );
      if (created.code !== 0)
        throw (
          this.imageGone(spec.image, created.stderr) ??
          new ContainerRuntimeError(`docker create ${spec.name} failed:\n${tailCombined(created)}`)
        );
      await removeIfStopped();
      await this.copyIntoCreated(spec, dockerHost);
      await removeIfStopped();
      // No await between the last check and the launch: a stop from here on reaches a started container.
      this.starting.delete(spec.name);
      const child = this.props.launcher.launch('docker', ['start', '--attach', spec.name], {
        env: { DOCKER_HOST: dockerHost },
        logFile: spec.logFile,
      });
      const exit = await child.exited;
      if (exit.code === null)
        throw new ContainerRuntimeError(
          `docker start ${spec.name} was killed by ${exit.signal ?? 'an unknown signal'}`,
        );
      return exit.code;
    })();
    // However the start ends, its container is no longer between create and start.
    void exited.then(
      () => this.starting.delete(spec.name),
      () => this.starting.delete(spec.name),
    );
    return { exited };
  }

  stop(name: string, mode: 'drain', graceS: number): Promise<void>;
  stop(name: string, mode: 'kill'): Promise<void>;
  async stop(name: string, mode: StopMode, graceS?: number): Promise<void> {
    if (mode === 'drain' && (graceS === undefined || !Number.isInteger(graceS) || graceS < 0))
      throw new Error(`stop ${name} drain needs its grace in whole seconds, not ${String(graceS)}`);
    // A container still being created or given its files is removed by start, never started (ContainerStoppedBeforeStart).
    const pending = this.starting.get(name);
    if (pending !== undefined) pending.stopped = true;
    // docker stop waits out the grace itself, so its own bound is the grace plus the usual command bound.
    const seconds = mode === 'drain' ? present(graceS, 'graceS, validated above when mode is drain') : 0;
    const result = await this.docker(['stop', '--timeout', String(seconds), name], seconds * 1_000 + DOCKER_TIMEOUT_MS);
    // The container is already gone: it exited, and `docker create --rm` removed it, racing this call.
    if (result.code !== 0 && !/No such container/i.test(result.stderr)) {
      throw new ContainerRuntimeError(
        `docker stop --timeout ${String(seconds)} ${name} failed: ${result.stderr.trim()}`,
      );
    }
  }

  async copyOut(
    name: string,
    path: string,
    onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>,
    signal?: AbortSignal,
  ): Promise<CopyOutcome> {
    return this.copyFrom(name, path, onChunk, this.requireDockerHost(), signal);
  }

  private async copyFrom(
    name: string,
    path: string,
    onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>,
    dockerHost: string,
    signal?: AbortSignal,
  ): Promise<CopyOutcome> {
    let result;
    try {
      result = await this.props.runner.stream('docker', ['cp', `${name}:${path}`, '-'], {
        timeoutMs: DOCKER_TIMEOUT_MS,
        env: { DOCKER_HOST: dockerHost },
        onStdout: onChunk,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      // A copy past its own bound is an expected failure: data (R6's copy_failed). An abort is the caller's own bound: its to handle.
      if (error instanceof CommandTimedOut) return { ok: false, detail: error.message };
      throw error;
    }
    // Stopped by the reader (a bound reached, an entry refused): the reader has the reason.
    if (result.stopped) return { ok: true };
    if (result.code !== 0)
      return { ok: false, detail: `docker cp ${name}:${path} - exited ${String(result.code)}: ${tail(result.stderr)}` };
    return { ok: true };
  }

  /**
   * start()'s copy into the created container: the saved state's root archive, or the recipe's documents into
   * /workspace. Created but never started, a container is not removed by --rm, and it mounts the channel's volume,
   * which its stop could then not remove: so any failed copy — exited non-zero, or thrown (its bound passed, its
   * input unreadable) — removes it (bounded), and fails naming the copy (recipes.md; R1-RELIABILITY-001).
   */
  private async copyIntoCreated(spec: ContainerSpec, dockerHost: string): Promise<void> {
    const what =
      spec.archive === undefined
        ? `docker cp of ${String(spec.files.length)} file(s) into ${spec.name}:${WORKSPACE_DIR}`
        : `docker cp of the saved state into ${spec.name}:/`;
    if (spec.archive === undefined && spec.files.length === 0) return;
    let failure: { readonly detail: string; readonly cause?: unknown } | undefined;
    try {
      const detail =
        spec.archive === undefined
          ? await this.copyDocuments(spec, dockerHost)
          : await this.restore(spec.name, spec.archive, dockerHost);
      if (detail !== undefined) failure = { detail };
    } catch (error) {
      failure = { detail: error instanceof Error ? error.message : String(error), cause: error };
    }
    if (failure === undefined) return;
    let leftover = '';
    try {
      const removed = await this.props.runner.run('docker', ['rm', '--force', spec.name], {
        timeoutMs: DOCKER_TIMEOUT_MS,
        env: { DOCKER_HOST: dockerHost },
      });
      if (removed.code !== 0) leftover = `; and docker rm --force ${spec.name} failed too: ${removed.stderr.trim()}`;
    } catch (error) {
      leftover = `; and docker rm --force ${spec.name} failed too: ${error instanceof Error ? error.message : String(error)}`;
    }
    throw new ContainerRuntimeError(
      `${what} failed:\n${failure.detail}${leftover}`,
      failure.cause === undefined ? undefined : { cause: failure.cause },
    );
  }

  /** The recipe's documents into a created container's /workspace; undefined when it succeeded, else the copy's output. */
  private async copyDocuments(spec: ContainerSpec, dockerHost: string): Promise<string | undefined> {
    // -a keeps each entry's owner from the archive: the agent's user, so its file tools can edit its copy (R3, R4).
    const copied = await this.props.runner.run('docker', ['cp', '-a', '-', `${spec.name}:${WORKSPACE_DIR}`], {
      timeoutMs: DOCKER_TIMEOUT_MS,
      env: { DOCKER_HOST: dockerHost },
      stdin: workspaceArchive(spec.files, AGENT_WORKSPACE_OWNER, Math.floor(this.props.clock().getTime() / 1000)),
    });
    return copied.code === 0 ? undefined : tailCombined(copied);
  }

  /**
   * Streams a root archive into a created container — one tar into /, from the stored files (agent-persistence R11);
   * -a keeps each entry's owner, 1000 — undefined when it succeeded, else the copy's output.
   */
  private async restore(
    name: string,
    archive: () => AsyncIterable<Uint8Array>,
    dockerHost: string,
  ): Promise<string | undefined> {
    const copied = await this.props.runner.stream('docker', ['cp', '-a', '-', `${name}:/`], {
      timeoutMs: DOCKER_TIMEOUT_MS,
      env: { DOCKER_HOST: dockerHost },
      stdin: archive(),
    });
    return copied.code === 0 ? undefined : tail(copied.stderr);
  }

  oneShot(spec: OneShotSpec): OneShot {
    const dockerHost = this.requireDockerHost();
    const docker = (args: readonly string[]) =>
      this.props.runner.run('docker', args, { timeoutMs: DOCKER_TIMEOUT_MS, env: { DOCKER_HOST: dockerHost } });
    return {
      run: async () => {
        // No --rm (R10's one stated exception: its /memory is copied after it exits), no network, no environment.
        // Its arguments can name a user (R16's erase-user --user): a timeout names the container, never its command line (R15).
        let created;
        try {
          created = await docker([
            'create',
            '--pull',
            'never',
            '--name',
            spec.name,
            '--network',
            'none',
            '--label',
            `${HOME_LABEL}=${this.props.homeId}`,
            spec.image,
            ...spec.args,
          ]);
        } catch (error) {
          if (!(error instanceof CommandTimedOut)) throw error;
          throw new ContainerRuntimeError(
            `docker create ${spec.name} did not finish within ${String(error.timeoutMs)} ms`,
          );
        }
        if (created.code !== 0)
          throw (
            this.imageGone(spec.image, created.stderr) ??
            new ContainerRuntimeError(`docker create ${spec.name} failed:\n${tailCombined(created)}`)
          );
        const copied = await this.restore(spec.name, spec.archive, dockerHost);
        if (copied !== undefined)
          throw new ContainerRuntimeError(`docker cp of the saved state into ${spec.name}:/ failed:\n${copied}`);
        let stdout = Buffer.alloc(0);
        let overflow = false;
        let started;
        try {
          started = await this.props.runner.stream('docker', ['start', '--attach', spec.name], {
            timeoutMs: spec.timeoutMs,
            env: { DOCKER_HOST: dockerHost },
            // Its standard error only in its log file, never an event (R16).
            stderrFile: spec.logFile,
            onStdout: (chunk) => {
              // Read to the end, so the container is never blocked on a full pipe; only the first bytes are kept.
              if (stdout.length + chunk.length > spec.maxStdoutBytes) overflow = true;
              if (stdout.length <= spec.maxStdoutBytes)
                stdout = Buffer.concat([stdout, chunk]).subarray(0, spec.maxStdoutBytes + 1);
              return Promise.resolve('more');
            },
          });
        } catch (error) {
          if (!(error instanceof CommandTimedOut)) throw error;
          // The attached client was killed at the bound; the container is killed now.
          const killed = await docker(['stop', '--timeout', '0', spec.name]);
          if (killed.code !== 0 && !/No such container/i.test(killed.stderr))
            throw new ContainerRuntimeError(`docker stop --timeout 0 ${spec.name} failed: ${killed.stderr.trim()}`);
          return { kind: 'timeout' };
        }
        return {
          kind: 'exited',
          code: started.code,
          stdout: stdout.subarray(0, spec.maxStdoutBytes).toString('utf8'),
          overflow,
        };
      },
      copyOut: (path, onChunk) => this.copyFrom(spec.name, path, onChunk, dockerHost),
      remove: async () => {
        const removed = await docker(['rm', '--force', spec.name]);
        if (removed.code !== 0 && !/No such container/i.test(removed.stderr))
          throw new ContainerRuntimeError(`docker rm --force ${spec.name} failed: ${removed.stderr.trim()}`);
      },
    };
  }

  async createVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void> {
    const result = await this.docker(['volume', 'create', ...labelArgs(labels), name], DOCKER_TIMEOUT_MS);
    if (result.code !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      throw new ContainerRuntimeError(`docker volume create ${name} failed:\n${tail(combined)}`);
    }
  }

  async volumeLabel(name: string, key: string): Promise<string> {
    const result = await this.docker(
      ['volume', 'inspect', '--format', `{{index .Labels "${key}"}}`, name],
      DOCKER_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      throw new ContainerRuntimeError(`docker volume inspect ${name} failed:\n${tail(combined)}`);
    }
    // A label the volume does not carry prints "<no value>".
    const value = result.stdout.trim();
    return value === '<no value>' ? '' : value;
  }

  async createHolder(spec: HolderSpec): Promise<void> {
    // Never started; no pull (the image is the launched agent's, present because the launch built it); no network.
    const result = await this.docker(
      [
        'create',
        '--pull',
        'never',
        '--name',
        spec.name,
        '--network',
        'none',
        '--entrypoint',
        'true',
        ...labelArgs(spec.labels),
        '-v',
        `${spec.volume}:/channel`,
        spec.image,
      ],
      DOCKER_TIMEOUT_MS,
    );
    if (result.code !== 0) {
      const combined = `${result.stdout}\n${result.stderr}`.trim();
      throw (
        this.imageGone(spec.image, result.stderr) ??
        new ContainerRuntimeError(`docker create ${spec.name} failed:\n${tail(combined)}`)
      );
    }
  }

  async removeContainer(name: string): Promise<void> {
    const result = await this.docker(['rm', '--force', name], DOCKER_TIMEOUT_MS);
    if (result.code !== 0 && !/No such container/i.test(result.stderr))
      throw new ContainerRuntimeError(`docker rm --force ${name} failed: ${result.stderr.trim()}`);
  }

  async removeVolume(name: string): Promise<void> {
    const result = await this.docker(['volume', 'rm', name], DOCKER_TIMEOUT_MS);
    if (result.code !== 0 && !/no such volume/i.test(result.stderr))
      throw new ContainerRuntimeError(`docker volume rm ${name} failed: ${result.stderr.trim()}`);
  }

  async copyIn(name: string, archive: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<DockerOutcome> {
    try {
      const result = await this.props.runner.stream('docker', ['cp', '-', `${name}:/`], {
        timeoutMs: DOCKER_TIMEOUT_MS,
        env: { DOCKER_HOST: this.requireDockerHost() },
        stdin: archive,
        ...(signal === undefined ? {} : { signal }),
      });
      return { kind: 'exited', code: result.code, stderr: tail(result.stderr) };
    } catch (error) {
      if (error instanceof CommandTimedOut) return { kind: 'timeout' };
      throw error;
    }
  }

  async rollback(spec: RollbackSpec, signal?: AbortSignal): Promise<DockerOutcome> {
    // The folder goes into a root shell's rm -rf: only exactly an upload's folder name is ever passed (R3a).
    if (!/^upload-[0-9a-f]{16}$/.test(spec.folder))
      throw new Error(`rollback of ${JSON.stringify(spec.folder)}: not an upload's folder`);
    return this.spaceOneShot(spec, ['rm', spec.image, '-rf', '--', `/channel/${spec.folder}`], signal);
  }

  async emptySpace(spec: EmptySpaceSpec, signal?: AbortSignal): Promise<DockerOutcome> {
    // One fixed command, nothing interpolated: the three globs match every name but `.` and `..` (POSIX sh; probed
    // in the agent image's busybox sh, 2026-10-17), and a glob matching nothing is a name rm -f ignores.
    return this.spaceOneShot(
      spec,
      ['sh', spec.image, '-c', 'rm -rf -- /channel/* /channel/.[!.]* /channel/..?*'],
      signal,
    );
  }

  /**
   * A root one-shot of the holder's image on a space's volume (R3a's rollback, R15's emptying): `--rm --pull never
   * --network none --user 0:0`, the home's label, the volume at /channel, then `--entrypoint` and `command`.
   */
  private async spaceOneShot(
    spec: { readonly volume: string },
    command: readonly [entrypoint: string, image: string, ...args: string[]],
    signal: AbortSignal | undefined,
  ): Promise<DockerOutcome> {
    try {
      const result = await this.props.runner.stream(
        'docker',
        [
          'run',
          '--rm',
          '--pull',
          'never',
          '--network',
          'none',
          '--user',
          '0:0',
          '--label',
          `${HOME_LABEL}=${this.props.homeId}`,
          '-v',
          `${spec.volume}:/channel`,
          '--entrypoint',
          ...command,
        ],
        {
          timeoutMs: DOCKER_TIMEOUT_MS,
          env: { DOCKER_HOST: this.requireDockerHost() },
          ...(signal === undefined ? {} : { signal }),
        },
      );
      return { kind: 'exited', code: result.code, stderr: tail(result.stderr) };
    } catch (error) {
      if (error instanceof CommandTimedOut) return { kind: 'timeout' };
      throw error;
    }
  }

  async vmArchitecture(): Promise<string> {
    const result = await this.colima(['ssh', '--profile', this.props.profile, '--', 'uname', '-m'], SSH_TIMEOUT_MS);
    if (result.code !== 0) throw new ContainerRuntimeError(`colima ssh -- uname -m failed:\n${tailCombined(result)}`);
    const arch = result.stdout.trim();
    if (!/^[a-z0-9_]+$/.test(arch))
      throw new ContainerRuntimeError(
        `colima ssh -- uname -m printed ${JSON.stringify(arch.slice(0, 80))}, not an architecture`,
      );
    return arch;
  }

  async engineVersion(): Promise<string> {
    const result = await this.docker(['version', '--format', '{{.Server.Version}}'], DOCKER_TIMEOUT_MS);
    if (result.code !== 0) throw new ContainerRuntimeError(`docker version failed:\n${tailCombined(result)}`);
    return result.stdout.trim();
  }

  async createNetwork(spec: NetworkSpec): Promise<void> {
    if (spec.bridge !== undefined && !/^(asha[a-z]?[0-9a-f]{8}|asham[0-9a-f]{10})$/.test(spec.bridge))
      throw new Error(`bridge ${JSON.stringify(spec.bridge)}: not an asha bridge name`);
    const args = [
      'network',
      'create',
      '--driver',
      'bridge',
      ...(spec.internal ? ['--internal'] : []),
      ...(spec.bridge === undefined ? [] : ['--opt', `com.docker.network.bridge.name=${spec.bridge}`]),
      '--ipv6=false',
      '--label',
      `${HOME_LABEL}=${this.props.homeId}`,
      ...labelArgs(spec.labels),
      spec.name,
    ];
    const result = await this.docker(args, DOCKER_TIMEOUT_MS);
    if (result.code !== 0)
      throw new ContainerRuntimeError(`docker network create ${spec.name} failed:\n${tailCombined(result)}`);
  }

  async removeNetwork(name: string): Promise<void> {
    const result = await this.docker(['network', 'rm', name], DOCKER_TIMEOUT_MS);
    if (result.code !== 0 && !/not found|No such network/i.test(result.stderr))
      throw new ContainerRuntimeError(`docker network rm ${name} failed: ${result.stderr.trim()}`);
  }

  async installEgressRules(bridge: string): Promise<void> {
    const out = await this.ssh(egressRulesScript(this.props.homeId, bridge, 'install'), 'egress rule install');
    const summary = /asha-egress: ready inserted=(\d+)/.exec(out);
    if (summary === null)
      throw new ContainerIsolationFailed('egress rule install', `the script did not report its result:\n${tail(out)}`);
    this.props.logger.info('egress.rules_ready', { homeId: this.props.homeId, bridge, inserted: Number(summary[1]) });
  }

  async verifyEgressRules(bridge: string): Promise<void> {
    const out = await this.ssh(egressRulesScript(this.props.homeId, bridge, 'verify'), 'egress rule verify');
    if (!/asha-egress: verified/.test(out))
      throw new ContainerIsolationFailed('egress rule verify', `the script did not report its result:\n${tail(out)}`);
  }

  runAttached(spec: AttachedSpec): AttachedContainer {
    const dockerHost = this.requireDockerHost();
    const envArgs = containerEnvArgs(spec.env);
    // Docker's own refusal of a removed tag, seen on its standard error (debt-paydown-2 R5).
    let gone = false;
    const child = this.props.interactive.launchInteractive(
      'docker',
      [
        'run',
        '--pull',
        'never',
        '--interactive',
        '--rm',
        '--name',
        spec.name,
        '--network',
        spec.network,
        '--label',
        `${HOME_LABEL}=${this.props.homeId}`,
        ...labelArgs(spec.labels),
        ...MODULE_LIMITS,
        '--memory',
        '512m',
        '--read-only',
        '--tmpfs',
        '/tmp:rw,size=64m',
        ...envArgs,
        spec.image,
      ],
      {
        env: { ...spec.env, DOCKER_HOST: dockerHost },
        onStdout: spec.onStdout,
        onStderrLine: (line) => {
          if (line.includes(`No such image: ${spec.image}`)) gone = true;
          spec.onStderrLine(line);
        },
      },
    );
    return {
      exited: child.exited.then((exit) => {
        if (gone)
          throw present(
            this.imageGone(spec.image, `No such image: ${spec.image}`),
            'imageGone, given exactly the stderr line it matches on',
          );
        return exit.code;
      }),
      write: (line) => child.write(line),
      remove: async () => {
        const removed = await this.docker(['rm', '--force', spec.name], DOCKER_TIMEOUT_MS);
        if (removed.code !== 0 && !/No such container/i.test(removed.stderr))
          throw new ContainerRuntimeError(`docker rm --force ${spec.name} failed: ${removed.stderr.trim()}`);
        child.end();
      },
    };
  }

  async connectNetwork(network: string, container: string, alias: string): Promise<string> {
    const connected = await this.docker(
      ['network', 'connect', '--alias', alias, network, container],
      DOCKER_TIMEOUT_MS,
    );
    if (connected.code !== 0)
      throw new ContainerRuntimeError(
        `docker network connect ${network} ${container} failed:\n${tail(connected.stderr)}`,
      );
    const inspect = await this.docker(
      ['inspect', '--format', `{{json .NetworkSettings.Networks}}`, container],
      DOCKER_TIMEOUT_MS,
    );
    if (inspect.code !== 0)
      throw new ContainerRuntimeError(`docker inspect ${container} failed:\n${tail(inspect.stderr)}`);
    let networks: unknown;
    try {
      networks = JSON.parse(inspect.stdout);
    } catch (error) {
      throw new ContainerRuntimeError(
        `docker inspect ${container} printed networks that are not JSON: ${inspect.stdout.slice(0, 200)}`,
        { cause: error },
      );
    }
    const address = (networks as Record<string, { IPAddress?: unknown }> | null)?.[network]?.IPAddress;
    if (typeof address !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(address))
      throw new ContainerRuntimeError(`${container} has no IPv4 address on ${network} after connecting it`);
    return address;
  }

  async disconnectNetwork(network: string, container: string): Promise<void> {
    const result = await this.docker(['network', 'disconnect', '--force', network, container], DOCKER_TIMEOUT_MS);
    if (result.code !== 0 && !/not found|No such|is not connected/i.test(result.stderr))
      throw new ContainerRuntimeError(
        `docker network disconnect ${network} ${container} failed: ${result.stderr.trim()}`,
      );
  }

  pluginContainer(spec: PluginSpec): PluginContainer {
    const dockerHost = this.requireDockerHost();
    const env = { DOCKER_HOST: dockerHost };
    const bounded = (timeoutMs: number) => Math.max(1, Math.min(timeoutMs, DOCKER_TIMEOUT_MS));
    return {
      create: async (signal) => {
        // The program reaches out only through the egress proxy (R6 (b)), whatever its manifest says.
        const envArgs = [
          ...containerEnvArgs(spec.env),
          ...Object.entries(PLUGIN_PROXY_ENV).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        ];
        let result;
        try {
          result = await this.props.runner.stream(
            'docker',
            [
              'create',
              '--pull',
              'never',
              '--name',
              spec.name,
              '--network',
              spec.network,
              '--label',
              `${HOME_LABEL}=${this.props.homeId}`,
              ...labelArgs(spec.labels),
              ...MODULE_LIMITS,
              '--memory',
              '1g',
              ...envArgs,
              '--entrypoint',
              spec.entrypoint,
              spec.image,
              ...spec.args,
            ],
            { timeoutMs: DOCKER_TIMEOUT_MS, env: { ...spec.env, ...env }, signal },
          );
        } catch (error) {
          // The command line holds the call's arguments, which no harness line may (modules.md): a timeout names the
          // container and its bound, with no cause, as the one-shot's does (R1-SECURITY-002).
          if (!(error instanceof CommandTimedOut)) throw error;
          throw new ContainerRuntimeError(
            `docker create ${spec.name} did not finish within ${String(DOCKER_TIMEOUT_MS)} ms`,
          );
        }
        if (result.code !== 0)
          throw (
            this.imageGone(spec.image, result.stderr) ??
            new ContainerRuntimeError(`docker create ${spec.name} failed:\n${tail(result.stderr)}`)
          );
      },
      copyIn: async (archive, timeoutMs, signal) => {
        try {
          const result = await this.props.runner.stream('docker', ['cp', '-a', '-', `${spec.name}:/`], {
            timeoutMs: bounded(timeoutMs),
            env,
            stdin: archive,
            signal,
          });
          return { kind: 'exited', code: result.code, stderr: tail(result.stderr) };
        } catch (error) {
          if (error instanceof CommandTimedOut) return { kind: 'timeout' };
          throw error;
        }
      },
      run: async (timeoutMs, maxBytes, signal) => {
        const out = new BoundedCapture(maxBytes);
        const err = new BoundedCapture(maxBytes);
        try {
          const result = await this.props.runner.stream('docker', ['start', '--attach', spec.name], {
            timeoutMs: Math.max(1, timeoutMs),
            env,
            signal,
            onStdout: (chunk) => {
              out.add(chunk);
              return Promise.resolve('more');
            },
            onStderr: (chunk) => {
              err.add(chunk);
            },
          });
          return {
            kind: 'exited',
            code: result.code,
            stdout: out.kept(),
            stderr: err.kept(),
            stdoutBytes: out.total,
            stderrBytes: err.total,
          };
        } catch (error) {
          if (!(error instanceof CommandTimedOut)) throw error;
          return { kind: 'timeout' };
        }
      },
      copyOut: async (path, onChunk, timeoutMs, signal) => {
        try {
          const result = await this.props.runner.stream('docker', ['cp', `${spec.name}:${path}`, '-'], {
            timeoutMs: bounded(timeoutMs),
            env,
            onStdout: onChunk,
            signal,
          });
          if (result.stopped) return { ok: true };
          if (result.code !== 0)
            return {
              ok: false,
              detail: `docker cp ${spec.name}:${path} - exited ${String(result.code)}: ${tail(result.stderr)}`,
            };
          return { ok: true };
        } catch (error) {
          if (error instanceof CommandTimedOut) return { ok: false, detail: error.message };
          throw error;
        }
      },
      remove: async () => {
        const removed = await this.docker(['rm', '--force', spec.name], DOCKER_TIMEOUT_MS);
        if (removed.code !== 0 && !/No such container/i.test(removed.stderr))
          throw new ContainerRuntimeError(`docker rm --force ${spec.name} failed: ${removed.stderr.trim()}`);
      },
    };
  }

  /**
   * ImageGone, logged `image.gone`, when a create or run failed with Docker's `No such image: <tag>` for exactly the tag
   * it was given (debt-paydown-2 R5); undefined for any other failure.
   */
  private imageGone(tag: string, stderr: string): ImageGone | undefined {
    if (!stderr.includes(`No such image: ${tag}`)) return undefined;
    this.props.logger.warn('image.gone', { tag });
    return new ImageGone(tag);
  }

  private status() {
    return this.colima(['status', '--profile', this.props.profile, '--json'], STATUS_TIMEOUT_MS);
  }

  /** A colima command, bounded; passing its bound is ContainerRuntimeError naming it — its arguments hold no call's (R1-DOCS-006). */
  private async colima(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    try {
      return await this.props.runner.run('colima', args, { timeoutMs });
    } catch (error) {
      if (!(error instanceof CommandTimedOut)) throw error;
      throw new ContainerRuntimeError(`colima ${args.join(' ')} did not finish within ${String(timeoutMs)} ms`, {
        cause: error,
      });
    }
  }

  /**
   * A docker command against colima's socket, bounded; passing its bound is DockerTimedOut naming the command but
   * never its arguments, which may hold a plugin call's (R1-DOCS-006, R1-SECURITY-002).
   */
  private async docker(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    const env = { DOCKER_HOST: this.requireDockerHost() };
    try {
      return await this.props.runner.run('docker', args, { timeoutMs, env });
    } catch (error) {
      if (!(error instanceof CommandTimedOut)) throw error;
      throw new DockerTimedOut(commandName(args, 2), timeoutMs);
    }
  }

  private requireDockerHost(): string {
    if (this.dockerHost === undefined) {
      throw new Error('ColimaRuntime used before ensureReady(); the docker socket is unknown');
    }
    return this.dockerHost;
  }
}

// The egress proxy's own alias and port (modules/host.ts PROXY_ALIAS, egress-proxy/proxy.ts PROXY_PORT): a plain
// HTTP CONNECT to the proxy itself, which then tunnels the plugin's https:// traffic on — not a cleartext network
// target of its own.
const EGRESS_PROXY_HOST = 'asha-egress';
const EGRESS_PROXY_PORT = 3128;
const EGRESS_PROXY_URL = `http://${EGRESS_PROXY_HOST}:${String(EGRESS_PROXY_PORT)}`;

/** A command plugin's container's proxy (R6 (b)): the egress proxy by the alias every module network gives it. */
const PLUGIN_PROXY_ENV = {
  HTTPS_PROXY: EGRESS_PROXY_URL,
  HTTP_PROXY: EGRESS_PROXY_URL,
} as const;

/**
 * `-e NAME` for each of a container's variables, whose values the docker CLI reads from its own environment (never its
 * argument list, which a process listing shows). A name the CLI itself, or the harness, uses would change what the
 * host runs: the manifest schema refuses those, and this refuses them again (review of 2026-10-02, finding H1).
 */
function containerEnvArgs(env: Readonly<Record<string, string>>): string[] {
  const reserved = Object.keys(env).filter(reservedVariableName);
  if (reserved.length > 0)
    throw new ContainerRuntimeError(
      `a container's variables may not include ${reserved.join(', ')}: the docker CLI or the harness uses those names`,
    );
  return Object.keys(env).flatMap((key) => ['-e', key]);
}

/**
 * The limits every module, proxy and plugin container is created with (extension-modules R5), besides its memory:
 * no capability, no privilege gained through exec, at most 256 processes, one CPU.
 */
const MODULE_LIMITS = [
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '256',
  '--cpus',
  '1',
] as const;

/** The first `max` bytes of a stream, and how many bytes it carried in all. */
class BoundedCapture {
  private readonly parts: Buffer[] = [];
  private held = 0;
  total = 0;
  constructor(private readonly max: number) {}
  add(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.held >= this.max) return;
    const part = chunk.subarray(0, this.max - this.held);
    this.parts.push(part);
    this.held += part.length;
  }
  kept(): Buffer {
    return Buffer.concat(this.parts);
  }
}

/** `--label k=v` for each label, in order. */
function labelArgs(labels: Readonly<Record<string, string>>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
}

/** A command's result as the prune reads it. */
interface CommandResultLike {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One row of the prune's listing: `CreatedAt` read to the second it shows. */
interface ListedVersion {
  readonly repository: string;
  readonly tag: string;
  readonly createdS: number;
}

/**
 * Reads the prune's listing (`{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}`, CreatedAt as `2026-10-03 05:25:57
 * -0500 CDT`); an untagged row (`<none>`) is not a version. A line of any other shape throws: never read as none.
 */
export function parseImageListing(stdout: string): ListedVersion[] {
  const rows: ListedVersion[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const m =
      /^([^\t]+)\t([^\t]+)\t(sha256:[0-9a-f]{64})\t(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})(?: \S+)?$/.exec(
        line,
      );
    if (m === null)
      throw new ContainerRuntimeError(
        `docker image ls printed a line the prune cannot read: ${JSON.stringify(line.slice(0, 200))}`,
      );
    const repository = present(m[1], "the listing regex's repository group");
    const tag = present(m[2], "the listing regex's tag group");
    if (tag === '<none>') continue;
    const date = present(m[4], "the listing regex's date group");
    const time = present(m[5], "the listing regex's time group");
    const tzSign = present(m[6], "the listing regex's timezone-sign group");
    const tzMinutes = present(m[7], "the listing regex's timezone-minutes group");
    const ms = Date.parse(`${date}T${time}${tzSign}:${tzMinutes}`);
    if (Number.isNaN(ms))
      throw new ContainerRuntimeError(
        `docker image ls printed a time the prune cannot read: ${JSON.stringify(line.slice(0, 200))}`,
      );
    rows.push({ repository, tag, createdS: ms / 1000 });
  }
  return rows;
}

/** Reads `docker image inspect --format '{{.Id}}\t{{.Created}}\t{{json .Config.Labels}}'` of `refs`, one line each, in order. */
export function parseImageInspect(
  stdout: string,
  refs: readonly { readonly repository: string; readonly tag: string }[],
): ImageVersion[] {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  if (lines.length !== refs.length)
    throw new ContainerRuntimeError(
      `docker image inspect of ${String(refs.length)} version(s) printed ${String(lines.length)} line(s)`,
    );
  return lines.map((line, n) => {
    const m = /^(sha256:[0-9a-f]{64})\t(\S+)\t(.*)$/.exec(line);
    const created = m === null ? NaN : Date.parse(present(m[2], "the inspect regex's created group"));
    let labels: unknown;
    try {
      labels = m === null ? undefined : JSON.parse(present(m[3], "the inspect regex's labels group"));
    } catch (error) {
      throw new ContainerRuntimeError(
        `docker image inspect printed labels that are not JSON: ${JSON.stringify(line.slice(0, 200))}`,
        { cause: error },
      );
    }
    if (
      m === null ||
      Number.isNaN(created) ||
      (labels !== null && (typeof labels !== 'object' || Array.isArray(labels)))
    ) {
      throw new ContainerRuntimeError(
        `docker image inspect printed a line the prune cannot read: ${JSON.stringify(line.slice(0, 200))}`,
      );
    }
    const source = (labels as Record<string, unknown> | null)?.[SOURCE_LABEL];
    const ref = present(refs[n], 'a ref at this line index, since refs.length === lines.length was checked above');
    return {
      repository: ref.repository,
      tag: ref.tag,
      id: present(m[1], "the inspect regex's id group"),
      created,
      source: typeof source === 'string' ? source : '',
    };
  });
}

/** Reads the docker socket out of `colima status --json`. */
export function parseDockerSocket(statusJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(statusJson);
  } catch (error) {
    throw new ContainerRuntimeError(`colima status --json printed invalid JSON: ${statusJson.slice(0, 200)}`, {
      cause: error,
    });
  }
  const socket = (parsed as { docker_socket?: unknown }).docker_socket;
  if (typeof socket !== 'string' || !socket.startsWith('unix://')) {
    throw new ContainerRuntimeError(
      `colima status --json has no docker_socket (is the runtime docker?): ${statusJson.slice(0, 200)}`,
    );
  }
  return socket;
}

interface InspectedNetwork {
  readonly driver: unknown;
  readonly bridge: unknown;
  readonly subnets: readonly string[];
  readonly ipv6: unknown;
  /** `com.docker.network.bridge.enable_icc`: "false" when containers on it cannot reach each other. */
  readonly icc: unknown;
}

/** Reads the fields R13 checks out of `docker network inspect --format '{{json .}}'`. */
function parseNetworkInspect(network: string, json: string): InspectedNetwork {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new ContainerIsolationFailed(
      `network ${network}`,
      `docker network inspect printed invalid JSON: ${json.slice(0, 200)}`,
      { cause: error },
    );
  }
  const n = parsed as {
    Driver?: unknown;
    Options?: Record<string, unknown> | null;
    IPAM?: { Config?: { Subnet?: unknown }[] | null };
    EnableIPv6?: unknown;
  };
  const subnets = (n.IPAM?.Config ?? []).map((c) => c.Subnet).filter((x): x is string => typeof x === 'string');
  return {
    driver: n.Driver,
    bridge: n.Options?.['com.docker.network.bridge.name'],
    subnets,
    ipv6: n.EnableIPv6,
    icc: n.Options?.['com.docker.network.bridge.enable_icc'],
  };
}

/** Every way the network differs from what the daemon created: the driver, the bridge name, the subnets, IPv6, inter-container traffic. */
function describeMismatches(
  network: InspectedNetwork,
  expected: { readonly bridge: string; readonly subnets: readonly string[] },
): string[] {
  const mismatches: string[] = [];
  if (network.driver !== 'bridge') mismatches.push(`driver ${JSON.stringify(network.driver)}, expected "bridge"`);
  if (network.bridge !== expected.bridge)
    mismatches.push(`bridge name ${JSON.stringify(network.bridge)}, expected "${expected.bridge}"`);
  if (JSON.stringify(network.subnets) !== JSON.stringify(expected.subnets)) {
    mismatches.push(`subnet ${JSON.stringify(network.subnets)}, expected ${JSON.stringify(expected.subnets)}`);
  }
  if (network.ipv6 !== false) mismatches.push(`EnableIPv6 ${JSON.stringify(network.ipv6)}, expected false`);
  if (network.icc !== 'false')
    mismatches.push(`com.docker.network.bridge.enable_icc ${JSON.stringify(network.icc)}, expected "false"`);
  return mismatches;
}

// The scripts below run as root in the colima VM (`sudo sh -s`, POSIX sh). Every
// change a daemon makes is under one lock, so daemons of different homes never
// interleave; the home's rule changes are one `iptables-restore --noflush`,
// which declares no chain, so they apply entirely or not at all. A daemon only
// ever deletes rules tagged with its own home id; the jump, the chain and the
// shared rejects are never deleted (other homes rely on them). Failures exit
// non-zero with a line `asha-isolation: <what>` on stderr.

const LOCK = `exec 9>/run/asha-iptables.lock
flock -w ${String(LOCK_WAIT_S)} 9 || { echo "asha-isolation: lock: /run/asha-iptables.lock not free within ${String(LOCK_WAIT_S)} s" >&2; exit 4; }`;

/**
 * A shell pipeline printing the lines of `$rules` (from `iptables -S`) that hold this home's tagged rules; with
 * `iface`, only those on that input interface — the agent rules on `asha<homeId>`, not the egress bridge's
 * (`ashae<homeId>`, extension-modules R6 (d)), which carry the same tag so the reclaim removes them too.
 */
function taggedRules(homeId: string, iface?: string): string {
  const only = iface === undefined ? '' : ` && index($0, " -i ${iface} ") > 0`;
  return `printf '%s\\n' "$rules" | awk -v t='--comment "asha:${homeId}"' 'index($0, "-A ASHA-AGENTS ") == 1 && index($0, t) > 0${only}'`;
}

/**
 * Every module bridge's traffic to an address of the VM itself — its own gateway address on that bridge, the VM's
 * sshd, any port the VM listens on — rejected (D53: the colima sandbox suite reached the VM's sshd at a module
 * network's gateway, which `--internal` leaves open, since it drops only forwarded traffic). Shared by every home and
 * never removed by a reclaim, as another home's modules may be running; forwarded traffic (a module to the proxy on
 * its own bridge) is not to a local address and is not matched. Inserted first in the chain, so the shared rejects
 * stay its last rules (agent-tools R14's layout, which the isolation eval asserts).
 */
export const MODULE_LOCAL_REJECT = '-i asham+ -m addrtype --dst-type LOCAL -j REJECT';

/**
 * The destinations the egress bridge may never reach (extension-modules R6 (d)): RFC 1918, the shared address space
 * 100.64.0.0/10, link-local, colima's 192.168.5.0/24 and the host gateway (both inside 192.168.0.0/16, named
 * besides it as R6 (d) names them).
 */
export const EGRESS_REJECTED = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '169.254.0.0/16',
  '192.168.5.0/24',
  `${HOST_GATEWAY}/32`,
] as const;

/**
 * Installs (`install`: each reject inserted where missing) or checks (`verify`) the egress bridge's rejects, in the
 * chain the `asha+` jumps reach from DOCKER-USER and INPUT, each tagged `asha:<homeId>` so the reclaim removes them;
 * both then check the jumps are rule 1 of DOCKER-USER and INPUT and every reject is present (R6 (d)).
 */
export function egressRulesScript(homeId: string, bridge: string, mode: 'install' | 'verify'): string {
  if (!/^[0-9a-f]{8}$/.test(homeId) || bridge !== `ashae${homeId}`)
    throw new Error(`egress rules for ${JSON.stringify(bridge)}: not this home's egress bridge`);
  const rule = (cidr: string) => `-i ${bridge} -d ${cidr} -m comment --comment asha:${homeId} -j REJECT`;
  const install = EGRESS_REJECTED.map(
    (cidr) =>
      `if ! iptables -w -C ASHA-AGENTS ${rule(cidr)}; then iptables -w -I ASHA-AGENTS 1 ${rule(cidr)}; inserted=$((inserted + 1)); fi`,
  ).join('\n');
  const verify = EGRESS_REJECTED.map(
    (cidr) =>
      `if ! iptables -w -C ASHA-AGENTS ${rule(cidr)}; then echo "asha-egress: verify: the reject of ${cidr} from ${bridge} is missing" >&2; exit 5; fi`,
  ).join('\n');
  const moduleInstall = `if ! iptables -w -C ASHA-AGENTS ${MODULE_LOCAL_REJECT}; then iptables -w -I ASHA-AGENTS 1 ${MODULE_LOCAL_REJECT}; inserted=$((inserted + 1)); fi`;
  const moduleVerify = `if ! iptables -w -C ASHA-AGENTS ${MODULE_LOCAL_REJECT}; then echo "asha-egress: verify: the reject of the VM's own addresses from module bridges (asham+) is missing" >&2; exit 5; fi`;
  return `set -eu
${LOCK}
rules=$(iptables -w -S)
if ! printf '%s\\n' "$rules" | grep -qxF -- '-N ASHA-AGENTS'; then echo "asha-egress: the chain ASHA-AGENTS is missing: an agent's confinement must be in place first" >&2; exit 5; fi
inserted=0
${mode === 'install' ? `${install}\n${moduleInstall}` : ''}
rules=$(iptables -w -S)
first=$(printf '%s\\n' "$rules" | awk '/^-A DOCKER-USER / { print; exit }')
if [ "$first" != '-A DOCKER-USER -i asha+ -j ASHA-AGENTS' ]; then echo "asha-egress: verify: the jump is not rule 1 of DOCKER-USER (rule 1 is: $first)" >&2; exit 5; fi
input_first=$(printf '%s\\n' "$rules" | awk '/^-A INPUT / { print; exit }')
if [ "$input_first" != '-A INPUT -i asha+ -j ASHA-AGENTS' ]; then echo "asha-egress: verify: the jump is not rule 1 of INPUT (rule 1 is: $input_first)" >&2; exit 5; fi
${verify}
${moduleVerify}
${mode === 'install' ? 'echo "asha-egress: ready inserted=$inserted"' : 'echo "asha-egress: verified"'}
`;
}

/**
 * Checks that `host.lima.internal` in the VM is 192.168.5.2 (R13), then
 * verifies, and where missing installs, the chain, the shared rejects, the
 * jumps as rule 1 of DOCKER-USER and of INPUT, and exactly this home's two
 * rules, in order: the allow from its bridge to the host gateway on
 * `hostPort` (control-api-auth R12), then the reject of everything else from
 * its bridge (agent-tools R14).
 */
export function installScript(homeId: string, hostPort: number): string {
  const allow = `-i asha${homeId} -d ${HOST_GATEWAY}/32 -p tcp --dport ${String(hostPort)} -m comment --comment asha:${homeId} -j RETURN`;
  const homeReject = `-i asha${homeId} -m comment --comment asha:${homeId} -j REJECT`;
  const reset = `-i asha+ -d ${HOST_GATEWAY}/32 -p tcp -j REJECT --reject-with tcp-reset`;
  const reject = `-i asha+ -d ${HOST_GATEWAY}/32 -j REJECT`;
  return `set -eu
${LOCK}
hosts_addr=$(awk '{ for (i = 2; i <= NF; i++) if ($i == "host.lima.internal") { print $1; exit } }' /etc/hosts)
if [ "$hosts_addr" != "${HOST_GATEWAY}" ]; then
  echo "asha-isolation: host check: host.lima.internal is \\"$hosts_addr\\" in the VM's /etc/hosts, not ${HOST_GATEWAY}" >&2
  exit 3
fi
rules=$(iptables -w -S)
if ! printf '%s\\n' "$rules" | grep -qxF -- '-N ASHA-AGENTS'; then
  iptables -w -N ASHA-AGENTS
fi
if ! iptables -w -C ASHA-AGENTS ${reset}; then
  iptables -w -A ASHA-AGENTS ${reset}
fi
if ! iptables -w -C ASHA-AGENTS ${reject}; then
  iptables -w -A ASHA-AGENTS ${reject}
fi
rules=$(iptables -w -S)
jump='-A DOCKER-USER -i asha+ -j ASHA-AGENTS'
first=$(printf '%s\\n' "$rules" | awk '/^-A DOCKER-USER / { print; exit }')
jumps=$(printf '%s\\n' "$rules" | awk -v j="$jump" '$0 == j { n++ } END { print n + 0 }')
input_jump='-A INPUT -i asha+ -j ASHA-AGENTS'
input_first=$(printf '%s\\n' "$rules" | awk '/^-A INPUT / { print; exit }')
input_jumps=$(printf '%s\\n' "$rules" | awk -v j="$input_jump" '$0 == j { n++ } END { print n + 0 }')
tagged=$(${taggedRules(homeId, `asha${homeId}`)})
count=$(printf '%s\\n' "$tagged" | awk 'NF { n++ } END { print n + 0 }')
order=$(printf '%s\\n' "$tagged" | awk 'NF { if ($0 ~ / -j RETURN$/) printf "allow "; else if ($0 ~ / -j REJECT /) printf "reject "; else printf "other " }')
fix_jump=1
if [ "$first" = "$jump" ] && [ "$jumps" -eq 1 ]; then fix_jump=0; fi
fix_input=1
if [ "$input_first" = "$input_jump" ] && [ "$input_jumps" -eq 1 ]; then fix_input=0; fi
fix_home=1
if [ "$count" -eq 2 ] && [ "$order" = "allow reject " ] && iptables -w -C ASHA-AGENTS ${allow} && iptables -w -C ASHA-AGENTS ${homeReject}; then fix_home=0; fi
if [ "$fix_jump" -eq 1 ] || [ "$fix_input" -eq 1 ] || [ "$fix_home" -eq 1 ]; then
  {
    echo '*filter'
    if [ "$fix_jump" -eq 1 ]; then
      i=0
      while [ "$i" -lt "$jumps" ]; do echo '-D DOCKER-USER -i asha+ -j ASHA-AGENTS'; i=$((i + 1)); done
      echo '-I DOCKER-USER 1 -i asha+ -j ASHA-AGENTS'
    fi
    if [ "$fix_input" -eq 1 ]; then
      i=0
      while [ "$i" -lt "$input_jumps" ]; do echo '-D INPUT -i asha+ -j ASHA-AGENTS'; i=$((i + 1)); done
      echo '-I INPUT 1 -i asha+ -j ASHA-AGENTS'
    fi
    if [ "$fix_home" -eq 1 ]; then
      if [ -n "$tagged" ]; then printf '%s\\n' "$tagged" | sed 's/^-A /-D /'; fi
      echo '-I ASHA-AGENTS 1 ${homeReject}'
      echo '-I ASHA-AGENTS 1 ${allow}'
    fi
    echo COMMIT
  } | iptables-restore --noflush
fi
rules=$(iptables -w -S)
first=$(printf '%s\\n' "$rules" | awk '/^-A DOCKER-USER / { print; exit }')
if [ "$first" != "$jump" ]; then echo "asha-isolation: verify: the jump is not rule 1 of DOCKER-USER (rule 1 is: $first)" >&2; exit 5; fi
input_first=$(printf '%s\\n' "$rules" | awk '/^-A INPUT / { print; exit }')
if [ "$input_first" != "$input_jump" ]; then echo "asha-isolation: verify: the jump is not rule 1 of INPUT (rule 1 is: $input_first)" >&2; exit 5; fi
if ! iptables -w -C ASHA-AGENTS ${allow}; then echo "asha-isolation: verify: the allow for port ${String(hostPort)} is missing" >&2; exit 5; fi
if ! iptables -w -C ASHA-AGENTS ${homeReject}; then echo "asha-isolation: verify: the reject of everything else from asha${homeId} is missing" >&2; exit 5; fi
tagged=$(${taggedRules(homeId, `asha${homeId}`)})
order=$(printf '%s\\n' "$tagged" | awk 'NF { if ($0 ~ / -j RETURN$/) printf "allow "; else if ($0 ~ / -j REJECT /) printf "reject "; else printf "other " }')
if [ "$order" != "allow reject " ]; then echo "asha-isolation: verify: this home's rules are not exactly the allow then the reject (they are: $order)" >&2; exit 5; fi
if ! iptables -w -C ASHA-AGENTS ${reset} || ! iptables -w -C ASHA-AGENTS ${reject}; then echo "asha-isolation: verify: a shared reject is missing" >&2; exit 5; fi
echo "asha-isolation: ready jump_fixed=$fix_jump input_jump_fixed=$fix_input home_rules_replaced=$fix_home"
`;
}

/**
 * The part of the reclaim that removes a dead daemon's containers of this home (on its network, or carrying its
 * label), setting `$containers`, in one `docker rm --force` naming them all (extension-modules P7, 2026-10-02: one
 * call per container cost about 40 ms each, serially). A `--rm` container whose daemon died may already be removing
 * itself: Docker then answers "removal of container … is already in progress" (or, once it is done, "No such
 * container"), which is tolerated — exactly those two answers, line by line — and waited for, polled every 0.2 s and
 * bounded by the clock at `waitS` (20 s; a test shortens it), inside the reclaim's own 30 s bound; any other answer fails the
 * reclaim. Found by p20-b's run, 2026-09-29: the restarted daemon refused to start. Each listing is its own
 * assignment, so a `docker ps` that fails fails the script (`set -e`), never read as none — a pipeline's or a test's
 * command substitution would hide it (R1-DESIGN-002).
 */
export function removeHomeContainers(homeId: string, waitS = 20): string {
  return `home_containers() {
  by_net=$(docker ps --all --quiet --filter network=asha-${homeId}) || return 1
  by_label=$(docker ps --all --quiet --filter label=${HOME_LABEL}=${homeId}) || return 1
  printf '%s\\n' $by_net $by_label | sort -u
}
containers=$(home_containers)
if [ -n "$containers" ]; then
  if ! out=$(docker rm --force $containers 2>&1 >/dev/null); then
    bad=$(printf '%s\\n' "$out" | grep -v -e 'is already in progress' -e 'No such container' | grep -v '^$' || true)
    if [ -n "$bad" ]; then printf '%s\\n' "$bad" >&2; exit 1; fi
  fi
fi
deadline=$(( $(date +%s) + ${String(waitS)} ))
while :; do
  left=$(home_containers)
  if [ -z "$left" ]; then break; fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "reclaim: this home's containers still present ${String(waitS)} s after their removal" >&2; exit 1; fi
  sleep 0.2
done
`;
}

/**
 * The part of the reclaim that removes every volume carrying this home's label (agent-files R10a), after its
 * containers (the spaces' holders among them), setting `$removed_volumes`. A listing that fails fails the script
 * (`set -e` on the assignment), never read as none; a volume that cannot be removed fails it, naming the volume.
 */
export function removeHomeVolumes(homeId: string): string {
  return `volumes=$(docker volume ls --quiet --filter label=${HOME_LABEL}=${homeId})
removed_volumes=0
for v in $volumes; do
  if ! out=$(docker volume rm "$v" 2>&1); then echo "asha-isolation: reclaim: volume $v could not be removed: $out" >&2; exit 6; fi
  removed_volumes=$((removed_volumes + 1))
done
`;
}

/**
 * The part of the reclaim that removes every network carrying this home's label (extension-modules R5: each module
 * network and the egress bridge), after the containers on them, setting `$removed_networks`, in one `docker network rm`
 * naming them all (P7). A listing that fails fails the script; a network that cannot be removed fails it, with
 * Docker's answer naming the network.
 */
export function removeHomeNetworks(homeId: string): string {
  return `labelled_networks=$(docker network ls --quiet --filter label=${HOME_LABEL}=${homeId})
removed_networks=0
if [ -n "$labelled_networks" ]; then
  if ! out=$(docker network rm $labelled_networks 2>&1 >/dev/null); then echo "asha-isolation: reclaim: networks could not be removed: $out" >&2; exit 6; fi
  removed_networks=$(printf '%s\\n' "$labelled_networks" | awk 'NF { n++ } END { print n + 0 }')
fi
`;
}

/**
 * The reclaim, as root in the VM (agent-files R10a, extension-modules R5): removes this home's tagged rules, any
 * container on its network or carrying its label, its labelled volumes, the home network and every network carrying
 * its label, and prints what it removed. Every listing is an assignment, so one that fails fails the script.
 */
export function reclaimScript(homeId: string): string {
  return `set -eu
${LOCK}
rules=$(iptables -w -S)
tagged=$(${taggedRules(homeId)})
removed=0
if [ -n "$tagged" ]; then
  { echo '*filter'; printf '%s\\n' "$tagged" | sed 's/^-A /-D /'; echo COMMIT; } | iptables-restore --noflush
  removed=$(printf '%s\\n' "$tagged" | awk 'NF { n++ } END { print n + 0 }')
fi
${removeHomeContainers(homeId)}${removeHomeVolumes(homeId)}network=0
home_network=$(docker network ls --quiet --filter 'name=^asha-${homeId}$')
if [ -n "$home_network" ]; then
  docker network rm asha-${homeId}
  network=1
fi
${removeHomeNetworks(homeId)}echo "asha-isolation: reclaimed rules=$removed containers=$(printf '%s\\n' "$containers" | awk 'NF { n++ } END { print n + 0 }') network=$network volumes=$removed_volumes networks=$removed_networks"
`;
}

/**
 * A command's name for an error, from its first `words` arguments up to the first flag: `network create`,
 * `volume rm`, `start --profile` stops at `start`. Never its operands past them, which may be a call's arguments.
 */
function commandName(args: readonly string[], words: number): string {
  const name: string[] = [];
  for (const arg of args.slice(0, words)) {
    if (arg.startsWith('-')) break;
    name.push(arg);
  }
  return name.join(' ');
}
