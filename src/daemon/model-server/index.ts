// Serving a cached model on the host. The contract is ModelServer; the one
// implementation is llama.cpp's `llama-server` (Metal on Apple Silicon — colima's
// Linux VM has no GPU, so inference never runs in a container). A PC build
// substitutes a CUDA build of the same server; the API it serves is the same.

import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import type { ServedEntry } from '../definitions/index.js';
import { ensureHostTool } from '../host-tools/index.js';
import type { Logger } from '../log.js';
import {
  WATCH_PID_LINE,
  isAlive,
  tail,
  type CommandRunner,
  type LaunchedProcess,
  type ProcessLauncher,
} from '../process/index.js';
import type { CachedModel } from '../model-store/index.js';
import { present } from '../../shared/assert-present.js';
import { byCodeUnit } from '../../shared/order.js';

/** Slots of a chat model's llama-server: requests served at once, each with the catalogue's `serve.contextSize` (D17). */
const CHAT_SLOTS = 4;

/**
 * The host-memory prompt cache of a chat model's llama-server, in MiB (`--cache-ram`): where a slot's prompt is
 * saved when another request takes the slot, and restored from. 8,192 is llama.cpp 0.5.0's default, kept
 * explicit (docs/plans/prompt-prefix.md R9), as the owner chose on 2026-09-28 (decision `model-server-memory`, option (a)); 0 turns
 * the store off.
 */
export const CHAT_CACHE_RAM_MIB = 8_192;

/**
 * A chat model's prompt-cache arguments, each explicit so that LLAMA_ARG_CACHE_PROMPT, LLAMA_ARG_CACHE_RAM,
 * LLAMA_ARG_CACHE_IDLE_SLOTS or LLAMA_ARG_CACHE_REUSE in the user's environment cannot change caching (the
 * arguments win over the environment: evals/probes/prompt-prefix-2026-09-28, A5), and a llama.cpp upgrade
 * cannot silently change the slot-selection threshold (docs/plans/prompt-prefix.md R9). Prefix reuse only:
 * `--cache-reuse 0`, because chunk reuse shifts KV computed under another agent's handle or another user's
 * memory into this prompt.
 */
const CHAT_CACHE_ARGS: readonly string[] = [
  '--cache-prompt',
  '--cache-ram',
  String(CHAT_CACHE_RAM_MIB),
  '--cache-idle-slots',
  '--cache-reuse',
  '0',
  '--slot-prompt-similarity',
  '0.10',
];

export interface ModelEndpoint {
  /** OpenAI-compatible base URL on host loopback, e.g. http://127.0.0.1:51305 */
  readonly baseUrl: string;
  /** The catalogue id, which is also the model name the server answers to. */
  readonly model: string;
  /**
   * The key the server requires: every call to it sends `Authorization: Bearer <apiKey>`.
   * Only the daemon holds it; it never reaches a container.
   */
  readonly apiKey: string;
}

/** One call's hold on a served model (docs/plans/idle-shutdown.md R1, R2). */
export interface ModelLease {
  readonly endpoint: ModelEndpoint;
  /**
   * Which server this is, unique within its ModelServer: a model stopped and started again is a new server, with a new
   * number, even on the same port.
   */
  readonly server: number;
  /** Ends the hold; the model's idle time counts from its last release. A second call does nothing. */
  release(): void;
}

/**
 * Serves models on the host's loopback. Every endpoint it returns requires its
 * `apiKey` on every route that reaches the model (docs/architecture/models.md#gateway
 * lists the routes llama-server leaves open).
 */
export interface ModelServer {
  /** Starts serving the model unless it is already served. */
  ensureServing(entry: ServedEntry, cached: CachedModel): Promise<ModelEndpoint>;
  /**
   * The model's endpoint for one call, its server started again if unloadIdle stopped it; held — never unloaded — until
   * `release` (idle-shutdown R2).
   */
  lease(entry: ServedEntry, cached: CachedModel): Promise<ModelLease>;
  /**
   * A lease on `server` if it is still the model's server and ready; undefined if it is not. Never starts a server: for
   * work that only that server's state is worth (the prompt store, idle-shutdown R2).
   */
  holdServer(model: string, server: number): ModelLease | undefined;
  /**
   * Stops each model with no lease held whose last release — or, never leased, its readiness — is `idleMs` or more
   * ago, each logged `model_server.unloaded_idle` with `{model, idleMs}`; a later lease starts it again (idle-shutdown
   * R1). Resolves with the models stopped.
   */
  unloadIdle(idleMs: number): Promise<string[]>;
  /** Stops every server this instance started. */
  stopAll(): Promise<void>;
  /**
   * Stops each server no agent needs (docs/plans/portal-demo-stop.md R3): every model this instance serves that
   * `inUse()` does not name, a server still starting awaited first, `inUse()` read again just before each is stopped.
   * Each is logged `model_server.stopped_idle`; a later ensureServing starts it again. Resolves with the models stopped.
   */
  stopIdle(inUse: () => ReadonlySet<string>): Promise<string[]>;
  /**
   * Stops every model server a killed daemon of this home left running, found by this home's key file on its command
   * line, before this daemon starts any (docs/plans/debt-paydown.md R12; debt D13). Resolves with how many ended.
   */
  reclaimOrphans(): Promise<number>;
  /**
   * This instance's key, from the moment it is made — before its file is written — or undefined until it is: the
   * daemon refuses an upload holding it (docs/plans/portal.md R8b).
   */
  apiKeyMade(): string | undefined;
}

/** The model server could not be started. Carries the tail of its log. */
export class ModelServerFailed extends Error {
  constructor(
    readonly model: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`serving ${model} failed: ${detail}`, options);
    this.name = 'ModelServerFailed';
  }
}

export interface LlamaCppServerProps {
  readonly runner: CommandRunner;
  readonly launcher: ProcessLauncher;
  readonly logger: Logger;
  readonly fetch: typeof fetch;
  /** Each server's output goes to <logDir>/model-server-<id>.log. */
  readonly logDir: string;
  /** Bound on launch → healthy. */
  readonly readyTimeoutMs: number;
  /**
   * Where the API key is written (mode 0600, by create-and-rename) for
   * `--api-key-file`: `<home>/model-server.key`. A fresh key is generated for
   * each instance (each daemon start) and the file is removed by stopAll.
   */
  readonly keyFile: string;
  /** Writes the key file, mode 0600 (writePrivateFile in production); injected so a test can hold the write. */
  readonly writeKeyFile: (path: string, content: string) => Promise<void>;
  /** The processes the orphan sweep signals and watches (reclaimOrphans): the real ones, or a test's table and clock. */
  readonly orphans: OrphanSweepProps;
  /** The clock a model's idle time is measured on (idle-shutdown R1): Date.now in production. */
  readonly now: () => number;
}

/** What reclaimOrphans acts through: `process.kill`, `isAlive`, a sleep and a clock in production. */
export interface OrphanSweepProps {
  readonly signal: (pid: number, signal: NodeJS.Signals) => void;
  readonly isAlive: (pid: number) => boolean;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

/** The real processes and clock: process.kill, the zero-signal liveness check of the pid locks, timers. */
export const realOrphanSweep: OrphanSweepProps = {
  signal: (pid, signal) => {
    process.kill(pid, signal);
  },
  isAlive,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** The process listing the sweep reads, every command line whole (probe P4: 22–24 ms for 830 processes). */
const PS_ARGS = ['-axww', '-o', 'pid=,ppid=,command='] as const;
/** Bound on that listing. */
const PS_TIMEOUT_MS = 2_000;
/** An orphan's SIGTERM grace: its daemon is dead, so no call in flight is worth finishing (stopAll's is 10 s). */
const ORPHAN_TERM_MS = 3_000;
/** After SIGKILL, how long the sweep waits before it logs a survivor and goes on. */
const ORPHAN_KILL_MS = 1_000;
/** How often the sweep checks whether a signalled orphan has ended. */
const ORPHAN_POLL_MS = 100;

/**
 * The pids, from `ps -axww -o pid=,ppid=,command=`, of the llama-server processes whose command names `keyFile` as
 * its `--api-key-file`: the command's first word has the basename llama-server, and it holds ` --api-key-file
 * <keyFile>` followed by a space or the end of the line. A line that is not `pid ppid command` throws.
 */
function orphanPids(table: string, keyFile: string): number[] {
  const flag = ` --api-key-file ${keyFile}`;
  const pids: number[] = [];
  for (const line of table.split('\n')) {
    if (line.trim() === '') continue;
    // The command is read by slicing past the matched "pid ppid " prefix, not by a trailing `(.*)$` capture group,
    // so the pattern never pairs a `\s+` quantifier against the `.` it overlaps with (sonarjs/super-linear-regex).
    const head = /^\s*(\d+)\s+(\d+)\s+/.exec(line);
    if (head === null)
      throw new Error(`ps printed a line that is not "pid ppid command": ${JSON.stringify(line.slice(0, 200))}`);
    const command = line.slice(head[0].length);
    if (basename(present(command.split(' ')[0], "command.split(' ')[0]")) !== 'llama-server') continue;
    const at = command.indexOf(flag);
    if (at < 0) continue;
    const next = command[at + flag.length];
    if (next === undefined || next === ' ') pids.push(Number(head[1]));
  }
  return pids;
}

/** `ps`'s own listing, bounded by PS_TIMEOUT_MS; a non-zero exit throws (reclaimOrphans's two reads of it). */
async function listProcesses(runner: CommandRunner): Promise<string> {
  const listed = await runner.run('ps', PS_ARGS, { timeoutMs: PS_TIMEOUT_MS });
  if (listed.code !== 0)
    throw new Error(`ps ${PS_ARGS.join(' ')} exited ${String(listed.code)}: ${listed.stderr.trim()}`);
  return listed.stdout;
}

interface Serving {
  readonly process: LaunchedProcess;
  readonly ready: Promise<ModelEndpoint>;
  /** Its number (ModelLease.server). */
  readonly server: number;
  /** Its endpoint once it is ready; undefined until then. */
  endpoint: ModelEndpoint | undefined;
  /** The calls holding it now (lease): it is never unloaded or stopped idle while one is (idle-shutdown R1). */
  holds: number;
  /** When its last hold was released, or, never held, when it became ready; undefined until it is ready. */
  lastUsed: number | undefined;
}

// build 8130: "main: server is listening on http://127.0.0.1:N - starting the main loop";
// 0.5.0 (Homebrew, 2026-09-27): "… I srv  llama_server: listening on http://127.0.0.1:N".
const LISTENING = /\blistening on (http:\/\/127\.0\.0\.1:\d+)/;
const HEALTH_POLL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const STOP_GRACE_MS = 10_000;

export class LlamaCppServer implements ModelServer {
  private readonly serving = new Map<string, Serving>();
  /** The servers launched so far: the last one's number (ModelLease.server). */
  private launches = 0;
  /** The servers being stopped on purpose, by process: an exit of one of these is not a warning. */
  private readonly stopping = new Set<LaunchedProcess>();
  /** The key, once written to keyFile; one per instance, shared by every server it starts. */
  private key: Promise<string> | undefined;
  /** The key from the moment it is made, before its file is written (portal R8b); undefined again if the write fails. */
  private made: string | undefined;

  constructor(private readonly props: LlamaCppServerProps) {}

  /**
   * 32 bytes from the CSPRNG, hex-encoded, written to keyFile on first use. Never on a command line,
   * where `ps` would show it.
   */
  private apiKey(): Promise<string> {
    this.key ??= (async () => {
      const key = randomBytes(32).toString('hex');
      // Recorded before the file exists: no upload that starts after the key file is written goes unchecked against it.
      this.made = key;
      await this.props.writeKeyFile(this.props.keyFile, `${key}\n`);
      return key;
    })().catch((error: unknown) => {
      this.key = undefined;
      this.made = undefined;
      throw error;
    });
    return this.key;
  }

  apiKeyMade(): string | undefined {
    return this.made;
  }

  async reclaimOrphans(): Promise<number> {
    const { keyFile } = this.props;
    // A relative path would name every home given the same relative ASHA_HOME (R13): the sweep must name one.
    if (!isAbsolute(keyFile)) throw new Error(`the model server key file ${keyFile} is not an absolute path`);
    const stdout = await listProcesses(this.props.runner);
    const ended = await this.signalOrphans(orphanPids(stdout, keyFile), keyFile);
    // The dead daemon's key: this instance writes its own.
    await rm(keyFile, { force: true });
    return ended;
  }

  /**
   * reclaimOrphans's escalation, pulled out to keep that method's own flow short: `pids` (named by `keyFile`) are
   * sent SIGTERM; whichever are still alive after ORPHAN_TERM_MS, and still named by `keyFile` on a fresh listing
   * (R12: never SIGKILL a pid that has since been taken by another process), are sent SIGKILL; each survivor past
   * SIGKILL is logged and left running. Returns how many ended.
   */
  private async signalOrphans(pids: readonly number[], keyFile: string): Promise<number> {
    const { signal, isAlive, sleep, now } = this.props.orphans;
    const left = new Map<number, NodeJS.Signals>();
    const started = now();
    let ended = 0;
    for (const pid of pids) left.set(pid, 'SIGTERM');
    if (left.size === 0) return ended;
    /**
     * Signals each orphan still left. One already gone (ESRCH) is seen ended by the next poll; one this user may not
     * signal (EPERM: another user's process) is logged as surviving and left alone, and the start goes on (R12's reason
     * for not refusing the start); any other failure throws.
     */
    const send = (sig: NodeJS.Signals): void => {
      for (const pid of [...left.keys()]) {
        try {
          signal(pid, sig);
          left.set(pid, sig);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ESRCH') continue;
          if (code !== 'EPERM') throw error;
          left.delete(pid);
          this.props.logger.error('model_server.orphan_survived', { pid, error });
        }
      }
    };
    /** Polls until every orphan has ended or `ms` have passed, logging each as it ends. */
    const waitFor = async (ms: number): Promise<void> => {
      const until = now() + ms;
      while (left.size > 0 && now() < until) {
        await sleep(ORPHAN_POLL_MS);
        for (const [pid, last] of left) {
          if (isAlive(pid)) continue;
          left.delete(pid);
          ended += 1;
          this.props.logger.warn('model_server.orphan_stopped', { pid, signal: last, ms: now() - started });
        }
      }
    };
    send('SIGTERM');
    await waitFor(ORPHAN_TERM_MS);
    if (left.size > 0) {
      // Listed again before SIGKILL: a pid that ended since the last poll and was taken by another process is not this
      // home's server any more, and is never sent SIGKILL (R12: no process it did not select).
      const stdout = await listProcesses(this.props.runner);
      const still = new Set(orphanPids(stdout, keyFile));
      for (const [pid, last] of [...left]) {
        if (still.has(pid)) continue;
        left.delete(pid);
        ended += 1;
        this.props.logger.warn('model_server.orphan_stopped', { pid, signal: last, ms: now() - started });
      }
      if (left.size > 0) {
        send('SIGKILL');
        await waitFor(ORPHAN_KILL_MS);
      }
    }
    // A process that outlives SIGKILL wastes memory; refusing every start for it would cost more (R12).
    for (const pid of left.keys())
      this.props.logger.error('model_server.orphan_survived', {
        pid,
        error: new Error(`llama-server pid ${String(pid)} still alive after SIGKILL`),
      });
    return ended;
  }

  async ensureServing(entry: ServedEntry, cached: CachedModel): Promise<ModelEndpoint> {
    const existing = this.serving.get(entry.id);
    if (existing) return existing.ready;

    await ensureHostTool(this.props.runner, this.props.logger, {
      binary: 'llama-server',
      probeArgs: ['--version'],
      formula: 'llama.cpp',
    });
    const apiKey = await this.apiKey();
    // Re-check: a concurrent caller may have launched it while we probed.
    const raced = this.serving.get(entry.id);
    if (raced) return raced.ready;

    const logFile = join(this.props.logDir, `model-server-${entry.id}.log`);
    // Assigned synchronously, inside the Promise constructor, below — before the launcher is even called, so
    // `announce` is never undefined by the time onLine could call it.
    let announce: ((baseUrl: string) => void) | undefined;
    const announced = new Promise<string>((resolve) => {
      announce = resolve;
    });
    // The watch's first line names llama-server's own pid (idle-shutdown R5); assigned synchronously, as `announce` is.
    let name: ((pid: number) => void) | undefined;
    const named = new Promise<number>((resolve) => {
      name = resolve;
    });
    const child = this.props.launcher.launch(
      'llama-server',
      [
        '--model',
        cached.weightsPath,
        '--alias',
        entry.id,
        '--host',
        '127.0.0.1',
        '--port',
        '0',
        // A chat model: CHAT_SLOTS slots, each with the catalogue's context — llama.cpp sizes the KV cache per slot
        // (kv_unified false) when --parallel is given. Without it (0.5.0: 4 auto slots over one unified pool of
        // --ctx-size) concurrent turns shared 8,192 tokens, and four 2,127-token turns all failed with HTTP 500
        // "Context size has been exceeded" (measured 2026-09-27, debt D17; resident memory 6.2 → 9.8 GB for
        // qwen3-8b-q4_k_m). An embedding model keeps one context of contextSize.
        ...(entry.kind === 'chat'
          ? ['--parallel', String(CHAT_SLOTS), '--ctx-size', String(CHAT_SLOTS * entry.serve.contextSize)]
          : ['--ctx-size', String(entry.serve.contextSize)]),
        // Every route that reaches the model requires the key; /health stays open, for the readiness poll.
        '--api-key-file',
        this.props.keyFile,
        // A chat model needs its chat template for tool calls, and the prefill that forced tool calls rely on
        // (the gateway's toolCallStart), set here because LLAMA_ARG_PREFILL_ASSISTANT in the user's environment
        // could turn the default off. An embedding model is served for /v1/embeddings only, pooled as its model
        // card says, with a batch as big as its context.
        ...(entry.kind === 'chat'
          ? ['--jinja', '--prefill-assistant', ...CHAT_CACHE_ARGS]
          : ['--embeddings', '--pooling', entry.serve.pooling, '--ubatch-size', String(entry.serve.contextSize)]),
      ],
      {
        // LLAMA_API_KEY in the user's environment would add a second key the server accepts (llama.cpp
        // 0.5.0, checked 2026-09-27); set empty, it adds none.
        env: { LLAMA_API_KEY: '' },
        // A daemon that dies takes its model servers with it, whatever killed it (docs/plans/idle-shutdown.md R5).
        dieWithParent: true,
        logFile,
        onLine: (line) => {
          const match = LISTENING.exec(line);
          if (match?.[1]) announce?.(match[1]);
          const pid = WATCH_PID_LINE.exec(line);
          if (pid?.[1]) name?.(Number(pid[1]));
        },
      },
    );
    this.props.logger.info('model_server.launching', { model: entry.id, weights: cached.weightsPath, logFile });

    const ready = this.awaitReady(entry.id, child, Promise.all([announced, named]), logFile, apiKey);
    this.launches += 1;
    const serving: Serving = {
      process: child,
      ready,
      server: this.launches,
      endpoint: undefined,
      holds: 0,
      lastUsed: undefined,
    };
    this.serving.set(entry.id, serving);
    // Its idle time counts from when it is ready, not from the launch: a slow start is not idleness. A failed start is
    // handled below, where `ready` is awaited.
    ready.then(
      (endpoint) => {
        serving.endpoint = endpoint;
        serving.lastUsed ??= this.props.now();
      },
      () => undefined,
    );
    // Once launched, an exit at any time means the model is no longer served.
    child.exited.then(
      (exit) => {
        // Only this server's entry: one stopIdle stopped may already have a successor under the same id.
        if (this.serving.get(entry.id)?.process === child) this.serving.delete(entry.id);
        // Only an exit nobody asked for is a warning; stopAll and stopIdle log their own.
        if (!this.stopping.has(child)) {
          this.props.logger.warn('model_server.exited', { model: entry.id, code: exit.code, signal: exit.signal });
        }
      },
      (error: unknown) => {
        if (this.serving.get(entry.id)?.process === child) this.serving.delete(entry.id);
        this.props.logger.error('model_server.spawn_failed', { model: entry.id, error });
      },
    );
    try {
      return await ready;
    } catch (error) {
      if (this.serving.get(entry.id)?.process === child) this.serving.delete(entry.id);
      child.kill('SIGKILL');
      throw error;
    }
  }

  async stopAll(): Promise<void> {
    const all = [...this.serving.entries()];
    // And each already being stopped — an idle unload under way, out of `serving` already — so none outlives stopAll.
    const already = [...this.stopping].map((process) => process.exited.catch(() => undefined));
    await Promise.all([
      ...all.map(([model, { process }]) => this.stopProcess(model, process, 'model_server.stopped')),
      ...already,
    ]);
    // The key dies with its servers; the next instance writes a new one.
    this.key = undefined;
    await rm(this.props.keyFile, { force: true });
  }

  async stopIdle(inUse: () => ReadonlySet<string>): Promise<string[]> {
    const stopped: string[] = [];
    await Promise.all(
      [...this.serving.entries()].map(async ([model, serving]) => {
        if (inUse().has(model)) return;
        // A server still starting is awaited first (R3); one whose start fails has removed itself, and said why.
        const started = await serving.ready.then(
          () => true,
          () => false,
        );
        // Read again in the same turn as the stop: a launch registers the model it needs before it asks for a server,
        // so no launch is handed this server once it is taken out of `serving` here; nor is a call holding it cut off.
        if (!started || inUse().has(model) || serving.holds > 0 || this.serving.get(model) !== serving) return;
        this.serving.delete(model);
        await this.stopProcess(model, serving.process, 'model_server.stopped_idle');
        stopped.push(model);
      }),
    );
    return stopped.sort(byCodeUnit);
  }

  async lease(entry: ServedEntry, cached: CachedModel): Promise<ModelLease> {
    let serving = this.serving.get(entry.id);
    if (serving === undefined) {
      // Not served — unloaded idle, or stopped — so this call waits for a start: logged with how long it waited, the
      // cost an idle unload put on the call (idle-shutdown R2).
      const started = this.props.now();
      await this.ensureServing(entry, cached);
      serving = this.serving.get(entry.id);
      if (serving === undefined) throw new ModelServerFailed(entry.id, 'its server stopped as soon as it was ready');
      this.props.logger.info('model_server.reloaded', { model: entry.id, ms: this.props.now() - started });
    }
    // Found and held in the same turn: an unload or idle stop that runs after this sees the hold.
    const held = serving;
    held.holds += 1;
    let endpoint: ModelEndpoint;
    try {
      endpoint = await held.ready;
    } catch (error) {
      held.holds -= 1;
      throw error;
    }
    return this.leaseOf(held, endpoint);
  }

  holdServer(model: string, server: number): ModelLease | undefined {
    const serving = this.serving.get(model);
    if (serving?.server !== server || serving.endpoint === undefined) return undefined;
    serving.holds += 1;
    return this.leaseOf(serving, serving.endpoint);
  }

  /** The lease of a hold already counted on `held`: its release, once, ends the hold and stamps the idle clock. */
  private leaseOf(held: Serving, endpoint: ModelEndpoint): ModelLease {
    let released = false;
    return {
      endpoint,
      server: held.server,
      release: () => {
        if (released) return;
        released = true;
        held.holds -= 1;
        held.lastUsed = this.props.now();
      },
    };
  }

  async unloadIdle(idleMs: number): Promise<string[]> {
    const now = this.props.now();
    // Taken out of `serving` in one turn, before any await: a lease taken after this finds none and starts the model
    // again; one taken before it holds the server, which is then not idle.
    const idle: { readonly model: string; readonly serving: Serving; readonly idleFor: number }[] = [];
    for (const [model, serving] of this.serving) {
      if (serving.holds > 0 || serving.lastUsed === undefined) continue;
      const idleFor = now - serving.lastUsed;
      if (idleFor < idleMs) continue;
      this.serving.delete(model);
      idle.push({ model, serving, idleFor });
    }
    await Promise.all(
      idle.map(({ model, serving, idleFor }) =>
        this.stopProcess(model, serving.process, 'model_server.unloaded_idle', { idleMs: idleFor }),
      ),
    );
    return idle.map(({ model }) => model).sort(byCodeUnit);
  }

  /** SIGTERM, then SIGKILL after STOP_GRACE_MS; resolves once it has exited, and logs `event` with `fields`. */
  private async stopProcess(
    model: string,
    process: LaunchedProcess,
    event: 'model_server.stopped' | 'model_server.stopped_idle' | 'model_server.unloaded_idle',
    fields: Readonly<Record<string, number>> = {},
  ): Promise<void> {
    this.stopping.add(process);
    process.kill('SIGTERM');
    const grace = setTimeout(() => {
      process.kill('SIGKILL');
    }, STOP_GRACE_MS);
    try {
      await process.exited;
    } catch {
      // Never started; nothing to stop. The spawn failure is already logged
      // by the exited handler in ensureServing.
    } finally {
      clearTimeout(grace);
      this.stopping.delete(process);
    }
    this.props.logger.info(event, { model, ...fields });
  }

  /**
   * Resolves once the server has announced its address and its pid has been named (`announced`) and /health answers;
   * rejects with ModelServerFailed if it exits first or readyTimeoutMs passes.
   */
  private async awaitReady(
    model: string,
    child: LaunchedProcess,
    announced: Promise<readonly [string, number]>,
    logFile: string,
    apiKey: string,
  ): Promise<ModelEndpoint> {
    const deadline = Date.now() + this.props.readyTimeoutMs;
    const died = child.exited.then(async (exit) => {
      throw new ModelServerFailed(
        model,
        `llama-server exited (code ${String(exit.code)}, signal ${String(exit.signal)}) before becoming healthy:\n${await logTail(logFile)}`,
      );
    });
    let deadlineTimer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(() => {
        void (async () => {
          reject(
            new ModelServerFailed(
              model,
              `not healthy within ${String(this.props.readyTimeoutMs)} ms:\n${await logTail(logFile)}`,
            ),
          );
        })();
      }, this.props.readyTimeoutMs);
    });
    try {
      const [baseUrl, pid] = await Promise.race([announced, died, timedOut]);
      await Promise.race([this.pollHealth(model, baseUrl, deadline), died, timedOut]);
      // pid is llama-server's own, as the orphan sweep finds it; watchPid the watch the daemon started it under.
      this.props.logger.info('model_server.ready', { model, baseUrl, pid, watchPid: child.pid ?? null });
      return { baseUrl, model, apiKey };
    } finally {
      clearTimeout(deadlineTimer);
      // `died` is only a race participant; once ready, a later exit is handled
      // by the exited handler, so its rejection here is expected and inert.
      died.catch(() => undefined);
    }
  }

  private async pollHealth(model: string, baseUrl: string, deadline: number): Promise<void> {
    let last = 'no health check completed';
    while (Date.now() < deadline) {
      try {
        const response = await this.props.fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
        });
        if (response.ok) return;
        // 503 while the model loads is expected; remember it and keep polling.
        last = `GET /health answered HTTP ${String(response.status)}`;
      } catch (error) {
        // Refused while the server binds is expected; remember it and keep polling.
        last = `GET /health failed: ${(error as Error).message}`;
      }
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    throw new ModelServerFailed(model, `not healthy by the deadline; last check: ${last}`);
  }
}

async function logTail(logFile: string): Promise<string> {
  try {
    return tail(await readFile(logFile, 'utf8'));
  } catch (error) {
    return `(could not read ${logFile}: ${(error as Error).message})`;
  }
}
