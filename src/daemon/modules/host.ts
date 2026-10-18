// The module host (docs/plans/extension-modules.md R3, R5, R6, R7, R34, R35, R38): runs every granted module in its
// own container, on its own internal network whose one other member is the egress proxy, and carries calls to it as
// newline-delimited JSON over stdio. Nothing here runs until a launch grants a module (R38): then, once per daemon
// run, the Docker Engine's version is checked (R6 (a)); once per home, the egress bridge, its rejects and the proxy
// are set up (R6 (d)); and per (module, channel), the network, the proxy's listener on it, and — for a ToolModule or
// a ModelProvider — the container, started when the channel's first granting agent comes online and stopped when its
// last leaves. A command plugin's calls run as one-shots on that network (plugins.ts).
//
// Every failure reaches its caller as data with a reason from a closed set, and is logged through the facade:
// `module.failed` (error), `module.stderr` and `module.record` (a module's own lines, its secrets redacted),
// `egress.connection`, `egress.refused` and `egress.handle_failed` (the proxy's records).

import { createHash } from 'node:crypto';

import { present } from '../../shared/assert-present.js';
import { MODEL_FAILURE_REASONS } from '../../shared/protocol.js';
import { DECIDER_ONLY_REASONS, TOOL_FAILURE_REASONS } from '../../shared/tools.js';
import type { AttachedContainer, ContainerRuntime } from '../container-runtime/index.js';
import type { Logger } from '../log.js';
import type { SecretStore } from '../secrets/index.js';
import type { InstalledModule, ModuleImages } from './images.js';
import { redact, redactValue } from './redact.js';

/** The engine from which a container on an internal network resolves no outside name (R6 (a); CVE-2024-29018). */
const MIN_ENGINE = [26, 0, 0] as const;
/** The most bytes one framed line may hold (R34). */
export const MAX_LINE_BYTES = 1024 * 1024;
/** Restarts of a (module, channel)'s container within RESTART_WINDOW_MS before its calls fail until relaunched (R34). */
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 10 * 60_000;
/** A provider call's bounds (R19, model-streaming's): to its first chunk, and between chunks. */
export const PROVIDER_QUEUE_MS = 55_000;
export const PROVIDER_IDLE_MS = 22_000;
/** Bound on the proxy answering one order. */
const PROXY_ORDER_MS = 10_000;
/** The alias every module network gives the proxy: what HTTPS_PROXY names in the module base (R6 (b)). */
const PROXY_ALIAS = 'asha-egress';

/** A module could not be made ready for a launch: the launch fails `module_unavailable` (R6 (a), R7, R34). */
export class ModuleUnavailable extends Error {
  constructor(
    readonly module: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`module ${module} is unavailable: ${detail}`, options);
    this.name = 'ModuleUnavailable';
  }
}

export type SetTimer = (callback: () => void, ms: number) => () => void;

/** The reasons a module tool may answer with: every tool failure reason but the decision model's own (decider-tool R11). */
const MODULE_TOOL_REASONS: ReadonlySet<string> = new Set<string>(
  TOOL_FAILURE_REASONS.filter((r) => !DECIDER_ONLY_REASONS.includes(r)),
);

/** A module call's outcome (R8, R34): its result, or a reason from TOOL_FAILURE_REASONS (or, for a provider, ModelFailureReason). */
export type CallOutcome =
  | { readonly ok: true; readonly result: unknown; readonly usage?: unknown }
  | { readonly ok: false; readonly reason: string; readonly detail: string };

export interface ModuleHostProps {
  readonly runtime: ContainerRuntime;
  readonly images: Pick<ModuleImages, 'harness' | 'module' | 'plugin'>;
  readonly installed: ReadonlyMap<string, InstalledModule>;
  readonly secrets: SecretStore;
  readonly logger: Logger;
  readonly homeId: string;
  readonly newId: () => string;
  readonly setTimer: SetTimer;
  readonly now: () => number;
}

/** One call in flight in a module's container. */
interface Pending {
  readonly module: string;
  readonly tool: string;
  readonly consequential: boolean;
  /** The reasons this call may answer with: a tool's, or a provider's. */
  readonly reasons: ReadonlySet<string>;
  readonly settle: (outcome: CallOutcome) => void;
  readonly onDelta?: (delta: unknown) => void;
  /** Called on every delta and on the answer: restarts a provider's idle bound. */
  readonly onChunk?: () => void;
}

interface Running {
  readonly name: string;
  readonly attached: AttachedContainer;
  readonly pending: Map<string, Pending>;
  /** Ids whose calls already ended (timed out or abandoned): a late answer to one is not a defect. */
  readonly ended: Set<string>;
  buffered: Buffer;
  dead: boolean;
}

interface Slot {
  readonly key: string;
  readonly installed: InstalledModule;
  readonly channel: string;
  readonly network: string;
  agents: number;
  ready: Promise<void> | undefined;
  /** The proxy's address on this network, once it listens there. */
  listening: string | undefined;
  secrets: Readonly<Record<string, string>>;
  image: string | undefined;
  running: Running | undefined;
  starting: Promise<Running> | undefined;
  /** When each restart (after the first start) happened, for R34's budget. */
  readonly restarts: number[];
  exhausted: boolean;
}

interface Egress {
  readonly network: string;
  readonly bridge: string;
  readonly container: string;
  readonly attached: AttachedContainer;
  readonly orders: Map<string, (answer: { readonly op: string; readonly detail?: string }) => void>;
  buffered: string;
  dead: boolean;
  /** Its setup failed and the host removed it: its exit is not a second failure. */
  abandoned: boolean;
}

function semverAtLeast(version: string, min: readonly number[]): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (parts === null) return false;
  for (let i = 0; i < 3; i += 1) {
    const n = Number(parts[i + 1]);
    const expected = present(min[i], `MIN_ENGINE[${String(i)}]`);
    if (n !== expected) return n > expected;
  }
  return true;
}

export class ModuleHost {
  private engine: Promise<void> | undefined;
  private egress: Promise<Egress> | undefined;
  /** The proxy that exited, whose container and network are removed before the next is set up (review of 2026-10-02). */
  private deadEgress: Egress | undefined;
  /** Each (module, channel) whose container and network are being removed, by its key. */
  private readonly tearingDown = new Map<string, Promise<void>>();
  private readonly slots = new Map<string, Slot>();
  private closing = false;

  constructor(private readonly props: ModuleHostProps) {}

  /** The module an agent's grant or model names, or undefined. */
  module(id: string): InstalledModule | undefined {
    return this.props.installed.get(id);
  }

  /** The (module, channel) network's name: unique per home, module and channel, short enough for Docker. */
  private networkOf(module: string, channel: string): string {
    return `asha-m-${this.props.homeId}-${module}-${channel}`.slice(0, 120);
  }

  /**
   * Its bridge interface: `asham` + 10 hex of sha256(home, module, channel), 15 characters, Linux's limit. Under
   * `asha+`, the jumps from INPUT and DOCKER-USER reach it, and MODULE_LOCAL_REJECT closes the VM to it (D53).
   */
  private bridgeOf(module: string, channel: string): string {
    const key = `${this.props.homeId}\0${module}\0${channel}`;
    return `asham${createHash('sha256').update(key).digest('hex').slice(0, 10)}`;
  }

  /** R6 (a): before the first module network; a version too old is kept for the run, a failure to read it is not. */
  private engineOk(): Promise<void> {
    this.engine ??= (async () => {
      const version = await this.props.runtime.engineVersion();
      if (!semverAtLeast(version, MIN_ENGINE)) {
        const error = new ModuleUnavailable(
          '(all)',
          `the colima VM's Docker Engine is ${version}, older than 26.0.0: from 26.0.0 a container on an internal network resolves no outside name (CVE-2024-29018), which a module's confinement needs`,
        );
        this.props.logger.error('module.engine_too_old', { version, error });
        throw error;
      }
    })();
    // A version too old is kept, so every granting launch fails alike; a failure to read it (a VM briefly busy) is
    // not: the next acquire asks again (review of 2026-10-02, B-21).
    const asked = this.engine;
    asked.catch((error: unknown) => {
      if (!(error instanceof ModuleUnavailable) && this.engine === asked) this.engine = undefined;
    });
    return this.engine;
  }

  /**
   * Makes `module` ready on `channel` for one more granting agent (R34): the engine checked, the egress set up, the
   * network and the proxy's listener on it, the module's secrets read (a declared one missing fails it, R7), its image
   * ensured, and — a ToolModule or ModelProvider — its container started. Throws ModuleUnavailable.
   */
  async acquire(module: string, channel: string): Promise<void> {
    const installed = this.props.installed.get(module);
    if (installed === undefined) throw new ModuleUnavailable(module, 'it is not installed');
    const key = `${module}\0${channel}`;
    // A teardown of this (module, channel) still removing its container and network finishes first, or the new slot
    // would create a network of the same name while the old is being removed (review of 2026-10-02, B-10).
    for (let ending = this.tearingDown.get(key); ending !== undefined; ending = this.tearingDown.get(key)) await ending;
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = {
        key,
        installed,
        channel,
        network: this.networkOf(module, channel),
        agents: 0,
        ready: undefined,
        listening: undefined,
        secrets: {},
        image: undefined,
        running: undefined,
        starting: undefined,
        restarts: [],
        exhausted: false,
      };
      this.slots.set(key, slot);
    }
    slot.agents += 1;
    slot.ready ??= this.prepare(slot);
    try {
      await slot.ready;
    } catch (error) {
      slot.agents -= 1;
      if (slot.agents === 0) await this.teardown(slot);
      if (error instanceof ModuleUnavailable) throw error;
      throw new ModuleUnavailable(module, (error as Error).message, { cause: error });
    }
  }

  private async prepare(slot: Slot): Promise<void> {
    const { manifest } = slot.installed;
    await this.engineOk();
    const stored = await this.props.secrets.get(manifest.id);
    const missing = manifest.secrets.filter((name) => stored[name] === undefined);
    if (missing.length > 0)
      throw new ModuleUnavailable(
        manifest.id,
        `its secret ${missing.join(', ')} is not set: asha --set-secret module=${manifest.id} name=${present(missing[0], 'the first missing secret name (missing.length > 0)')}`,
      );
    // Every name here is not in `missing`, so `stored` holds it (the filter above): present() names it if that
    // invariant ever breaks, rather than silently writing an `undefined` secret.
    slot.secrets = Object.fromEntries(
      manifest.secrets.map((name) => [name, present(stored[name], `the module's secret ${name}`)]),
    );
    const egress = await this.ensureEgress();
    await this.props.runtime.createNetwork({
      name: slot.network,
      internal: true,
      bridge: this.bridgeOf(manifest.id, slot.channel),
      labels: { 'asha.module': manifest.id, 'asha.channel': slot.channel },
    });
    await this.listen(slot, egress);
    const image =
      manifest.kind === 'CommandTool'
        ? await this.props.images.plugin(slot.installed)
        : await this.props.images.module(slot.installed);
    slot.image = image.tag;
    if (manifest.kind !== 'CommandTool') await this.start(slot);
  }

  /** The proxy's listener on the slot's network, its module's hosts its list (R6 (c)). */
  private async listen(slot: Slot, egress: Egress): Promise<void> {
    const address = await this.props.runtime.connectNetwork(slot.network, egress.container, PROXY_ALIAS);
    const answer = await this.order(egress, address, {
      op: 'listen',
      address,
      module: slot.installed.manifest.id,
      hosts: slot.installed.manifest.hosts,
    });
    if (answer.op !== 'listening')
      throw new ModuleUnavailable(
        slot.installed.manifest.id,
        `the egress proxy did not listen on ${slot.network}: ${answer.detail ?? answer.op}`,
      );
    slot.listening = address;
  }

  /** One order to the proxy, answered within PROXY_ORDER_MS. */
  private order(
    egress: Egress,
    address: string,
    order: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly op: string; readonly detail?: string }> {
    return new Promise((resolve) => {
      const cancel = this.props.setTimer(() => {
        egress.orders.delete(address);
        resolve({ op: 'failed', detail: `no answer within ${String(PROXY_ORDER_MS)} ms` });
      }, PROXY_ORDER_MS);
      egress.orders.set(address, (answer) => {
        cancel();
        resolve(answer);
      });
      if (!egress.attached.write(`${JSON.stringify(order)}\n`)) {
        cancel();
        egress.orders.delete(address);
        resolve({ op: 'failed', detail: 'the proxy has exited' });
      }
    });
  }

  /** R6 (d): the home's egress bridge, its rejects, and the proxy on it, once; set up again after the proxy exits. */
  private ensureEgress(): Promise<Egress> {
    this.egress ??= (async () => {
      // After the proxy exited: its container and its network go first, or creating them again would fail as taken.
      const dead = this.deadEgress;
      if (dead !== undefined) {
        await dead.attached.remove();
        await this.props.runtime.removeNetwork(dead.network);
        this.deadEgress = undefined;
      }
      const network = `asha-egress-${this.props.homeId}`;
      const bridge = `ashae${this.props.homeId}`;
      const container = `asha-egress-${this.props.homeId}`;
      await this.props.runtime.createNetwork({ name: network, internal: false, bridge, labels: {} });
      // From here a failure removes what was made, or the next setup would find the network's name taken (the
      // sandbox suite's first run, 2026-10-02: one failed proxy image left `asha-egress-<home>`, and every later
      // acquire failed "already exists").
      let egress: Egress | undefined;
      try {
        await this.props.runtime.installEgressRules(bridge);
        const image = await this.props.images.harness('egress-proxy');
        await this.props.runtime.verifyEgressRules(bridge);
        const made: Egress = {
          network,
          bridge,
          container,
          attached: undefined as unknown as AttachedContainer,
          orders: new Map(),
          buffered: '',
          dead: false,
          abandoned: false,
        };
        egress = made;
        const attached = this.props.runtime.runAttached({
          name: container,
          image: image.tag,
          network,
          env: {},
          labels: { 'asha.role': 'egress-proxy' },
          onStdout: (chunk) => {
            this.proxyAnswers(made, chunk);
          },
          onStderrLine: (line) => {
            this.proxyRecord(line);
          },
        });
        (made as { attached: AttachedContainer }).attached = attached;
        // Registered before proxyExited's, so a proxy that exits before its ready line fails with its own exit.
        const started = this.started(made);
        void attached.exited.then(
          (code) => {
            this.proxyExited(made, `exited with code ${String(code)}`);
          },
          (error: unknown) => {
            this.proxyExited(made, (error as Error).message);
          },
        );
        // `docker run` creates the container a while after it is spawned; until the program says ready, a
        // `docker network connect` to it finds no such container (the gate at 360ac36).
        const outcome = await started;
        if (outcome !== 'ready') throw new Error(`the egress proxy did not start: ${outcome}`);
        this.props.logger.info('egress.ready', { network, bridge, container });
        return made;
      } catch (error) {
        // The proxy's setup failed: one error-level record of it, whatever step failed (R35).
        this.props.logger.error('module.failed', { module: 'egress-proxy', reason: 'module_unavailable', error });
        await this.abandonEgress(network, egress);
        throw error;
      }
    })();
    this.egress.catch(() => {
      this.egress = undefined;
    });
    return this.egress;
  }

  /** The proxy's first line, `{"op":"ready"}`, within PROXY_ORDER_MS: 'ready', or why it did not start. */
  private started(egress: Egress): Promise<string> {
    return new Promise((resolve) => {
      let ready = false;
      const cancel = this.props.setTimer(() => {
        egress.orders.delete('');
        resolve(`no ready line within ${String(PROXY_ORDER_MS)} ms`);
      }, PROXY_ORDER_MS);
      egress.orders.set('', (answer) => {
        cancel();
        ready = answer.op === 'ready';
        const detailSuffix = answer.detail === undefined ? '' : `: ${answer.detail}`;
        resolve(ready ? 'ready' : `it answered ${answer.op}${detailSuffix} before it was ready`);
      });
      // An exit before the ready line is the setup's failure, reported once by it: marked abandoned here, before
      // proxyExited (registered after this) runs, so that neither reports it again nor clears the setup under it. An
      // exit after the ready line is proxyExited's alone.
      void egress.attached.exited.then(
        (code) => {
          if (ready) return;
          cancel();
          egress.orders.delete('');
          egress.abandoned = true;
          resolve(`it exited with code ${String(code)}`);
        },
        (error: unknown) => {
          if (ready) return;
          cancel();
          egress.orders.delete('');
          egress.abandoned = true;
          resolve(`it did not start: ${(error as Error).message}`);
        },
      );
    });
  }

  /** A failed egress setup's container (if it was run) and network removed; a failure to remove is logged, not thrown over the setup's own. */
  private async abandonEgress(network: string, egress: Egress | undefined): Promise<void> {
    try {
      if (egress !== undefined) {
        egress.abandoned = true;
        await egress.attached.remove();
        if (this.deadEgress === egress) this.deadEgress = undefined;
      }
      await this.props.runtime.removeNetwork(network);
    } catch (error) {
      this.props.logger.error('egress.cleanup_failed', { network, error });
    }
  }

  private proxyAnswers(egress: Egress, chunk: Buffer): void {
    egress.buffered += chunk.toString('utf8');
    for (let newline = egress.buffered.indexOf('\n'); newline >= 0; newline = egress.buffered.indexOf('\n')) {
      const line = egress.buffered.slice(0, newline);
      egress.buffered = egress.buffered.slice(newline + 1);
      let answer: { op?: unknown; address?: unknown; detail?: unknown };
      try {
        answer = JSON.parse(line) as typeof answer;
      } catch (error) {
        this.props.logger.error('egress.answer_invalid', { error });
        continue;
      }
      const address = typeof answer.address === 'string' ? answer.address : '';
      const waiting = egress.orders.get(address);
      egress.orders.delete(address);
      waiting?.({ op: String(answer.op), ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) });
    }
  }

  /** The proxy's records, re-logged through the facade as the events they are; anything else as module.stderr (R35). */
  private proxyRecord(line: string): void {
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // A plain line: Node's own warnings among them.
      this.props.logger.info('module.stderr', { module: 'egress-proxy', line: line.slice(0, 4096) });
      return;
    }
    const { event, ...fields } = record;
    if (event === 'egress.connection') this.props.logger.info('egress.connection', fields);
    else if (event === 'egress.refused') this.props.logger.warn('egress.refused', fields);
    else if (event === 'egress.handle_failed') {
      const { detail, ...where } = fields;
      this.props.logger.error('egress.handle_failed', {
        ...where,
        error: new Error(typeof detail === 'string' ? detail : JSON.stringify(detail)),
      });
    } else this.props.logger.info('module.record', { module: 'egress-proxy', record });
  }

  private proxyExited(egress: Egress, detail: string): void {
    egress.dead = true;
    for (const waiting of egress.orders.values()) waiting({ op: 'failed', detail: 'the proxy has exited' });
    egress.orders.clear();
    if (this.closing || egress.abandoned) return;
    this.props.logger.error('module.failed', {
      module: 'egress-proxy',
      reason: 'module_unavailable',
      error: new Error(`the egress proxy ${detail}`),
    });
    // The next call sets the egress up again and listens on each network anew.
    this.deadEgress = egress;
    this.egress = undefined;
    for (const slot of this.slots.values()) slot.listening = undefined;
  }

  /** Starts a ToolModule's or ModelProvider's container (R5): the egress rejects verified first (R6 (d)). */
  private async start(slot: Slot): Promise<Running> {
    const { manifest } = slot.installed;
    await this.props.runtime.verifyEgressRules(`ashae${this.props.homeId}`);
    const name = `asha-mod-${manifest.id}-${slot.channel}-${this.props.newId().slice(0, 8)}`;
    const secrets = Object.values(slot.secrets);
    const running: Running = {
      name,
      attached: undefined as unknown as AttachedContainer,
      pending: new Map(),
      ended: new Set(),
      buffered: Buffer.alloc(0),
      dead: false,
    };
    const attached = this.props.runtime.runAttached({
      name,
      image: present(slot.image, `module ${manifest.id}'s image (set by prepare() before start() ever runs)`),
      network: slot.network,
      env: { ...slot.secrets },
      labels: { 'asha.module': manifest.id, 'asha.channel': slot.channel },
      onStdout: (chunk) => {
        this.stdout(slot, running, chunk);
      },
      onStderrLine: (line) => {
        this.stderr(slot, redact(line, secrets));
      },
    });
    (running as { attached: AttachedContainer }).attached = attached;
    void attached.exited.then(
      (code) => {
        this.failed(slot, running, `its container exited with code ${String(code)}`);
      },
      (error: unknown) => {
        this.failed(slot, running, `its container did not start: ${(error as Error).message}`);
      },
    );
    slot.running = running;
    this.props.logger.info('module.started', { module: manifest.id, channel: slot.channel, container: name });
    return running;
  }

  /** A module's stderr line, redacted: a JSON object as `module.record`, anything else as `module.stderr` (R35). */
  private stderr(slot: Slot, line: string): void {
    const module = slot.installed.manifest.id;
    try {
      const record = JSON.parse(line) as unknown;
      if (typeof record === 'object' && record !== null && !Array.isArray(record)) {
        this.props.logger.info('module.record', { module, channel: slot.channel, record });
        return;
      }
    } catch {
      // Not JSON: a plain line.
    }
    this.props.logger.info('module.stderr', { module, channel: slot.channel, line: line.slice(0, 4096) });
  }

  /** Splits a module's stdout into lines of at most MAX_LINE_BYTES; any line that is not a valid answer fails the module (R34). */
  private stdout(slot: Slot, running: Running, chunk: Buffer): void {
    if (running.dead) return;
    running.buffered = Buffer.concat([running.buffered, chunk]);
    for (let newline = running.buffered.indexOf(0x0a); newline >= 0; newline = running.buffered.indexOf(0x0a)) {
      const line = running.buffered.subarray(0, newline);
      running.buffered = running.buffered.subarray(newline + 1);
      if (line.length > MAX_LINE_BYTES) {
        this.fail(slot, running, `it wrote a line of ${String(line.length)} bytes, over ${String(MAX_LINE_BYTES)}`);
        return;
      }
      const problem = this.answer(slot, running, line.toString('utf8'));
      if (problem !== undefined) {
        this.fail(slot, running, problem);
        return;
      }
    }
    if (running.buffered.length > MAX_LINE_BYTES)
      this.fail(slot, running, `it wrote a line of more than ${String(MAX_LINE_BYTES)} bytes`);
  }

  /** One line from a module: a delta or an answer to a call in flight. What is wrong with it, or undefined. */
  private answer(slot: Slot, running: Running, line: string): string | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return 'it wrote a line that is not JSON';
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Record<string, unknown>)['id'] !== 'string')
      return 'it wrote a line that is not an answer {id, …}';
    const message = parsed as { id: string } & Record<string, unknown>;
    const id = message.id;
    const pending = running.pending.get(id);
    if (pending === undefined) {
      if (running.ended.has(id)) {
        this.props.logger.warn('module.late_answer', { module: slot.installed.manifest.id, channel: slot.channel, id });
        return undefined;
      }
      return `it answered a call it was never given (${id.slice(0, 40)})`;
    }
    if ('delta' in message) {
      if (pending.onDelta === undefined) return "it streamed a delta for a call that is not a provider's";
      pending.onChunk?.();
      pending.onDelta(redactValue(message['delta'], Object.values(slot.secrets)));
      return undefined;
    }
    const ok = message['ok'];
    if (ok === true) {
      running.pending.delete(id);
      pending.onChunk?.();
      // What a module answers is redacted of its own secrets before anything logs it or a model reads it (R35; B-13).
      pending.settle({
        ok: true,
        result: redactValue(message['result'], Object.values(slot.secrets)),
        ...(message['usage'] === undefined ? {} : { usage: message['usage'] }),
      });
      return undefined;
    }
    if (ok === false && typeof message['reason'] === 'string' && pending.reasons.has(message['reason'])) {
      running.pending.delete(id);
      pending.settle({
        ok: false,
        reason: message['reason'],
        detail:
          typeof message['detail'] === 'string'
            ? redact(message['detail'].slice(0, 1_000), Object.values(slot.secrets))
            : '',
      });
      return undefined;
    }
    return `it answered ${id.slice(0, 40)} with neither {ok: true, result} nor {ok: false, reason} from its closed set`;
  }

  /** The module failed: its container is removed and every call in flight ends (R34). */
  private fail(slot: Slot, running: Running, detail: string): void {
    void running.attached.remove().catch((error: unknown) => {
      this.props.logger.error('module.remove_failed', {
        module: slot.installed.manifest.id,
        container: running.name,
        error,
      });
    });
    this.failed(slot, running, detail);
  }

  /** Every call in flight ends `module_unavailable` — a consequential one `unknown_outcome` (R12 (c)) — logged; the next call starts a new container. */
  private failed(slot: Slot, running: Running, detail: string): void {
    if (running.dead) return;
    running.dead = true;
    if (slot.running === running) slot.running = undefined;
    if (this.closing) {
      for (const pending of running.pending.values())
        pending.settle({
          ok: false,
          reason: pending.consequential ? 'unknown_outcome' : 'module_unavailable',
          detail: 'the daemon stopped',
        });
      running.pending.clear();
      return;
    }
    const module = slot.installed.manifest.id;
    this.props.logger.error('module.container_failed', {
      module,
      channel: slot.channel,
      container: running.name,
      error: new Error(`module ${module} on ${slot.channel}: ${detail}`),
    });
    for (const [id, pending] of running.pending) {
      const reason = pending.consequential ? 'unknown_outcome' : 'module_unavailable';
      this.props.logger.error('module.failed', {
        module,
        tool: pending.tool,
        channel: slot.channel,
        reason,
        error: new Error(detail),
      });
      running.ended.add(id);
      pending.settle({ ok: false, reason, detail });
    }
    running.pending.clear();
  }

  /** The slot's container, restarted when it has failed, within R34's budget; undefined once the budget is spent. */
  private async container(slot: Slot): Promise<Running | undefined> {
    if (slot.running !== undefined && !slot.running.dead) return slot.running;
    if (slot.exhausted) return undefined;
    if (slot.starting !== undefined) return slot.starting;
    const now = this.props.now();
    const recent = slot.restarts.filter((at) => now - at < RESTART_WINDOW_MS);
    if (recent.length >= MAX_RESTARTS) {
      slot.exhausted = true;
      this.props.logger.error('module.failed', {
        module: slot.installed.manifest.id,
        channel: slot.channel,
        reason: 'module_unavailable',
        error: new Error(
          `restarted ${String(MAX_RESTARTS)} times in ${String(RESTART_WINDOW_MS / 60_000)} minutes; its calls fail until its agents are launched again`,
        ),
      });
      return undefined;
    }
    slot.restarts.push(now);
    slot.starting = (async () => {
      if (slot.listening === undefined) await this.listen(slot, await this.ensureEgress());
      return this.start(slot);
    })();
    try {
      return await slot.starting;
    } finally {
      slot.starting = undefined;
    }
  }

  /**
   * One call to a ToolModule's tool (R8, R34): written as a request line, answered by its id within `timeoutMs` —
   * `timeout`, or `unknown_outcome` for a consequential call (R13). `abandon` aborting (its agent gone) ends a call that
   * is not consequential at once, `module.failed` `abandoned`; a consequential one runs on, for its audit (R34).
   */
  call(request: {
    readonly module: string;
    readonly channel: string;
    readonly tool: string;
    readonly arguments: unknown;
    readonly timeoutMs: number;
    readonly consequential: boolean;
    readonly idempotencyKey?: string;
    readonly abandon: AbortSignal;
  }): Promise<CallOutcome> {
    // decider_busy and decider_unavailable are the decision model's alone (docs/plans/decider-tool.md R11): a module that
    // answers either is answering outside its closed set, and is refused as any such answer is.
    return this.send({ ...request, kind: 'tool', reasons: MODULE_TOOL_REASONS });
  }

  /**
   * A provider's chat or embed (R19, R34): bounded by PROVIDER_QUEUE_MS to its first chunk — a delta or the answer —
   * and PROVIDER_IDLE_MS between chunks; each delta handed to `onDelta`.
   */
  provider(request: {
    readonly module: string;
    readonly channel: string;
    readonly tool: 'chat' | 'embed' | 'lifecycle';
    readonly arguments: unknown;
    readonly onDelta: (delta: unknown) => void;
    readonly abandon: AbortSignal;
  }): Promise<CallOutcome> {
    return this.send({
      ...request,
      kind: 'provider',
      consequential: false,
      timeoutMs: PROVIDER_QUEUE_MS,
      reasons: new Set<string>(MODEL_FAILURE_REASONS),
    });
  }

  private async send(request: {
    readonly kind: 'tool' | 'provider';
    readonly module: string;
    readonly channel: string;
    readonly tool: string;
    readonly arguments: unknown;
    readonly timeoutMs: number;
    readonly consequential: boolean;
    readonly idempotencyKey?: string;
    readonly abandon: AbortSignal;
    readonly reasons: ReadonlySet<string>;
    readonly onDelta?: (delta: unknown) => void;
  }): Promise<CallOutcome> {
    const unavailable = (detail: string): CallOutcome => ({
      ok: false,
      reason: request.kind === 'provider' ? 'unavailable' : 'module_unavailable',
      detail,
    });
    const slot = this.slots.get(`${request.module}\0${request.channel}`);
    if (slot === undefined || slot.agents === 0)
      return unavailable(`module ${request.module} is not running on channel ${request.channel}`);
    let running: Running | undefined;
    try {
      running = await this.container(slot);
    } catch (error) {
      this.props.logger.error('module.failed', {
        module: request.module,
        tool: request.tool,
        channel: request.channel,
        reason: 'module_unavailable',
        error,
      });
      return unavailable((error as Error).message);
    }
    if (running === undefined)
      return unavailable(
        `module ${request.module} was restarted ${String(MAX_RESTARTS)} times in ${String(RESTART_WINDOW_MS / 60_000)} minutes; launch its agents again`,
      );
    const id = this.props.newId();
    const line = `${JSON.stringify({ id, tool: request.tool, arguments: request.arguments, ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }) })}\n`;
    const live = running;
    return new Promise<CallOutcome>((resolve) => {
      // A plain object property, not a `let`: `settle` below mutates it from inside `arm`'s timer and `onAbandon`,
      // which — a call reached synchronously from this same function, at `if (request.abandon.aborted) onAbandon();`
      // below — can settle the call before the write check near the end of this function; a bare `let settled`
      // would read there as a literal `false` to @typescript-eslint/no-unnecessary-condition, since TypeScript does
      // not see a mutation through a called closure, which is not the same as the value being unreachable.
      const state = { settled: false };
      let cancel: () => void = () => undefined;
      const settle = (outcome: CallOutcome): void => {
        if (state.settled) return;
        state.settled = true;
        cancel();
        request.abandon.removeEventListener('abort', onAbandon);
        resolve(outcome);
      };
      // A provider's bound: to the first chunk, then between chunks (R19); a tool's: the whole call (R34).
      const arm = (ms: number, why: string): void => {
        cancel();
        cancel = this.props.setTimer(() => {
          if (state.settled) return;
          live.pending.delete(id);
          live.ended.add(id);
          const reason = request.consequential ? 'unknown_outcome' : 'timeout';
          this.props.logger.error('module.failed', {
            module: request.module,
            tool: request.tool,
            channel: request.channel,
            reason,
            error: new Error(why),
          });
          settle({ ok: false, reason, detail: why });
        }, ms);
      };
      const onAbandon = (): void => {
        if (request.consequential || state.settled) return;
        live.pending.delete(id);
        live.ended.add(id);
        this.props.logger.error('module.failed', {
          module: request.module,
          tool: request.tool,
          channel: request.channel,
          reason: 'abandoned',
          error: new Error('its agent left while the call was in flight'),
        });
        settle({
          ok: false,
          reason: request.kind === 'provider' ? 'unavailable' : 'module_unavailable',
          detail: 'abandoned',
        });
      };
      live.pending.set(id, {
        module: request.module,
        tool: request.tool,
        consequential: request.consequential,
        reasons: request.reasons,
        settle,
        ...(request.onDelta === undefined ? {} : { onDelta: request.onDelta }),
        ...(request.kind === 'provider'
          ? {
              onChunk: () => {
                arm(PROVIDER_IDLE_MS, `no chunk within ${String(PROVIDER_IDLE_MS)} ms`);
              },
            }
          : {}),
      });
      arm(
        request.timeoutMs,
        request.kind === 'provider'
          ? `no first chunk within ${String(PROVIDER_QUEUE_MS)} ms`
          : `no answer within ${String(request.timeoutMs)} ms`,
      );
      if (request.abandon.aborted) onAbandon();
      else request.abandon.addEventListener('abort', onAbandon, { once: true });
      if (!state.settled && !live.attached.write(line)) {
        live.pending.delete(id);
        settle({
          ok: false,
          reason: request.consequential ? 'unknown_outcome' : 'module_unavailable',
          detail: 'its container had exited',
        });
      }
    });
  }

  /** The slot's network and secrets, for a command plugin's call (R30, R33); its listener set up again if the proxy restarted. */
  async pluginSlot(
    module: string,
    channel: string,
  ): Promise<
    { readonly network: string; readonly image: string; readonly secrets: Readonly<Record<string, string>> } | undefined
  > {
    const slot = this.slots.get(`${module}\0${channel}`);
    if (slot === undefined || slot.agents === 0 || slot.image === undefined) return undefined;
    if (slot.listening === undefined) await this.listen(slot, await this.ensureEgress());
    await this.props.runtime.verifyEgressRules(`ashae${this.props.homeId}`);
    return { network: slot.network, image: slot.image, secrets: slot.secrets };
  }

  /**
   * One granting agent of `module` on `channel` has gone (R34): when it was the last, the container is killed and
   * removed, the proxy stops listening there, and the network is removed. Nothing is released one by one once the
   * daemon is stopping: the reclaim removes everything.
   */
  async release(module: string, channel: string): Promise<void> {
    if (this.closing) return;
    const slot = this.slots.get(`${module}\0${channel}`);
    if (slot === undefined || slot.agents === 0) return;
    slot.agents -= 1;
    if (slot.agents === 0) await this.teardown(slot);
  }

  private teardown(slot: Slot): Promise<void> {
    this.slots.delete(slot.key);
    const ending = this.tearDown(slot).finally(() => {
      if (this.tearingDown.get(slot.key) === ending) this.tearingDown.delete(slot.key);
    });
    this.tearingDown.set(slot.key, ending);
    return ending;
  }

  private async tearDown(slot: Slot): Promise<void> {
    const module = slot.installed.manifest.id;
    try {
      await slot.ready?.catch(() => undefined);
      const running = slot.running;
      if (running !== undefined) {
        slot.running = undefined;
        running.dead = true;
        for (const [id, pending] of running.pending) {
          running.ended.add(id);
          this.props.logger.error('module.failed', {
            module,
            tool: pending.tool,
            channel: slot.channel,
            reason: 'abandoned',
            error: new Error('its last agent left while the call was in flight'),
          });
          pending.settle({
            ok: false,
            reason: pending.consequential ? 'unknown_outcome' : 'module_unavailable',
            detail: 'abandoned: the container was stopped',
          });
        }
        running.pending.clear();
        await running.attached.remove();
      }
      const egress = this.egress === undefined ? undefined : await this.egress.catch(() => undefined);
      if (slot.listening !== undefined && egress !== undefined && !egress.dead) {
        await this.order(egress, slot.listening, { op: 'close', address: slot.listening });
        await this.props.runtime.disconnectNetwork(slot.network, egress.container);
      }
      await this.props.runtime.removeNetwork(slot.network);
      this.props.logger.info('module.released', { module, channel: slot.channel });
    } catch (error) {
      // Left behind, every object carries the home's label: the next reclaim removes it (R5).
      this.props.logger.error('module.release_failed', { module, channel: slot.channel, error });
    }
  }

  /** The daemon is stopping (R34): nothing more is released one by one; calls in flight end with their containers. */
  stop(): void {
    this.closing = true;
  }
}
