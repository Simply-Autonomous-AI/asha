// Fakes for the daemon's adapter contracts, and a fixture repo root, shared by
// the supervisor unit tests and the integration tests.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  imageTag,
  type AttachedContainer,
  type AttachedSpec,
  type NetworkSpec,
  type PluginContainer,
  type PluginRun,
  type PluginSpec,
  type ContainerRuntime,
  type ContainerSpec,
  type CopyOutcome,
  type DockerOutcome,
  type EnsuredImage,
  type HolderSpec,
  type ImageSpec,
  type OneShot,
  type OneShotRun,
  type OneShotSpec,
  type Reclaimed,
  type RollbackSpec,
  type EmptySpaceSpec,
  type StopMode,
} from '../../src/daemon/container-runtime/index.js';
import { TarParser, padOf, tarEntryHeader, type TarHeader } from '../../src/daemon/state/tar.js';
import type { CatalogueEntry } from '../../src/daemon/definitions/index.js';
import { MODEL_IDLE_UNLOAD_MS, type LifetimeOptions } from '../../src/daemon/lifetime.js';
import type { ModelEndpoint, ModelLease, ModelServer } from '../../src/daemon/model-server/index.js';
import type { CachedModel, ModelStore } from '../../src/daemon/model-store/index.js';
import { nodeStateFs } from '../../src/daemon/state/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { insideGitTree } from '../../src/shared/paths.js';
import { PORTAL_MODULES, PORTAL_STATIC_FILES } from '../../src/daemon/portal/index.js';

/**
 * `s` up to its first NUL byte (a fixed-width tar field's padding starts there), or `s` whole when it has none —
 * linear, never a regex: `.replace(/\0.*$/s, '')` is a trailing greedy quantifier that `sonarjs/super-linear-regex`
 * flags; confirmed byte-for-byte equivalent to the regex over 20,000 fuzzed inputs plus the empty, no-NUL,
 * leading-NUL and multiple-NUL cases, before this change.
 */
function truncateAtNul(s: string): string {
  const at = s.indexOf('\0');
  return at === -1 ? s : s.slice(0, at);
}

/** The real filesystem and check for saved state: DaemonDependencies' stateFs and insideGitTree as production wires them. */
export const REAL_STATE = { stateFs: nodeStateFs, insideGitTree } as const;

/**
 * A test daemon's lifetime (docs/plans/idle-shutdown.md): the model check at its production bound, and neither an idle
 * stop nor a watched process — the daemon `asha --server` runs for a user who started it. Its checks run only when the
 * test's schedule fires them.
 */
export const TEST_LIFETIME: LifetimeOptions = { modelIdleMs: MODEL_IDLE_UNLOAD_MS };

/** One recorded stop: the container, the mode, the grace a drain was given, and when (Date.now(), a fake clock's in A8a). */
export interface RecordedStop {
  readonly name: string;
  readonly mode: StopMode;
  readonly graceS?: number;
  readonly at: number;
}

/** What a scripted one-shot does (agent-persistence R16): how it ends, and what its /memory holds after. */
export type OneShotScript = (
  spec: OneShotSpec,
  memory: Buffer,
) => Promise<{ readonly run: OneShotRun; readonly memoryAfter?: Buffer }>;

/**
 * Splits a restore archive into one tar per top directory (`memory`, `workspace`), each with its own end marker,
 * so a fake container's snapshot of a directory is what was restored into it.
 */
export function splitRestore(archive: Buffer): Map<string, Buffer> {
  const parts = new Map<string, Buffer[]>();
  for (let at = 0; at + 512 <= archive.length;) {
    const h = archive.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const field = (o: number, l: number) => truncateAtNul(h.subarray(o, o + l).toString('utf8'));
    const prefix = field(345, 155);
    const name = (prefix === '' ? '' : `${prefix}/`) + field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const length = 512 + Math.ceil(size / 512) * 512;
    const root = `/${present(name.split('/')[0], 'the archive entry name')}`;
    parts.set(root, [...(parts.get(root) ?? []), archive.subarray(at, at + length)]);
    at += length;
  }
  return new Map([...parts].map(([root, blocks]) => [root, Buffer.concat([...blocks, Buffer.alloc(1024)])]));
}

/** One entry of a fake channel space, by its name below `channel/`. */
export type FakeEntry =
  | { readonly type: 'dir'; readonly owner: string }
  | { readonly type: 'file'; readonly content: Buffer; readonly owner: string; readonly mode: number }
  | { readonly type: 'link'; readonly target: string }
  | { readonly type: 'fifo' };

/** A fake Docker volume: its labels, its root's owner, and its entries (`channel` itself is the root). */
export interface FakeVolume {
  readonly labels: Record<string, string>;
  rootOwner: string;
  readonly entries: Map<string, FakeEntry>;
}

/** One copy into a holder, as the fake saw it: the bytes it was given and whether they ended with a tar's end blocks. */
export interface RecordedCopyIn {
  readonly name: string;
  readonly bytes: Buffer;
  readonly endBlocks: boolean;
}

/**
 * A module's or the proxy's container as the fake runs it (extension-modules R5, R34): every line the daemon writes to
 * it, and the means to answer — a stdout line, a stderr line, an exit.
 */
export class FakeAttached {
  readonly written: string[] = [];
  removed = false;
  private resolveExit!: (code: number | null) => void;
  readonly exited: Promise<number | null>;
  /** Called with each line the daemon writes: script the module here. */
  onLine: (line: string) => void = () => undefined;
  constructor(readonly spec: AttachedSpec) {
    this.exited = new Promise((resolve) => (this.resolveExit = resolve));
  }
  /** The requests written so far, parsed. */
  requests(): Record<string, unknown>[] {
    return this.written.map((line) => JSON.parse(line) as Record<string, unknown>);
  }
  stdout(text: string): void {
    this.spec.onStdout(Buffer.from(text));
  }
  /** One JSON line on its stdout. */
  respond(value: unknown): void {
    this.stdout(`${JSON.stringify(value)}\n`);
  }
  stderr(line: string): void {
    this.spec.onStderrLine(line);
  }
  exit(code: number | null): void {
    this.resolveExit(code);
  }
  /**
   * The egress proxy's container exists and its program has started: it says so with `{"op":"ready"}` on stdout, as
   * the real one does (extension-modules R6; until then `docker network connect` to it finds no such container).
   */
  started = false;
  ready(): void {
    if (this.removed || this.started) return;
    this.started = true;
    this.respond({ op: 'ready', address: '' });
  }
}

/** One plugin call's container as the fake keeps it: what was created, copied in, run and copied out. */
export class FakePlugin {
  created = false;
  removed = false;
  readonly copiedIn: Buffer[] = [];
  readonly copiedOut: string[] = [];
  /** How its command ends; the default exits 0 printing nothing. */
  run: (container: FakePlugin, signal: AbortSignal) => Promise<PluginRun> = () =>
    Promise.resolve({
      kind: 'exited',
      code: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      stdoutBytes: 0,
      stderrBytes: 0,
    });
  /** What `docker cp <c>:<path> -` gives, by path; absent: the copy fails. */
  readonly outputs = new Map<string, Buffer>();
  /** Scripts a copy in: called with its input; an outcome replaces exit 0. */
  onCopyIn: (input: Buffer, signal: AbortSignal) => Promise<DockerOutcome | undefined> = () =>
    Promise.resolve(undefined);
  constructor(readonly spec: PluginSpec) {}
}

export class FakeRuntime implements ContainerRuntime {
  /** The VM's architecture and Docker Engine version (extension-modules R6 (a), R28). */
  arch = 'aarch64';
  engine = '29.2.1';
  /** Networks the module host created, by name. */
  readonly networks = new Map<string, NetworkSpec>();
  /** Bridges whose egress rejects are installed (R6 (d)); a test deletes one to see the verify fail. */
  readonly egressRules = new Set<string>();
  readonly attached: FakeAttached[] = [];
  /** Called with each attached container as it starts: script the module or proxy here. */
  onAttached: (container: FakeAttached) => void = () => undefined;
  /**
   * How the egress proxy starts: 'auto', it says ready on the next macrotask, as `docker run` creates its container
   * and starts its program a while after the daemon spawns it; 'manual', only when the test calls `ready()`; 'never',
   * not at all (a proxy that hangs before its first line).
   */
  proxyStart: 'auto' | 'manual' | 'never' = 'auto';
  readonly plugins: FakePlugin[] = [];
  /** Called with each plugin container as it is made: script its command here. */
  onPlugin: (plugin: FakePlugin) => void = () => undefined;
  /** Each container's address on each network it was connected to. */
  readonly connections: {
    readonly network: string;
    readonly container: string;
    readonly alias: string;
    readonly address: string;
  }[] = [];

  /** The channel spaces' volumes and holders, as a fake docker keeps them (docs/plans/agent-files.md R10). */
  readonly volumes = new Map<string, FakeVolume>();
  readonly holders = new Map<string, HolderSpec>();
  readonly copyIns: RecordedCopyIn[] = [];
  readonly rollbacks: RollbackSpec[] = [];
  /** Volumes the next reclaim reports removed (R10a). */
  reclaimVolumes = 0;
  /** Scripts a copy in: called once its input has ended; an outcome replaces the fake's own (exit 0, entries applied). */
  onCopyIn: (name: string, input: RecordedCopyIn, signal?: AbortSignal) => Promise<DockerOutcome | undefined> = () =>
    Promise.resolve(undefined);
  /** Scripts a rollback's outcome; undefined runs it (removes the folder, exit 0). */
  onRollback: (spec: RollbackSpec, signal?: AbortSignal) => Promise<DockerOutcome | undefined> = () =>
    Promise.resolve(undefined);
  /** Scripts a space's emptying (agent-files R15); undefined runs it (removes every entry, exit 0). */
  onEmptySpace: (spec: EmptySpaceSpec, signal?: AbortSignal) => Promise<DockerOutcome | undefined> = () =>
    Promise.resolve(undefined);
  /** Scripts a space call's failure: `volumeCreate`, `volumeLabel`, `holder`, `rootOwner`. */
  failSpace: Partial<Record<'volumeCreate' | 'holder', Error>> = {};

  readonly hostAddress: string;
  readonly starts: ContainerSpec[] = [];
  readonly images: ImageSpec[] = [];
  readonly stops: string[] = [];
  readonly stopModes: StopMode[] = [];
  /** Every stop with its grace and time (agent-persistence A8a). */
  readonly stopRecords: RecordedStop[] = [];
  /** The host port each ensureReady was given: the one port containers may reach. */
  readonly readyPorts: number[] = [];
  reclaims = 0;
  /**
   * Every call, in order: `ensureReady <port>`, `start <name>`, `stop <name> kill`, `stop <name> drain <graceS>`,
   * `copyOut <name> <path>`, `oneShot <name> <run|copyOut|remove>`, `reclaim`, `pruneImages`.
   */
  readonly calls: string[] = [];
  /** Each container's directories as tars, by path (`/memory`, `/workspace`): its restore, then whatever a test sets. */
  readonly contents = new Map<string, Map<string, Buffer>>();
  /** Each started container's restore archive, read in full. */
  readonly restored = new Map<string, Buffer>();
  /** Called before a copy out answers: lets a test hold it (a slow snapshot) or fail it (return a failure). */
  onCopy: (name: string, path: string) => Promise<CopyOutcome | undefined> = () => Promise.resolve(undefined);
  /** What each one-shot does; by default it exits 0 having erased nothing. */
  /** Runs as a one-shot is removed; a test makes it throw (a failed docker rm). */
  onOneShotRemove: (name: string) => Promise<void> = () => Promise.resolve(undefined);
  onOneShot: OneShotScript = (_spec, memory) =>
    Promise.resolve({
      run: { kind: 'exited', code: 0, stdout: '{"erased":{"files":0,"bytes":0}}\n', overflow: false },
      memoryAfter: memory,
    });
  /** The one-shots run, with the /memory each was given. */
  readonly oneShots: { readonly spec: OneShotSpec; readonly memory: Buffer }[] = [];
  /** When set, ensureReady rejects with it: a runtime that cannot confine its containers. */
  readyError: Error | undefined;
  /** Awaited by each ensureReady: a test holds a launch in progress here (docs/plans/portal-demo-stop.md R1, R3). */
  onEnsureReady: () => Promise<void> = () => Promise.resolve(undefined);
  /** Called with each started container; script what the "agent" does. */
  onStart: (spec: ContainerSpec) => void = () => undefined;
  /**
   * What `stop` does to a container; script an agent that drains. Default: a drained one exits at
   * once with 143 (SIGTERM), a killed one with 137 (SIGKILL).
   */
  onStop: (name: string, mode: StopMode) => Promise<void> = (name, mode) => {
    this.exit(name, mode === 'drain' ? 143 : 137);
    return Promise.resolve(undefined);
  };
  private readonly exits = new Map<string, (code: number) => void>();
  /** Each started container's loss: its `exited` rejected, as a `docker start --attach` killed from outside makes it. */
  private readonly losses = new Map<string, (error: Error) => void>();

  constructor(hostAddress = 'host.test') {
    this.hostAddress = hostAddress;
  }

  get readyCalls(): number {
    return this.readyPorts.length;
  }

  async ensureReady(hostPort: number): Promise<'ready'> {
    this.readyPorts.push(hostPort);
    this.calls.push(`ensureReady ${String(hostPort)}`);
    await this.onEnsureReady();
    if (this.readyError !== undefined) throw this.readyError;
    return 'ready';
  }

  reclaim(): Promise<Reclaimed> {
    this.reclaims += 1;
    this.calls.push('reclaim');
    const volumes = this.reclaimVolumes;
    this.reclaimVolumes = 0;
    for (const holder of this.holders.keys()) this.holders.delete(holder);
    for (const volume of this.volumes.keys()) this.volumes.delete(volume);
    // As `docker rm --force` of the home's labelled containers: every module and proxy container still running exits.
    for (const container of this.attached) {
      if (container.removed) continue;
      container.removed = true;
      container.exit(137);
    }
    return Promise.resolve({ volumes });
  }

  /** What the next image prune does (debt-paydown-2 R1): by default nothing; a test makes it throw. */
  onPrune: () => Promise<void> = () => Promise.resolve(undefined);
  async pruneImages(): Promise<void> {
    this.calls.push('pruneImages');
    await this.onPrune();
  }

  createVolume(name: string, labels: Readonly<Record<string, string>>): Promise<void> {
    this.calls.push(`createVolume ${name}`);
    if (this.failSpace.volumeCreate !== undefined) return Promise.reject(this.failSpace.volumeCreate);
    // As Docker does (probe P5 (b)): a taken name succeeds and keeps its labels.
    if (!this.volumes.has(name))
      this.volumes.set(name, { labels: { ...labels }, rootOwner: '0:0', entries: new Map() });
    return Promise.resolve(undefined);
  }

  volumeLabel(name: string, key: string): Promise<string> {
    this.calls.push(`volumeLabel ${name} ${key}`);
    const volume = this.volumes.get(name);
    if (volume === undefined) return Promise.reject(new Error(`docker volume inspect ${name} failed:\nno such volume`));
    return Promise.resolve(volume.labels[key] ?? '');
  }

  createHolder(spec: HolderSpec): Promise<void> {
    this.calls.push(`createHolder ${spec.name} ${spec.image} ${spec.volume}`);
    if (this.failSpace.holder !== undefined) return Promise.reject(this.failSpace.holder);
    this.holders.set(spec.name, spec);
    return Promise.resolve(undefined);
  }

  removeContainer(name: string): Promise<void> {
    this.calls.push(`removeContainer ${name}`);
    this.holders.delete(name);
    return Promise.resolve(undefined);
  }

  removeVolume(name: string): Promise<void> {
    this.calls.push(`removeVolume ${name}`);
    this.volumes.delete(name);
    return Promise.resolve(undefined);
  }

  /** The volume a holder mounts. */
  spaceOf(holder: string): FakeVolume {
    const spec = this.holders.get(holder);
    const volume = spec === undefined ? undefined : this.volumes.get(spec.volume);
    if (volume === undefined) throw new Error(`FakeRuntime: no space behind ${holder}`);
    return volume;
  }

  async copyIn(name: string, archive: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<DockerOutcome> {
    this.calls.push(`copyIn ${name}`);
    const volume = this.spaceOf(name);
    const parts: Buffer[] = [];
    const aborted = new Promise<never>((_, reject) => {
      if (signal?.aborted === true) reject(signal.reason as Error);
      signal?.addEventListener(
        'abort',
        () => {
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
    aborted.catch(() => undefined);
    // The input is read to its end, as docker cp reads its standard input; a stop kills it.
    await Promise.race([
      (async () => {
        for await (const chunk of archive) parts.push(Buffer.from(chunk));
      })(),
      aborted,
    ]);
    const bytes = Buffer.concat(parts);
    const endBlocks = bytes.length >= 1024 && bytes.subarray(-1024).every((b) => b === 0);
    const input = { name, bytes, endBlocks };
    this.copyIns.push(input);
    this.calls.push(`copyIn ${name} input ended, end blocks ${endBlocks ? 'present' : 'absent'}`);
    const scripted = await Promise.race([this.onCopyIn(name, input, signal), aborted]);
    if (scripted !== undefined) {
      this.calls.push(`copyIn ${name} exit ${scripted.kind === 'exited' ? String(scripted.code) : 'timeout'}`);
      return scripted;
    }
    await applyTar(volume, bytes);
    this.calls.push(`copyIn ${name} exit 0`);
    return { kind: 'exited', code: 0, stderr: '' };
  }

  async rollback(spec: RollbackSpec, signal?: AbortSignal): Promise<DockerOutcome> {
    this.calls.push(`rollback ${spec.volume} ${spec.folder}`);
    this.rollbacks.push(spec);
    const scripted = await this.onRollback(spec, signal);
    if (signal?.aborted === true) throw signal.reason;
    if (scripted !== undefined) return scripted;
    const volume = this.volumes.get(spec.volume);
    // Reached only when `volume` has entries to iterate, which only a defined `volume` can: present() never throws here.
    for (const name of [...(volume?.entries.keys() ?? [])])
      if (name === spec.folder || name.startsWith(`${spec.folder}/`))
        present(volume, `the volume ${spec.volume}`).entries.delete(name);
    return { kind: 'exited', code: 0, stderr: '' };
  }

  async emptySpace(spec: EmptySpaceSpec, signal?: AbortSignal): Promise<DockerOutcome> {
    this.calls.push(`emptySpace ${spec.volume}`);
    const scripted = await this.onEmptySpace(spec, signal);
    if (signal?.aborted === true) throw signal.reason;
    if (scripted !== undefined) return scripted;
    this.volumes.get(spec.volume)?.entries.clear();
    return { kind: 'exited', code: 0, stderr: '' };
  }

  ensureRunning(): Promise<'ready'> {
    this.calls.push('ensureRunning');
    if (this.readyError !== undefined) return Promise.reject(this.readyError);
    return Promise.resolve('ready');
  }

  vmArchitecture(): Promise<string> {
    this.calls.push('vmArchitecture');
    return Promise.resolve(this.arch);
  }

  /** How many of the next engineVersion calls fail, as a VM that does not answer. */
  engineFailures = 0;

  engineVersion(): Promise<string> {
    this.calls.push('engineVersion');
    if (this.engineFailures > 0) {
      this.engineFailures -= 1;
      return Promise.reject(new Error('docker version failed: Cannot connect to the Docker daemon'));
    }
    return Promise.resolve(this.engine);
  }

  createNetwork(spec: NetworkSpec): Promise<void> {
    this.calls.push(`createNetwork ${spec.name}${spec.internal ? ' internal' : ''}`);
    // As docker does: a name already taken is an error.
    if (this.networks.has(spec.name))
      return Promise.reject(
        new Error(`docker network create ${spec.name} failed: network with name ${spec.name} already exists`),
      );
    this.networks.set(spec.name, spec);
    return Promise.resolve(undefined);
  }

  /** When set, a network removal waits for it before it removes the network: a teardown in progress. */
  removeNetworkGate: Promise<void> | undefined;

  async removeNetwork(name: string): Promise<void> {
    this.calls.push(`removeNetwork ${name}`);
    if (this.removeNetworkGate !== undefined) await this.removeNetworkGate;
    this.networks.delete(name);
  }

  installEgressRules(bridge: string): Promise<void> {
    this.calls.push(`installEgressRules ${bridge}`);
    this.egressRules.add(bridge);
    return Promise.resolve(undefined);
  }

  verifyEgressRules(bridge: string): Promise<void> {
    this.calls.push(`verifyEgressRules ${bridge}`);
    if (!this.egressRules.has(bridge))
      return Promise.reject(
        new Error(`container isolation failed: egress rule verify: the rejects from ${bridge} are missing`),
      );
    return Promise.resolve(undefined);
  }

  runAttached(spec: AttachedSpec): AttachedContainer {
    this.calls.push(`runAttached ${spec.name} ${spec.image} ${spec.network}`);
    const container = new FakeAttached(spec);
    this.attached.push(container);
    // The egress proxy answers every order at once, as the real one does when its listen succeeds (R6).
    if (spec.labels['asha.role'] === 'egress-proxy') {
      container.onLine = (line) => {
        const order = JSON.parse(line) as { op: string; address: string };
        queueMicrotask(() => {
          container.respond({ op: order.op === 'listen' ? 'listening' : 'closed', address: order.address });
        });
      };
      if (this.proxyStart === 'auto')
        setImmediate(() => {
          container.ready();
        });
    }
    this.onAttached(container);
    return {
      exited: container.exited,
      write: (line) => {
        if (container.removed) return false;
        container.written.push(line.replace(/\n$/, ''));
        container.onLine(line.replace(/\n$/, ''));
        return true;
      },
      remove: () => {
        this.calls.push(`removeAttached ${spec.name}`);
        container.removed = true;
        container.exit(137);
        return Promise.resolve(undefined);
      },
    };
  }

  connectNetwork(network: string, container: string, alias: string): Promise<string> {
    this.calls.push(`connectNetwork ${network} ${container} ${alias}`);
    // As docker does: a container `docker run` has not created yet (the proxy before its ready line) is no such container.
    const proxy = this.attached
      .filter((a) => a.spec.name === container && a.spec.labels['asha.role'] === 'egress-proxy')
      .at(-1);
    if (proxy !== undefined && (proxy.removed || !proxy.started))
      return Promise.reject(
        new Error(
          `docker network connect ${network} ${container} failed:\nError response from daemon: No such container: ${container}`,
        ),
      );
    const address = `10.99.${String(this.connections.length)}.2`;
    this.connections.push({ network, container, alias, address });
    return Promise.resolve(address);
  }

  disconnectNetwork(network: string, container: string): Promise<void> {
    this.calls.push(`disconnectNetwork ${network} ${container}`);
    return Promise.resolve(undefined);
  }

  pluginContainer(spec: PluginSpec): PluginContainer {
    const plugin = new FakePlugin(spec);
    this.plugins.push(plugin);
    this.onPlugin(plugin);
    return {
      create: () => {
        this.calls.push(`plugin create ${spec.name}`);
        plugin.created = true;
        return Promise.resolve(undefined);
      },
      copyIn: async (archive, _timeoutMs, signal) => {
        this.calls.push(`plugin copyIn ${spec.name}`);
        const parts: Buffer[] = [];
        for await (const chunk of archive) parts.push(Buffer.from(chunk));
        const input = Buffer.concat(parts);
        plugin.copiedIn.push(input);
        return (await plugin.onCopyIn(input, signal)) ?? { kind: 'exited', code: 0, stderr: '' };
      },
      run: async (_timeoutMs, _maxBytes, signal) => {
        this.calls.push(`plugin run ${spec.name}`);
        return plugin.run(plugin, signal);
      },
      copyOut: async (path, onChunk) => {
        this.calls.push(`plugin copyOut ${spec.name} ${path}`);
        plugin.copiedOut.push(path);
        const out = plugin.outputs.get(path);
        if (out === undefined) return { ok: false, detail: `no ${path} in ${spec.name}` };
        for (let i = 0; i < out.length; i += 4096) if ((await onChunk(out.subarray(i, i + 4096))) === 'stop') break;
        return { ok: true };
      },
      remove: () => {
        this.calls.push(`plugin remove ${spec.name}`);
        plugin.removed = true;
        return Promise.resolve(undefined);
      },
    };
  }

  ensureImage(spec: ImageSpec): Promise<EnsuredImage> {
    this.images.push(spec);
    return Promise.resolve({
      tag: imageTag(spec),
      status: 'built',
      labels: { 'asha.source': spec.sourceDigest, ...spec.labels },
    });
  }

  /** When set, the next start's `exited` rejects with it: its container could not be created (an ImageGone, R5). */
  failStartWith: Error | undefined;

  start(spec: ContainerSpec): { readonly exited: Promise<number> } {
    this.starts.push(spec);
    this.calls.push(`start ${spec.name}`);
    if (this.failStartWith !== undefined) {
      const failure = this.failStartWith;
      this.failStartWith = undefined;
      return { exited: Promise.reject(failure) };
    }
    const exited = new Promise<number>((resolve, reject) => {
      this.exits.set(spec.name, resolve);
      this.losses.set(spec.name, reject);
    });
    this.contents.set(spec.name, new Map());
    if (spec.archive === undefined) {
      this.onStart(spec);
      return { exited };
    }
    // The restore is read in full before the container starts, as docker cp finishes before docker start.
    const archive = spec.archive;
    const restoring = (async () => {
      const parts: Buffer[] = [];
      for await (const chunk of archive()) parts.push(Buffer.from(chunk));
      const whole = Buffer.concat(parts);
      this.restored.set(spec.name, whole);
      this.contents.set(spec.name, splitRestore(whole));
    })();
    const started = restoring.then(() => {
      this.onStart(spec);
    });
    return { exited: started.then(() => exited) };
  }

  /** Simulates the container exiting on its own. */
  exit(name: string, code: number): void {
    this.exits.get(name)?.(code);
  }

  /** The container's `docker start --attach` dies with `error`, the container started: its `exited` rejects. */
  lose(name: string, error: Error): void {
    this.losses.get(name)?.(error);
  }

  stop(name: string, mode: 'drain', graceS: number): Promise<void>;
  stop(name: string, mode: 'kill'): Promise<void>;
  async stop(name: string, mode: StopMode, graceS?: number): Promise<void> {
    if (mode === 'drain' && graceS === undefined) throw new Error(`FakeRuntime: stop ${name} drain without its grace`);
    this.stops.push(name);
    this.stopModes.push(mode);
    this.stopRecords.push({ name, mode, ...(graceS === undefined ? {} : { graceS }), at: Date.now() });
    this.calls.push(
      mode === 'drain'
        ? `stop ${name} drain ${String(present(graceS, 'graceS when mode is drain'))}`
        : `stop ${name} kill`,
    );
    await this.onStop(name, mode);
  }

  /** `copyOut` of a holder's space, extracted for `copyOut`'s cognitive complexity. */
  private async copyOutHolder(
    name: string,
    path: string,
    onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>,
    signal: AbortSignal | undefined,
  ): Promise<CopyOutcome> {
    const scripted = await this.onCopy(name, path);
    if (signal?.aborted === true) throw signal.reason;
    if (scripted !== undefined) return scripted;
    const tar = spaceTar(this.spaceOf(name), path);
    if (tar === undefined)
      return {
        ok: false,
        detail: `docker cp ${name}:${path} - exited 1: Error response from daemon: Could not find the file ${path} in container ${name}`,
      };
    const aborted = (): boolean => signal?.aborted === true;
    for (let i = 0; i < tar.length; i += 4096) {
      if (aborted()) throw present(signal, 'signal when aborted').reason;
      if ((await onChunk(tar.subarray(i, i + 4096))) === 'stop') break;
    }
    return { ok: true };
  }

  /**
   * `copyOut` of a held copy in progress, which a checkpoint's bound may still abort: extracted for `copyOut`'s
   * cognitive complexity.
   */
  private async copyOutHeld(
    name: string,
    path: string,
    onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>,
    signal: AbortSignal | undefined,
  ): Promise<CopyOutcome> {
    const aborted = new Promise<never>((_, reject) => {
      if (signal?.aborted === true) reject(signal.reason as Error);
      signal?.addEventListener(
        'abort',
        () => {
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
    const scripted = await Promise.race([this.onCopy(name, path), aborted]);
    if (signal?.aborted === true) throw signal.reason;
    if (scripted !== undefined) return scripted;
    const content = this.contents.get(name)?.get(path);
    // An empty directory: docker cp gives its entry alone.
    const tar = content ?? Buffer.concat([emptyDirectoryTar(path.slice(1)), Buffer.alloc(1024)]);
    for (let i = 0; i < tar.length; i += 4096) if ((await onChunk(tar.subarray(i, i + 4096))) === 'stop') break;
    return { ok: true };
  }

  async copyOut(
    name: string,
    path: string,
    onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>,
    signal?: AbortSignal,
  ): Promise<CopyOutcome> {
    this.calls.push(`copyOut ${name} ${path}`);
    return this.holders.has(name)
      ? this.copyOutHolder(name, path, onChunk, signal)
      : this.copyOutHeld(name, path, onChunk, signal);
  }

  oneShot(spec: OneShotSpec): OneShot {
    let memoryAfter: Buffer | undefined;
    return {
      run: async () => {
        this.calls.push(`oneShot ${spec.name} run`);
        const parts: Buffer[] = [];
        for await (const chunk of spec.archive()) parts.push(Buffer.from(chunk));
        const memory = splitRestore(Buffer.concat(parts)).get('/memory') ?? Buffer.alloc(0);
        this.oneShots.push({ spec, memory });
        const scripted = await this.onOneShot(spec, memory);
        memoryAfter = scripted.memoryAfter;
        return scripted.run;
      },
      copyOut: async (path, onChunk) => {
        this.calls.push(`oneShot ${spec.name} copyOut ${path}`);
        if (memoryAfter === undefined) return { ok: false, detail: `no ${path} in ${spec.name}` };
        for (let i = 0; i < memoryAfter.length; i += 4096)
          if ((await onChunk(memoryAfter.subarray(i, i + 4096))) === 'stop') break;
        return { ok: true };
      },
      remove: async () => {
        this.calls.push(`oneShot ${spec.name} remove`);
        await this.onOneShotRemove(spec.name);
      },
    };
  }
}

/** Applies a tar's directories and regular files to a fake volume, as Docker's extraction does (owners from the headers). */
export async function applyTar(volume: FakeVolume, bytes: Buffer): Promise<void> {
  let current: { name: string; parts: Buffer[]; header: TarHeader } | undefined;
  const owner = (h: Buffer, at: number): string => {
    const field = (o: number, l: number) =>
      parseInt(truncateAtNul(h.subarray(o, o + l).toString('latin1')).trim() || '0', 8);
    return `${String(field(at + 108, 8))}:${String(field(at + 116, 8))}`;
  };
  const owners: string[] = [];
  // Owners in header order (the parser does not report them): every non-extended header's.
  for (let at = 0; at + 512 <= bytes.length;) {
    const h = bytes.subarray(at, at + 512);
    if (h.every((b) => b === 0)) break;
    const size = parseInt(truncateAtNul(h.subarray(124, 136).toString('latin1')).trim() || '0', 8);
    const type = String.fromCharCode(present(h[156], 'tar header type byte'));
    if (!['x', 'g', 'L', 'K'].includes(type)) owners.push(owner(bytes, at));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  let index = 0;
  const parser = new TarParser({
    entry: (header) => {
      current = { name: header.name.replace(/\/$/, ''), parts: [], header };
      return Promise.resolve(undefined);
    },
    data: (chunk) => {
      present(current, 'the current tar entry').parts.push(Buffer.from(chunk));
      return Promise.resolve(undefined);
    },
    entryEnd: () => {
      const { name, parts, header } = present(current, 'the current tar entry');
      const who = owners[index++] ?? '0:0';
      const rel = name.split('/').slice(1).join('/');
      if (rel === '') volume.rootOwner = who;
      else if (header.type === '5') volume.entries.set(rel, { type: 'dir', owner: who });
      else volume.entries.set(rel, { type: 'file', content: Buffer.concat(parts), owner: who, mode: header.mode });
      return Promise.resolve(undefined);
    },
    end: () => Promise.resolve(undefined),
  });
  await parser.push(bytes);
}

/** A tar of a fake space at `path` (`/channel`, `/channel/<name>`, `/channel/<folder>`), as docker cp gives it, or undefined if absent. */
function spaceTar(volume: FakeVolume, path: string): Buffer | undefined {
  const rel = path.replace(/^\/channel\/?/, '');
  const base = rel === '' ? 'channel' : present(rel.split('/').at(-1), 'the last path segment');
  const parts: Buffer[] = [];
  const header = (name: string, type: string, size: number, link = '', ownerText = '1000:1000'): Buffer => {
    if (type === '0' || type === '5') {
      const h = tarEntryHeader(name, type === '5' ? 'directory' : 'file', size, 0);
      if (ownerText === '1000:1000') return h;
      // Rewrite the last header block's owner (and checksum) for another owner.
      const last = Buffer.from(h);
      const at = last.length - 512;
      const [uid, gid] = ownerText.split(':').map(Number);
      last.write(`${present(uid, 'ownerText uid').toString(8).padStart(7, '0')}\0`, at + 108, 8, 'ascii');
      last.write(`${present(gid, 'ownerText gid').toString(8).padStart(7, '0')}\0`, at + 116, 8, 'ascii');
      last.write('        ', at + 148, 8, 'ascii');
      let sum = 0;
      for (const b of last.subarray(at)) sum += b;
      last.write(`${sum.toString(8).padStart(6, '0')}\0 `, at + 148, 8, 'ascii');
      return last;
    }
    const h = Buffer.alloc(512);
    h.write(name, 0, 100, 'utf8');
    h.write('0000777\0', 100, 8, 'ascii');
    h.write('0001750\0', 108, 8, 'ascii');
    h.write('0001750\0', 116, 8, 'ascii');
    h.write('00000000000\0', 124, 12, 'ascii');
    h.write('00000000000\0', 136, 12, 'ascii');
    h.write('        ', 148, 8, 'ascii');
    h.write(type, 156, 1, 'ascii');
    h.write(link, 157, 100, 'utf8');
    h.write('ustar\0', 257, 6, 'ascii');
    h.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const b of h) sum += b;
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return h;
  };
  const add = (relName: string, entry: FakeEntry): void => {
    let name: string;
    if (rel === '') name = `channel/${relName}`;
    else if (relName === rel) name = base;
    else name = `${base}/${relName.slice(rel.length + 1)}`;
    if (entry.type === 'dir') parts.push(header(name, '5', 0, '', entry.owner));
    else if (entry.type === 'file')
      parts.push(
        header(name, '0', entry.content.length, '', entry.owner),
        entry.content,
        Buffer.alloc(padOf(entry.content.length)),
      );
    else if (entry.type === 'link') parts.push(header(name, '2', 0, entry.target));
    else parts.push(header(name, '6', 0));
  };
  if (rel === '') {
    parts.push(header('channel', '5', 0, '', volume.rootOwner));
  } else {
    const entry = volume.entries.get(rel);
    if (entry === undefined) return undefined;
    add(rel, entry);
    // docker cp never follows a link at the copied path's last component: the link alone.
    if (entry.type !== 'dir') return Buffer.concat([...parts, Buffer.alloc(1024)]);
  }
  for (const name of [...volume.entries.keys()].sort(byCodeUnit)) {
    if (rel !== '' && !name.startsWith(`${rel}/`)) continue;
    add(name, present(volume.entries.get(name), `volume entry ${name}`));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

/** A tar of one directory entry, owned by 1000: what docker cp gives for an empty directory. */
function emptyDirectoryTar(name: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(`${name}/`, 0, 100, 'utf8');
  h.write('0000755\0', 100, 8, 'ascii');
  h.write('0001750\0', 108, 8, 'ascii');
  h.write('0001750\0', 116, 8, 'ascii');
  h.write('00000000000\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write('5', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

export class FakeStore implements ModelStore {
  readonly ensured: string[] = [];
  ensure(entry: CatalogueEntry): Promise<CachedModel> {
    this.ensured.push(entry.id);
    return Promise.resolve({
      dir: `/models/${entry.id}`,
      weightsPath: `/models/${entry.id}/${entry.weights}`,
      status: 'cached',
    });
  }
}

/** The key every FakeModelServer endpoint requires. */
const FAKE_MODEL_KEY = 'fake-model-server-key';

export class FakeModelServer implements ModelServer {
  readonly served: string[] = [];
  /** A model served at its own address, as each catalogue entry gets its own llama-server; the rest share baseUrl. */
  readonly urlFor: Record<string, string> = {};
  stopped = 0;
  /** The models served now: added by ensureServing, removed by stopIdle (docs/plans/portal-demo-stop.md R3). */
  readonly live = new Set<string>();
  /** Each stopIdle call's stopped models, in order. */
  readonly stoppedIdle: string[][] = [];
  constructor(private readonly baseUrl: string) {}
  private endpointOf(entry: CatalogueEntry): ModelEndpoint {
    return { baseUrl: this.urlFor[entry.id] ?? this.baseUrl, model: entry.id, apiKey: FAKE_MODEL_KEY };
  }
  /** Each live model's server number (ModelLease.server): a new one each time ensureServing starts the model. */
  readonly servers = new Map<string, number>();
  private launches = 0;
  /** When set, every start of a model not live fails with it, as a server that never becomes ready does. */
  startFailure: Error | undefined;
  ensureServing(entry: CatalogueEntry): Promise<ModelEndpoint> {
    if (this.startFailure !== undefined && !this.live.has(entry.id)) return Promise.reject(this.startFailure);
    this.served.push(entry.id);
    if (!this.live.has(entry.id)) {
      this.launches += 1;
      this.servers.set(entry.id, this.launches);
    }
    this.live.add(entry.id);
    return Promise.resolve(this.endpointOf(entry));
  }
  /** Each lease's model, in order (docs/plans/idle-shutdown.md R2); and how many are held now. */
  readonly leased: string[] = [];
  held = 0;
  /** When set, a lease that must start its model waits for it first: a start that takes as long as the test says. */
  startGate: Promise<void> | undefined;
  /** A lease of a model not live starts it, as the real server does: through ensureServing, so `served` shows it. */
  async lease(entry: CatalogueEntry): Promise<ModelLease> {
    this.leased.push(entry.id);
    if (!this.live.has(entry.id) && this.startGate !== undefined) await this.startGate;
    const endpoint = this.live.has(entry.id) ? this.endpointOf(entry) : await this.ensureServing(entry);
    return this.leaseOf(endpoint, present(this.servers.get(entry.id), `${entry.id}'s server`));
  }
  /** Each holdServer call's model and server, in order; a hold of a server no longer live is refused. */
  readonly holds: (readonly [string, number])[] = [];
  holdServer(model: string, server: number): ModelLease | undefined {
    this.holds.push([model, server]);
    if (!this.live.has(model) || this.servers.get(model) !== server) return undefined;
    return this.leaseOf({ baseUrl: this.urlFor[model] ?? this.baseUrl, model, apiKey: FAKE_MODEL_KEY }, server);
  }
  private leaseOf(endpoint: ModelEndpoint, server: number): ModelLease {
    this.held += 1;
    let released = false;
    return {
      endpoint,
      server,
      release: () => {
        if (released) return;
        released = true;
        this.held -= 1;
      },
    };
  }
  /** Each unloadIdle call's bound (idle-shutdown R1); a test names the models the next call stops, taken out of `live`. */
  readonly unloadCalls: number[] = [];
  unloadNext: string[] = [];
  unloadIdle(idleMs: number): Promise<string[]> {
    this.unloadCalls.push(idleMs);
    const stopped = this.unloadNext.filter((m) => this.live.delete(m)).sort(byCodeUnit);
    this.unloadNext = [];
    return Promise.resolve(stopped);
  }
  stopAll(): Promise<void> {
    this.stopped += 1;
    return Promise.resolve(undefined);
  }
  stopIdle(inUse: () => ReadonlySet<string>): Promise<string[]> {
    const used = inUse();
    const idle = [...this.live].filter((m) => !used.has(m)).sort(byCodeUnit);
    for (const m of idle) this.live.delete(m);
    this.stoppedIdle.push(idle);
    return Promise.resolve(idle);
  }
  /** How many times the start's orphan sweep ran, and what it does: a count, or a failure (debt-paydown R13). */
  reclaimed = 0;
  reclaimOrphansWith: () => Promise<number> = () => Promise.resolve(0);
  async reclaimOrphans(): Promise<number> {
    this.reclaimed += 1;
    return this.reclaimOrphansWith();
  }
  /** The key a test says this server has made (docs/plans/portal.md R8b); undefined until it does. */
  key: string | undefined;
  apiKeyMade(): string | undefined {
    return this.key;
  }
}

export const FIXTURE_RECIPE = {
  id: 'greeter',
  image: 'greeter-image',
  description: 'Greets whoever asks.',
  prompt: 'you greet whoever asks.',
  model: 'tiny-model',
  startupTimeoutMs: 2_000,
  messageTimeoutMs: 2_000,
  chat: { temperature: 0 },
  tools: [] as string[],
};

export const FIXTURE_CHAT_DEFAULTS = { temperature: 0.5, chat_template_kwargs: { enable_thinking: false } };
export const FIXTURE_TOOL_CALL_START = '<tool_call>\n';

/** A second recipe on the same image, with an embedding model — as the memory recipe has. */
const FIXTURE_EMBEDDING_RECIPE = {
  ...FIXTURE_RECIPE,
  id: 'rememberer',
  description: 'Remembers things.',
  embeddingModel: 'tiny-embed',
};
/** The fixture embedding model's vector size and query template. */
const FIXTURE_EMBED = { dimensions: 4, queryTemplate: 'Q: {text}' };

/**
 * A repo root with one recipe, its image (Dockerfile + a fake compiled dist)
 * and its catalogue entry, so image staging and definition loading are real.
 */
export async function fixtureRoot(
  recipe: typeof FIXTURE_RECIPE = FIXTURE_RECIPE,
  manifest: unknown = { tools: [] },
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'asha-root-'));
  const files: Record<string, string> = {
    [`recipes/${recipe.id}.json`]: JSON.stringify(recipe),
    [`recipes/${FIXTURE_EMBEDDING_RECIPE.id}.json`]: JSON.stringify({
      ...FIXTURE_EMBEDDING_RECIPE,
      image: recipe.image,
      model: recipe.model,
    }),
    [`catalogue/${FIXTURE_EMBEDDING_RECIPE.embeddingModel}.json`]: JSON.stringify({
      kind: 'embedding',
      id: FIXTURE_EMBEDDING_RECIPE.embeddingModel,
      repo: 'Org/Tiny-Embed-GGUF',
      revision: 'e'.repeat(40),
      weights: 'embed.gguf',
      files: [{ path: 'embed.gguf', size: 1, sha256: 'e'.repeat(64) }],
      license: { id: 'apache-2.0', source: 'https://example/README.md', verified: '2026-09-26' },
      serve: { contextSize: 512, pooling: 'last' },
      embed: FIXTURE_EMBED,
    }),
    [`images/${recipe.image}/Dockerfile`]: 'FROM scratch\n',
    // The harness's own images (extension-modules R37), staged as the module host stages them.
    'harness-images/module-base/Dockerfile': 'FROM scratch\n',
    'harness-images/egress-proxy/Dockerfile': 'FROM scratch\n',
    'harness-images/plugin-base/Dockerfile': 'FROM scratch\n',
    'dist/src/module-runtime/main.js': '// module runtime\n',
    'dist/src/egress-proxy/main.js': '// egress proxy\n',
    [`images/${recipe.image}/image.json`]: JSON.stringify(manifest),
    [`dist/images/${recipe.image}/src/main.js`]: '// agent\n',
    'dist/src/shared/protocol.js': '// protocol\n',
    'dist/src/agent-sdk/index.js': '// sdk\n',
    // No agent packages: stageAgentImage copies the closure of these dependencies, here none, from dist/agent-packages
    // as the build makes it (debt-paydown R10, R11).
    'package.json': JSON.stringify({ name: 'fixture', dependencies: {} }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'fixture' } } }),
    'dist/agent-packages/package.json': JSON.stringify({ name: 'fixture', dependencies: {} }),
    'dist/agent-packages/package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'fixture' } },
    }),
    [`catalogue/${recipe.model}.json`]: JSON.stringify({
      kind: 'chat',
      id: recipe.model,
      repo: 'Org/Tiny-GGUF',
      revision: 'a'.repeat(40),
      weights: 'tiny.gguf',
      files: [{ path: 'tiny.gguf', size: 1, sha256: 'b'.repeat(64) }],
      license: { id: 'apache-2.0', source: 'https://example/LICENSE', verified: '2026-09-26' },
      serve: { contextSize: 512 },
      chat: FIXTURE_CHAT_DEFAULTS,
      toolCallStart: FIXTURE_TOOL_CALL_START,
    }),
    // The portal's page as an installation holds it (docs/plans/portal.md R2), stubbed: `asha --server` on this root
    // reads every allow-listed file at start. A test that loads the page uses the integration tier's compiled one.
    ...Object.fromEntries(PORTAL_STATIC_FILES.map((name) => [`portal/${name}`, `stub ${name}\n`])),
    ...Object.fromEntries(PORTAL_MODULES.map((path) => [`dist/portal-build/src/${path}`, `// stub ${path}\n`])),
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}
