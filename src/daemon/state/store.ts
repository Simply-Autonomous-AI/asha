// Where saved state lives and how it is written (docs/plans/agent-persistence.md R2, R4, R5, R6, R11): under
// ASHA_HOME/state/, `agents/<channel>/<team or ->/<name>/` for an agent and `channels/<channel>/` for a channel,
// directories 0700 and files 0600, never in a git tree. Each identity holds `current.json`, the pointer, naming its
// promoted generation `gen-<n>/`, which holds one file per asset: a normalised tar for /memory and /workspace, JSON
// for the board, and for a channel that persists its files `files.tar` beside `files-table.json` (agent-files R15).
// A checkpoint writes `gen-<n+1>/` beside it — created exclusively, every file written and fsynced,
// the directory fsynced — then replaces `current.json` (write, fsync, rename) and fsyncs the identity directory, and
// only then deletes the previous generation (PRINCIPLES §13: a unique name, promoted on success). A crash at any
// point leaves the previous pointer and its generation intact; the next start removes what a crash left behind.

import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';

import { present } from '../../shared/assert-present.js';
import { SPACE_MAX_BYTES, SPACE_MAX_ENTRIES } from '../../shared/files.js';
import { byCodeUnit } from '../../shared/order.js';
import {
  NAME_PATTERN,
  type AgentAsset,
  type ChannelAsset,
  type StateAsset,
  type StateListResponse,
  type StatePending,
  type StateRemoved,
  type StateSelector,
} from '../../shared/protocol.js';
import type { Logger } from '../log.js';
import type { StateFs } from './fs.js';
import { PendingRecord, PendingRecordInvalid } from './pending.js';
import { TarNormaliser, type NormaliseFailure, type NormaliseResult } from './tar.js';

/** A persisted agent: its channel, its team (null for a recipe launched alone, stored as `-`) and its name (R2). */
export interface AgentIdentity {
  readonly channel: string;
  readonly team: string | null;
  readonly name: string;
}

/** How an identity is written in logs, listings and messages: `<channel>/<team or ->/<name>`. */
export function identityKey(id: AgentIdentity): string {
  return `${id.channel}/${id.team ?? '-'}/${id.name}`;
}

/** The team-id rule (collaborating-agents R11, teams.ts TEAM_ID): what a `team=` selector must match (R5). */
const TEAM_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** ASHA_HOME/state is inside a git tree: nothing is read or written there (R2). */
export class StateInsideGitTree extends Error {
  constructor(readonly dir: string) {
    super(
      `${dir} is inside a git tree (a .git at or above it): saved state is never kept in one (docs/plans/agent-persistence.md R2); set ASHA_HOME outside it`,
    );
    this.name = 'StateInsideGitTree';
  }
}

/** Something in ASHA_HOME/state is not what the store writes: a link, a special file, a malformed pointer (R11). */
export class StateStoreCorrupt extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`saved state is corrupt: ${path}: ${detail}; remove it with asha --reset-state`);
    this.name = 'StateStoreCorrupt';
  }
}

/**
 * A promotion whose pointer was renamed into place but whose identity directory's fsync then failed (R4): the pointer
 * names the new generation, so neither generation is removed — discard() removes nothing — and the next start
 * removes the one the pointer does not name. Only the rename's durability is in doubt.
 */
class PromotionUnsynced extends Error {
  constructor(
    readonly identityDir: string,
    readonly generation: number,
    options: { readonly cause: unknown },
  ) {
    super(
      `${join(identityDir, 'current.json')} now names generation ${generation.toString()}, but syncing ${identityDir} failed: ${options.cause instanceof Error ? options.cause.message : String(options.cause)}; both generations are kept, and the next start removes the one it does not name`,
      options,
    );
    this.name = 'PromotionUnsynced';
  }
}

/** What a stored asset is: its bytes on disk, its regular files (a board's entries), and the sha256 of the file. */
export interface AssetRecord {
  readonly bytes: number;
  readonly files: number;
  readonly sha256: string;
}

/** An agent's `current.json` (R4). */
export interface AgentPointer {
  readonly kind: 'agent';
  readonly generation: number;
  readonly savedAt: string;
  readonly recipe: string;
  /** The recipe's image: the folder images/<name>/, never its tag (R12). */
  readonly image: string;
  /** The image's `asha.source` label. */
  readonly source: string;
  /** The image's `asha.state-schema` label, or `none` (R12). */
  readonly schema: string;
  readonly assets: Partial<Record<AgentAsset, AssetRecord>>;
  /** The acknowledged delivery this checkpoint follows; null for a stop's checkpoint with none in flight (R9 (b)). */
  readonly lastDelivery: string | null;
  /** Its handle when the checkpoint was written: the next launch's `resumed.previousHandle` (R8). */
  readonly handle: string;
}

/** A channel's `current.json` (R4, R7, R14). */
export interface ChannelPointer {
  readonly kind: 'channel';
  readonly generation: number;
  readonly savedAt: string;
  /** The team whose `persist` names the channel's assets. */
  readonly team: string;
  readonly assets: Partial<Record<ChannelAsset, AssetRecord>>;
  readonly lastDelivery: null;
  /** Set once a checkpoint was written while an agent that keeps memory was online on the channel, until reset (R7). */
  readonly memoryTainted: boolean;
  /** The file table saved beside `files` (docs/plans/agent-files.md R15): `files-table.json`, present with `files` only. */
  readonly filesTable?: AssetRecord;
}

/** One record of a persisted channel's file table (agent-files R6, R15): exactly these five fields. */
export interface SavedFileRecord {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly user: string;
  readonly time: string;
}

/** The file the file table is saved in, beside `files.tar` (agent-files R15). */
const FILES_TABLE_FILE = 'files-table.json';

/** A `current.json`: an agent's or a channel's, told apart by `kind`. */
export type Pointer = AgentPointer | ChannelPointer;

/** The stored file of an asset. */
function assetFile(asset: AgentAsset | ChannelAsset): string {
  return asset === 'board' ? 'board.json' : `${asset}.tar`;
}

/** What StateStore is built with: its directory (ASHA_HOME/state), filesystem, logger, clock and git-tree check. */
export interface StateStoreProps {
  readonly dir: string;
  readonly fs: StateFs;
  readonly logger: Logger;
  readonly clock: () => Date;
  /** `insideGitTree` of src/shared/paths.ts, injected so a test can count its calls (A2). */
  readonly insideGitTree: (path: string) => Promise<boolean>;
}

/** The bounds of one asset (R6): its regular files, their bytes together, and its entries (the root excluded). */
export interface AssetBounds {
  /** Most regular files. */
  readonly maxFiles: number;
  /** Most bytes the regular files hold together. */
  readonly maxBytes: number;
  /** Most entries, every directory and file counted but the root (R6: entries counted as they stream). */
  readonly maxEntries: number;
}

/**
 * R6: /workspace as agent-tools R9 bounds it, /memory about four users at the memory image's caps; each holds at
 * most twice its files in entries, room for every file in a directory of its own (R1-SECURITY-003).
 */
export const ASSET_BOUNDS: Readonly<Record<AgentAsset, AssetBounds>> = {
  workspace: { maxFiles: 256, maxBytes: 16 * 1024 * 1024, maxEntries: 512 },
  memory: { maxFiles: 4096, maxBytes: 64 * 1024 * 1024, maxEntries: 8192 },
};

/**
 * A channel's file space as saved (agent-files R11, R15; agent-persistence R6), bounded as the space is: 1,000
 * entries, every file and directory counted, and 256,000,000 bytes.
 */
export const FILES_BOUNDS: AssetBounds = {
  maxFiles: SPACE_MAX_ENTRIES,
  maxBytes: SPACE_MAX_BYTES,
  maxEntries: SPACE_MAX_ENTRIES,
};

/**
 * The store of saved state under ASHA_HOME/state (R2, R4, R5, R11): each identity's pointer and promoted generation,
 * checkpoints written and promoted as the file header says, listing, reset and the start's clean-up.
 */
export class StateStore {
  /** The git-tree check's answer, once asked in this run (R2): asked before the first read or write. */
  private checked: Promise<boolean> | undefined;

  constructor(private readonly props: StateStoreProps) {}

  /** The store's directory, ASHA_HOME/state. */
  get dir(): string {
    return this.props.dir;
  }

  /** An agent's identity directory, `agents/<channel>/<team or ->/<name>/` (R2). */
  agentDir(id: AgentIdentity): string {
    return join(this.props.dir, 'agents', id.channel, id.team ?? '-', id.name);
  }

  /** A channel's identity directory, `channels/<channel>/` (R2). */
  channelDir(channel: string): string {
    return join(this.props.dir, 'channels', channel);
  }

  /** Refuses every operation, with StateInsideGitTree, when ASHA_HOME/state is in a git tree (R2). Asked once a run. */
  async guard(): Promise<void> {
    this.checked ??= this.props.insideGitTree(this.props.dir);
    if (await this.checked) throw new StateInsideGitTree(this.props.dir);
  }

  /** Whether ASHA_HOME/state exists: the daemon's start applies the git-tree check only then (R2). */
  async exists(): Promise<boolean> {
    return (await this.props.fs.list(this.props.dir)) !== undefined;
  }

  /**
   * An agent's pointer, after the git-tree guard (R2): undefined when nothing is saved; a malformed one, or a
   * channel's in its place, is StateStoreCorrupt.
   */
  async readAgentPointer(id: AgentIdentity): Promise<AgentPointer | undefined> {
    await this.guard();
    const pointer = await this.readPointer(this.agentDir(id));
    if (pointer !== undefined && pointer.kind !== 'agent')
      throw new StateStoreCorrupt(join(this.agentDir(id), 'current.json'), 'not an agent pointer');
    return pointer;
  }

  /**
   * A channel's pointer, after the git-tree guard (R2): undefined when nothing is saved; a malformed one, or an
   * agent's in its place, is StateStoreCorrupt.
   */
  async readChannelPointer(channel: string): Promise<ChannelPointer | undefined> {
    await this.guard();
    const pointer = await this.readPointer(this.channelDir(channel));
    if (pointer !== undefined && pointer.kind !== 'channel')
      throw new StateStoreCorrupt(join(this.channelDir(channel), 'current.json'), 'not a channel pointer');
    return pointer;
  }

  /** The path of an asset of the promoted generation. */
  assetPath(dir: string, pointer: Pointer, asset: AgentAsset | ChannelAsset): string {
    return join(dir, `gen-${pointer.generation.toString()}`, assetFile(asset));
  }

  /** An asset of the promoted generation, whole (the board; an erase's unchanged /workspace). */
  async readAsset(dir: string, pointer: Pointer, asset: AgentAsset | ChannelAsset): Promise<Buffer> {
    const path = this.assetPath(dir, pointer, asset);
    const bytes = await this.props.fs.readFile(path);
    if (bytes === undefined)
      throw new StateStoreCorrupt(
        path,
        `the pointer names it (generation ${pointer.generation.toString()}) and it is missing`,
      );
    return bytes;
  }

  /** A stored file's size. */
  fileSize(path: string): Promise<number> {
    return this.props.fs.size(path);
  }

  /**
   * Checks an identity's directory before a restore reads it: every entry a directory or a regular file, walked with
   * lstat (R11); a link or special file is StateStoreCorrupt. Then each stored asset's sha256 against the pointer (R3).
   */
  async verify(dir: string, pointer: Pointer): Promise<void> {
    await this.walk(dir);
    const stored: [string, AssetRecord][] = (
      Object.entries(pointer.assets) as [AgentAsset | ChannelAsset, AssetRecord][]
    ).map(([asset, record]) => [this.assetPath(dir, pointer, asset), record]);
    if (pointer.kind === 'channel' && pointer.filesTable !== undefined)
      stored.push([join(dir, `gen-${pointer.generation.toString()}`, FILES_TABLE_FILE), pointer.filesTable]);
    for (const [path, record] of stored) {
      const bytes = await this.props.fs.readFile(path);
      if (bytes === undefined)
        throw new StateStoreCorrupt(
          path,
          `the pointer names it (generation ${pointer.generation.toString()}) and it is missing`,
        );
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== record.sha256)
        throw new StateStoreCorrupt(path, `its sha256 ${sha256} is not the ${record.sha256} its pointer records`);
    }
  }

  /** A channel's saved file table (agent-files R15): exactly five fields a record, else StateStoreCorrupt. */
  async readFilesTable(dir: string, pointer: ChannelPointer): Promise<SavedFileRecord[]> {
    if (pointer.filesTable === undefined) return [];
    const path = join(dir, `gen-${pointer.generation.toString()}`, FILES_TABLE_FILE);
    const raw = await this.props.fs.readFile(path);
    if (raw === undefined)
      throw new StateStoreCorrupt(
        path,
        `the pointer names it (generation ${pointer.generation.toString()}) and it is missing`,
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch (error) {
      throw new StateStoreCorrupt(path, `not JSON (${(error as Error).name})`);
    }
    const record = (r: unknown): r is SavedFileRecord => {
      const o = r as Record<string, unknown> | null;
      return (
        typeof o === 'object' &&
        o !== null &&
        Object.keys(o).sort(byCodeUnit).join() === 'path,sha256,size,time,user' &&
        typeof o['path'] === 'string' &&
        typeof o['size'] === 'number' &&
        typeof o['sha256'] === 'string' &&
        typeof o['user'] === 'string' &&
        typeof o['time'] === 'string'
      );
    };
    if (!Array.isArray(parsed) || !parsed.every(record))
      throw new StateStoreCorrupt(path, 'not a file table: expected [{path, size, sha256, user, time}]');
    return parsed;
  }

  /** The agent's record of unsaved deliveries (R9 (a)). */
  async pending(id: AgentIdentity): Promise<PendingRecord> {
    await this.guard();
    await this.ensureDir(this.agentDir(id));
    return PendingRecord.load({ fs: this.props.fs, dir: this.agentDir(id) });
  }

  /**
   * Begins a checkpoint of the identity at `dir`: `gen-<n+1>/` created exclusively beside the pointer (R4) — a
   * directory already there fails loudly (write_failed), untouched.
   */
  async begin(dir: string): Promise<GenerationWriter> {
    await this.guard();
    await this.ensureDir(dir);
    const current = await this.readPointer(dir);
    const generation = (current?.generation ?? 0) + 1;
    const genDir = join(dir, `gen-${generation.toString()}`);
    await this.props.fs.mkdirExclusive(genDir);
    return new GenerationWriter({ ...this.props, identityDir: dir, genDir, generation, previous: current?.generation });
  }

  /** Marks or clears an asset as full (R6: its last save failed over_bound), for --list-state. */
  async setFull(dir: string, asset: AgentAsset | ChannelAsset, full: boolean): Promise<void> {
    await this.guard();
    const file = join(dir, 'full.json');
    const raw = await this.props.fs.readFile(file);
    const now = raw === undefined ? [] : parseFull(raw, file);
    const next = full ? [...new Set([...now, asset])] : now.filter((a) => a !== asset);
    if (next.length === now.length && next.every((a) => now.includes(a))) return;
    await this.ensureDir(dir);
    if (next.length === 0) await this.props.fs.remove(file);
    else await this.props.fs.replaceFile(file, `${JSON.stringify({ assets: next })}\n`);
    await this.props.fs.fsyncDir(dir);
  }

  /** Every saved asset and every record of unsaved deliveries that holds entries (R5). */
  async list(): Promise<StateListResponse> {
    await this.guard();
    const assets: StateAsset[] = [];
    const pending: StatePending[] = [];
    let totalBytes = 0;
    // A corrupt identity or a stray file is listed as `unreadable`, never hidden, so the reset that clears it can be confirmed.
    const unreadable = async (kind: 'agent' | 'channel', identity: string, path: string) => {
      const bytes = await this.treeBytes(path);
      assets.push({ kind, identity, asset: 'unreadable', bytes, savedAt: 'unknown', full: false, tainted: false });
      totalBytes += bytes;
    };
    const { identities, strays } = await this.tolerantIdentities();
    for (const s of strays) await unreadable(s.kind, s.identity, s.path);
    for (const { kind, identity, dir } of identities) {
      try {
        await this.listOne(kind, identity, dir, assets, pending, (n) => (totalBytes += n));
      } catch (error) {
        if (!(error instanceof StateStoreCorrupt) && !(error instanceof PendingRecordInvalid)) throw error;
        await unreadable(kind, identity, dir);
      }
    }
    return { assets, pending, totalBytes };
  }

  private async listOne(
    kind: 'agent' | 'channel',
    identity: string,
    dir: string,
    assets: StateAsset[],
    pending: StatePending[],
    add: (bytes: number) => void,
  ): Promise<void> {
    {
      let totalBytes = 0;
      const pointer = await this.readPointer(dir);
      const fullRaw = await this.props.fs.readFile(join(dir, 'full.json'));
      const full = fullRaw === undefined ? [] : parseFull(fullRaw, join(dir, 'full.json'));
      if (pointer !== undefined) {
        const tainted = pointer.kind === 'channel' && pointer.memoryTainted;
        for (const [asset, record] of Object.entries(pointer.assets) as [AgentAsset | ChannelAsset, AssetRecord][]) {
          // A channel's file table is listed with its files: they are saved, and reset, together (agent-files R15).
          const bytes =
            record.bytes + (asset === 'files' && pointer.kind === 'channel' ? (pointer.filesTable?.bytes ?? 0) : 0);
          assets.push({
            kind,
            identity,
            asset,
            bytes,
            savedAt: pointer.savedAt,
            full: full.includes(asset) || (asset === 'board' && record.files >= 256),
            tainted,
          });
          totalBytes += bytes;
        }
      }
      if (kind === 'agent') {
        const record = await PendingRecord.load({ fs: this.props.fs, dir });
        if (record.entries.length > 0) {
          pending.push({
            identity,
            bytes: record.bytes,
            savedAt: present(record.entries[0], 'first pending entry').savedAt,
          });
          totalBytes += record.bytes;
        }
      }
      add(totalBytes);
    }
  }

  /**
   * Removes exactly what the selector names (R5): one agent, a channel's agents and its board and files, or
   * everything. Returns each asset and record removed, or `nothing_matches` when none is saved. Selectors are
   * pattern-checked by the caller before any path is formed (selectorProblem).
   */
  async reset(selector: StateSelector): Promise<StateRemoved[] | 'nothing_matches'> {
    await this.guard();
    // Read tolerantly: a corrupt pointer or record, or a stray file, is what a reset exists to clear (StateStoreCorrupt names it).
    const { identities, strays } = await this.tolerantIdentities();
    const matched = identities.filter((i) => matches(i, selector));
    const removed: StateRemoved[] = [];
    for (const { kind, identity, dir } of matched) removed.push(...(await this.removedFor(kind, identity, dir)));
    const strayed = strays.filter(
      (s) => 'all' in selector || (selector.name === undefined && s.channel === selector.channel),
    );
    for (const s of strayed)
      removed.push({ kind: s.kind, identity: s.identity, asset: 'unreadable', bytes: await this.treeBytes(s.path) });
    if (removed.length === 0) return 'nothing_matches';
    for (const { dir } of matched) await this.props.fs.remove(dir);
    for (const s of strayed) await this.props.fs.remove(s.path);
    // A reset removes identity directories and strays, never a parent of one: every parent is there to sync, and a
    // failure to sync one, a missing one included, fails the reset loudly (PRINCIPLES §11).
    for (const parent of new Set(matched.map((m) => join(m.dir, '..')))) await this.props.fs.fsyncDir(parent);
    for (const r of removed)
      this.props.logger.info('state.reset', { kind: r.kind, identity: r.identity, asset: r.asset, bytes: r.bytes });
    return removed;
  }

  /**
   * One identity's assets and pending record, as reset() removes them; `unreadable`, whole, for one whose pointer or
   * record is corrupt. Extracted from reset() to keep its cognitive complexity within bound — the logic is unchanged.
   */
  private async removedFor(kind: 'agent' | 'channel', identity: string, dir: string): Promise<StateRemoved[]> {
    try {
      const found: StateRemoved[] = [];
      const pointer = await this.readPointer(dir);
      for (const [asset, record] of Object.entries(pointer?.assets ?? {}) as [AgentAsset | ChannelAsset, AssetRecord][])
        found.push({ kind, identity, asset, bytes: record.bytes });
      if (kind === 'agent') {
        const record = await PendingRecord.load({ fs: this.props.fs, dir });
        if (record.entries.length > 0) found.push({ kind, identity, asset: 'pending', bytes: record.bytes });
      }
      return found;
    } catch (error) {
      if (!(error instanceof StateStoreCorrupt) && !(error instanceof PendingRecordInvalid)) throw error;
      return [{ kind, identity, asset: 'unreadable', bytes: await this.treeBytes(dir) }];
    }
  }

  /**
   * At the daemon's start, before any agent launches (R4, R11): walks the store with lstat — a link or special file
   * anywhere is StateStoreCorrupt — deletes every `gen-*` its identity's pointer does not name (`state.orphan_removed`,
   * warn) and every `.*.tmp` a crash left (a writePrivateFile it interrupted). Returns the agents whose records hold
   * entries, for the caller's orphaned-record check (R9 (h)).
   */
  async cleanupAtStart(): Promise<{ readonly withPending: readonly AgentIdentity[] }> {
    await this.guard();
    await this.walk(this.props.dir);
    const withPending: AgentIdentity[] = [];
    for (const { kind, identity, dir, agent } of await this.identities()) {
      const pointer = await this.readPointer(dir);
      const entries = (await this.props.fs.list(dir)) ?? [];
      // The generation the pointer names must be there before any other is removed: deleting the rest would leave
      // nothing to restore (R1-DESIGN-001).
      if (pointer !== undefined && !entries.some((e) => e.name === `gen-${pointer.generation.toString()}`))
        throw new StateStoreCorrupt(
          join(dir, `gen-${pointer.generation.toString()}`),
          `the pointer names it (generation ${pointer.generation.toString()}) and it is missing`,
        );
      for (const entry of entries) {
        if (/^gen-\d+$/.test(entry.name) && entry.name !== `gen-${(pointer?.generation ?? -1).toString()}`) {
          await this.props.fs.remove(join(dir, entry.name));
          this.props.logger.warn('state.orphan_removed', { kind, identity, generation: Number(entry.name.slice(4)) });
        } else if (entry.name.startsWith('.') && entry.name.endsWith('.tmp')) {
          await this.props.fs.remove(join(dir, entry.name));
          this.props.logger.warn('state.orphan_removed', { kind, identity, file: entry.name });
        }
      }
      if (agent !== undefined && (await PendingRecord.load({ fs: this.props.fs, dir })).entries.length > 0)
        withPending.push(agent);
    }
    return { withPending };
  }

  /**
   * Creates an identity's directory when it does not exist, then fsyncs each directory above it up to the store's
   * parent, so the new directories themselves survive a crash (a pointer inside an unsynced directory could vanish).
   */
  private async ensureDir(dir: string): Promise<void> {
    if ((await this.props.fs.list(dir)) !== undefined) return;
    await this.props.fs.mkdirp(dir);
    const top = dirname(this.props.dir);
    for (
      let parent = dirname(dir);
      relative(top, parent) !== '' && !relative(top, parent).startsWith('..');
      parent = dirname(parent)
    ) {
      await this.props.fs.fsyncDir(parent);
    }
    await this.props.fs.fsyncDir(top);
  }

  /** Every identity directory under the store, agents then channels, each named as listings name it. */
  private async identities(): Promise<
    { kind: 'agent' | 'channel'; identity: string; dir: string; agent?: AgentIdentity }[]
  > {
    const out: { kind: 'agent' | 'channel'; identity: string; dir: string; agent?: AgentIdentity }[] = [];
    const agents = join(this.props.dir, 'agents');
    for (const channel of await this.dirs(agents)) {
      for (const team of await this.dirs(join(agents, channel))) {
        for (const name of await this.dirs(join(agents, channel, team))) {
          const agent = { channel, team: team === '-' ? null : team, name };
          out.push({ kind: 'agent', identity: identityKey(agent), dir: join(agents, channel, team, name), agent });
        }
      }
    }
    for (const channel of await this.dirs(join(this.props.dir, 'channels')))
      out.push({ kind: 'channel', identity: channel, dir: this.channelDir(channel) });
    return out;
  }

  /**
   * Every identity directory, as identities() names them, and every entry that is not a directory where the store
   * keeps only directories (a stray file, a link) — for the reset, which removes what the strict walk refuses.
   */
  private async tolerantIdentities(): Promise<{
    identities: { kind: 'agent' | 'channel'; identity: string; dir: string; agent?: AgentIdentity }[];
    strays: { kind: 'agent' | 'channel'; identity: string; path: string; channel: string | undefined }[];
  }> {
    const identities: { kind: 'agent' | 'channel'; identity: string; dir: string; agent?: AgentIdentity }[] = [];
    const strays: { kind: 'agent' | 'channel'; identity: string; path: string; channel: string | undefined }[] = [];
    const split = async (dir: string, kind: 'agent' | 'channel', channel: string | undefined): Promise<string[]> => {
      const names: string[] = [];
      for (const e of (await this.props.fs.list(dir)) ?? []) {
        if (e.kind === 'directory') names.push(e.name);
        // Named as listings name its neighbours: its path under agents/ (`<channel>/…`) or channels/.
        else
          strays.push({
            kind,
            identity: relative(join(this.props.dir, kind === 'agent' ? 'agents' : 'channels'), join(dir, e.name)),
            path: join(dir, e.name),
            channel: channel ?? (kind === 'channel' ? e.name : undefined),
          });
      }
      return names.sort(byCodeUnit);
    };
    const agents = join(this.props.dir, 'agents');
    for (const channel of await split(agents, 'agent', undefined)) {
      for (const team of await split(join(agents, channel), 'agent', channel)) {
        for (const name of await split(join(agents, channel, team), 'agent', channel)) {
          const agent = { channel, team: team === '-' ? null : team, name };
          identities.push({
            kind: 'agent',
            identity: identityKey(agent),
            dir: join(agents, channel, team, name),
            agent,
          });
        }
      }
    }
    for (const channel of await split(join(this.props.dir, 'channels'), 'channel', undefined))
      identities.push({ kind: 'channel', identity: channel, dir: this.channelDir(channel) });
    return { identities, strays };
  }

  /** The bytes of every regular file under `path` (itself when it is one), not following links. */
  private async treeBytes(path: string): Promise<number> {
    let entries;
    try {
      entries = await this.props.fs.list(path);
    } catch (error) {
      // A stray file where a directory belongs: its own size.
      if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return this.props.fs.size(path);
      throw error;
    }
    if (entries === undefined) return 0;
    let bytes = 0;
    for (const e of entries) {
      if (e.kind === 'directory') bytes += await this.treeBytes(join(path, e.name));
      else if (e.kind === 'file') bytes += await this.props.fs.size(join(path, e.name));
    }
    return bytes;
  }

  /** The directories in `dir`, sorted; a link or special file there is StateStoreCorrupt. */
  private async dirs(dir: string): Promise<string[]> {
    const entries = (await this.props.fs.list(dir)) ?? [];
    for (const e of entries)
      if (e.kind !== 'directory')
        throw new StateStoreCorrupt(
          join(dir, e.name),
          `a ${e.kind === 'file' ? 'file' : e.kind} where the store keeps only directories`,
        );
    return entries.map((e) => e.name).sort(byCodeUnit);
  }

  /** Every entry under `dir`, not following links: directories and regular files only (R11). */
  private async walk(dir: string): Promise<void> {
    for (const entry of (await this.props.fs.list(dir)) ?? []) {
      const path = join(dir, entry.name);
      if (entry.kind === 'directory') await this.walk(path);
      else if (entry.kind !== 'file')
        throw new StateStoreCorrupt(
          path,
          `a ${entry.kind === 'symlink' ? 'symbolic link' : 'special file'}: the store holds only directories and regular files`,
        );
    }
  }

  private async readPointer(dir: string): Promise<Pointer | undefined> {
    const file = join(dir, 'current.json');
    const raw = await this.props.fs.readFile(file);
    return raw === undefined ? undefined : parsePointer(raw, file);
  }
}

/** What a GenerationWriter writes: its identity's directory, its own generation's directory and number, and the previous. */
export interface GenerationWriterProps extends StateStoreProps {
  readonly identityDir: string;
  readonly genDir: string;
  readonly generation: number;
  /** The generation the pointer names now, deleted once this one is promoted. */
  readonly previous: number | undefined;
}

/** A generation being written: its assets, then promote — or discard, which removes it and keeps the previous. */
export class GenerationWriter {
  private readonly records: Partial<Record<AgentAsset | ChannelAsset, AssetRecord>> = {};
  /** The file table's record, when one was written (agent-files R15). */
  private table: AssetRecord | undefined;
  private finished = false;
  /** Set once promote's rename resolved: the pointer on disk names this generation (R1-DESIGN-001). */
  private renamed = false;

  constructor(private readonly props: GenerationWriterProps) {}

  /** The generation this writer writes, `gen-<n>`. */
  get generation(): number {
    return this.props.generation;
  }

  /**
   * Streams one asset's snapshot through the tar reader (R11) into `<asset>.tar`, bounded (R6); `feed` pushes the
   * copy's chunks and stops when a push reports a failure. The file is fsynced once complete. A failure leaves the
   * file for discard() to remove with the generation.
   */
  async writeTar(
    asset: AgentAsset | 'files',
    bounds: AssetBounds,
    feed: (push: (chunk: Uint8Array) => Promise<NormaliseFailure | undefined>) => Promise<void>,
    options: { readonly skip?: (name: string) => boolean } = {},
  ): Promise<NormaliseResult> {
    const path = join(this.props.genDir, assetFile(asset));
    const file = await this.props.fs.createFile(path);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      // A channel's file space is rooted at channel/ (agent-files R15), its names up to 255 bytes in an upload's folder.
      const normaliser = new TarNormaliser({
        root: asset === 'files' ? 'channel' : asset,
        ...bounds,
        ...(asset === 'files' ? { longNames: 'pax' as const } : {}),
        ...(options.skip === undefined ? {} : { skip: options.skip }),
        write: async (chunk) => {
          hash.update(chunk);
          bytes += chunk.byteLength;
          await file.write(chunk);
        },
      });
      await feed((chunk) => normaliser.push(chunk));
      const result = normaliser.finish();
      if (!result.ok) return result;
      await file.sync();
      this.records[asset] = { bytes, files: result.files, sha256: hash.digest('hex') };
      return result;
    } finally {
      await file.close();
    }
  }

  /** Writes a JSON asset (the board, R14), fsynced. `files` is what it counts (the board's entries). */
  async writeJson(asset: ChannelAsset, value: unknown, files: number): Promise<void> {
    await this.writeBytes(asset, Buffer.from(`${JSON.stringify(value)}\n`), files);
  }

  /** Writes a channel's file table beside its files (agent-files R15), fsynced; the pointer records it as `filesTable`. */
  async writeFilesTable(records: readonly SavedFileRecord[]): Promise<void> {
    const content = Buffer.from(
      `${JSON.stringify(records.map(({ path, size, sha256, user, time }) => ({ path, size, sha256, user, time })))}\n`,
    );
    const file = await this.props.fs.createFile(join(this.props.genDir, FILES_TABLE_FILE));
    try {
      await file.write(content);
      await file.sync();
    } finally {
      await file.close();
    }
    this.table = {
      bytes: content.byteLength,
      files: records.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  /** Writes an asset's bytes unchanged from the previous generation (an erase keeps every asset but /memory, R16). */
  async writeBytes(asset: AgentAsset | ChannelAsset, content: Uint8Array, files: number): Promise<void> {
    const file = await this.props.fs.createFile(join(this.props.genDir, assetFile(asset)));
    try {
      await file.write(content);
      await file.sync();
    } finally {
      await file.close();
    }
    this.records[asset] = {
      bytes: content.byteLength,
      files,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  }

  /**
   * Promotes the generation (R4): the generation directory fsynced, then `current.json` replaced (write, fsync,
   * rename) and the identity directory fsynced, then `state.promoted` logged, and only then the previous generation
   * deleted. `pointer` is everything but the generation, the time and the assets, which this writer fills in.
   */
  async promote<P extends Pointer>(
    pointer: Omit<P, 'generation' | 'savedAt' | 'assets'>,
    identity: string,
  ): Promise<P> {
    const { fs, logger } = this.props;
    await fs.fsyncDir(this.props.genDir);
    const promoted = {
      ...pointer,
      generation: this.props.generation,
      savedAt: this.props.clock().toISOString(),
      assets: { ...this.records },
      ...(this.table === undefined ? {} : { filesTable: this.table }),
    } as unknown as P;
    await fs.replaceFile(join(this.props.identityDir, 'current.json'), `${JSON.stringify(promoted)}\n`);
    // From the rename on, the pointer names this generation: it is never removed, whatever fails next.
    this.renamed = true;
    try {
      await fs.fsyncDir(this.props.identityDir);
    } catch (error) {
      throw new PromotionUnsynced(this.props.identityDir, this.props.generation, { cause: error });
    }
    this.finished = true;
    const records = Object.values<AssetRecord>(this.records);
    logger.info('state.promoted', {
      identity,
      generation: this.props.generation,
      bytes: records.reduce((n, r) => n + r.bytes, 0),
      files: records.reduce((n, r) => n + r.files, 0),
    });
    if (this.props.previous !== undefined) {
      try {
        await fs.remove(join(this.props.identityDir, `gen-${this.props.previous.toString()}`));
      } catch (error) {
        // The new generation is promoted; the old one is an orphan the next start removes (R4). Said, not swallowed.
        logger.error('state.cleanup_failed', { identity, generation: this.props.previous, error });
      }
    }
    return promoted;
  }

  /**
   * Removes the unpromoted generation: the previous one stays as it was. After a PromotionUnsynced it removes
   * nothing, since the pointer names this generation; the next start removes the previous one (R4).
   */
  async discard(): Promise<void> {
    if (this.finished)
      throw new Error(`generation ${this.props.generation.toString()} was promoted; it cannot be discarded`);
    this.finished = true;
    if (this.renamed) return;
    await this.props.fs.remove(this.props.genDir);
  }
}

function matches(
  i: { kind: 'agent' | 'channel'; identity: string; agent?: AgentIdentity },
  selector: StateSelector,
): boolean {
  if ('all' in selector) return true;
  if (selector.name === undefined)
    return i.kind === 'channel'
      ? i.identity === selector.channel
      : present(i.agent, 'identity agent').channel === selector.channel;
  if (i.kind !== 'agent') return false;
  const agent = present(i.agent, 'identity agent');
  return agent.channel === selector.channel && agent.name === selector.name && agent.team === (selector.team ?? null);
}

/**
 * What is wrong with the parts of a reset's or an erase's selector, checked before any path is formed (R5): `channel=`
 * and `name=` must be channel names, `team=` a team id. Only the parts' patterns: which parts may be combined
 * (`team=` and `name=` need `channel=`, `team=` needs `name=`) is each caller's check (cli/state.ts, server.ts).
 */
export function selectorProblem(selector: {
  readonly channel?: string;
  readonly name?: string;
  readonly team?: string;
}): string | undefined {
  if (selector.channel !== undefined && !NAME_PATTERN.test(selector.channel))
    return `channel=${selector.channel} is not a valid channel name`;
  if (selector.name !== undefined && !NAME_PATTERN.test(selector.name))
    return `name=${selector.name} is not a valid agent name`;
  if (selector.team !== undefined && !TEAM_ID_PATTERN.test(selector.team))
    return `team=${selector.team} is not a valid team name`;
  return undefined;
}

function parseFull(raw: Buffer, file: string): (AgentAsset | ChannelAsset)[] {
  try {
    const o = JSON.parse(raw.toString('utf8')) as { assets?: unknown };
    if (
      Array.isArray(o.assets) &&
      o.assets.every((a) => ['memory', 'workspace', 'board', 'files'].includes(a as string))
    )
      return o.assets as (AgentAsset | ChannelAsset)[];
  } catch (error) {
    throw new StateStoreCorrupt(file, `not JSON (${(error as Error).name})`);
  }
  throw new StateStoreCorrupt(file, 'expected {"assets": [...]}');
}

/** Parses a pointer, strictly: a malformed one is StateStoreCorrupt, never a guess. */
export function parsePointer(raw: Buffer, file: string): Pointer {
  let o: unknown;
  try {
    o = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new StateStoreCorrupt(file, `not JSON (${(error as Error).name})`);
  }
  // A function declaration, not a const arrow: TypeScript only narrows a later check (`assets`, below) past a call
  // to a never-returning function when it is one of these (confirmed with a minimal repro under this tsconfig).
  function bad(what: string): never {
    throw new StateStoreCorrupt(file, what);
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) bad('not an object');
  const pointer = o as Record<string, unknown>;
  if (pointer['kind'] !== 'agent' && pointer['kind'] !== 'channel') bad('kind must be "agent" or "channel"');
  if (
    typeof pointer['generation'] !== 'number' ||
    !Number.isInteger(pointer['generation']) ||
    pointer['generation'] < 1
  )
    bad('generation must be a whole number from 1');
  if (typeof pointer['savedAt'] !== 'string') bad('savedAt must be a string');
  const assets = pointer['assets'] as Record<string, unknown> | null;
  if (typeof assets !== 'object' || assets === null) bad('assets must be an object');
  checkPointerAssets(pointer, assets, bad);
  if (pointer['kind'] === 'agent') checkAgentPointerFields(pointer, bad);
  else checkChannelPointerFields(pointer, assets, bad);
  return o as Pointer;
}

/** Each entry of a pointer's `assets`: a known asset of its kind, and exactly {bytes, files, sha256}. */
function checkPointerAssets(
  pointer: Record<string, unknown>,
  assets: Record<string, unknown>,
  bad: (what: string) => never,
): void {
  const allowed = pointer['kind'] === 'agent' ? ['memory', 'workspace'] : ['board', 'files'];
  for (const [asset, record] of Object.entries(assets)) {
    if (!allowed.includes(asset)) bad(`assets.${asset} is not a ${String(pointer['kind'])}'s asset`);
    if (!isRecordObject(record)) bad(`assets.${asset} must be {bytes, files, sha256}`);
    const r = record;
    if (
      typeof r['bytes'] !== 'number' ||
      typeof r['files'] !== 'number' ||
      typeof r['sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(r['sha256'])
    )
      bad(`assets.${asset} must be {bytes, files, sha256}`);
  }
}

/** An agent pointer's own fields: recipe, image, source, schema and handle as strings, and lastDelivery. */
function checkAgentPointerFields(pointer: Record<string, unknown>, bad: (what: string) => never): void {
  for (const key of ['recipe', 'image', 'source', 'schema', 'handle'])
    if (typeof pointer[key] !== 'string') bad(`${key} must be a string`);
  if (pointer['lastDelivery'] !== null && typeof pointer['lastDelivery'] !== 'string')
    bad('lastDelivery must be a string or null');
}

/** A channel pointer's own fields: team, memoryTainted, and filesTable (agent-files R15) when it is saved. */
function checkChannelPointerFields(
  pointer: Record<string, unknown>,
  assets: Record<string, unknown>,
  bad: (what: string) => never,
): void {
  if (typeof pointer['team'] !== 'string') bad('team must be a string');
  if (typeof pointer['memoryTainted'] !== 'boolean') bad('memoryTainted must be true or false');
  const table = pointer['filesTable'];
  if (table !== undefined && !isRecordObject(table)) bad('filesTable must be {bytes, files, sha256}');
  if (
    table !== undefined &&
    (typeof table['bytes'] !== 'number' ||
      typeof table['files'] !== 'number' ||
      typeof table['sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(table['sha256']))
  )
    bad('filesTable must be {bytes, files, sha256}');
  if (table !== undefined && assets['files'] === undefined) bad('filesTable is saved only beside files');
}

/** Whether a pointer's field is a plain object whose fields can be read: never null, an array or a scalar. */
function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
