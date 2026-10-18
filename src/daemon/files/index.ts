// The channel file spaces (docs/plans/agent-files.md R3a, R4–R6, R10–R15): one Docker volume per channel, mounted at
// /channel in every agent container of the channel, created before the channel's first agent starts, filled and read
// through a holder container that is created and never started, and removed by the daemon's reclaim at its stop and
// start (R10a). Every operation on one channel's space runs under that channel's lock (lock.ts), each bounded.
//
// The daemon never writes attachment bytes to the host's disk (R4): an upload streams from the request through a tar
// built here into `docker cp - <holder>:/`, into a folder of its own, `/channel/upload-<16 hex>/`; a failed copy of
// any kind is undone by removing that folder as root (R3a). A returned file is read out of the space only to check
// it (R12) and again to stream it to the CLI that fetches it (R12a). Every failure is logged through the daemon's
// facade (R14), never with file content or a host path; `files.refused` never carries a user ID.

import { createHash, randomBytes } from 'node:crypto';

import type { ContainerRuntime, CopyOutcome, DockerOutcome } from '../container-runtime/index.js';
import type { Logger } from '../log.js';
import {
  STATE_OWNER,
  TarParser,
  padOf,
  tarEntryHeader,
  type TarFormatFailure,
  type TarHeader,
  type TarReader,
} from '../state/index.js';
import {
  MANIFEST_MAX_BYTES,
  MAX_ATTACHMENT_BYTES,
  MAX_FILES_PER_MESSAGE,
  SPACE_MAX_BYTES,
  SPACE_MAX_ENTRIES,
  UPLOAD_FOLDER_PATTERN,
  fileNameProblem,
  uniqueNames,
} from '../../shared/files.js';
import {
  NAME_PATTERN,
  UPLOAD_REFUSALS,
  type Attachment,
  type ReturnedFile,
  type UploadManifestEntry,
  type UploadRefusal,
  type UploadResponse,
} from '../../shared/protocol.js';
import { withTimeout } from '../../shared/abort.js';
import { present } from '../../shared/assert-present.js';
import { byCodeUnit } from '../../shared/order.js';
import { ChannelLock } from './lock.js';

export { ChannelLock } from './lock.js';

/** No body bytes for this long fails an upload (R3a). */
export const UPLOAD_STALL_MS = 30_000;
/** An upload waits at most this long for its channel's lock (R3a). */
const UPLOAD_LOCK_WAIT_MS = 60_000;
/**
 * A space's creation, fill or removal waits at most this long for its channel's lock: past the longest holder — an
 * upload's measurement, copy and rollback, 60 s each — with a minute to spare. The daemon's stop also ends a
 * creation's or a fill's wait, never a removal's: its own stop removes the spaces.
 */
export const SPACE_LOCK_WAIT_MS = 240_000;
/** An upload id no posted message used is rolled back after this long (R3a). */
const UPLOAD_UNUSED_MS = 600_000;
/** The most unused upload ids one channel keeps (R3a). */
const MAX_UNUSED_UPLOADS = 100;
/** A return waits at most this long for the lock (R12)… */
const RETURN_LOCK_WAIT_MS = 10_000;
/** …and is answered within this long of its start (R12). */
const RETURN_ANSWER_MS = 20_000;
/** The most records one channel's file table, and its returned files, keep (R6, R12a). */
export const MAX_RECORDS = 1_000;
/**
 * The most a refused upload's body is read in all, the upload's own part included, before its drain stops
 * (docs/plans/portal.md R8b): the largest body a valid manifest can name, MANIFEST_MAX_BYTES plus
 * MAX_FILES_PER_MESSAGE × MAX_ATTACHMENT_BYTES — 250,008,192 bytes.
 */
export const DRAIN_MAX_BYTES = MANIFEST_MAX_BYTES + MAX_FILES_PER_MESSAGE * MAX_ATTACHMENT_BYTES;
/** The longest a refused upload's drain runs (R8b): ten times what P5 took for 25 MB, and more. */
const DRAIN_MAX_MS = 60_000;

/** One of asha's own secrets an upload must not hold (R8b): which it is, as the refusal names it, and its value. */
export interface OwnSecret {
  readonly which: string;
  readonly value: string;
}

/** How a refused upload's drain ended (R8b). */
export type DrainOutcome = 'ended' | 'hung_up' | 'stalled' | 'over_bound' | 'over_time' | 'closed';

/** One record of a channel's file table (R6): exactly these five fields. */
export interface FileTableRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly user: string;
  /** ISO 8601. */
  readonly time: string;
}

/** What fills a space from a persisted channel's saved generation (R15): its `channel/` tar and its file table. */
export interface SpaceFill {
  readonly archive: () => AsyncIterable<Uint8Array>;
  readonly table: readonly FileTableRecord[];
}

/** What a persisted snapshot leaves out (R15), decided under the lock before its first byte. */
export interface SnapshotPlan {
  /** Whether an entry of the copy (`channel/…`) is an unused upload's, to read past. */
  readonly skip: (name: string) => boolean;
  /** The file table without the unused uploads' records. */
  readonly table: readonly FileTableRecord[];
}

/** A fill given for a space that already holds an entry: the saved files would mix with this run's (R15). */
export class SpaceHoldsFiles extends Error {
  constructor(readonly channel: string) {
    super(
      `channel ${channel}'s file space already holds files this run put there; the saved files are not filled into it`,
    );
    this.name = 'SpaceHoldsFiles';
  }
}

/** A channel's space could not be removed (docs/plans/portal-demo-stop.md R2); what is left is the reclaim's. */
export class FileSpaceRemoveFailed extends Error {
  constructor(
    readonly channel: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`the file space of channel ${channel} could not be removed: ${detail}`, options);
    this.name = 'FileSpaceRemoveFailed';
  }
}

/** A space could not be created; names the channel and the step (R10). Fails the launch or the space route loudly. */
export class FileSpaceUnavailable extends Error {
  constructor(
    readonly channel: string,
    readonly step: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`the file space of channel ${channel} could not be created (${step}): ${detail}`, options);
    this.name = 'FileSpaceUnavailable';
  }
}

/**
 * An upload's answer: its response, or a refusal with its status and reason (R3a). A refusal met after the body began
 * to be read carries `drain`: once the refusal is answered, the rest of the body is read and discarded, bounded, so a
 * browser — which reads no answer before it has sent its whole body — reads it (docs/plans/portal.md R8b, P5).
 */
export type UploadResult =
  | { readonly ok: true; readonly answer: UploadResponse }
  | {
      readonly ok: false;
      readonly reason: UploadRefusal;
      readonly status: number;
      readonly detail: string;
      /**
       * `closed` settles when the request's connection closes: once a response is sent, Node no longer ends the request
       * when its client hangs up, so the drain watches the connection itself.
       */
      readonly drain?: (closed: Promise<void>) => Promise<DrainOutcome>;
    };

/** A message's attachments, once its upload id is checked (R3a): the files, to attach and to log. */
export type Claimed =
  { readonly ok: true; readonly attachments: readonly Attachment[] } | { readonly ok: false; readonly detail: string };

/** A reply's files, copied out and checked (R12): their records, or the first refusal. */
export type ReturnResult =
  | { readonly ok: true; readonly files: readonly ReturnedFile[] }
  | { readonly ok: false; readonly file: string; readonly rule: string };

/** A download (R12a): where its bytes go. `begin` once the file's entry is checked, before any byte. */
export interface DownloadSink {
  begin(file: { readonly name: string; readonly size: number }): void;
  write(chunk: Buffer): Promise<void>;
}

/** A download's outcome: every byte sent, or why not (unknown id: nothing sent; refused: the response is cut short). */
export type DownloadResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'unknown' | 'refused'; readonly rule: string };

/** The channel file spaces, as the server and the supervisor use them. */
export interface FileSpaces {
  /** Whether the channel has a space in this daemon run. */
  exists(channel: string): boolean;
  /** The channel's volume, for an agent container's mount; undefined when it has no space. */
  volumeOf(channel: string): string | undefined;
  /**
   * Makes sure the channel has a space (R10): created from `image` (an agent image's exact tag, already present) under
   * the channel's lock, filled from `fill` when given (R15). Concurrent calls for one channel share one creation.
   */
  ensure(channel: string, image: string, fill?: SpaceFill): Promise<string>;
  /** The space's measured usage (R11): every entry below its root, and its regular files' bytes. */
  usage(channel: string): Promise<{ readonly bytes: number; readonly entries: number }>;
  /** Fills an existing, empty space from a persisted channel's saved files (R15); false, filling nothing, when it holds any entry. */
  fillIfEmpty(channel: string, fill: SpaceFill): Promise<boolean>;
  /** One message's attachments, uploaded (R3a). */
  upload(props: {
    readonly channel: string;
    readonly user: string;
    readonly body: AsyncIterable<Uint8Array>;
  }): Promise<UploadResult>;
  /** Checks a conversation's `attachments` id (R3a): known, unexpired, this channel's, unused. Marks it claimed. */
  claim(channel: string, upload: string): Claimed;
  /** The conversation naming a claimed upload was posted: it is used, kept, and its files logged `files.attached` (R8, R14). */
  used(channel: string, upload: string, props: { readonly user: string; readonly agents: readonly string[] }): void;
  /** The conversation naming a claimed upload was refused: rolled back, its records dropped (R3a). */
  refused(channel: string, upload: string): void;
  /** A reply's files (R12), copied out of the space and checked, under the lock; recorded for download (R12a). */
  returnFiles(props: {
    readonly channel: string;
    readonly conversation: string;
    readonly user: string;
    readonly handle: string;
    readonly paths: readonly string[];
  }): Promise<ReturnResult>;
  /** Streams a returned file to `sink`, checking its size and sha256 against the record (R12a). */
  download(id: string, sink: DownloadSink, signal?: AbortSignal): Promise<DownloadResult>;
  /** The channel's file table (R6). */
  table(channel: string): readonly FileTableRecord[];
  /**
   * A persisted channel's snapshot of its space (R15): under the lock, `start` is told what to leave out — every upload
   * of this run no posted message named — and the file table without their records, before any byte; then
   * `docker cp <holder>:/channel -`, each chunk to the consumer `start` returns.
   */
  snapshot(
    channel: string,
    start: (taken: SnapshotPlan) => (chunk: Buffer) => Promise<'more' | 'stop'>,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }>;
  /**
   * A command plugin call's read of the space (extension-modules R30): `docker cp <holder>:/channel/<rel> -` under the
   * channel's lock, each chunk to `onChunk` — the caller reads it with the tar reader's entry rules.
   */
  readForPlugin(
    channel: string,
    rel: string,
    onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>,
    signal: AbortSignal,
  ): Promise<CopyOutcome>;
  /**
   * A command plugin call's write-back into the space (R30, this plan's R11 and R13): under the channel's lock, the
   * space measured and refused `space_full` when `adds` would pass a bound, else the tar copied in.
   */
  writeFromPlugin(
    channel: string,
    adds: { readonly entries: number; readonly bytes: number },
    archive: () => AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: 'space_full' | 'failed'; readonly detail: string }
  >;
  /** The daemon is stopping (R3a): refuse new uploads and returns, abort those in flight, cancel expiries, kill rollbacks. */
  stop(): void;
  /**
   * Removes one channel's space (docs/plans/portal-demo-stop.md R2): its upload in flight killed and a new one refused
   * (503 `stopping`, "channel <name> is stopping"), as the daemon's stop does; then, under its lock, its unused uploads'
   * expiries cleared, its returned files forgotten, its holder container and its volume removed. A later launch on the channel
   * makes a new one. A channel with no space is refused: the caller checks `exists` first.
   */
  remove(channel: string): Promise<void>;
}

/** What ChannelFileSpaces is built with, at the daemon's one composition root (compose.ts). */
export interface ChannelFileSpacesProps {
  readonly runtime: ContainerRuntime;
  readonly logger: Logger;
  /** The home's id (8 hex): the volumes' label and names (R10). */
  readonly homeId: string;
  /** 8 hex characters drawn at each daemon start: a crashed run's volume is never reused (R10). */
  readonly runId: string;
  /** Random hex of `bytes` bytes: folders, upload and file ids, the space label. Injected so a test can draw a taken name. */
  readonly randomHex?: (bytes: number) => string;
  readonly clock: () => Date;
  /**
   * asha's own secrets no upload may hold (docs/plans/portal.md R8b): today the running daemon's control credential
   * and, once made, this run's model-server key. Called once per upload, when it starts.
   */
  readonly ownSecrets: () => readonly OwnSecret[];
}

/** A channel's space in this daemon run. */
interface Space {
  readonly channel: string;
  readonly volume: string;
  readonly holder: string;
  /** The holder's image, by exact tag: every rollback runs it (R3a). */
  readonly image: string;
  readonly table: FileTableRecord[];
  /** Upload ids not yet named by a posted message, with their folder, files and expiry. */
  readonly unused: Map<string, Upload>;
  /** The folders of every upload of this run no posted message named — failed, rolled back or not (R15). */
  readonly unusedFolders: Set<string>;
  /** Returned files (R12a), oldest first, at most MAX_RECORDS. */
  readonly returned: ReturnedRecord[];
  /** Aborted by the space's removal (portal-demo-stop R2): its upload in flight is killed, as the daemon's stop kills one. */
  readonly closing: AbortController;
}

interface Upload {
  readonly id: string;
  readonly folder: string;
  readonly attachments: readonly Attachment[];
  readonly user: string;
  timer: NodeJS.Timeout | undefined;
  claimed: boolean;
}

/** buildUploadArchive's own failure, read from `box.failure` by uploadLocked once the archive is fully consumed. */
interface UploadFailure {
  readonly reason: 'body_short' | 'body_long' | 'body_stalled' | 'sha256_mismatch' | 'holds_asha_secret';
  readonly detail: string;
  readonly name?: string;
}

/** Where a returned file lies: top level, or an attachment in its upload's folder (R12). */
type ReturnSource = { readonly name: string; readonly folder?: string };

interface ReturnedRecord extends ReturnedFile {
  readonly channel: string;
  readonly conversation: string;
  readonly source: ReturnSource;
}

/**
 * `s` with every trailing NUL or space character removed (rootOwner's tar header fields are fixed-width, padded
 * with one or the other). A loop, not a `/[\0 ]+$/` regex (sonarjs/super-linear-regex): the regex is anchored and
 * only one character class deep, so it never actually backtracks super-linearly, but the loop removes the finding
 * without relying on that argument.
 */
function trimTrailingPad(s: string): string {
  let end = s.length;
  while (end > 0 && (s[end - 1] === '\0' || s[end - 1] === ' ')) end -= 1;
  return s.slice(0, end);
}

/**
 * uploadLocked's own tar builder, pulled out of that method as its own function to keep its complexity down: the
 * folder, then each file, verified as its bytes pass; on a failure its input ends where it is, with no end blocks,
 * and docker cp's exit is awaited whatever its status (P8 B1, B2). Each file's bytes are scanned for asha's own
 * secrets before any byte of a chunk passes on (R8b). `box.failure` is set on a failure, for the caller to read
 * once this generator's consumer (docker cp) is done with it — a generator's return value is not otherwise visible
 * to a `for await` consumer, which is all `copyIn` gives this one.
 */
async function* buildUploadArchive(props: {
  readonly folder: string;
  readonly mtime: number;
  readonly files: readonly UploadManifestEntry[];
  readonly names: readonly string[];
  readonly body: BodyReader;
  readonly scan: SecretScan;
  readonly box: { failure: UploadFailure | undefined };
}): AsyncIterable<Uint8Array> {
  const { folder, mtime, files, names, body, scan, box } = props;
  yield tarEntryHeader(`channel/${folder}`, 'directory', 0, mtime);
  for (const [i, file] of files.entries()) {
    const name = present(names[i], `names[${String(i)}]`);
    yield tarEntryHeader(`channel/${folder}/${name}`, 'file', file.size, mtime);
    // The search starts afresh for each file.
    for await (const chunk of readUploadFile(file, body, scan.file(), box)) yield chunk;
    if (box.failure !== undefined) return;
    if (padOf(file.size) > 0) yield Buffer.alloc(padOf(file.size));
  }
  const extra = await body.take(1);
  if (extra === 'stalled') {
    box.failure = { reason: 'body_stalled', detail: `no body bytes for ${String(UPLOAD_STALL_MS)} ms` };
    return;
  }
  if (extra !== 'end') {
    box.failure = { reason: 'body_long', detail: 'the body holds more bytes than its manifest names' };
    return;
  }
  yield Buffer.alloc(1024);
}

/**
 * buildUploadArchive's read of one file's bytes, pulled out as its own function to keep that function's complexity
 * down: verified against its sha256 and scanned for asha's own secrets (R8b) as they pass. Sets `box.failure` and
 * stops yielding, without the trailing padding, on any problem — its caller checks `box.failure` once this ends.
 */
async function* readUploadFile(
  file: UploadManifestEntry,
  body: BodyReader,
  scanning: ReturnType<SecretScan['file']>,
  box: { failure: UploadFailure | undefined },
): AsyncIterable<Uint8Array> {
  const hash = createHash('sha256');
  for (let left = file.size; left > 0;) {
    const chunk = await body.take(left);
    if (chunk === 'end') {
      const why = body.failure === undefined ? '' : ` (${body.failure})`;
      box.failure = { reason: 'body_short', detail: `the body ended inside ${file.name}${why}`, name: file.name };
      return;
    }
    if (chunk === 'stalled') {
      box.failure = {
        reason: 'body_stalled',
        detail: `no body bytes for ${String(UPLOAD_STALL_MS)} ms`,
        name: file.name,
      };
      return;
    }
    hash.update(chunk);
    left -= chunk.byteLength;
    const passed = scanning.push(chunk);
    if (typeof passed === 'string') {
      box.failure = { reason: 'holds_asha_secret', detail: `${file.name} holds asha's ${passed}`, name: file.name };
      return;
    }
    if (passed.byteLength > 0) yield passed;
  }
  if (hash.digest('hex') !== file.sha256) {
    box.failure = {
      reason: 'sha256_mismatch',
      detail: `${file.name}'s bytes do not have the sha256 its manifest names`,
      name: file.name,
    };
    return;
  }
  const rest = scanning.end();
  if (rest.byteLength > 0) yield rest;
}

/**
 * The channel file spaces of one daemon run (agent-files R10): each channel's volume and holder, its file table,
 * unused uploads and returned files, every operation on a space serialised by that channel's lock (lock.ts), and the
 * daemon's stop, which refuses new work and ends what is in flight.
 */
export class ChannelFileSpaces implements FileSpaces {
  private readonly spaces = new Map<string, Space>();
  private readonly creating = new Map<string, Promise<Space>>();
  private readonly locks = new Map<string, ChannelLock>();
  /** Returned files by id, across channels, for the download route. */
  private readonly returnedById = new Map<string, ReturnedRecord>();
  /** Aborted at the daemon's stop: every upload, return, expiry and rollback in flight ends (R3a). */
  private readonly stopping = new AbortController();
  private readonly random: (bytes: number) => string;

  constructor(private readonly props: ChannelFileSpacesProps) {
    if (!/^[0-9a-f]{8}$/.test(props.homeId))
      throw new Error(`homeId must be 8 hex characters, not ${JSON.stringify(props.homeId)}`);
    if (!/^[0-9a-f]{8}$/.test(props.runId))
      throw new Error(`runId must be 8 hex characters, not ${JSON.stringify(props.runId)}`);
    this.random = props.randomHex ?? ((bytes) => randomBytes(bytes).toString('hex'));
  }

  exists(channel: string): boolean {
    return this.spaces.has(channel);
  }

  volumeOf(channel: string): string | undefined {
    return this.spaces.get(channel)?.volume;
  }

  private lockOf(channel: string): ChannelLock {
    let lock = this.locks.get(channel);
    if (lock === undefined) {
      lock = new ChannelLock();
      this.locks.set(channel, lock);
    }
    return lock;
  }

  // ------------------------------------------------------------------ creation (R10)

  async ensure(channel: string, image: string, fill?: SpaceFill): Promise<string> {
    if (!NAME_PATTERN.test(channel)) throw new Error(`ensure: ${JSON.stringify(channel)} is not a channel name`);
    const existing = this.spaces.get(channel);
    let creation = this.creating.get(channel);
    if (existing === undefined && creation === undefined) {
      creation = this.create(channel, image, fill).finally(() => this.creating.delete(channel));
      this.creating.set(channel, creation);
      return (await creation).volume;
    }
    const volume = existing?.volume ?? (await present(creation, 'creation')).volume;
    // A fill for a space another call made — already, or while this one waited — is never dropped: into it when it is
    // empty, else refused (R15; completion review, finding 2: dropped, the next checkpoint lost the saved files).
    if (fill !== undefined && !(await this.fillIfEmpty(channel, fill))) throw new SpaceHoldsFiles(channel);
    return volume;
  }

  /** R10's four steps under the lock; any failure removes what was made, logs files.space_create_failed and throws. */
  private async create(channel: string, image: string, fill: SpaceFill | undefined): Promise<Space> {
    const { runtime, logger, homeId, runId } = this.props;
    const volume = `asha-${homeId}-${runId}-${channel}`;
    const holder = `${volume}-files`;
    const label = this.random(16);
    const labels = { 'asha.home': homeId, 'asha.space': label };
    const lock = await this.lockOf(channel).acquire(SPACE_LOCK_WAIT_MS, this.stopping.signal);
    if (!lock.ok)
      return this.createFailed(new FileSpaceUnavailable(channel, 'lock', lockRefusal(lock.why)), {
        channel,
        volume,
        holder,
        made: 'nothing',
        step: 'lock',
      });
    let made: 'nothing' | 'volume' | 'holder' = 'nothing';
    let step = 'volume';
    try {
      await runtime.createVolume(volume, labels);
      // A create of a taken name succeeds and keeps the old labels (probe P5 (b)): only a label this creation drew proves it made the volume.
      step = 'volume_taken';
      const read = await runtime.volumeLabel(volume, 'asha.space');
      if (read !== label)
        throw new FileSpaceUnavailable(
          channel,
          'volume_taken',
          `volume ${volume} already existed (its asha.space label is not the one this creation drew); it is left for the reclaim`,
        );
      made = 'volume';
      step = 'holder';
      await runtime.createHolder({ name: holder, image, volume, labels });
      made = 'holder';
      step = fill === undefined ? 'root' : 'fill';
      const copied = await runtime.copyIn(
        holder,
        fill === undefined ? rootArchive(this.props.clock()) : fill.archive(),
      );
      if (copied.kind === 'timeout')
        throw new FileSpaceUnavailable(channel, step, 'docker cp did not finish within its bound');
      if (copied.code !== 0)
        throw new FileSpaceUnavailable(channel, step, `docker cp exited ${String(copied.code)}: ${copied.stderr}`);
      step = 'owner';
      const owner = await this.rootOwner(holder);
      const wantOwner = `${String(STATE_OWNER.uid)}:${String(STATE_OWNER.gid)}`;
      if (owner !== wantOwner)
        throw new FileSpaceUnavailable(
          channel,
          'owner',
          `the space's root is owned ${owner}, not ${wantOwner}: no agent could write it`,
        );
      const space: Space = {
        channel,
        volume,
        holder,
        image,
        table: [...(fill?.table ?? [])],
        unused: new Map(),
        unusedFolders: new Set(),
        returned: [],
        closing: new AbortController(),
      };
      this.spaces.set(channel, space);
      logger.info('files.space_created', { channel, volume });
      return space;
    } catch (error) {
      return await this.createFailed(error, { channel, volume, holder, made, step });
    } finally {
      lock.release();
    }
  }

  /**
   * create()'s catch, pulled out to keep that method's complexity down: what create() made is removed (a volume it
   * did not make — volume_taken — is left for the reclaim), the failure logged, and re-thrown as a
   * FileSpaceUnavailable (or rethrown as-is, already one). Always throws.
   */
  private async createFailed(
    error: unknown,
    props: {
      readonly channel: string;
      readonly volume: string;
      readonly holder: string;
      readonly made: 'nothing' | 'volume' | 'holder';
      readonly step: string;
    },
  ): Promise<never> {
    const { runtime, logger } = this.props;
    const { channel, volume, holder, made, step } = props;
    const cleanup: string[] = [];
    if (made === 'holder')
      await runtime.removeContainer(holder).catch((e: unknown) => cleanup.push(`holder: ${(e as Error).message}`));
    if (made !== 'nothing')
      await runtime.removeVolume(volume).catch((e: unknown) => cleanup.push(`volume: ${(e as Error).message}`));
    logger.error('files.space_create_failed', {
      channel,
      volume,
      step: error instanceof FileSpaceUnavailable ? error.step : step,
      error,
      cleanup,
    });
    if (error instanceof FileSpaceUnavailable) throw error;
    throw new FileSpaceUnavailable(channel, step, (error as Error).message, { cause: error });
  }

  /** R10 step 4: the root's owner, read from the first entry of a snapshot. */
  private async rootOwner(holder: string): Promise<string> {
    let header: Buffer = Buffer.alloc(0);
    const copied = await this.props.runtime.copyOut(holder, '/channel', (chunk) => {
      header = Buffer.concat([header, chunk]);
      return Promise.resolve(header.length >= 512 ? 'stop' : 'more');
    });
    if (!copied.ok) throw new Error(`reading the root back failed: ${copied.detail}`);
    if (header.length < 512) throw new Error('reading the root back gave no tar header');
    const octal = (o: number, l: number): number =>
      parseInt(trimTrailingPad(header.subarray(o, o + l).toString('latin1')).trim() || '0', 8);
    return `${String(octal(108, 8))}:${String(octal(116, 8))}`;
  }

  // ------------------------------------------------------------------ measurement (R11)

  async usage(channel: string): Promise<{ readonly bytes: number; readonly entries: number }> {
    const space = this.require(channel);
    const lock = await this.lockOf(channel).acquire(UPLOAD_LOCK_WAIT_MS, this.stopping.signal);
    if (!lock.ok) throw new Error(`the space of channel ${channel} was busy past ${String(UPLOAD_LOCK_WAIT_MS)} ms`);
    try {
      const measured = await this.measure(space, this.stopping.signal);
      if (!measured.ok) throw new Error(`measuring the space of channel ${channel} failed: ${measured.detail}`);
      return { bytes: measured.bytes, entries: measured.entries };
    } finally {
      lock.release();
    }
  }

  /** Every entry below the root (any kind, counted, never refused) and its regular files' bytes, and the top-level names. */
  private async measure(
    space: Space,
    signal?: AbortSignal,
  ): Promise<{ ok: true; entries: number; bytes: number; top: Set<string> } | { ok: false; detail: string }> {
    const counter = new SpaceCounter();
    const parser = new TarParser(counter);
    let failure: TarFormatFailure | undefined;
    const copied = await this.props.runtime.copyOut(
      space.holder,
      '/channel',
      async (chunk) => {
        failure = await parser.push(chunk);
        return failure === undefined ? 'more' : 'stop';
      },
      signal,
    );
    if (failure !== undefined) return { ok: false, detail: `${failure.entry}: ${failure.detail}` };
    if (!copied.ok) return { ok: false, detail: copied.detail };
    const end = parser.finish();
    if (end !== undefined) return { ok: false, detail: `${end.entry}: ${end.detail}` };
    return { ok: true, entries: counter.entries, bytes: counter.bytes, top: counter.top };
  }

  async fillIfEmpty(channel: string, fill: SpaceFill): Promise<boolean> {
    const space = this.require(channel);
    const lock = await this.lockOf(channel).acquire(SPACE_LOCK_WAIT_MS, this.stopping.signal);
    if (!lock.ok) {
      const detail = lockRefusal(lock.why);
      this.props.logger.error('files.space_create_failed', {
        channel,
        volume: space.volume,
        step: 'lock',
        error: new Error(detail),
        cleanup: [],
      });
      throw new FileSpaceUnavailable(channel, 'lock', detail);
    }
    try {
      const measured = await this.measure(space);
      if (!measured.ok) throw new Error(`measuring the space of channel ${channel} failed: ${measured.detail}`);
      if (measured.entries > 0) return false;
      let copied: DockerOutcome;
      try {
        copied = await this.props.runtime.copyIn(space.holder, fill.archive());
      } catch (error) {
        return await this.fillFailed(space, messageOf(error), error);
      }
      if (copied.kind === 'timeout') return await this.fillFailed(space, 'docker cp did not finish within its bound');
      if (copied.code !== 0)
        return await this.fillFailed(space, `docker cp exited ${String(copied.code)}: ${copied.stderr}`);
      space.table.splice(0, space.table.length, ...fill.table);
      return true;
    } finally {
      lock.release();
    }
  }

  /**
   * A failed fill, under the lock: the space was empty when it began, so whatever the copy extracted before it
   * failed is removed — nothing half-filled is left for an agent to read or a launch to refuse (R15) — and the
   * failure logged files.space_create_failed, `cleanup` naming an emptying that failed too. Always throws.
   */
  private async fillFailed(space: Space, detail: string, cause?: unknown): Promise<never> {
    const cleanup = await this.emptied(space);
    this.props.logger.error('files.space_create_failed', {
      channel: space.channel,
      volume: space.volume,
      step: 'fill',
      error: cause ?? new Error(detail),
      cleanup,
    });
    throw new FileSpaceUnavailable(space.channel, 'fill', detail, cause === undefined ? undefined : { cause });
  }

  /** Removes every entry under the space's root (a failed fill's undoing); what could not be removed, said. */
  private async emptied(space: Space): Promise<string[]> {
    let outcome: DockerOutcome;
    try {
      outcome = await this.props.runtime.emptySpace({ volume: space.volume, image: space.image }, this.stopping.signal);
    } catch (error) {
      return [`space: emptying it failed: ${messageOf(error)}`];
    }
    if (outcome.kind === 'timeout') return ['space: emptying it did not finish within its bound'];
    if (outcome.code !== 0) return [`space: emptying it exited ${String(outcome.code)}: ${outcome.stderr}`];
    return [];
  }

  // ------------------------------------------------------------------ uploads (R3a)

  async upload(props: {
    readonly channel: string;
    readonly user: string;
    readonly body: AsyncIterable<Uint8Array>;
  }): Promise<UploadResult> {
    const { channel } = props;
    const refuse = (reason: UploadRefusal, detail: string, name?: string): UploadResult => {
      this.props.logger.error('files.refused', { channel, reason, name: name ?? null, error: new Error(detail) });
      return { ok: false, reason, status: UPLOAD_REFUSALS[reason], detail };
    };
    if (this.stopping.signal.aborted) return refuse('stopping', 'the daemon is stopping');
    // asha's own secrets, read once, when the upload starts (R8b).
    const secrets = this.props.ownSecrets();
    const body = new BodyReader(props.body);
    // From here the body is being read: a refusal comes with its drain (R8b).
    const refuseRead = (reason: UploadRefusal, detail: string, name?: string): UploadResult => {
      const refused = refuse(reason, detail, name);
      if (refused.ok) throw new Error('a refusal is never ok');
      return { ...refused, drain: (closed) => this.drain(channel, refused.status, body, closed) };
    };
    const manifest = await readManifest(body);
    if (!manifest.ok) return refuseRead(manifest.reason, manifest.detail, manifest.name);
    const space = this.spaces.get(channel);
    if (space === undefined)
      return refuseRead(
        'no_space',
        `channel ${channel} has no file space in this daemon run: make it ready first (POST /v1/channel/space)`,
      );
    if (space.unused.size >= MAX_UNUSED_UPLOADS)
      return refuseRead(
        'too_many_uploads',
        `channel ${channel} holds ${String(MAX_UNUSED_UPLOADS)} uploads no message has used`,
      );
    const end = this.endOf(space);
    const lock = await this.lockOf(channel).acquire(UPLOAD_LOCK_WAIT_MS, end);
    if (!lock.ok)
      return lock.why === 'timeout'
        ? refuseRead('space_busy', `the space of channel ${channel} was busy for ${String(UPLOAD_LOCK_WAIT_MS)} ms`)
        : refuseRead('stopping', this.endedWhy(space));
    try {
      return await this.uploadLocked(space, props.user, manifest.files, body, refuseRead, secrets, end);
    } finally {
      lock.release();
    }
  }

  /**
   * R8b's drain of a refused upload's body, after its refusal is answered: read and discarded through the upload's
   * reader until the body ends (`ended`), reading fails (`hung_up`, or `closed` once the daemon stops), no byte comes
   * for UPLOAD_STALL_MS (`stalled`), the body read in all passes DRAIN_MAX_BYTES (`over_bound`), or DRAIN_MAX_MS pass
   * (`over_time`); logged `files.body_drained` — `info` when it ended, else `warn`. It holds no channel lock.
   */
  private async drain(channel: string, status: number, body: BodyReader, closed: Promise<void>): Promise<DrainOutcome> {
    const { outcome, bytes } = await body.drain({
      maxTotal: DRAIN_MAX_BYTES,
      maxMs: DRAIN_MAX_MS,
      stopping: () => this.stopping.signal.aborted,
      closed,
    });
    const fields = { channel, status, bytes, outcome };
    if (outcome === 'ended') this.props.logger.info('files.body_drained', fields);
    else this.props.logger.warn('files.body_drained', fields);
    return outcome;
  }

  private async uploadLocked(
    space: Space,
    user: string,
    files: readonly UploadManifestEntry[],
    body: BodyReader,
    refuse: (reason: UploadRefusal, detail: string, name?: string) => UploadResult,
    secrets: readonly OwnSecret[],
    stop: AbortSignal,
  ): Promise<UploadResult> {
    const { channel, volume } = space;
    // Checked again under the lock: uploads that passed the early check together cannot pass the bound (R3a).
    if (space.unused.size >= MAX_UNUSED_UPLOADS)
      return refuse(
        'too_many_uploads',
        `channel ${channel} holds ${String(MAX_UNUSED_UPLOADS)} uploads no message has used`,
      );
    let measured;
    try {
      measured = await this.measure(space, stop);
    } catch (error) {
      if (stop.aborted) return refuse('stopping', this.endedWhy(space));
      throw error;
    }
    if (!measured.ok) return refuse('measure_failed', `measuring the space failed: ${measured.detail}`);
    // The upload's folder counts as one entry beside its files (R11).
    const entries = measured.entries + 1 + files.length;
    if (entries > SPACE_MAX_ENTRIES)
      return refuse(
        'space_entries',
        `the space would hold ${String(entries)} entries, over its bound of ${String(SPACE_MAX_ENTRIES)}`,
      );
    const bytes = measured.bytes + files.reduce((n, f) => n + f.size, 0);
    if (bytes > SPACE_MAX_BYTES)
      return refuse(
        'space_bytes',
        `the space would hold ${String(bytes)} bytes, over its bound of ${String(SPACE_MAX_BYTES)}`,
      );
    let folder = `upload-${this.random(8)}`;
    while (measured.top.has(folder)) folder = `upload-${this.random(8)}`;
    const names = uniqueNames(files.map((f) => f.name));
    const mtime = Math.floor(this.props.clock().getTime() / 1_000);
    const scan = new SecretScan(secrets);
    const box: { failure: UploadFailure | undefined } = { failure: undefined };
    let copied: DockerOutcome;
    try {
      copied = await this.props.runtime.copyIn(
        space.holder,
        buildUploadArchive({ folder, mtime, files, names, body, scan, box }),
        stop,
      );
    } catch (error) {
      return await this.copyRejected(space, folder, error, stop, refuse);
    }
    if (box.failure === undefined && copied.kind === 'exited' && copied.code === 0) {
      return { ok: true, answer: this.record(space, user, folder, files, names) };
    }
    space.unusedFolders.add(folder);
    // Computed whether or not the rollback below succeeds, so files.copy_failed is logged either way, exactly as
    // when this was inline (the rollback's own outcome only decides which refusal is returned, next).
    const answer = this.uploadCopyFailure({ channel, volume, folder, failure: box.failure, copied });
    const rolledBack = await this.rollback(space, folder);
    return rolledBack
      ? refuse(...answer)
      : refuse('rollback_failed', `the failed copy's folder ${folder} could not be removed`);
  }

  /**
   * uploadLocked's answer when the copy rejected, pulled out to keep that method's complexity down. The stop killed
   * it: no rollback (the reclaim removes the volume; a persisted snapshot leaves the folder out). Any other
   * rejection — a signal asha did not send, the client failing — may have extracted part of the folder: logged
   * files.copy_failed and rolled back, as a copy that exited non-zero is (R3a).
   */
  private async copyRejected(
    space: Space,
    folder: string,
    error: unknown,
    stop: AbortSignal,
    refuse: (reason: UploadRefusal, detail: string, name?: string) => UploadResult,
  ): Promise<UploadResult> {
    space.unusedFolders.add(folder);
    if (stop.aborted) return refuse('stopping', `${this.endedWhy(space)}; the copy was killed`);
    const { channel, volume } = space;
    this.props.logger.error('files.copy_failed', { channel, volume, folder, reason: 'error', error });
    return (await this.rollback(space, folder))
      ? refuse('copy_failed', `the copy into the space failed: ${messageOf(error)}`)
      : refuse('rollback_failed', `the failed copy's folder ${folder} could not be removed`);
  }

  /**
   * uploadLocked's own translation of the archive's or the copy's failure into a refusal, pulled out to keep that
   * method's complexity down; `refuse`'s own arguments, in order.
   */
  private uploadCopyFailure(props: {
    readonly channel: string;
    readonly volume: string;
    readonly folder: string;
    readonly failure: UploadFailure | undefined;
    readonly copied: DockerOutcome;
  }): readonly [reason: UploadRefusal, detail: string, name?: string] {
    const { channel, volume, folder, failure, copied } = props;
    if (failure !== undefined) return [failure.reason, failure.detail, failure.name];
    if (copied.kind === 'timeout') {
      this.props.logger.error('files.copy_failed', {
        channel,
        volume,
        folder,
        reason: 'timeout',
        error: new Error('docker cp did not finish within its bound, and was killed'),
      });
      return ['copy_timeout', 'the copy into the space did not finish within its bound'];
    }
    this.props.logger.error('files.copy_failed', {
      channel,
      volume,
      folder,
      reason: 'exit',
      error: new Error(`docker cp exited ${String(copied.code)}: ${copied.stderr}`),
    });
    return ['copy_failed', `the copy into the space failed: docker cp exited ${String(copied.code)}`];
  }

  /** A successful upload: its id, its file-table records, its expiry. */
  private record(
    space: Space,
    user: string,
    folder: string,
    files: readonly UploadManifestEntry[],
    names: readonly string[],
  ): UploadResponse {
    const id = this.random(16);
    const time = this.props.clock().toISOString();
    const attachments = files.map((f, i): Attachment => {
      const name = present(names[i], `names[${String(i)}]`);
      return { path: `/channel/${folder}/${name}`, size: f.size, sha256: f.sha256 };
    });
    for (const a of attachments) space.table.push({ path: a.path, size: a.size, sha256: a.sha256, user, time });
    if (space.table.length > MAX_RECORDS) space.table.splice(0, space.table.length - MAX_RECORDS);
    const upload: Upload = { id, folder, attachments, user, timer: undefined, claimed: false };
    upload.timer = setTimeout(() => void this.expire(space, upload), UPLOAD_UNUSED_MS);
    space.unused.set(id, upload);
    space.unusedFolders.add(folder);
    return {
      upload: id,
      files: attachments.map((a, i) => ({
        name: present(names[i], `names[${String(i)}]`),
        path: a.path,
        size: a.size,
        sha256: a.sha256,
      })),
    };
  }

  /**
   * Removes an upload's folder, as root, by R3a's one-shot, under the lock the caller holds. True when nothing of it
   * is left; a failure is logged files.rollback_failed and never retried. The stop kills a running one.
   */
  private async rollback(space: Space, folder: string): Promise<boolean> {
    let outcome: DockerOutcome;
    const end = this.endOf(space);
    try {
      outcome = await this.props.runtime.rollback({ volume: space.volume, image: space.image, folder }, end);
    } catch (error) {
      if (!end.aborted) {
        // A client that failed or was killed by another's signal: the folder may be left, and is named (R14).
        this.props.logger.error('files.rollback_failed', {
          channel: space.channel,
          volume: space.volume,
          folder,
          error,
        });
        return false;
      }
      this.props.logger.warn('files.rollback_abandoned', { channel: space.channel, volume: space.volume, folder });
      return false;
    }
    if (outcome.kind === 'exited' && outcome.code === 0) return true;
    const detail =
      outcome.kind === 'timeout'
        ? 'the rollback did not finish within its bound, and was killed'
        : `the rollback exited ${String(outcome.code)}: ${outcome.stderr}`;
    this.props.logger.error('files.rollback_failed', {
      channel: space.channel,
      volume: space.volume,
      folder,
      error: new Error(detail),
    });
    return false;
  }

  /** An unused upload rolled back — expired, or its conversation refused — and its records dropped (R3a). */
  private async discard(space: Space, upload: Upload, why: 'expired' | 'refused'): Promise<void> {
    clearTimeout(upload.timer);
    space.unused.delete(upload.id);
    const paths = new Set(upload.attachments.map((a) => a.path));
    for (let i = space.table.length - 1; i >= 0; i -= 1)
      if (paths.has(present(space.table[i], `space.table[${String(i)}]`).path)) space.table.splice(i, 1);
    const end = this.endOf(space);
    if (end.aborted) return;
    const lock = await this.lockOf(space.channel).acquire(UPLOAD_LOCK_WAIT_MS, end);
    if (!lock.ok) {
      if (lock.why === 'timeout')
        this.props.logger.error('files.rollback_failed', {
          channel: space.channel,
          volume: space.volume,
          folder: upload.folder,
          error: new Error(`the lock was busy past ${String(UPLOAD_LOCK_WAIT_MS)} ms`),
        });
      return;
    }
    try {
      if (await this.rollback(space, upload.folder))
        this.props.logger.info('files.upload_rolled_back', { channel: space.channel, folder: upload.folder, why });
    } finally {
      lock.release();
    }
  }

  private expire(space: Space, upload: Upload): Promise<void> {
    return this.background(this.discard(space, upload, 'expired'));
  }

  /** Background work (an expiry's or a refused conversation's rollback): its failure is logged, never thrown away. */
  private background(work: Promise<void>): Promise<void> {
    return work.catch((error: unknown) => {
      this.props.logger.error('files.rollback_failed', { error });
    });
  }

  claim(channel: string, upload: string): Claimed {
    for (const space of this.spaces.values()) {
      const found = space.unused.get(upload);
      if (found === undefined) continue;
      if (space.channel !== channel)
        return { ok: false, detail: `attachments ${upload} was uploaded to another channel` };
      if (found.claimed) return { ok: false, detail: `attachments ${upload} is already used` };
      found.claimed = true;
      // Claimed, its conversation decides its fate — used() or refused() — however long bringing an agent online
      // takes (a first model download can pass 600 s): the expiry is only for an upload no conversation named.
      clearTimeout(found.timer);
      return { ok: true, attachments: found.attachments };
    }
    return { ok: false, detail: `attachments ${upload} is unknown, expired or already used` };
  }

  used(channel: string, upload: string, props: { readonly user: string; readonly agents: readonly string[] }): void {
    const space = this.require(channel);
    const found = space.unused.get(upload);
    if (found === undefined || !found.claimed)
      throw new Error(`used: upload ${upload} was not claimed on channel ${channel}`);
    clearTimeout(found.timer);
    space.unused.delete(upload);
    space.unusedFolders.delete(found.folder);
    for (const a of found.attachments) {
      this.props.logger.info('files.attached', {
        user: props.user,
        channel,
        agents: [...props.agents],
        name: present(a.path.split('/').at(-1), `${a.path}.split('/').at(-1)`),
        size: a.size,
        sha256: a.sha256,
      });
    }
  }

  refused(channel: string, upload: string): void {
    const space = this.require(channel);
    const found = space.unused.get(upload);
    if (found === undefined) return;
    void this.background(this.discard(space, found, 'refused'));
  }

  // ------------------------------------------------------------------ returns (R12, R12a)

  async returnFiles(props: {
    readonly channel: string;
    readonly conversation: string;
    readonly user: string;
    readonly handle: string;
    readonly paths: readonly string[];
  }): Promise<ReturnResult> {
    const { channel } = props;
    const refuse = (file: string, rule: string): ReturnResult => {
      this.props.logger.error('files.refused', {
        channel,
        reason: 'file_refused',
        name: file.split('/').at(-1) ?? file,
        error: new Error(rule),
      });
      return { ok: false, file, rule };
    };
    const space = this.spaces.get(channel);
    if (space === undefined) return refuse(props.paths[0] ?? '', `channel ${channel} has no file space`);
    if (this.stopping.signal.aborted) return refuse(props.paths[0] ?? '', 'the daemon is stopping');
    if (props.paths.length < 1 || props.paths.length > MAX_FILES_PER_MESSAGE)
      return refuse(
        props.paths[0] ?? '',
        `a reply returns 1 to ${String(MAX_FILES_PER_MESSAGE)} files, not ${String(props.paths.length)}`,
      );
    const sources: ReturnSource[] = [];
    for (const path of props.paths) {
      const source = returnSource(path);
      if (typeof source === 'string') return refuse(path, source);
      sources.push(source);
    }
    // At most 20 s for the whole answer: the lock's 10 s, then every copy (R12).
    const deadline = withTimeout(RETURN_ANSWER_MS, this.stopping.signal);
    const lock = await this.lockOf(channel).acquire(RETURN_LOCK_WAIT_MS, deadline);
    if (!lock.ok) return refuse(present(props.paths[0], 'props.paths[0]'), this.lockRefusalDetail(lock.why));
    const checked: { source: ReturnSource; size: number; sha256: string }[] = [];
    try {
      for (const [i, source] of sources.entries()) {
        const read = await this.readOut(space, source, () => Promise.resolve(), deadline);
        if (!read.ok) return refuse(present(props.paths[i], `props.paths[${String(i)}]`), read.rule);
        checked.push({ source, size: read.size, sha256: read.sha256 });
      }
    } finally {
      lock.release();
    }
    const files = checked.map(({ source, size, sha256 }): ReturnedFile => {
      const record: ReturnedRecord = {
        id: this.random(16),
        name: source.name,
        size,
        sha256,
        channel,
        conversation: props.conversation,
        source,
      };
      space.returned.push(record);
      this.returnedById.set(record.id, record);
      if (space.returned.length > MAX_RECORDS)
        for (const old of space.returned.splice(0, space.returned.length - MAX_RECORDS))
          this.returnedById.delete(old.id);
      this.props.logger.info('files.returned', {
        user: props.user,
        channel,
        handle: props.handle,
        name: source.name,
        size,
        sha256,
      });
      return { id: record.id, name: source.name, size, sha256 };
    });
    return { ok: true, files };
  }

  async download(id: string, sink: DownloadSink, signal?: AbortSignal): Promise<DownloadResult> {
    const record = /^[0-9a-f]{32}$/.test(id) ? this.returnedById.get(id) : undefined;
    if (record === undefined) return { ok: false, reason: 'unknown', rule: `no returned file ${id}` };
    const space = this.spaces.get(record.channel);
    if (space === undefined) return { ok: false, reason: 'unknown', rule: `no returned file ${id}` };
    const refuse = (rule: string): DownloadResult => {
      this.props.logger.error('files.refused', {
        channel: record.channel,
        reason: 'download_refused',
        name: record.name,
        error: new Error(rule),
      });
      return { ok: false, reason: 'refused', rule };
    };
    // A file whose size differs from the record's is refused at its entry, before begin (R12a: nothing is sent past
    // the reply's length). Every byte but the last is written as it passes; the last only once the sha256 is the
    // record's too, so a file changed since the reply, at the same size, arrives one byte short.
    let held: Buffer | undefined;
    let begun = false;
    const read = await this.readOut(
      space,
      record.source,
      async (chunk) => {
        if (!begun) {
          begun = true;
          sink.begin({ name: record.name, size: record.size });
        }
        const all = held === undefined ? chunk : Buffer.concat([held, chunk]);
        if (all.length === 0) return;
        held = all.subarray(all.length - 1);
        await sink.write(all.subarray(0, all.length - 1));
      },
      AbortSignal.any([this.stopping.signal, ...(signal === undefined ? [] : [signal])]),
      () => {
        if (!begun) {
          begun = true;
          sink.begin({ name: record.name, size: record.size });
        }
      },
      record.size,
    );
    if (!read.ok) return refuse(read.rule);
    if (read.size !== record.size || read.sha256 !== record.sha256)
      return refuse(`the file changed since the reply: ${String(read.size)} bytes, sha256 ${read.sha256}`);
    if (held !== undefined) await sink.write(held);
    return { ok: true };
  }

  /**
   * Copies a returned file out of the space (R12): `docker cp <holder>:/channel/<name> -`, never following a link, or
   * for an attachment `docker cp <holder>:/channel/<folder> -`; accepted only as one regular file of at most
   * 25,000,000 bytes (the folder's other entries read past through the same entry rules). Its data goes to `onData`.
   */
  private async readOut(
    space: Space,
    source: ReturnSource,
    onData: (chunk: Buffer) => Promise<void>,
    signal: AbortSignal,
    onFile?: () => void,
    expectSize?: number,
  ): Promise<{ ok: true; size: number; sha256: string } | { ok: false; rule: string }> {
    const reader = new ReturnReader(source, onData, onFile, expectSize);
    const parser = new TarParser(reader);
    let failure: TarFormatFailure | undefined;
    let copied;
    try {
      copied = await this.props.runtime.copyOut(
        space.holder,
        source.folder === undefined ? `/channel/${source.name}` : `/channel/${source.folder}`,
        async (chunk) => {
          failure = await parser.push(chunk);
          return failure === undefined ? 'more' : 'stop';
        },
        signal,
      );
    } catch (error) {
      if (signal.aborted)
        return {
          ok: false,
          rule: this.stopping.signal.aborted
            ? 'the daemon is stopping'
            : `no answer within ${String(RETURN_ANSWER_MS)} ms`,
        };
      throw error;
    }
    if (failure !== undefined) return { ok: false, rule: `${failure.entry}: ${failure.detail}` };
    if (!copied.ok)
      return {
        ok: false,
        rule: /No such container|Could not find the file|no such file/i.test(copied.detail)
          ? 'no such file in the space'
          : copied.detail,
      };
    const end = parser.finish();
    if (end !== undefined) return { ok: false, rule: `${end.entry}: ${end.detail}` };
    return reader.result();
  }

  // ------------------------------------------------------------------ persistence (R15), the table (R6), the stop

  table(channel: string): readonly FileTableRecord[] {
    return [...(this.spaces.get(channel)?.table ?? [])];
  }

  async snapshot(
    channel: string,
    start: (taken: SnapshotPlan) => (chunk: Buffer) => Promise<'more' | 'stop'>,
    signal: AbortSignal,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
    const space = this.require(channel);
    const lock = await this.lockOf(channel).acquire(undefined, signal);
    if (!lock.ok) return { ok: false, detail: 'the checkpoint ended before the space was free' };
    try {
      const unused = new Set(space.unusedFolders);
      const skip = (name: string): boolean => {
        const parts = name.split('/');
        return parts.length >= 2 && unused.has(present(parts[1], 'parts[1], since parts.length >= 2'));
      };
      const table = space.table.filter((r) => !unused.has(r.path.split('/')[2] ?? ''));
      const push = start({ skip, table });
      const copied = await this.props.runtime.copyOut(space.holder, '/channel', push, signal);
      return copied.ok ? { ok: true } : { ok: false, detail: copied.detail };
    } finally {
      lock.release();
    }
  }

  async readForPlugin(
    channel: string,
    rel: string,
    onChunk: (chunk: Buffer) => Promise<'more' | 'stop'>,
    signal: AbortSignal,
  ): Promise<CopyOutcome> {
    const space = this.spaces.get(channel);
    if (space === undefined) return { ok: false, detail: `channel ${channel} has no file space` };
    const both = AbortSignal.any([signal, this.stopping.signal]);
    const lock = await this.lockOf(channel).acquire(RETURN_LOCK_WAIT_MS, both);
    if (!lock.ok)
      return {
        ok: false,
        detail:
          lock.why === 'timeout'
            ? `the space was busy for ${String(RETURN_LOCK_WAIT_MS)} ms`
            : 'the call ended before the space was free',
      };
    try {
      return await this.props.runtime.copyOut(space.holder, rel === '' ? '/channel' : `/channel/${rel}`, onChunk, both);
    } finally {
      lock.release();
    }
  }

  async writeFromPlugin(
    channel: string,
    adds: { readonly entries: number; readonly bytes: number },
    archive: () => AsyncIterable<Uint8Array>,
    signal: AbortSignal,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: 'space_full' | 'failed'; readonly detail: string }
  > {
    const space = this.spaces.get(channel);
    if (space === undefined) return { ok: false, reason: 'failed', detail: `channel ${channel} has no file space` };
    const both = AbortSignal.any([signal, this.stopping.signal]);
    const lock = await this.lockOf(channel).acquire(UPLOAD_LOCK_WAIT_MS, both);
    if (!lock.ok)
      return {
        ok: false,
        reason: 'failed',
        detail:
          lock.why === 'timeout'
            ? `the space was busy for ${String(UPLOAD_LOCK_WAIT_MS)} ms`
            : 'the call ended before the space was free',
      };
    try {
      const measured = await this.measure(space, both);
      if (!measured.ok)
        return { ok: false, reason: 'failed', detail: `measuring the space failed: ${measured.detail}` };
      if (measured.entries + adds.entries > SPACE_MAX_ENTRIES)
        return {
          ok: false,
          reason: 'space_full',
          detail: `the space would hold ${String(measured.entries + adds.entries)} entries, over its bound of ${String(SPACE_MAX_ENTRIES)}`,
        };
      if (measured.bytes + adds.bytes > SPACE_MAX_BYTES)
        return {
          ok: false,
          reason: 'space_full',
          detail: `the space would hold ${String(measured.bytes + adds.bytes)} bytes, over its bound of ${String(SPACE_MAX_BYTES)}`,
        };
      const copied = await this.props.runtime.copyIn(space.holder, archive(), both);
      if (copied.kind === 'timeout')
        return { ok: false, reason: 'failed', detail: 'the copy into the space did not finish within its bound' };
      if (copied.code !== 0)
        return {
          ok: false,
          reason: 'failed',
          detail: `the copy into the space failed: docker cp exited ${String(copied.code)}: ${copied.stderr}`,
        };
      return { ok: true };
    } finally {
      lock.release();
    }
  }

  async remove(channel: string): Promise<void> {
    const space = this.require(channel);
    const { runtime, logger } = this.props;
    // Its upload in flight is killed, and a new one refused, before the lock is awaited.
    space.closing.abort(new Error(`channel ${channel} is stopping`));
    // Bounded by time alone: the daemon's own stop removes each channel's space after stop() (the channel stops).
    const lock = await this.lockOf(channel).acquire(SPACE_LOCK_WAIT_MS);
    if (!lock.ok) {
      const detail = lockRefusal(lock.why);
      logger.error('files.space_remove_failed', { channel, volume: space.volume, error: new Error(detail) });
      throw new FileSpaceRemoveFailed(channel, detail);
    }
    try {
      for (const upload of space.unused.values()) clearTimeout(upload.timer);
      this.spaces.delete(channel);
      for (const [id, record] of this.returnedById) if (record.channel === channel) this.returnedById.delete(id);
      await runtime.removeContainer(space.holder);
      await runtime.removeVolume(space.volume);
      logger.info('files.space_removed', { channel, volume: space.volume });
    } catch (error) {
      // What is left carries the home's label: the daemon's reclaim at its stop or next start removes it (R10a).
      logger.error('files.space_remove_failed', { channel, volume: space.volume, error });
      throw new FileSpaceRemoveFailed(channel, (error as Error).message, { cause: error });
    } finally {
      lock.release();
    }
  }

  stop(): void {
    if (this.stopping.signal.aborted) return;
    this.stopping.abort(new Error('the daemon is stopping'));
    for (const space of this.spaces.values()) for (const upload of space.unused.values()) clearTimeout(upload.timer);
  }

  /** What ends an operation on a space: the daemon's stop, or the space's removal (portal-demo-stop R2). */
  private endOf(space: Space): AbortSignal {
    return AbortSignal.any([this.stopping.signal, space.closing.signal]);
  }

  /** Why an operation on a space was ended, for its refusal. */
  private endedWhy(space: Space): string {
    return this.stopping.signal.aborted ? 'the daemon is stopping' : `channel ${space.channel} is stopping`;
  }

  /**
   * Why returnFiles's lock acquire was not granted (R12): the lock's own wait passed, or the signal it was given
   * (bounded by RETURN_ANSWER_MS, and by this.stopping — withTimeout's "others") ended, for either of its two
   * reasons. A plain `if` here, not a nested ternary (sonarjs/no-nested-conditional); a method, not the same
   * `this.stopping.signal.aborted` expression returnFiles's own earlier check already narrowed to `false` for the
   * rest of its body — TypeScript does not re-check a mutable property across the `await` in between, so that
   * expression reads as permanently false there even though the signal can abort while the lock is awaited.
   */
  private lockRefusalDetail(why: 'timeout' | 'aborted'): string {
    if (why === 'timeout') return `the space was busy for ${String(RETURN_LOCK_WAIT_MS)} ms`;
    if (this.stopping.signal.aborted) return 'the daemon is stopping';
    return `no answer within ${String(RETURN_ANSWER_MS)} ms`;
  }

  private require(channel: string): Space {
    const space = this.spaces.get(channel);
    if (space === undefined) throw new Error(`channel ${channel} has no file space`);
    return space;
  }
}

/**
 * A fresh space's root: one `channel/` directory owned 1000:1000, mode 0755 (R10 step 3), and the end blocks.
 * Not a generator (it never awaits anything, @typescript-eslint/require-await): its own AsyncIterator, whose
 * `next()` returns the header, then the end blocks, then ends — the same two values a generator would yield.
 */
function rootArchive(now: Date): AsyncIterable<Uint8Array> {
  const header = tarEntryHeader('channel', 'directory', 0, Math.floor(now.getTime() / 1_000));
  const trailer = Buffer.alloc(1024);
  let step: 0 | 1 | 2 = 0;
  return {
    [Symbol.asyncIterator]: () => ({
      next: (): Promise<IteratorResult<Uint8Array>> => {
        if (step === 0) {
          step = 1;
          return Promise.resolve({ done: false, value: header });
        }
        if (step === 1) {
          step = 2;
          return Promise.resolve({ done: false, value: trailer });
        }
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  };
}

/** returnSource's own result, kept to one return shape (sonarjs/function-return-type); unwrapped below. */
type ReturnSourceOutcome =
  { readonly ok: true; readonly value: ReturnSource } | { readonly ok: false; readonly rule: string };

function returnSourceOutcome(path: string): ReturnSourceOutcome {
  const parts = path.split('/');
  if (parts[0] !== '' || parts[1] !== 'channel') return { ok: false, rule: 'not a path in /channel' };
  if (parts.length === 3) {
    const name = present(parts[2], 'parts[2], since parts.length === 3');
    const problem = fileNameProblem(name, { returned: true });
    return problem === undefined ? { ok: true, value: { name } } : { ok: false, rule: `${problem}, or a folder` };
  }
  if (parts.length === 4) {
    const folder = present(parts[2], 'parts[2], since parts.length === 4');
    if (!UPLOAD_FOLDER_PATTERN.test(folder))
      return { ok: false, rule: "a file in a folder that is not an upload's (/channel/upload-<16 hex>/<name>)" };
    const name = present(parts[3], 'parts[3], since parts.length === 4');
    const problem = fileNameProblem(name, { returned: true });
    return problem === undefined ? { ok: true, value: { name, folder } } : { ok: false, rule: problem };
  }
  return { ok: false, rule: 'a path more than one folder deep' };
}

/** Where a returned path lies (R12), or the rule it breaks. */
function returnSource(path: string): ReturnSource | string {
  const outcome = returnSourceOutcome(path);
  return outcome.ok ? outcome.value : outcome.rule;
}

/** Counts a snapshot of /channel for the bounds (R11): every entry but the root, any kind; regular files' bytes. */
class SpaceCounter implements TarReader {
  entries = 0;
  bytes = 0;
  readonly top = new Set<string>();

  entry(header: TarHeader): Promise<TarFormatFailure | undefined> {
    const name = header.name.replace(/\/$/, '');
    const parts = name.split('/');
    if (parts[0] !== 'channel' || parts.some((p) => p === '' || p === '.' || p === '..'))
      return Promise.resolve({ entry: header.name, detail: 'not under channel/' });
    if (parts.length === 1) return Promise.resolve(undefined);
    this.entries += 1;
    if (header.type === '0' || header.type === '\0') this.bytes += header.size;
    if (parts.length === 2) this.top.add(present(parts[1], 'parts[1], since parts.length === 2'));
    return Promise.resolve(undefined);
  }

  data(): Promise<void> {
    return Promise.resolve();
  }

  entryEnd(): Promise<undefined> {
    return Promise.resolve(undefined);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Reads a returned file's copy-out (R12): exactly one regular file named `<name>` — or, for an attachment, the folder's
 * directory entry first and `<folder>/<name>` as a regular file among its entries — of at most 25,000,000 bytes; a
 * link, a hard link, a special file, a missing file or a second file is refused by TarNormaliser's entry rules.
 */
class ReturnReader implements TarReader {
  private found: { size: number; hash: ReturnType<typeof createHash> } | undefined;
  private inFile = false;
  private entries = 0;
  private done: { size: number; sha256: string } | undefined;

  constructor(
    private readonly source: ReturnSource,
    private readonly onData: (chunk: Buffer) => Promise<void>,
    private readonly onFile: (() => void) | undefined,
    /** The size the file must have (a download's record, R12a): any other is refused at its entry, before onFile. */
    private readonly expectSize?: number,
  ) {}

  /**
   * entry()'s own decision of what this entry is for the source it reads (folder-less, or an attachment's folder
   * and its one file within it), pulled out to keep that method's complexity down: an error naming the rule it
   * breaks, a non-matching entry to skip (read past, not recorded), or the one entry to record as found.
   */
  private entryPlacement(
    name: string,
    regular: boolean,
    header: TarHeader,
  ):
    | { readonly kind: 'error'; readonly failure: TarFormatFailure }
    | { readonly kind: 'skip' }
    | { readonly kind: 'record' } {
    if (this.source.folder === undefined) {
      if (this.entries > 1) return { kind: 'error', failure: { entry: name, detail: 'more than one entry' } };
      if (!regular || name !== this.source.name)
        return { kind: 'error', failure: { entry: name, detail: 'not a regular file' } };
      return { kind: 'record' };
    }
    if (this.entries === 1) {
      if (name === this.source.folder && header.type === '5') return { kind: 'skip' };
      return { kind: 'error', failure: { entry: name, detail: "the upload's folder is not a folder" } };
    }
    if (!regular || name !== `${this.source.folder}/${this.source.name}`) return { kind: 'skip' };
    if (this.found !== undefined)
      return { kind: 'error', failure: { entry: name, detail: 'more than one entry of that name' } };
    return { kind: 'record' };
  }

  entry(header: TarHeader): Promise<TarFormatFailure | undefined> {
    this.entries += 1;
    const name = header.name.replace(/\/$/, '');
    const regular = header.type === '0' || header.type === '\0';
    if (!regular && header.type !== '5')
      return Promise.resolve({ entry: name, detail: 'a link, a hard link or a special file is never returned' });
    const placement = this.entryPlacement(name, regular, header);
    if (placement.kind === 'error') return Promise.resolve(placement.failure);
    if (placement.kind === 'skip') return Promise.resolve(undefined);
    if (header.size > MAX_ATTACHMENT_BYTES)
      return Promise.resolve({ entry: name, detail: `over ${String(MAX_ATTACHMENT_BYTES)} bytes` });
    if (this.expectSize !== undefined && header.size !== this.expectSize)
      return Promise.resolve({
        entry: name,
        detail: `the file changed since the reply: ${String(header.size)} bytes, not ${String(this.expectSize)}`,
      });
    this.found = { size: header.size, hash: createHash('sha256') };
    this.inFile = true;
    this.onFile?.();
    return Promise.resolve(undefined);
  }

  async data(chunk: Buffer): Promise<void> {
    if (!this.inFile || this.found === undefined) return;
    this.found.hash.update(chunk);
    await this.onData(chunk);
  }

  entryEnd(): Promise<undefined> {
    if (this.inFile && this.found !== undefined)
      this.done = { size: this.found.size, sha256: this.found.hash.digest('hex') };
    this.inFile = false;
    return Promise.resolve(undefined);
  }

  end(): Promise<void> {
    return Promise.resolve();
  }

  result(): { ok: true; size: number; sha256: string } | { ok: false; rule: string } {
    return this.done === undefined ? { ok: false, rule: 'no such file in the space' } : { ok: true, ...this.done };
  }
}

/**
 * R8b's scan of one upload's files for asha's own secrets. Per file: the last `h` bytes received so far are held back
 * — `h` the longest value's length less one — and searched with each new chunk for each value before any byte of the
 * chunk passes on; all but the last `h` bytes then pass. So a value split across chunks is found, and no byte of an
 * occurrence passes. It adds no await, timer or file read, and makes no copy of a value but the bytes it searches for.
 */
export class SecretScan {
  private readonly needles: readonly { readonly which: string; readonly bytes: Buffer }[];
  private readonly hold: number;

  constructor(secrets: readonly OwnSecret[]) {
    this.needles = secrets.map((s) => ({ which: s.which, bytes: Buffer.from(s.value, 'utf8') }));
    this.hold = this.needles.reduce((n, s) => Math.max(n, s.bytes.byteLength - 1), 0);
  }

  /** A fresh search for one file: `push` each chunk (the bytes to pass on, or the secret found), then `end`. */
  file(): { push(chunk: Buffer): Buffer | string; end(): Buffer } {
    let held: Buffer = Buffer.alloc(0);
    const { needles, hold } = this;
    // push()'s own result, kept to one return shape (sonarjs/function-return-type); unwrapped in push() below.
    const pushOutcome = (
      window: Buffer,
    ): { readonly kind: 'found'; readonly which: string } | { readonly kind: 'passed'; readonly bytes: Buffer } => {
      for (const needle of needles)
        if (window.indexOf(needle.bytes) >= 0) return { kind: 'found', which: needle.which };
      if (window.byteLength <= hold) {
        held = Buffer.from(window);
        return { kind: 'passed', bytes: Buffer.alloc(0) };
      }
      held = Buffer.from(window.subarray(window.byteLength - hold));
      return { kind: 'passed', bytes: window.subarray(0, window.byteLength - hold) };
    };
    return {
      push: (chunk) => {
        const window = held.byteLength === 0 ? chunk : Buffer.concat([held, chunk]);
        const outcome = pushOutcome(window);
        return outcome.kind === 'found' ? outcome.which : outcome.bytes;
      },
      end: () => {
        const rest = held;
        held = Buffer.alloc(0);
        return rest;
      },
    };
  }
}

/** A request body read in pieces, each read bounded by UPLOAD_STALL_MS of silence (R3a). */
class BodyReader {
  private readonly iterator: AsyncIterator<Uint8Array>;
  private leftover: Buffer = Buffer.alloc(0);
  private pending: Promise<IteratorResult<Uint8Array>> | undefined;
  private ended = false;
  /** Why the body ended early, when reading it failed (the client hung up): the upload's refusal says so. */
  failure: string | undefined;

  constructor(body: AsyncIterable<Uint8Array>) {
    this.iterator = body[Symbol.asyncIterator]();
  }

  /** Puts bytes back in front (what follows the manifest's line). */
  unread(bytes: Buffer): void {
    this.leftover = bytes.length === 0 ? this.leftover : Buffer.concat([bytes, this.leftover]);
  }

  /** Bytes pulled from the body so far, however they were used. */
  private read = 0;

  /**
   * drain()'s own classification of an iterator that is done, used at both of its exits for one: ended cleanly, or
   * how a failed read looks from the drain's own end — `closed` when the daemon's own stop closed it, else
   * `hung_up`. A method, not drain()'s own nested ternary twice over (sonarjs/no-nested-conditional).
   */
  private endedOutcome(stopping: () => boolean): 'ended' | 'closed' | 'hung_up' {
    if (this.failure === undefined) return 'ended';
    return stopping() ? 'closed' : 'hung_up';
  }

  /**
   * Reads the rest of the body and discards it (R8b), through this reader's iterator: until it ends, a read fails
   * (`closed` when `stopping()`, else `hung_up`), a read stalls for UPLOAD_STALL_MS, the body read in all passes
   * `maxTotal`, or `maxMs` pass. Returns how it ended and the bytes this drain read.
   */
  async drain(limits: {
    readonly maxTotal: number;
    readonly maxMs: number;
    readonly stopping: () => boolean;
    readonly closed: Promise<void>;
  }): Promise<{ readonly outcome: DrainOutcome; readonly bytes: number }> {
    // What the upload already pulled and left unread is discarded; `bytes` counts what the drain itself reads.
    const bytes = 0;
    this.leftover = Buffer.alloc(0);
    if (this.read > limits.maxTotal) return { outcome: 'over_bound', bytes };
    if (this.ended) return { outcome: this.endedOutcome(limits.stopping), bytes };
    let timer: NodeJS.Timeout | undefined;
    const overTime = new Promise<'over_time'>((resolve) => {
      timer = setTimeout(() => {
        resolve('over_time');
      }, limits.maxMs);
    });
    // The client hung up, or the daemon's stop closed every connection (closeServer's closeAllConnections).
    const closed = limits.closed.then(() => 'closed' as const);
    try {
      return await this.drainLoop(limits, overTime, closed, bytes);
    } finally {
      clearTimeout(timer);
    }
  }

  /** drain()'s own read loop, pulled out to keep that method's complexity down. */
  private async drainLoop(
    limits: { readonly maxTotal: number; readonly stopping: () => boolean },
    overTime: Promise<'over_time'>,
    closed: Promise<'closed'>,
    startBytes: number,
  ): Promise<{ readonly outcome: DrainOutcome; readonly bytes: number }> {
    let bytes = startBytes;
    for (;;) {
      const next = await Promise.race([this.next(), overTime, closed]);
      if (next === 'over_time') return { outcome: 'over_time', bytes };
      if (next === 'closed') return { outcome: limits.stopping() ? 'closed' : 'hung_up', bytes };
      if (next === 'stalled') return { outcome: 'stalled', bytes };
      if (next.done === true) {
        this.ended = true;
        return { outcome: this.endedOutcome(limits.stopping), bytes };
      }
      bytes += next.value.byteLength;
      if (this.read > limits.maxTotal) return { outcome: 'over_bound', bytes };
    }
  }

  /** Up to `max` bytes, or the body's end, or 'stalled' when none came for UPLOAD_STALL_MS. */
  async take(max: number): Promise<Buffer | 'end' | 'stalled'> {
    if (this.leftover.length === 0) {
      if (this.ended) return 'end';
      const next = await this.next();
      if (next === 'stalled') return 'stalled';
      if (next.done === true) {
        this.ended = true;
        return 'end';
      }
      this.leftover = Buffer.from(next.value);
      if (this.leftover.length === 0) return this.take(max);
    }
    const out = this.leftover.subarray(0, max);
    this.leftover = this.leftover.subarray(out.length);
    return out;
  }

  private async next(): Promise<IteratorResult<Uint8Array> | 'stalled'> {
    // A body whose reading fails (the client hung up mid-request) has ended short: the upload is refused body_short.
    this.pending ??= this.iterator.next().catch((error: unknown): IteratorResult<Uint8Array> => {
      this.failure = error instanceof Error ? error.message : String(error);
      return { done: true, value: undefined };
    });
    let timer: NodeJS.Timeout | undefined;
    const stalled = new Promise<'stalled'>((resolve) => {
      timer = setTimeout(() => {
        resolve('stalled');
      }, UPLOAD_STALL_MS);
    });
    try {
      const result = await Promise.race([this.pending, stalled]);
      if (result !== 'stalled') {
        this.pending = undefined;
        if (result.done !== true) this.read += result.value.byteLength;
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** What readManifest and its own helpers return on a problem. */
type ManifestProblem = {
  readonly ok: false;
  readonly reason: 'bad_manifest' | 'body_stalled';
  readonly detail: string;
  readonly name?: string;
};

/** readManifest's own read of its one line, pulled out to keep that function's complexity down. */
async function readManifestLine(
  body: BodyReader,
): Promise<{ readonly ok: true; readonly line: Buffer } | ManifestProblem> {
  let line = Buffer.alloc(0);
  for (;;) {
    const chunk = await body.take(MANIFEST_MAX_BYTES);
    if (chunk === 'stalled')
      return { ok: false, reason: 'body_stalled', detail: `no body bytes for ${String(UPLOAD_STALL_MS)} ms` };
    if (chunk === 'end')
      return { ok: false, reason: 'bad_manifest', detail: 'the body ended before its manifest line did' };
    line = Buffer.concat([line, chunk]);
    const newline = line.indexOf(0x0a);
    if (newline >= 0) {
      if (newline + 1 > MANIFEST_MAX_BYTES)
        return {
          ok: false,
          reason: 'bad_manifest',
          detail: `the manifest line is over ${String(MANIFEST_MAX_BYTES)} bytes`,
        };
      body.unread(line.subarray(newline + 1));
      return { ok: true, line: line.subarray(0, newline) };
    }
    if (line.length >= MANIFEST_MAX_BYTES)
      return {
        ok: false,
        reason: 'bad_manifest',
        detail: `the manifest line is over ${String(MANIFEST_MAX_BYTES)} bytes`,
      };
  }
}

/** readManifest's own validation of one manifest entry, pulled out to keep that function's complexity down. */
function validateManifestEntry(
  entry: unknown,
): { readonly ok: true; readonly value: UploadManifestEntry } | ManifestProblem {
  const e = entry as Record<string, unknown> | null;
  if (
    typeof e !== 'object' ||
    e === null ||
    Array.isArray(e) ||
    Object.keys(e).sort(byCodeUnit).join() !== 'name,sha256,size'
  ) {
    return { ok: false, reason: 'bad_manifest', detail: 'each file of the manifest is exactly {name, size, sha256}' };
  }
  const { name, size, sha256 } = e as { name: unknown; size: unknown; sha256: unknown };
  if (typeof name !== 'string') return { ok: false, reason: 'bad_manifest', detail: 'a name is not a string' };
  const problem = fileNameProblem(name, { returned: false });
  if (problem !== undefined) return { ok: false, reason: 'bad_manifest', detail: problem, name };
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      reason: 'bad_manifest',
      detail: `${name}'s size is not a whole number of bytes from 0 to ${String(MAX_ATTACHMENT_BYTES)}`,
      name,
    };
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
    return { ok: false, reason: 'bad_manifest', detail: `${name}'s sha256 is not 64 lowercase hex characters`, name };
  return { ok: true, value: { name, size, sha256 } };
}

/** The manifest's line (R3a): checked whole before a byte of any file is read. */
async function readManifest(
  body: BodyReader,
): Promise<{ readonly ok: true; readonly files: readonly UploadManifestEntry[] } | ManifestProblem> {
  const read = await readManifestLine(body);
  if (!read.ok) return read;
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.line.toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_manifest', detail: 'the manifest line is not JSON' };
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > MAX_FILES_PER_MESSAGE) {
    return {
      ok: false,
      reason: 'bad_manifest',
      detail: `the manifest is a list of 1 to ${String(MAX_FILES_PER_MESSAGE)} files`,
    };
  }
  const files: UploadManifestEntry[] = [];
  for (const entry of parsed as unknown[]) {
    const validated = validateManifestEntry(entry);
    if (!validated.ok) return validated;
    files.push(validated.value);
  }
  return { ok: true, files };
}

/** Why a space's lock was not granted, for a creation's, fill's or removal's failure (SPACE_LOCK_WAIT_MS). */
function lockRefusal(why: 'timeout' | 'aborted'): string {
  return why === 'timeout'
    ? `the space's lock was busy past ${String(SPACE_LOCK_WAIT_MS)} ms`
    : 'the daemon is stopping';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
