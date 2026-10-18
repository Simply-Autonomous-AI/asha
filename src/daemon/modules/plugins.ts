// A command plugin's call (docs/plans/extension-modules.md R30–R33): the one place a third-party program runs for an
// agent. Every layer holds on its own:
//
// 1. The harness builds the command (R31, arguments.ts): typed values, no shell, no option the manifest does not name.
// 2. Paths are checked on the host with no link followed (R32, paths.ts): each component lstat'ed, a link anywhere or a
//    hard-linked file refused, the copy made through an O_NOFOLLOW descriptor whose identity is the checked file's;
//    the credential deny list and every stored secret value refused in what is read.
// 3. Only copies exist (R30): the command runs in a fresh container in which no host path is mounted — its read set
//    streamed in as one tar owned 1000:1000, its write paths copied out after it exits, read by the tar reader's entry
//    rules, and written back only once the whole tar is read within its bounds.
// 4. Credentials live for one command (R33): set on its container alone; its output redacted, then cut.
// 5. The network is the plugin's (R6): its container is on the (plugin, channel) network, reaching only the proxy.
//
// The whole call — checks, copy in, command, copy out, write-back — is bounded by the command's timeoutMs, each copy
// also by 60 s; past either, what runs is killed, the container removed, nothing written back, and the call ends
// `timeout` (or `unknown_outcome` for a consequential call whose command had started, R12 (c)).

import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

import { present } from '../../shared/assert-present.js';
import { fileNameProblem, SPACE_MAX_BYTES, SPACE_MAX_ENTRIES } from '../../shared/files.js';
import { canonicalJson } from '../../shared/jcs.js';
import type { CommandDeclaration } from '../../shared/modules.js';
import { byCodeUnit } from '../../shared/order.js';
import type { ContainerRuntime, PluginContainer } from '../container-runtime/index.js';
import type { FileSpaces } from '../files/index.js';
import type { Logger } from '../log.js';
import {
  TarParser,
  padOf,
  tarEntryHeader,
  type TarFormatFailure,
  type TarHeader,
  type TarReader,
} from '../state/index.js';
import type { PathArgument } from './arguments.js';
import { buildArguments } from './arguments.js';
import { cutResult } from './cut.js';
import type { CallOutcome, SetTimer } from './host.js';
import type { InstalledModule } from './images.js';
import { resolvePluginPath, writeRefusal, type AllowedRoot, type ResolvedPath } from './paths.js';
import { redact } from './redact.js';
import { deniedBy } from '../../shared/credentials.js';

/** A call's read set at most (R30), and a named root's write-back at most. */
const MAX_READ_BYTES = 1024 * 1024 * 1024;
export const MAX_READ_FILES = 10_000;
const MAX_WRITE_BYTES = 1024 * 1024 * 1024;
const MAX_WRITE_ENTRIES = 10_000;
/** Each copy's own bound (R30: DOCKER_TIMEOUT_MS). */
const COPY_TIMEOUT_MS = 60_000;
/** A command's stdout and stderr, each, at most (R33). */
export const MAX_CAPTURE_BYTES = 256 * 1024;

/** A refusal or failure of the call, as the reason the model sees and the detail the log keeps. */
class CallFailed extends Error {
  constructor(
    readonly reason:
      | 'invalid_arguments'
      | 'path_refused'
      | 'input_too_large'
      | 'output_too_large'
      | 'space_full'
      | 'timeout'
      | 'module_unavailable'
      | 'unknown_outcome',
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'CallFailed';
  }
}

/** Finds any of `secrets` in a stream of chunks, across chunk boundaries (R32's content check). */
class SecretScanner {
  private tail = Buffer.alloc(0);
  private readonly needles: readonly Buffer[];
  private readonly keep: number;
  found = false;
  constructor(secrets: readonly string[]) {
    this.needles = secrets.filter((s) => s.length > 0).map((s) => Buffer.from(s, 'utf8'));
    this.keep = Math.max(0, ...this.needles.map((n) => n.length - 1));
  }
  push(chunk: Buffer): void {
    if (this.found || this.needles.length === 0) return;
    const window = Buffer.concat([this.tail, chunk]);
    if (this.needles.some((n) => window.includes(n))) this.found = true;
    this.tail = window.subarray(Math.max(0, window.length - this.keep));
  }
}

/** One regular file of the read set: where it lies on the host (named roots), its identity and size, its name in the container's tar. */
interface HostFile {
  readonly host: string;
  readonly tarName: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
}

/** What a tar entry's type is, when it is none of the ones EntryRules allows (helper of {@link EntryRules.entry}). */
function kindOfDisallowedEntry(type: string): string {
  if (type === '1') return 'a hard link';
  if (type === '2') return 'a symbolic link';
  return `a special file (type ${JSON.stringify(type)})`;
}

/** A reader of a tar copied out of a container or the space: only directories and regular files, under one top name. */
class EntryRules implements TarReader {
  constructor(
    private readonly onEntry: (name: string, header: TarHeader) => Promise<TarFormatFailure | undefined>,
    private readonly onData: (chunk: Buffer) => Promise<void>,
    private readonly onEnd: () => Promise<TarFormatFailure | undefined>,
  ) {}
  async entry(header: TarHeader): Promise<TarFormatFailure | undefined> {
    if (header.type !== '0' && header.type !== '\0' && header.type !== '5') {
      const kind = kindOfDisallowedEntry(header.type);
      return { entry: header.name, detail: `${kind} is not a directory or a regular file` };
    }
    const name = header.name.replace(/\/$/, '');
    const parts = name.split('/');
    if (name.startsWith('/') || parts.some((p) => p === '' || p === '.' || p === '..'))
      return { entry: header.name, detail: 'a name that is absolute or climbs out' };
    return this.onEntry(name, header);
  }
  async data(chunk: Buffer): Promise<void> {
    await this.onData(chunk);
  }
  async entryEnd(): Promise<TarFormatFailure | undefined> {
    return this.onEnd();
  }
  async end(): Promise<void> {}
}

export interface PluginCallRequest {
  readonly agent: string;
  readonly channel: string;
  readonly plugin: InstalledModule;
  readonly command: CommandDeclaration;
  readonly arguments: unknown;
  readonly roots: readonly AllowedRoot[];
  readonly consequential: boolean;
  readonly idempotencyKey?: string;
  /** Aborted when the call must end at once: its agent gone (not for a consequential call), or the daemon stopping. */
  readonly abandon: AbortSignal;
}

export interface PluginRunnerProps {
  readonly runtime: Pick<ContainerRuntime, 'pluginContainer'>;
  readonly slot: (
    module: string,
    channel: string,
  ) => Promise<
    { readonly network: string; readonly image: string; readonly secrets: Readonly<Record<string, string>> } | undefined
  >;
  readonly files: Pick<FileSpaces, 'readForPlugin' | 'writeFromPlugin'>;
  /** Every value the secret store holds (R32: a file holding one is refused). */
  readonly storedSecrets: () => Promise<readonly string[]>;
  readonly logger: Logger;
  readonly ashaHome: string;
  readonly stagingDir: string;
  readonly newId: () => string;
  readonly now: () => number;
  /** The call's bound (R30): injected, so a test passes it on its own clock. */
  readonly setTimer: SetTimer;
  /** Between the read set's checks and its copy: a test swaps a file for a link here (A28); production does nothing. */
  readonly afterChecks: () => Promise<void>;
}

/** A stream's capture, redacted before the cut's marker is added, so a secret cut at the capture's end is still found (B-14). */
export function captureText(kept: Buffer, total: number, secrets: readonly string[]): string {
  const text = redact(kept.toString('utf8'), secrets);
  return total > kept.length
    ? `${text} [${String(total - kept.length)} bytes past the ${String(MAX_CAPTURE_BYTES)}-byte capture]`
    : text;
}

/**
 * Whether a refused or failed call's reason becomes `unknown_outcome` (R12 (c)): consequential, its command had
 * started, and the refusal is not one of the kinds that could never have reached the vendor or the space — helper
 * of {@link PluginRunner.call}, split out to keep its cognitive complexity down.
 */
function finalReason(consequential: boolean, commandStarted: boolean, failed: CallFailed): CallFailed['reason'] {
  const neverStarted =
    failed.reason === 'invalid_arguments' ||
    failed.reason === 'path_refused' ||
    failed.reason === 'output_too_large' ||
    failed.reason === 'space_full';
  return consequential && commandStarted && !neverStarted ? 'unknown_outcome' : failed.reason;
}

export class PluginRunner {
  constructor(private readonly props: PluginRunnerProps) {}

  /**
   * Resolves every argument path and checks the whole read set (R30, R32), before anything is created: each read
   * path walked (a root) or scanned (the channel), each host file scanned again for a stored secret, the set's size
   * counted throughout. `pathsIn` is pushed into as each read path starts, so a failure midway still names what was
   * read so far (helper of {@link call}, split out to keep its cognitive complexity down).
   */
  private async checkReadSet(
    request: PluginCallRequest,
    built: { readonly argv: readonly string[]; readonly paths: readonly PathArgument[] },
    secrets: readonly string[],
    signal: AbortSignal,
    pathsIn: string[],
  ): Promise<{
    readonly reads: readonly ResolvedPath[];
    readonly writes: readonly ResolvedPath[];
    readonly hostFiles: readonly HostFile[];
    readonly hostDirs: ReadonlySet<string>;
  }> {
    const resolved: ResolvedPath[] = [];
    for (const path of built.paths) {
      const r = resolvePluginPath(path, request.roots, this.props.ashaHome);
      if ('problem' in r) throw new CallFailed('path_refused', `argument ${path.name}: ${r.problem}`);
      resolved.push(r);
    }
    const reads = resolved.filter((r) => r.mode === 'read');
    const writes = resolved.filter((r) => r.mode === 'write');
    const hostFiles: HostFile[] = [];
    const hostDirs = new Set<string>();
    let readBytes = 0;
    let readFiles = 0;
    const count = (bytes: number): void => {
      readFiles += 1;
      readBytes += bytes;
      if (readFiles > MAX_READ_FILES || readBytes > MAX_READ_BYTES)
        throw new CallFailed(
          'input_too_large',
          `the read set is over ${String(MAX_READ_FILES)} files or ${String(MAX_READ_BYTES)} bytes`,
        );
    };
    for (const r of reads) {
      pathsIn.push(r.container);
      if (r.kind === 'root') await this.walkRoot(r, hostFiles, hostDirs, count, signal);
      else await this.scanChannel(request.channel, r, secrets, count, signal);
    }
    for (const file of hostFiles) await this.scanHostFile(file, secrets, signal);
    return { reads, writes, hostFiles, hostDirs };
  }

  /**
   * Streams the read set into the container (R30), bounded by the call's clock; a failure found while streaming
   * (`failure`, set by {@link readSet}) takes priority over the copy's own outcome (helper of {@link call}).
   */
  private async copyIntoContainer(
    channel: string,
    container: PluginContainer,
    reads: readonly ResolvedPath[],
    hostFiles: readonly HostFile[],
    hostDirs: ReadonlySet<string>,
    writes: readonly ResolvedPath[],
    secrets: readonly string[],
    signal: AbortSignal,
    started: number,
    timeoutMs: number,
  ): Promise<void> {
    const failure: { value?: CallFailed } = {};
    // The read set's producers end with the copy, whatever ended it: a channel read waiting for the copy to take its
    // chunks is woken and stops, so it releases the channel's lock (review of 2026-10-02, H5).
    const readDone = new AbortController();
    const archive = this.readSet(
      channel,
      reads,
      hostFiles,
      hostDirs,
      writes,
      secrets,
      failure,
      AbortSignal.any([signal, readDone.signal]),
    );
    let copied: Awaited<ReturnType<PluginContainer['copyIn']>>;
    try {
      copied = await container.copyIn(archive, this.left(started, timeoutMs), signal);
    } finally {
      readDone.abort();
    }
    if (failure.value !== undefined) throw failure.value;
    if (copied.kind === 'timeout') throw new CallFailed('timeout', 'the copy into the container passed its bound');
    if (copied.code !== 0)
      throw new CallFailed('module_unavailable', `the copy into the container failed: ${copied.stderr}`);
  }

  /** One call (R30–R33). Every outcome is data; a refused path never starts a container. */
  async call(request: PluginCallRequest): Promise<CallOutcome> {
    const started = this.props.now();
    const { plugin, command } = request;
    const module = plugin.manifest.id;
    const argumentsSha256 = createHash('sha256').update(canonicalJson(request.arguments)).digest('hex');
    const pathsIn: string[] = [];
    const pathsBack: string[] = [];
    let commandStarted = false;
    const deadline = new AbortController();
    const cancelBound = this.props.setTimer(() => {
      deadline.abort(new CallFailed('timeout', `the call passed its bound of ${String(command.timeoutMs)} ms`));
    }, command.timeoutMs);
    const signal = AbortSignal.any([deadline.signal, request.abandon]);
    const fields = () => ({
      agent: request.agent,
      plugin: module,
      command: command.name,
      argumentsSha256,
      pathsIn,
      pathsBack,
      durationMs: this.props.now() - started,
    });
    let container: PluginContainer | undefined;
    try {
      const built = buildArguments(command, request.arguments);
      if (!built.ok) throw new CallFailed('invalid_arguments', `argument ${built.field} ${built.problem}`);
      const secrets = await this.props.storedSecrets();
      // R30, R32: every file of the read set checked — and the set's size counted — before anything is created.
      const { reads, writes, hostFiles, hostDirs } = await this.checkReadSet(request, built, secrets, signal, pathsIn);
      await this.props.afterChecks();
      const slot = await this.props.slot(module, request.channel);
      if (slot === undefined)
        throw new CallFailed('module_unavailable', `plugin ${module} is not ready on channel ${request.channel}`);
      const name = `asha-plugin-${module}-${this.props.newId().slice(0, 12)}`;
      container = this.props.runtime.pluginContainer({
        name,
        image: slot.image,
        network: slot.network,
        entrypoint: plugin.manifest.kind === 'CommandTool' ? plugin.manifest.executable.name : '',
        args: built.argv,
        env: { ...(plugin.manifest.kind === 'CommandTool' ? plugin.manifest.executable.env : {}), ...slot.secrets },
        labels: { 'asha.module': module, 'asha.channel': request.channel },
      });
      await container.create(signal);
      await this.copyIntoContainer(
        request.channel,
        container,
        reads,
        hostFiles,
        hostDirs,
        writes,
        secrets,
        signal,
        started,
        command.timeoutMs,
      );
      commandStarted = true;
      const run = await container.run(this.left(started, command.timeoutMs), MAX_CAPTURE_BYTES, signal);
      if (run.kind === 'timeout')
        throw new CallFailed('timeout', `the command passed its bound of ${String(command.timeoutMs)} ms`);
      for (const w of writes) {
        pathsBack.push(w.container);
        await this.writeBack(request.channel, w, container, signal, started, command.timeoutMs);
      }
      const values = Object.values(slot.secrets);
      const stdout = captureText(run.stdout, run.stdoutBytes, values);
      const stderr = captureText(run.stderr, run.stderrBytes, values);
      const result = cutResult({ exit_code: run.code, stdout, stderr });
      this.props.logger.info('plugin.call', { ...fields(), exitCode: run.code, outcome: 'ok' });
      return { ok: true, result };
    } catch (error) {
      const failed = this.reasonOf(error, signal, deadline.signal);
      const reason = finalReason(request.consequential, commandStarted, failed);
      this.props.logger.error('plugin.failed', {
        ...fields(),
        outcome: reason,
        reason,
        error: new Error(failed.detail),
      });
      return { ok: false, reason, detail: failed.detail };
    } finally {
      cancelBound();
      if (container !== undefined)
        await container.remove().catch((error: unknown) => {
          this.props.logger.error('plugin.remove_failed', { plugin: module, error });
        });
    }
  }

  private reasonOf(error: unknown, signal: AbortSignal, deadline: AbortSignal): CallFailed {
    if (error instanceof CallFailed) return error;
    if (deadline.aborted)
      return deadline.reason instanceof CallFailed
        ? deadline.reason
        : new CallFailed('timeout', 'the call passed its bound');
    if (signal.aborted)
      return new CallFailed('module_unavailable', 'abandoned: its agent left, or the daemon is stopping');
    return new CallFailed('module_unavailable', error instanceof Error ? error.message : String(error));
  }

  /** The time left of the call's bound, at least 1 ms. */
  private left(started: number, timeoutMs: number): number {
    return Math.max(1, timeoutMs - (this.props.now() - started));
  }

  /**
   * A named root's read path, walked on the host (R32): every component lstat'ed — a link at any depth refused — a
   * regular file with more than one link refused, a directory read only when its argument is recursive, every entry
   * of it walked the same way; each file's identity kept for the copy.
   */
  private async walkRoot(
    r: Extract<ResolvedPath, { kind: 'root' }>,
    files: HostFile[],
    dirs: Set<string>,
    count: (bytes: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let at = r.root.host;
    const parts = r.rel === '' ? [] : r.rel.split('/');
    for (const [i, part] of parts.entries()) {
      at = join(at, part);
      const info = await this.lstatOrRefuse(at, r.container);
      if (info.isSymbolicLink())
        throw new CallFailed('path_refused', `${r.container}: a symbolic link at ${parts.slice(0, i + 1).join('/')}`);
      if (i < parts.length - 1 && !info.isDirectory())
        throw new CallFailed('path_refused', `${r.container}: ${parts.slice(0, i + 1).join('/')} is not a directory`);
    }
    const relSuffix = r.rel === '' ? '' : `/${r.rel}`;
    const tarBase = `roots/${r.root.name}${relSuffix}`;
    const visit = async (host: string, tarName: string, info: Stats): Promise<void> => {
      if (signal.aborted) throw signal.reason;
      const denied =
        deniedBy(host, { ashaHome: this.props.ashaHome }) ?? deniedBy(`/${tarName}`, { ashaHome: this.props.ashaHome });
      if (denied !== undefined)
        throw new CallFailed('path_refused', `/${tarName} matches the credential deny list (${denied})`);
      if (info.isSymbolicLink()) throw new CallFailed('path_refused', `/${tarName}: a symbolic link`);
      if (info.isDirectory()) {
        if (!r.recursive && host === join(r.root.host, ...parts))
          throw new CallFailed(
            'path_refused',
            `${r.container} is a directory, and argument ${r.name} is not read recursively`,
          );
        dirs.add(tarName);
        let names: string[];
        try {
          names = await readdir(host);
        } catch (error) {
          throw new CallFailed(
            'path_refused',
            `/${tarName}: the host refused to read it (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
          );
        }
        for (const child of names.toSorted(byCodeUnit)) {
          const childHost = join(host, child);
          await visit(childHost, `${tarName}/${child}`, await this.lstatOrRefuse(childHost, `/${tarName}/${child}`));
        }
        return;
      }
      if (!info.isFile()) throw new CallFailed('path_refused', `/${tarName} is not a regular file or a directory`);
      if (info.nlink > 1)
        throw new CallFailed('path_refused', `/${tarName} is a hard-linked file (${String(info.nlink)} links)`);
      count(info.size);
      files.push({ host, tarName, dev: info.dev, ino: info.ino, size: info.size });
    };
    await visit(at, tarBase, await this.lstatOrRefuse(at, r.container));
  }

  private async lstatOrRefuse(path: string, shown: string): Promise<Stats> {
    try {
      return await lstat(path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new CallFailed('path_refused', `${shown}: no such file`);
      // macOS's protection of ~/Documents, ~/Desktop and ~/Downloads, among others (M25).
      throw new CallFailed('path_refused', `${shown}: the host refused to read it (${code ?? 'error'})`);
    }
  }

  /** Opens a checked file by O_NOFOLLOW and checks the descriptor is the very file walked (R32; agent-tools correction 3). */
  private async openChecked(file: HostFile): Promise<FileHandle> {
    let handle: FileHandle;
    try {
      handle = await open(file.host, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const detail =
        code === 'ELOOP'
          ? 'it became a symbolic link after it was checked'
          : `the host refused to read it (${code ?? 'error'})`;
      throw new CallFailed('path_refused', `/${file.tarName}: ${detail}`);
    }
    const info = await handle.stat();
    if (info.dev !== file.dev || info.ino !== file.ino || !info.isFile() || info.nlink > 1) {
      await handle.close();
      throw new CallFailed('path_refused', `/${file.tarName}: it changed after it was checked`);
    }
    return handle;
  }

  /** Reads a checked host file once to look for every stored secret value (R32): a file holding one is refused, naming it. */
  private async scanHostFile(file: HostFile, secrets: readonly string[], signal: AbortSignal): Promise<void> {
    if (secrets.length === 0) return;
    const handle = await this.openChecked(file);
    const scanner = new SecretScanner(secrets);
    try {
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        end: Math.max(0, file.size - 1),
        start: 0,
      })) {
        if (signal.aborted) throw signal.reason;
        scanner.push(chunk as Buffer);
      }
    } finally {
      await handle.close();
    }
    if (scanner.found) throw new CallFailed('path_refused', `/${file.tarName} holds a value of the secret store`);
  }

  /** A channel read path, read out of the space through the entry rules (R30, R32): counted, deny-listed and scanned; nothing kept. */
  private async scanChannel(
    channel: string,
    r: Extract<ResolvedPath, { kind: 'channel' }>,
    secrets: readonly string[],
    count: (bytes: number) => void,
    signal: AbortSignal,
  ): Promise<void> {
    let scanner: SecretScanner | undefined;
    let current = '';
    const top = present(r.rel === '' ? 'channel' : r.rel.split('/').at(-1), `${r.rel}'s last path segment`);
    const parent = r.rel === '' ? '' : r.rel.split('/').slice(0, -1).join('/');
    const reader = new EntryRules(
      (name, header): Promise<TarFormatFailure | undefined> => {
        const parentPrefix = parent === '' ? '' : `${parent}/`;
        const relativeName = r.rel === '' ? name.slice('channel'.length + 1) : name;
        current = `/channel/${parentPrefix}${relativeName}`.replace(/\/$/, '');
        if (name !== top && !name.startsWith(`${top}/`))
          return Promise.resolve({ entry: name, detail: `outside ${top}` });
        const denied = deniedBy(current, { ashaHome: this.props.ashaHome });
        if (denied !== undefined)
          return Promise.resolve({ entry: current, detail: `matches the credential deny list (${denied})` });
        if (header.type === '5') {
          if (name === top && !r.recursive)
            return Promise.resolve({
              entry: current,
              detail: `a directory, and argument ${r.name} is not read recursively`,
            });
          return Promise.resolve(undefined);
        }
        count(header.size);
        scanner = new SecretScanner(secrets);
        return Promise.resolve(undefined);
      },
      (chunk): Promise<void> => {
        scanner?.push(chunk);
        return Promise.resolve();
      },
      (): Promise<TarFormatFailure | undefined> => {
        if (scanner?.found === true)
          return Promise.resolve({ entry: current, detail: 'holds a value of the secret store' });
        scanner = undefined;
        return Promise.resolve(undefined);
      },
    );
    const parser = new TarParser(reader);
    let failure: TarFormatFailure | undefined;
    const copied = await this.props.files.readForPlugin(
      channel,
      r.rel,
      async (chunk) => {
        failure = await parser.push(chunk);
        return failure === undefined ? 'more' : 'stop';
      },
      signal,
    );
    if (failure !== undefined) throw new CallFailed('path_refused', `${failure.entry}: ${failure.detail}`);
    if (!copied.ok)
      throw new CallFailed(
        'path_refused',
        `${r.container}: ${/Could not find|no such/i.test(copied.detail) ? 'no such file in the space' : copied.detail}`,
      );
    const end = parser.finish();
    if (end !== undefined) throw new CallFailed('path_refused', `${end.entry}: ${end.detail}`);
  }

  /** `name`'s missing ancestor directories, as tar entries, each emitted once (helper of {@link readSet}). */
  private *dirEntries(name: string, emitted: Set<string>, mtime: number): Iterable<Uint8Array> {
    const parts = name.split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      const d = parts.slice(0, i).join('/');
      if (emitted.has(d)) continue;
      emitted.add(d);
      yield tarEntryHeader(d, 'directory', 0, mtime);
    }
  }

  /**
   * One checked host file's tar entry and content, read again through an O_NOFOLLOW descriptor whose identity is the
   * walk's, scanned again for a stored secret as it is read (R32; helper of {@link readSet}, split out to keep its
   * cognitive complexity down).
   */
  private async *yieldHostFile(
    file: HostFile,
    secrets: readonly string[],
    mtime: number,
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const handle = await this.openChecked(file);
    const scanner = new SecretScanner(secrets);
    try {
      yield tarEntryHeader(file.tarName, 'file', file.size, mtime);
      let read = 0;
      const buffer = Buffer.alloc(1 << 20);
      while (read < file.size) {
        if (signal.aborted) throw signal.reason;
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - read), read);
        if (bytesRead === 0) throw new CallFailed('path_refused', `/${file.tarName}: it shrank after it was checked`);
        const chunk = Buffer.from(buffer.subarray(0, bytesRead));
        scanner.push(chunk);
        if (scanner.found) throw new CallFailed('path_refused', `/${file.tarName} holds a value of the secret store`);
        read += bytesRead;
        yield chunk;
      }
      if (padOf(file.size) > 0) yield Buffer.alloc(padOf(file.size));
    } finally {
      await handle.close();
    }
  }

  /**
   * The read set as one tar, owned 1000:1000 (R30): each named root's checked files read again through O_NOFOLLOW
   * descriptors whose identity is the walk's, at most the size checked, scanned again; each channel path read again
   * through the entry rules; an empty directory for each write path. A failure ends the stream without its end blocks
   * and is left in `failure` for the call to throw.
   */
  private async *readSet(
    channel: string,
    reads: readonly ResolvedPath[],
    hostFiles: readonly HostFile[],
    hostDirs: ReadonlySet<string>,
    writes: readonly ResolvedPath[],
    secrets: readonly string[],
    failure: { value?: CallFailed },
    signal: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const mtime = Math.floor(this.props.now() / 1_000);
    const emitted = new Set<string>();
    try {
      for (const d of [...hostDirs].sort(byCodeUnit)) yield* this.dirEntries(d, emitted, mtime);
      for (const file of hostFiles) {
        yield* this.dirEntries(dirname(file.tarName), emitted, mtime);
        yield* this.yieldHostFile(file, secrets, mtime, signal);
      }
      for (const r of reads) {
        if (r.kind !== 'channel') continue;
        yield* this.channelEntries(channel, r, secrets, signal, emitted, mtime);
      }
      for (const w of writes) yield* this.dirEntries(w.container.slice(1), emitted, mtime);
      yield Buffer.alloc(1024);
    } catch (error) {
      failure.value =
        error instanceof CallFailed ? error : new CallFailed('module_unavailable', (error as Error).message);
    }
  }

  /** One channel read path re-read and re-emitted under `channel/` (its checks made again: the space may have changed). */
  private async *channelEntries(
    channel: string,
    r: Extract<ResolvedPath, { kind: 'channel' }>,
    secrets: readonly string[],
    signal: AbortSignal,
    emitted: Set<string>,
    mtime: number,
  ): AsyncIterable<Uint8Array> {
    const parent = r.rel === '' ? '' : r.rel.split('/').slice(0, -1).join('/');
    const top = present(r.rel === '' ? 'channel' : r.rel.split('/').at(-1), `${r.rel}'s last path segment`);
    const out: Buffer[] = [];
    let wake: (() => void) | undefined;
    // A plain object property, not a `let`: the `.finally()` below mutates it from a callback this function never
    // calls directly, which would otherwise read as a literal `false` to @typescript-eslint/no-unnecessary-condition
    // in the loop below (TypeScript does not see a mutation through a callback — see host.ts's `send()`).
    const state = { done: false };
    let failure: CallFailed | undefined;
    let scanner: SecretScanner | undefined;
    let current = '';
    let pad = 0;
    const base = (name: string): string => {
      if (r.rel === '') return name;
      const parentPrefix = parent === '' ? '' : `${parent}/`;
      return `channel/${parentPrefix}${name}`;
    };
    const onAbort = (): void => wake?.();
    signal.addEventListener('abort', onAbort, { once: true });
    const reader = new EntryRules(
      (name, header): Promise<TarFormatFailure | undefined> => {
        if (name !== top && !name.startsWith(`${top}/`))
          return Promise.resolve({ entry: name, detail: `outside ${top}` });
        current = base(name);
        const denied = deniedBy(`/${current}`, { ashaHome: this.props.ashaHome });
        if (denied !== undefined)
          return Promise.resolve({ entry: current, detail: `matches the credential deny list (${denied})` });
        const parts = current.split('/');
        for (let i = 1; i < parts.length; i += 1) {
          const d = parts.slice(0, i).join('/');
          if (!emitted.has(d)) {
            emitted.add(d);
            out.push(tarEntryHeader(d, 'directory', 0, mtime));
          }
        }
        if (header.type === '5') {
          if (!emitted.has(current)) {
            emitted.add(current);
            out.push(tarEntryHeader(current, 'directory', 0, mtime));
          }
          return Promise.resolve(undefined);
        }
        scanner = new SecretScanner(secrets);
        out.push(tarEntryHeader(current, 'file', header.size, mtime));
        pad = padOf(header.size);
        return Promise.resolve(undefined);
      },
      (chunk): Promise<void> => {
        scanner?.push(chunk);
        out.push(Buffer.from(chunk));
        wake?.();
        return Promise.resolve();
      },
      (): Promise<TarFormatFailure | undefined> => {
        if (scanner?.found === true)
          return Promise.resolve({ entry: current, detail: 'holds a value of the secret store' });
        if (scanner !== undefined && pad > 0) out.push(Buffer.alloc(pad));
        scanner = undefined;
        pad = 0;
        wake?.();
        return Promise.resolve(undefined);
      },
    );
    const parser = new TarParser(reader);
    const copy = this.props.files
      .readForPlugin(
        channel,
        r.rel,
        async (chunk) => {
          const f = await parser.push(chunk);
          if (f !== undefined) {
            failure = new CallFailed('path_refused', `${f.entry}: ${f.detail}`);
            return 'stop';
          }
          // Backpressure: the reader waits while the container's copy has not taken what is queued; it stops when the
          // copy has ended (the signal), so the space's lock is released.
          while (out.length > 64 && !signal.aborted) await new Promise<void>((resolve) => (wake = resolve));
          return signal.aborted ? 'stop' : 'more';
        },
        signal,
      )
      .then((copied) => {
        if (failure === undefined && !copied.ok)
          failure = new CallFailed('path_refused', `${r.container}: ${copied.detail}`);
        const end = parser.finish();
        if (failure === undefined && end !== undefined)
          failure = new CallFailed('path_refused', `${end.entry}: ${end.detail}`);
      })
      .finally(() => {
        state.done = true;
        wake?.();
      });
    for (;;) {
      const next = out.shift();
      if (next !== undefined) {
        wake?.();
        yield next;
        continue;
      }
      if (state.done) break;
      await new Promise<void>((resolve) => (wake = resolve));
    }
    await copy;
    signal.removeEventListener('abort', onAbort);
    if (failure !== undefined) throw failure;
  }

  /** The two write-size bounds (R30, B-9): a root's 1 GiB and 10,000 entries, or a file space's own measure (helper of {@link writeBack}'s entry reader). */
  private checkWriteSize(w: ResolvedPath, entries: number, bytes: number): void {
    if (w.kind === 'root' && (entries > MAX_WRITE_ENTRIES || bytes > MAX_WRITE_BYTES))
      throw new CallFailed(
        'output_too_large',
        `${w.container}: the command wrote more than ${String(MAX_WRITE_ENTRIES)} entries or ${String(MAX_WRITE_BYTES)} bytes`,
      );
    // Into the channel's space: no more than the space could ever hold is staged on the host's disk (the space's
    // own measure, with what it holds, is checked once the tar is read; review of 2026-10-02, B-9).
    if (w.kind !== 'root' && (entries > SPACE_MAX_ENTRIES || bytes > SPACE_MAX_BYTES))
      throw new CallFailed(
        'space_full',
        `${w.container}: the command wrote more than a file space holds (${String(SPACE_MAX_ENTRIES)} entries, ${String(SPACE_MAX_BYTES)} bytes)`,
      );
  }

  /** Why a write entry is refused (R32): the credential deny list, then `writeRefusal` — the container path, and a root's host target too (helper of {@link writeBack}'s entry reader). */
  private writeEntryRefusal(containerPath: string, target: string | undefined): string | undefined {
    const denied = deniedBy(containerPath, { ashaHome: this.props.ashaHome });
    if (denied !== undefined) return `matches the credential deny list (${denied})`;
    return (
      writeRefusal(containerPath) ?? (target === undefined ? undefined : writeRefusal(target.split(sep).join('/')))
    );
  }

  /**
   * One root write entry's target opened or made (R32, B-23): a directory made in place, or a temp file opened
   * beside its target, for a rename into place only once the whole tar is read (helper of {@link writeBack}'s entry
   * reader, split out to keep its cognitive complexity down). `problem` is set instead when the target is the root
   * itself; `handle` is undefined for a directory.
   */
  private async openRootWriteEntry(
    w: Extract<ResolvedPath, { kind: 'root' }>,
    header: TarHeader,
    target: string,
    id: string,
    temps: { temp: string; target: string }[],
  ): Promise<{ readonly handle?: FileHandle; readonly problem?: string }> {
    if (header.type === '5') {
      await this.mkdirInRoot(w.root.host, target);
      return {};
    }
    // A file in place of the root itself would put its temporary file in the root's parent, outside it (B-23).
    if (target === w.root.host) return { problem: 'a file in place of the root folder itself' };
    await this.mkdirInRoot(w.root.host, dirname(target));
    const temp = join(dirname(target), `.asha-plugin-${id}-${String(temps.length)}.tmp`);
    const handle = await open(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o644,
    );
    temps.push({ temp, target });
    return { handle };
  }

  /** One space (channel) write entry staged (helper of {@link writeBack}'s entry reader): a directory recorded, or a file opened in the staging directory. */
  private async openSpaceWriteEntry(
    header: TarHeader,
    containerPath: string,
    stageDir: string,
    staged: { name: string; file: string; size: number }[],
  ): Promise<FileHandle | undefined> {
    if (header.type === '5') {
      staged.push({ name: containerPath.slice(1), file: '', size: 0 });
      return undefined;
    }
    await mkdir(stageDir, { recursive: true, mode: 0o700 });
    const file = join(stageDir, `${String(staged.length)}.bin`);
    const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    staged.push({ name: containerPath.slice(1), file, size: header.size });
    return handle;
  }

  /** Finishes a root write-back (R30): every temp file renamed into place, now that the whole tar is read within its bounds (helper of {@link writeBack}). */
  private async finishRootWrite(
    w: Extract<ResolvedPath, { kind: 'root' }>,
    temps: { temp: string; target: string }[],
  ): Promise<void> {
    for (const { temp, target } of temps) {
      await this.mkdirInRoot(w.root.host, dirname(target));
      await rename(temp, target);
    }
    temps.length = 0;
  }

  /** Finishes a space (channel) write-back (R30): the staged files archived and written in, through the file spaces' bounds (helper of {@link writeBack}). */
  private async finishSpaceWrite(
    channel: string,
    w: ResolvedPath,
    staged: readonly { readonly name: string; readonly file: string; readonly size: number }[],
    bytes: number,
    signal: AbortSignal,
  ): Promise<void> {
    const mtime = Math.floor(this.props.now() / 1_000);
    const dirs = new Set<string>();
    for (const s of staged) {
      const parts = s.name.split('/');
      for (let i = 2; i < parts.length + (s.file === '' ? 1 : 0); i += 1) dirs.add(parts.slice(0, i).join('/'));
    }
    async function* archive(): AsyncIterable<Uint8Array> {
      for (const d of [...dirs].sort(byCodeUnit)) yield tarEntryHeader(d, 'directory', 0, mtime);
      for (const s of staged) {
        if (s.file === '') continue;
        yield tarEntryHeader(s.name, 'file', s.size, mtime);
        const h = await open(s.file, 'r');
        try {
          for await (const chunk of h.createReadStream({ autoClose: false })) yield chunk as Buffer;
        } finally {
          await h.close();
        }
        if (padOf(s.size) > 0) yield Buffer.alloc(padOf(s.size));
      }
      yield Buffer.alloc(1024);
    }
    const written = await this.props.files.writeFromPlugin(
      channel,
      { entries: dirs.size + staged.filter((s) => s.file !== '').length, bytes },
      archive,
      signal,
    );
    if (!written.ok)
      throw new CallFailed(
        written.reason === 'space_full' ? 'space_full' : 'module_unavailable',
        `${w.container}: ${written.detail}`,
      );
  }

  /**
   * A write path's copy-back (R30): `docker cp <c>:<path> -`, read by the entry rules — a link, a hard link or a special
   * file the command made refused — and every name checked by R32's write rules; into a named root as temporary files
   * beside their targets, renamed into place only once the whole tar is read within 1 GiB and 10,000 entries; into the
   * space through the file spaces' bounds (agent-files R11, R13).
   */
  private async writeBack(
    channel: string,
    w: ResolvedPath,
    container: PluginContainer,
    signal: AbortSignal,
    started: number,
    timeoutMs: number,
  ): Promise<void> {
    const top = present(w.container.split('/').at(-1), `${w.container}'s last path segment`);
    const temps: { temp: string; target: string }[] = [];
    const staged: { name: string; file: string; size: number }[] = [];
    const stageDir = join(this.props.stagingDir, `plugin-${this.props.newId().slice(0, 12)}`);
    let entries = 0;
    let bytes = 0;
    let handle: FileHandle | undefined;
    const id = this.props.newId().slice(0, 12);
    try {
      const reader = new EntryRules(
        async (name, header) => {
          if (name !== top && !name.startsWith(`${top}/`)) return { entry: name, detail: `outside ${top}` };
          const rel = name.slice(top.length + 1);
          const containerPath = rel === '' ? w.container : `${w.container}/${rel}`;
          entries += 1;
          bytes += header.size;
          this.checkWriteSize(w, entries, bytes);
          let target: string | undefined;
          if (w.kind === 'root') target = rel === '' ? w.host : join(w.host, ...rel.split('/'));
          const refusal = this.writeEntryRefusal(containerPath, target);
          if (refusal !== undefined) return { entry: containerPath, detail: refusal };
          for (const part of rel === '' ? [] : rel.split('/')) {
            const problem = fileNameProblem(part, { returned: false });
            if (problem !== undefined) return { entry: containerPath, detail: problem };
          }
          if (w.kind === 'root') {
            const opened = await this.openRootWriteEntry(
              w,
              header,
              present(target, "the root write target (computed above, since w.kind === 'root')"),
              id,
              temps,
            );
            if (opened.problem !== undefined) return { entry: containerPath, detail: opened.problem };
            handle = opened.handle;
            return undefined;
          }
          handle = await this.openSpaceWriteEntry(header, containerPath, stageDir, staged);
          return undefined;
        },
        async (chunk) => {
          await handle?.write(chunk);
        },
        async () => {
          await handle?.close();
          handle = undefined;
          return undefined;
        },
      );
      const parser = new TarParser(reader);
      let failure: TarFormatFailure | undefined;
      let thrown: unknown;
      const copied = await container.copyOut(
        w.container,
        async (chunk) => {
          try {
            failure = await parser.push(chunk);
          } catch (error) {
            thrown = error;
            return 'stop';
          }
          return failure === undefined ? 'more' : 'stop';
        },
        Math.min(COPY_TIMEOUT_MS, this.left(started, timeoutMs)),
        signal,
      );
      // Rethrown exactly as caught (even when it is a CallFailed, so its specific reason is kept, not generalised):
      // `as Error` only satisfies @typescript-eslint/only-throw-error's static check, with no runtime effect.
      if (thrown !== undefined) throw thrown as Error;
      if (failure !== undefined) throw new CallFailed('path_refused', `${failure.entry}: ${failure.detail}`);
      if (!copied.ok)
        throw new CallFailed(
          signal.aborted ? 'timeout' : 'module_unavailable',
          `the copy out of ${w.container} failed: ${copied.detail}`,
        );
      const end = parser.finish();
      if (end !== undefined) throw new CallFailed('path_refused', `${end.entry}: ${end.detail}`);
      // Awaited here, not returned bare: the `finally` below must run only once this has (the rename, or the
      // archive and its write) has actually finished, not merely been scheduled.
      if (w.kind === 'root') await this.finishRootWrite(w, temps);
      else await this.finishSpaceWrite(channel, w, staged, bytes, signal);
    } finally {
      await handle?.close().catch(() => undefined);
      for (const { temp } of temps) await rm(temp, { force: true });
      await rm(stageDir, { recursive: true, force: true });
    }
  }

  /** Creates the directories down to `dir` inside a root, refusing a symbolic link at any component (R32). */
  private async mkdirInRoot(root: string, dir: string): Promise<void> {
    const rel = dir === root ? '' : dir.slice(root.length + 1);
    let at = root;
    for (const part of rel === '' ? [] : rel.split(sep)) {
      at = join(at, part);
      let info: Stats | undefined;
      try {
        info = await lstat(at);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (info === undefined) await mkdir(at, { mode: 0o755 });
      else if (info.isSymbolicLink() || !info.isDirectory())
        throw new CallFailed('path_refused', `${at} is a symbolic link or not a directory`);
    }
  }
}

export type { PathArgument };
