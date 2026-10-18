// The composition root: the one place concrete adapters are chosen and wired
// (PRINCIPLES §10). Tests call startDaemon with fake dependencies; `asha
// --server` calls it with productionDependencies.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { present } from '../shared/assert-present.js';
import { ensureHome, insideGitTree, type HarnessPaths } from '../shared/paths.js';
import type { DaemonFile } from '../shared/protocol.js';
import { AgentSupervisor } from './agents/index.js';
import { Channels, FileUserLedger } from './channel/index.js';
import { ColimaRuntime, type ContainerRuntime } from './container-runtime/index.js';
import { Definitions, UnknownRecipe, UnknownTeam } from './definitions/index.js';
import { listDemos } from './demos/index.js';
import { ChannelFileSpaces } from './files/index.js';
import { DaemonLifetime, processRunning, type LifetimeOptions, type LifetimeStop } from './lifetime.js';
import type { Logger } from './log.js';
import { LlamaCppServer, realOrphanSweep, type ModelServer } from './model-server/index.js';
import { HuggingFaceModelStore, type ModelStore } from './model-store/index.js';
import {
  ExecCommandRunner,
  SpawnInteractiveLauncher,
  SpawnProcessLauncher,
  acquirePidLock,
  isAlive,
} from './process/index.js';
import { writePrivateFile, writePrivateFileSync } from './private-file/index.js';
import { RefusalLog, type Schedule } from './refusal-log/index.js';
import { PortalErrorLog, PortalFileMissing, PortalFiles, type PortalFolders } from './portal/index.js';
import { createDaemonServer } from './server.js';
import { Telemetry, recordAndCount } from './telemetry/index.js';
import { appendOpen, createModuleServices, loadInstalledModules, realSetTimer } from './modules/index.js';
import { FileSecretStore } from './secrets/index.js';
import { StateStore, identityKey, nodeStateFs, type AgentIdentity, type StateFs } from './state/index.js';
import {
  DaemonTracer,
  TRACE_AGENT_DAILY_BYTES,
  TRACE_DAEMON_RESERVE_BYTES,
  TRACE_FILE_CAP_BYTES,
  TraceFileWriter,
  nodeTraceFiles,
} from './traces/index.js';

export interface DaemonDependencies {
  readonly runtime: ContainerRuntime;
  readonly modelServer: ModelServer;
  readonly store: ModelStore;
  readonly fetch: typeof fetch;
  /** The filesystem saved state is written through (agent-persistence R4): the real one, or a fault-injecting double. */
  readonly stateFs: StateFs;
  /** The check that a path is in a git tree (agent-persistence R2), injected so a test can see whether it ran. */
  readonly insideGitTree: (path: string) => Promise<boolean>;
}

export interface StartDaemonProps {
  readonly paths: HarnessPaths;
  /** Repo root: images/, recipes/, catalogue/, dist/. */
  readonly root: string;
  readonly version: string;
  /** Fingerprint of the compiled code this daemon runs. */
  readonly build: string;
  readonly pid: number;
  readonly logger: Logger;
  readonly dependencies: DaemonDependencies;
  readonly heartbeatMs: number;
  readonly chatTimeoutMs: number;
  /** The timer refusal logging and the portal's error reports count their windows with (`timerSchedule` in production). */
  readonly schedule: Schedule;
  /** Where the portal's files are read at start (docs/plans/portal.md R2): `portalFolders(root)` in production. */
  readonly portal: PortalFolders;
  /**
   * How long the daemon and its model servers live (docs/plans/idle-shutdown.md R1, R3, R4, R6): from `asha --server`'s
   * environment in production; checked on `schedule`.
   */
  readonly lifetime: LifetimeOptions;
}

/**
 * Who began a stop (docs/plans/portal.md R14): a signal to `asha --server`, the portal's `POST /v1/stop`, an in-process
 * caller, or the daemon's lifetime — idle past its bound, or the process it exits with gone (idle-shutdown R3, R6).
 */
type StopSource =
  | { readonly source: 'signal'; readonly signal: NodeJS.Signals }
  | { readonly source: 'portal' }
  | { readonly source: 'call' }
  | LifetimeStop;

export interface RunningDaemon {
  readonly port: number;
  /**
   * The daemon's one stop trigger (R14): its first call starts the stop — every agent (letting each finish its started
   * work), then the server, the isolation and the model servers; the home released — and logs `daemon.stop_requested`
   * with its source; every later call changes nothing and logs `daemon.stop_requested` with `ignored: true`.
   */
  requestStop(source: StopSource): void;
  /** Settles when the stop the trigger began settles (`asha --server` awaits it). */
  readonly stopped: Promise<void>;
  /** The trigger, from an in-process caller (source `call`), and the stop's outcome. */
  stop(): Promise<void>;
}

export function productionDependencies(paths: HarnessPaths, logger: Logger): DaemonDependencies {
  const runner = new ExecCommandRunner();
  const launcher = new SpawnProcessLauncher();
  return {
    runtime: new ColimaRuntime({
      runner,
      launcher,
      interactive: new SpawnInteractiveLauncher(),
      logger,
      profile: 'default',
      homeId: paths.homeId,
      clock: () => new Date(),
    }),
    modelServer: new LlamaCppServer({
      runner,
      launcher,
      logger,
      fetch: globalThis.fetch,
      logDir: paths.logsDir,
      readyTimeoutMs: 120_000,
      keyFile: paths.modelServerKey,
      writeKeyFile: writePrivateFile,
      orphans: realOrphanSweep,
      now: () => Date.now(),
    }),
    store: new HuggingFaceModelStore({
      modelsDir: paths.modelsDir,
      baseUrl: 'https://huggingface.co',
      fetch: globalThis.fetch,
      logger,
      stallTimeoutMs: 60_000,
      pid: process.pid,
      isAlive,
    }),
    fetch: globalThis.fetch,
    stateFs: nodeStateFs,
    insideGitTree,
  };
}

/**
 * Saved state at the daemon's start, before any agent launches (agent-persistence R2, R4, R9 (h)): the git-tree
 * check, the store walked and what a crash left removed, then each record of unsaved deliveries whose identity's
 * recipe or team no longer persists anything logged `state.pending_orphaned` (--list-state shows it, and
 * --reset-state removes it).
 */
async function startState(state: StateStore, definitions: Definitions, logger: Logger): Promise<void> {
  const { withPending } = await state.cleanupAtStart();
  for (const identity of withPending) {
    let persists: boolean;
    try {
      persists = await stillPersists(definitions, identity);
    } catch (error) {
      // A definition that does not load is its own failure, found at launch; here it is said and the start goes on.
      logger.error('state.pending_check_failed', { identity: identityKey(identity), error });
      continue;
    }
    if (!persists) logger.warn('state.pending_orphaned', { identity: identityKey(identity) });
  }
}

/** Whether an identity's recipe (alone) or team member's recipe still persists anything; false when it is gone. */
async function stillPersists(definitions: Definitions, identity: AgentIdentity): Promise<boolean> {
  try {
    if (identity.team === null) return (await definitions.recipe(identity.name)).persist.length > 0;
    const member = (await definitions.team(identity.team)).members.find((m) => m.name === identity.name);
    return member !== undefined && member.recipe.persist.length > 0;
  } catch (error) {
    if (error instanceof UnknownRecipe || error instanceof UnknownTeam) return false;
    throw error;
  }
}

export async function startDaemon(props: StartDaemonProps): Promise<RunningDaemon> {
  const { paths, logger, dependencies } = props;
  // A new home is readable by this user only: it holds the control credential and the model server key.
  await ensureHome(paths);
  for (const dir of [paths.logsDir, paths.agentLogsDir, paths.stagingDir]) {
    await mkdir(dir, { recursive: true });
  }
  // The portal's files, read once, so a page always matches this daemon (docs/plans/portal.md R2): a missing one fails
  // the start, naming it, before anything is held.
  let portal: PortalFiles;
  try {
    portal = await PortalFiles.load(props.portal);
  } catch (error) {
    logger.error('daemon.start_failed', { path: error instanceof PortalFileMissing ? error.path : null, error });
    throw error;
  }
  // One daemon per home. A second one fails here with LockHeld, loudly.
  const release = await acquirePidLock({ file: paths.daemonLock, pid: props.pid, isAlive, logger });
  const daemonStartedAt = new Date().toISOString();
  const definitions = new Definitions(props.root);
  const state = new StateStore({
    dir: paths.stateDir,
    fs: dependencies.stateFs,
    logger,
    clock: () => new Date(),
    insideGitTree: dependencies.insideGitTree,
  });
  try {
    // Saved state, only when there is some (agent-persistence R2, R4): never in a git tree — checked here only when
    // state/ exists, so a home in a git tree starts as ever with persistence unused — and what a crash left removed.
    if (await state.exists()) await startState(state, definitions, logger);
  } catch (error) {
    logger.error('daemon.state_failed', { error });
    await release();
    throw error;
  }
  // Installed modules: only their manifests are read, and only when ASHA_HOME/modules/ exists (extension-modules R3, R38).
  let installed;
  try {
    installed = await loadInstalledModules(paths.modulesDir, logger);
  } catch (error) {
    logger.error('daemon.modules_failed', { error });
    await release();
    throw error;
  }
  try {
    // What a dead daemon of this home left in the container runtime (its network, rules, containers, volumes).
    const { volumes } = await dependencies.runtime.reclaim();
    if (volumes > 0) logger.warn('files.stale_space_removed', { volumes });
  } catch (error) {
    logger.error('daemon.reclaim_failed', { error });
    await release();
    throw error;
  }
  try {
    // The model servers a killed daemon of this home left running, found by this home's key file (debt-paydown R12,
    // R13; D13): the lock guarantees no live daemon of this home owns one. Before the server listens.
    await dependencies.modelServer.reclaimOrphans();
  } catch (error) {
    logger.error('daemon.orphan_sweep_failed', { error });
    await release();
    throw error;
  }
  try {
    // asha's own old image versions (debt-paydown-2 R1): after the sweeps, before the server listens. It logs its own
    // skip or failure; one that throws all the same is recorded here, and never fails the start (an explicit, logged
    // degraded mode: the prune frees disk, and nothing else depends on it).
    await dependencies.runtime.pruneImages();
  } catch (error) {
    logger.error('image.prune_failed', { removed: [], error });
  }

  // The control credential: 256 bits from the CSPRNG, fresh at every start, before the server exists.
  const credential = randomBytes(32).toString('hex');
  const refusals = new RefusalLog({ logger, schedule: props.schedule, windowMs: 1_000 });
  // Traces (docs/plans/otel-traces.md): the day's file, retention at startup; the daemon's own spans go to the same file.
  const traces = new TraceFileWriter({
    dir: paths.logsDir,
    clock: () => new Date(),
    logger,
    files: nodeTraceFiles,
    capBytes: TRACE_FILE_CAP_BYTES,
    daemonReserveBytes: TRACE_DAEMON_RESERVE_BYTES,
    agentDailyBytes: TRACE_AGENT_DAILY_BYTES,
  });
  traces.start();
  // Each online agent's telemetry for the portal (R10), from the daemon's own spans as they are written. `channels`
  // exists only once `new Channels` runs, below: these two callbacks are called only once the daemon is running, so
  // they read it through this box rather than needing it before it exists.
  const channelsBox: { current?: Channels } = {};
  const telemetry = new Telemetry({
    isMember: (channel, handle) =>
      present(channelsBox.current, 'channels').existing(channel)?.isMember(handle) === true,
    watchChannel: (channel, watcher) => {
      present(channelsBox.current, 'channels').get(channel).watchAll(watcher);
    },
  });
  const tracer = new DaemonTracer({
    clock: () => new Date(),
    newSpanId: () => randomBytes(8).toString('hex'),
    // A failed or dropped write is logged by the writer, and not counted; the daemon's work goes on.
    record: recordAndCount(traces, telemetry),
  });

  /** Set when stop() begins; the server reads it on every request. */
  let stopping = false;
  // `supervisor` exists only once `new AgentSupervisor` runs, well below: this callback is called only once the
  // daemon is running, so it reads it through this box rather than needing it before it exists.
  const supervisorBox: { current?: AgentSupervisor } = {};
  const channels = new Channels({
    logger,
    clock: () => new Date(),
    newId: () => randomBytes(8).toString('hex'),
    onDeliveryTimeout: (channel, handle) => {
      void supervisorBox.current?.stopHandle(channel, handle, 'held a delivery past its bound');
    },
    maxAgentPostsPerConversation: 32,
    users: new FileUserLedger(join(paths.home, 'users.json')),
    tracer,
  });
  channelsBox.current = channels;
  // `port` is set only once the server is listening, well below; `daemonPort` is handed out for use at any later
  // time, so it reads the box rather than needing the port before it exists.
  const portBox: { current?: number } = {};
  const daemonPort = (): number => {
    if (portBox.current === undefined) throw new Error('daemon port requested before the server is listening');
    return portBox.current;
  };
  // The channel file spaces (docs/plans/agent-files.md): runId drawn now, so no later run reuses a crashed run's volume (R10).
  // Logged on daemon.started, so a volume's name says which run made it.
  const runId = randomBytes(4).toString('hex');
  const files = new ChannelFileSpaces({
    runtime: dependencies.runtime,
    logger,
    homeId: paths.homeId,
    runId,
    clock: () => new Date(),
    // asha's own two secrets, refused in any upload (docs/plans/portal.md R8b): the control credential, and this run's
    // model-server key from the moment it is made. No other copy of either is made.
    ownSecrets: () => {
      const key = dependencies.modelServer.apiKeyMade();
      return [
        { which: 'control credential', value: credential },
        ...(key === undefined ? [] : [{ which: 'model-server key', value: key }]),
      ];
    },
  });
  const modules = createModuleServices({
    runtime: dependencies.runtime,
    root: props.root,
    paths,
    logger,
    installed,
    files,
    secrets: new FileSecretStore({
      home: paths.home,
      dir: paths.secretsDir,
      logger,
      pid: props.pid,
      isAlive,
      insideGitTree: dependencies.insideGitTree,
    }),
    setTimer: realSetTimer,
    now: () => Date.now(),
    online: (token) => supervisorBox.current?.isAgentToken(token) === true,
    appendOpen,
  });
  // The meter's file is read only when a module is installed (R38).
  if (installed.size > 0)
    await modules.meter.load(
      [...installed.values()].filter((m) => m.manifest.cost.model === 'metered').map((m) => m.manifest.id),
    );
  const supervisor = new AgentSupervisor({
    definitions,
    store: dependencies.store,
    modelServer: dependencies.modelServer,
    runtime: dependencies.runtime,
    logger,
    fetch: dependencies.fetch,
    root: props.root,
    stagingDir: paths.stagingDir,
    agentLogsDir: paths.agentLogsDir,
    daemonPort,
    chatTimeoutMs: props.chatTimeoutMs,
    tracer,
    clock: () => new Date(),
    state,
    daemonStartedAt,
    files,
    modules,
    userHome: homedir(),
    ashaHome: resolve(paths.home),
  });
  supervisorBox.current = supervisor;
  const portalErrors = new PortalErrorLog({ logger, schedule: props.schedule });
  // The one stop trigger (R14), made before the server so its stop route can call it.
  let stopping$: Promise<void> | undefined;
  let settle!: { resolve: () => void; reject: (error: unknown) => void };
  const stopped = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
  // Awaited by `asha --server` and by stop()'s callers, who see its failure; a stop nobody awaits (a test's daemon) is
  // not an unhandled rejection, and its failure is logged daemon.stop_failed (below).
  stopped.catch(() => undefined);
  // `stoppingFile` (daemon.json as the stop rewrites it, debt-paydown R14) is set only once the server is listening,
  // well below; the `write` closure here that reads it is only called once a stop actually begins, well after that,
  // so it reads it through this box rather than needing it before it exists.
  const stoppingFileBox: { current?: DaemonFile } = {};
  // How long the daemon lives (docs/plans/idle-shutdown.md R1, R3, R6): its checks are armed once it has started, below,
  // and cleared by any stop, whoever began it; its own stops go through the one trigger.
  const lifetime = new DaemonLifetime({
    options: props.lifetime,
    schedule: props.schedule,
    now: () => Date.now(),
    busy: () => supervisor.busy(),
    unloadIdle: (idleMs) => dependencies.modelServer.unloadIdle(idleMs),
    running: processRunning,
    requestStop: (stop) => void requestStop(stop),
    logger,
  });
  const requestStop = (source: StopSource): Promise<void> => {
    lifetime.end();
    if (stopping$ !== undefined) {
      logger.info('daemon.stop_requested', { ...source, ignored: true });
      return stopping$;
    }
    logger.info('daemon.stop_requested', { ...source });
    stopping$ = stopDaemon({
      logger,
      // Nothing new starts from here on: a CLI finds this daemon stopping, and the control API answers 503.
      beginStopping: () =>
        markStopping({
          logger,
          write: () => {
            if (stoppingFileBox.current === undefined)
              throw new Error('the stop began before the daemon listened: there is no daemon.json to mark');
            writePrivateFileSync(paths.daemonFile, `${JSON.stringify(stoppingFileBox.current)}\n`);
          },
          remove: () => rm(paths.daemonFile, { force: true }),
          setStopping: () => {
            stopping = true;
          },
        }),
      removeDaemonFile: () => removeOwnDaemonFile(paths.daemonFile, props.pid),
      supervisor: running,
      closeServer: async () => {
        const closed = new Promise<void>((resolve) =>
          server.close(() => {
            resolve();
          }),
        );
        server.closeAllConnections();
        await closed;
        refusals.flush();
        portalErrors.flush();
      },
      runtime: dependencies.runtime,
      modelServer: dependencies.modelServer,
      closeTraces: () => {
        traces.close();
      },
      release,
    });
    stopping$.then(settle.resolve, (error: unknown) => {
      // Some of the stop's steps throw without a record of their own: the stop's failure is always findable.
      logger.error('daemon.stop_failed', {
        source: source.source,
        signal: source.source === 'signal' ? source.signal : null,
        error,
      });
      settle.reject(error);
    });
    return stopping$;
  };
  const running = supervisor;
  const onlineChannels = channels;
  const server = createDaemonServer({
    supervisor,
    channels,
    files,
    logger,
    version: props.version,
    build: props.build,
    startedAt: new Date().toISOString(),
    pid: props.pid,
    heartbeatMs: props.heartbeatMs,
    credential,
    port: daemonPort,
    agentHostAddress: dependencies.runtime.hostAddress,
    refusals,
    traces,
    stopping: () => stopping,
    portal,
    portalErrors,
    telemetry: (channel) => {
      // A poll for a channel nothing has used creates none (it has no agents to show).
      const known = onlineChannels.existing(channel);
      return telemetry.answer(
        channel,
        known === undefined ? [] : running.telemetryAgents(known),
        running.modelCallsInFlight(),
      );
    },
    definitions: () => definitions.catalog(),
    demos: () => listDemos({ root: props.root, channelExists: (name) => onlineChannels.existing(name) !== undefined }),
    requestStop: () => void requestStop({ source: 'portal' }),
    stopIdleModels: () => dependencies.modelServer.stopIdle(() => running.modelsInUse()),
    activity: () => lifetime.begin(),
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await release();
    throw error;
  }
  const port = (server.address() as AddressInfo).port;
  portBox.current = port;
  const file: DaemonFile = { pid: props.pid, port, credential };
  // daemon.json as the stop rewrites it (debt-paydown R14); set once the daemon listens, before any stop can begin.
  stoppingFileBox.current = { ...file, stopping: true };
  // Mode 0600 by create-and-rename: never a stale file's mode, never half written.
  await writePrivateFile(paths.daemonFile, `${JSON.stringify(file)}\n`);
  logger.info('daemon.started', {
    pid: props.pid,
    port,
    version: props.version,
    build: props.build,
    home: paths.home,
    runId,
  });
  // Armed only now that the daemon listens and daemon.json is written: no lifetime stop can come before a stop can run.
  lifetime.start();

  return {
    port,
    requestStop: (source) => void requestStop(source),
    stopped,
    stop: () => requestStop({ source: 'call' }),
  };
}

/** How long the stop waits, after the reclaim, for approved calls to be audited (R12 (e)); inside R34's sum, beside the model servers' 10 s. */
export const APPROVED_SETTLE_MS = 1_000;

/**
 * The stop's first step (debt-paydown R14, D21): daemon.json rewritten with `stopping: true` — so a CLI reading it
 * mid-stop sees a stopping daemon, not an absent one — then the flag that makes the control API answer 503. The write
 * is synchronous, so no request is served between it and the flag: the stop route's second request is refused, as
 * before R14 (portal A15). A write that fails is logged daemon.stopping_file_failed, the flag set, and the file removed
 * as before R14; the stop goes on.
 */
export async function markStopping(props: {
  readonly logger: Logger;
  readonly write: () => void;
  readonly remove: () => Promise<void>;
  readonly setStopping: () => void;
}): Promise<void> {
  try {
    props.write();
  } catch (error) {
    props.logger.error('daemon.stopping_file_failed', { error });
    props.setStopping();
    await props.remove();
    return;
  }
  props.setStopping();
}

/**
 * Removes daemon.json only while it is still this daemon's (its pid): after the lock is released, a new daemon of the
 * home may already have written its own, which is left in place. Gone already is fine.
 */
export async function removeOwnDaemonFile(path: string, pid: number): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  let holder: unknown;
  try {
    holder = (JSON.parse(text) as { pid?: unknown }).pid;
  } catch (error) {
    // Not JSON: no daemon's file, so not another daemon's either; ours was written whole, by rename.
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (holder === undefined || holder === pid) await rm(path, { force: true });
}

export interface StopDaemonProps {
  readonly logger: Logger;
  /** Marks the daemon stopping: daemon.json says so, and the control API answers 503 (markStopping). */
  readonly beginStopping: () => Promise<void>;
  /** Removes daemon.json: the stop's last step, once daemon.lock is released (debt-paydown R14). */
  readonly removeDaemonFile: () => Promise<void>;
  readonly supervisor: Pick<AgentSupervisor, 'stopAll' | 'approvedSettled'>;
  /** Closes the HTTP server, once every agent is gone. */
  readonly closeServer: () => Promise<void>;
  readonly runtime: Pick<ContainerRuntime, 'reclaim'>;
  readonly modelServer: Pick<ModelServer, 'stopAll'>;
  readonly closeTraces: () => void;
  /** Releases daemon.lock. */
  readonly release: () => Promise<void>;
}

/**
 * `failure` and `settleFailure` below are set only from a caught rejection, and every one of this stop's own steps
 * throws or rejects with an `Error` (never anything else) — asserted here, loudly, rather than defaulted, so the
 * exact object caught is what gets thrown (its identity matters to callers logging or comparing it).
 */
function caughtError(value: unknown, what: string): Error {
  if (!(value instanceof Error)) throw new TypeError(`${what} was caught as a non-Error (${typeof value})`);
  return value;
}

/**
 * The daemon's full stop, in its order (agent-persistence R10 summed it at 86 s against the CLI's 90 s; 85 s since
 * the model servers stop beside the reclaim, 2026-10-02): agents first — each persisted one's ack awaited without a
 * signal, checkpointed, then drained; every other drained with its 70 s grace; a persisted channel's board
 * checkpointed once they are — while the server still answers them and the model servers still run (the stop-time
 * race, docs/plans/enterprise-targets.md, F2); then the server; then, at once, the model servers (their 10 s SIGTERM
 * grace) beside this home's containers, networks and rules (the reclaim, about 1 s, more with module objects) and the
 * approved calls' wait (R12 (e)). A reclaim that fails still lets the rest stop, then fails the stop.
 */
export async function stopDaemon(props: StopDaemonProps): Promise<void> {
  const { logger } = props;
  logger.info('daemon.stopping', {});
  await props.beginStopping();
  await props.supervisor.stopAll('daemon stopping');
  await props.closeServer();
  // The model servers stop beside the reclaim: every agent has gone, so nothing calls them, and neither waits on the
  // other. Their 10 s grace then covers the reclaim and the approved wait instead of following them (extension-modules
  // A38 (d), 2026-10-02: 16 module containers and networks add about 2.5 s to the reclaim, P7). Its failure is held
  // here, so it is never an unhandled rejection, and thrown once the reclaim and the wait are done, as before.
  const servers = props.modelServer.stopAll().then(
    () => undefined,
    (error: unknown) => ({ error }),
  );
  let failure: unknown;
  try {
    // The home's containers, the spaces' holders among them, then its volumes (agent-files R10a).
    const { volumes } = await props.runtime.reclaim();
    if (volumes > 0) logger.info('files.space_removed', { volumes });
  } catch (error) {
    logger.error('daemon.reclaim_failed', { error });
    failure = error;
  }
  // An approved call in flight ends with its container, removed above: its outcome audited before the daemon exits (extension-modules R12 (e)).
  let settleFailure: unknown;
  try {
    await props.supervisor.approvedSettled(APPROVED_SETTLE_MS);
  } catch (error) {
    settleFailure = error;
  }
  // The model servers' stop is read whatever came before it, so its failure is never dropped; it is logged, then thrown
  // first, as before the overlap.
  const stopped = await servers;
  if (stopped !== undefined) {
    logger.error('daemon.model_servers_stop_failed', { error: stopped.error });
    throw stopped.error;
  }
  if (settleFailure !== undefined) throw caughtError(settleFailure, "the approved calls' settle wait");
  // After every agent has left: their deliveries' spans are written; then the day's drop count, if any.
  props.closeTraces();
  await props.release();
  // After the lock is free: a CLI that finds no file finds the lock free too (R14; the plan's decided item 9).
  await props.removeDaemonFile();
  if (failure !== undefined) throw caughtError(failure, 'the reclaim');
  logger.info('daemon.stopped', {});
}
