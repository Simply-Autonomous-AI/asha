// A persisted agent and a persisted channel, as the supervisor runs them (docs/plans/agent-persistence.md R4, R6,
// R9–R14). A persisted agent's journal records every delivery the channel accepts for it before it is made
// (pending.json), its checkpoint follows every ack — /memory and /workspace copied out of the container through the
// tar reader into a new generation, promoted atomically — and clears the journal through the delivery it follows.
// A failed save is a declared degraded mode: logged at error, a notice on the channel the first time, the agent
// running on. A persisted channel's board is checkpointed after every ack on the channel, coalesced.

import { createReadStream } from 'node:fs';

import { present } from '../../shared/assert-present.js';
import {
  STATE_STOP_CHECKPOINT_MS,
  STATE_BOUNDED_ACK_MS,
  AGENT_DRAIN_MS,
  AGENT_STOP_GRACE_MS,
  userIdProblem,
  type AgentAsset,
  type ConversationMessage,
  type Delivery,
} from '../../shared/protocol.js';
import type { Blackboard, BoardSnapshot } from '../blackboard/index.js';
import type { Channel, MemberJournal, Resend } from '../channel/index.js';
import type { ContainerRuntime } from '../container-runtime/index.js';
import type { FileSpaces, SnapshotPlan, SpaceFill } from '../files/index.js';
import type { Logger } from '../log.js';
import {
  ASSET_BOUNDS,
  FILES_BOUNDS,
  PENDING_MAX_BYTES,
  PENDING_MAX_ENTRIES,
  TAR_BLOCK,
  readStoredEntries,
  tarDirectory,
  tarFile,
  type AgentIdentity,
  type AgentPointer,
  type ChannelPointer,
  type GenerationWriter,
  type PendingEntry,
  type PendingKind,
  type PendingRecord,
  StateStoreCorrupt,
  type StateStore,
  type TarEntry,
} from '../state/index.js';
import type { ChannelAsset } from '../../shared/protocol.js';

/** Why a checkpoint failed (R6); `journal_failed` is a failed write of the record of unsaved deliveries (R9 (a)). */
export type SaveFailure =
  'over_bound' | 'invalid_entry' | 'copy_failed' | 'write_failed' | 'timeout' | 'journal_failed';

/**
 * The deadlines a persisted stop runs to (R10), in ms since the epoch: the end of the ack wait, the latest a
 * checkpoint may end (a checkpoint's own bound is STATE_STOP_CHECKPOINT_MS from its start), the container deadline
 * the drain's grace is counted to, the latest the channel's final checkpoint may start, and the latest it may end.
 */
export interface StopDeadlines {
  readonly ackBy: number;
  readonly checkpointBy: number;
  readonly containerBy: number;
  readonly channelStartBy: number;
  readonly channelBy: number;
}

/** The full stop's (R10): acks until S+65 s, the container's deadline S+70 s, the channel's checkpoint starting by S+70 s. */
export function fullStopDeadlines(s: number): StopDeadlines {
  return {
    ackBy: s + AGENT_DRAIN_MS,
    checkpointBy: Number.POSITIVE_INFINITY,
    containerBy: s + AGENT_STOP_GRACE_MS,
    channelStartBy: s + AGENT_STOP_GRACE_MS,
    channelBy: Number.POSITIVE_INFINITY,
  };
}

/** The bounded stop's (R10; persistent-macos R20 item 2): acks by T+30 s, checkpoints by T+35 s, containers and the channel's checkpoint by T+40 s. */
export function boundedStopDeadlines(t: number): StopDeadlines {
  return {
    ackBy: t + STATE_BOUNDED_ACK_MS,
    checkpointBy: t + STATE_BOUNDED_ACK_MS + STATE_STOP_CHECKPOINT_MS,
    containerBy: t + STATE_BOUNDED_ACK_MS + 2 * STATE_STOP_CHECKPOINT_MS,
    channelStartBy: t + STATE_BOUNDED_ACK_MS + STATE_STOP_CHECKPOINT_MS,
    channelBy: t + STATE_BOUNDED_ACK_MS + 2 * STATE_STOP_CHECKPOINT_MS,
  };
}

/**
 * The bound of a checkpoint taken outside a stop, from the start of its writing: its copies, writes, fsyncs and
 * promotion are local and took at most 220 ms at p95 for the largest asset (the plan's E2d), so a minute is far past
 * anything legitimate — a checkpoint still going then is hung, and its member's next delivery waits on it (R10).
 */
export const STATE_CHECKPOINT_MS = 60_000;

/** Why the checkpoint was abandoned: its bound passed (R10). */
class CheckpointTimedOut extends Error {
  constructor() {
    super('the checkpoint did not finish within its bound');
    this.name = 'CheckpointTimedOut';
  }
}

/** A failure caught while writing an agent's assets: the bound that was hit (its own, or the abort it threw from), or a plain write failure. */
function failureReason(error: unknown, aborted: boolean): SaveFailure {
  if (error instanceof CheckpointTimedOut) return 'timeout';
  return aborted ? 'timeout' : 'write_failed';
}

/** Resolves after `ms` (at once for 0 or less); cancelled with the returned function. */
function sleep(ms: number): { readonly done: Promise<void>; readonly cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, ms));
  });
  return {
    done,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/**
 * Resolves once `signal` aborts (at once if it has); `cancel` drops its listener. A bounded checkpoint races its work
 * against this, so its bound holds whatever the work is waiting on — a copy, a write or an fsync that never returns.
 */
function whenAborted(signal: AbortSignal): { readonly done: Promise<void>; readonly cancel: () => void } {
  let listener: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    listener = () => {
      resolve();
    };
    signal.addEventListener('abort', listener, { once: true });
  });
  return {
    done,
    cancel: () => {
      if (listener !== undefined) signal.removeEventListener('abort', listener);
    },
  };
}

/** What a checkpoint's writing came to: promoted, or the failure to log. */
type Written =
  | { readonly ok: true }
  | { readonly ok: false; readonly asset: AgentAsset; readonly reason: SaveFailure; readonly error: unknown };

/** The kind of a delivery, as the record names it (R9 (a)). */
function pendingKind(message: ConversationMessage): PendingKind {
  if (message.call?.role === 'question') return 'call_question';
  if (message.call?.role === 'gather') return 'call_gather';
  return message.kind === 'input' ? 'input' : 'internal';
}

/** One persisted agent's own state and the collaborators its checkpoint, restore and stop need. */
export interface PersistedAgentProps {
  readonly identity: AgentIdentity;
  readonly key: string;
  readonly assets: readonly AgentAsset[];
  readonly state: StateStore;
  readonly runtime: ContainerRuntime;
  readonly logger: Logger;
  readonly clock: () => Date;
  /** This daemon run's start: an entry of this run is never re-sent (R9 (c)). */
  readonly daemonStartedAt: string;
  readonly pending: PendingRecord;
  /** The promoted generation's pointer at launch, if any. */
  readonly pointer: AgentPointer | undefined;
  readonly recipe: string;
  readonly image: { readonly name: string; readonly source: string; readonly schema: string };
  readonly container: string;
  readonly channel: Channel;
  /** Its handle, once it has joined. */
  readonly handle: () => string | undefined;
  /** The daemon is stopping: a delivery that ends without an ack then keeps its entry for the next run (R9 (c)). */
  readonly closing: () => boolean;
  /** The stop's deadlines, once a stop has begun: every checkpoint from then on is bounded by them (R10). */
  readonly stopDeadlines: () => StopDeadlines | undefined;
}

/** A persisted agent's record, checkpoints and stop (R9, R10). One per running persisted agent. */
export class PersistedAgent {
  private generation: number;
  /** The delivery made to the agent and not yet acknowledged; its ack resolves `acked`. */
  private hand:
    { readonly delivery: Delivery; readonly acked: Promise<void>; readonly resolve: () => void } | undefined;
  /** The checkpoint running, with its controller. */
  private running: { readonly done: Promise<'promoted' | 'failed'>; readonly controller: AbortController } | undefined;
  /** A save has failed in this run: its notice was posted (R6: once per identity per run). */
  private noticed = false;
  /** Deliveries made without an entry: gathers to a full record (R9 (a)). */
  private readonly unrecorded = new Set<string>();
  /**
   * Deliveries acknowledged whose entries may still be in the record: a checkpoint after an ack that failed keeps
   * them (R9 (b)), and the next promoted checkpoint — an ack's, or a stop's with nothing in hand — follows them.
   */
  private readonly acked = new Set<string>();
  /** Each delivery made to it in this run, by id: the conversation it was made in (patterns-phase-5 R1). */
  private readonly conversationOf = new Map<string, string>();

  constructor(private readonly props: PersistedAgentProps) {
    this.generation = props.pointer?.generation ?? 0;
  }

  get identity(): AgentIdentity {
    return this.props.identity;
  }

  get key(): string {
    return this.props.key;
  }

  get assets(): readonly AgentAsset[] {
    return this.props.assets;
  }

  /** The delivery the agent holds and has not acknowledged, if any. */
  get inHand(): Delivery | undefined {
    return this.hand?.delivery;
  }

  /** The checkpoint running now, if any. */
  get checkpointing(): Promise<'promoted' | 'failed'> | undefined {
    return this.running?.done;
  }

  /** The channel's view of it. */
  journal(): MemberJournal {
    return {
      fits: (message, deliveryId) => this.fits(message, deliveryId),
      record: (delivery) => this.record(delivery),
      resending: (delivery) => this.resending(delivery),
      acknowledged: (delivery) => this.acknowledged(delivery),
      unacknowledged: (delivery, reason) => {
        this.unacknowledged(delivery, reason);
      },
      left: () => {
        this.left();
      },
    };
  }

  /** The supervisor made a delivery to the agent: it holds it until its ack. */
  delivered(delivery: Delivery): void {
    let resolve!: () => void;
    const acked = new Promise<void>((r) => (resolve = r));
    this.hand = { delivery, acked, resolve };
  }

  /** Waits for the ack of the delivery in hand until `deadline` (ms since the epoch): true when it came. */
  async ackBy(deadline: number): Promise<boolean> {
    const hand = this.hand;
    if (hand === undefined) return true;
    const wait = sleep(deadline - Date.now());
    try {
      return await Promise.race([hand.acked.then(() => true), wait.done.then(() => false)]);
    } finally {
      wait.cancel();
    }
  }

  private entryOf(delivery: Delivery): PendingEntry {
    const m = delivery.message;
    const kind = pendingKind(m);
    return {
      messageId: m.id,
      conversation: m.conversation,
      deliveryId: delivery.deliveryId,
      daemonStartedAt: this.props.daemonStartedAt,
      afterGeneration: this.generation,
      attempts: 0,
      // For a user's input, the time the user sent it: the resuming launch prints it (R9 (h)).
      savedAt: kind === 'input' ? m.at : this.props.clock().toISOString(),
      kind,
      ...(kind === 'input' ? { user: m.user, text: m.text, to: m.to } : {}),
    };
  }

  private fits(message: ConversationMessage, deliveryId: string): string | undefined {
    const over = this.props.pending.wouldOverflow(this.entryOf({ deliveryId, message, traceparent: '' }));
    if (over === undefined) return undefined;
    const kind = pendingKind(message);
    this.props.logger.warn('state.pending_full', {
      identity: this.props.key,
      entries: over.entries,
      bytes: over.bytes,
      kind,
    });
    return `agent ${this.props.key}'s record of unsaved deliveries is full: at most ${String(PENDING_MAX_ENTRIES)} entries and ${String(PENDING_MAX_BYTES)} bytes`;
  }

  private async record(delivery: Delivery): Promise<void> {
    this.conversationOf.set(delivery.deliveryId, delivery.message.conversation);
    const entry = this.entryOf(delivery);
    if (entry.kind === 'call_gather') {
      const over = this.props.pending.wouldOverflow(entry);
      if (over !== undefined) {
        // A gather has no sender to refuse: it is made without an entry (R9 (a)); all a crash then loses is (d)'s notice.
        this.props.logger.warn('state.pending_full', {
          identity: this.props.key,
          entries: over.entries,
          bytes: over.bytes,
          kind: 'call_gather',
        });
        this.unrecorded.add(delivery.deliveryId);
        return;
      }
    }
    const written = await this.props.pending.add(entry);
    if (!written.ok) this.saveFailed('pending', 'journal_failed', written.error, delivery.message.conversation);
  }

  private async resending(delivery: Delivery): Promise<void> {
    const original = delivery.message.redelivered?.originalMessage;
    const entry = this.props.pending.entries.find((e) => e.messageId === original);
    if (entry === undefined)
      throw new Error(`resending: ${this.props.key} holds no entry for message ${String(original)}`);
    this.conversationOf.set(delivery.deliveryId, delivery.message.conversation);
    // Once, and counted before it goes (R9 (e)): a message that crashes the agent is not re-sent again. Its kept mark
    // is dropped: the promotion after the re-sent turn decides again, on the re-sent conversation (patterns-phase-5 R1).
    const unkept: PendingEntry = { ...entry };
    delete (unkept as { kept?: true }).kept;
    const written = await this.props.pending.replace(entry.deliveryId, {
      ...unkept,
      attempts: entry.attempts + 1,
      deliveryId: delivery.deliveryId,
    });
    if (!written.ok) this.saveFailed('pending', 'journal_failed', written.error, delivery.message.conversation);
    this.props.logger.info('state.redelivered', { identity: this.props.key, originalMessage: entry.messageId });
  }

  /** The ack: the checkpoint that follows it, bounded by the stop's deadlines once a stop has begun (R10). */
  private async acknowledged(delivery: Delivery): Promise<void> {
    this.acked.add(delivery.deliveryId);
    const hand = this.hand;
    if (hand?.delivery.deliveryId === delivery.deliveryId) {
      this.hand = undefined;
      hand.resolve();
    }
    await this.checkpoint(delivery.deliveryId, delivery.message.conversation);
  }

  private unacknowledged(delivery: Delivery, reason: 'agent_exited' | 'expired'): void {
    if (this.hand?.delivery.deliveryId === delivery.deliveryId) this.hand = undefined;
    // A stop of the daemon leaves every entry for the next run's re-send (R9 (c)); the stop has removed a re-send's.
    if (this.props.closing()) return;
    if (this.unrecorded.delete(delivery.deliveryId)) return;
    const { removed, written } = this.props.pending.remove((e) => e.deliveryId === delivery.deliveryId);
    removed.forEach(() => {
      this.props.logger.error('state.redelivery_failed', {
        identity: this.props.key,
        reason,
        error: new Error(`an unsaved delivery ended without an ack: ${reason}`),
      });
    });
    void written.then((w) => {
      if (!w.ok) this.saveFailed('pending', 'journal_failed', w.error);
    });
  }

  /**
   * The agent left the channel (patterns-phase-5 R3): outside a stop, its kept inputs are removed — their conversations
   * end with the harness's reply — each logged `state.redelivery_failed` `agent_exited`; a settle that follows finds
   * none left and writes nothing, so nothing of this run writes the record a relaunch or an erase loads next. A stop
   * leaves them for the next run (R9 (c)).
   */
  private left(): void {
    if (this.props.closing()) return;
    const { removed, written } = this.props.pending.remove((e) => e.kept === true);
    removed.forEach(() => {
      this.props.logger.error('state.redelivery_failed', {
        identity: this.props.key,
        reason: 'agent_exited',
        error: new Error('a kept input whose agent left the channel before its conversation was finished'),
      });
    });
    void written.then((w) => {
      if (!w.ok) this.saveFailed('pending', 'journal_failed', w.error);
    });
  }

  /**
   * A kept input's conversation settled (patterns-phase-5 R3): its kept entries are removed and
   * `state.pending_settled` logged — unless the daemon is stopping and no agent replied, when they are left for the
   * next run.
   */
  private settled(conversation: string): void {
    if (this.props.closing() && !this.props.channel.agentReplied(conversation)) return;
    const { removed, written } = this.props.pending.remove(
      (e) => e.kept === true && this.conversationOfEntry(e) === conversation,
    );
    if (removed.length > 0)
      this.props.logger.info('state.pending_settled', { identity: this.props.key, entries: removed.length });
    this.prune();
    void written.then((w) => {
      if (!w.ok) this.saveFailed('pending', 'journal_failed', w.error);
    });
  }

  /** Forgets the conversation of every delivery the record no longer holds: the map stays as small as the record. */
  private prune(): void {
    const held = new Set(this.props.pending.entries.map((e) => e.deliveryId));
    for (const id of this.conversationOf.keys()) if (!held.has(id)) this.conversationOf.delete(id);
  }

  /** The conversation an entry's delivery was made in during this run; else the one the record names. */
  private conversationOfEntry(entry: PendingEntry): string {
    return this.conversationOf.get(entry.deliveryId) ?? entry.conversation;
  }

  /**
   * A stop that got no ack (R10, R9 (f)): the previous checkpoint kept, `state.stop_unsaved` logged, and every
   * re-sent entry not acknowledged removed as `stop_unsaved` — a message is never re-sent twice; the rest stay for
   * the next run.
   */
  async stopUnsaved(): Promise<void> {
    this.props.logger.warn('state.stop_unsaved', { identity: this.props.key });
    const { removed, written } = this.props.pending.remove((e) => e.attempts > 0);
    removed.forEach(() => {
      this.props.logger.error('state.redelivery_failed', {
        identity: this.props.key,
        reason: 'stop_unsaved',
        error: new Error('a re-sent delivery got no ack before its stop'),
      });
    });
    const w = await written;
    if (!w.ok) this.saveFailed('pending', 'journal_failed', w.error);
  }

  /**
   * One checkpoint (R4, R6, R10, R11): every persisted asset copied out of the container through the tar reader into a
   * new generation, bounded, then promoted, and the journal cleared through `lastDelivery`. Runs one at a time; one
   * begun during a stop, or running when a stop begins, is bounded by STATE_STOP_CHECKPOINT_MS from its start and by
   * the stop's checkpoint deadline, and abandoned past it as a failed save with reason `timeout`, the previous
   * generation kept. A failure is R6's degraded mode and never throws.
   */
  checkpoint(lastDelivery: string | null, conversation?: string): Promise<'promoted' | 'failed'> {
    const previous = this.running?.done ?? Promise.resolve('promoted' as const);
    const controller = new AbortController();
    const done = previous.then(() => this.save(lastDelivery, controller, conversation));
    this.running = { done, controller };
    void done.then(() => {
      if (this.running?.done === done) this.running = undefined;
    });
    const deadlines = this.props.stopDeadlines();
    if (deadlines !== undefined) this.bound(deadlines);
    return done;
  }

  /** Bounds the running checkpoint by a stop's deadlines (R10): 5 s from now, and the stop's checkpoint deadline. */
  bound(deadlines: StopDeadlines): void {
    const run = this.running;
    if (run === undefined) return;
    const until = Math.min(Date.now() + STATE_STOP_CHECKPOINT_MS, deadlines.checkpointBy);
    const timer = sleep(until - Date.now());
    void timer.done.then(() => {
      run.controller.abort(new CheckpointTimedOut());
    });
    void run.done.then(timer.cancel, timer.cancel);
  }

  /**
   * The checkpoint: its writing raced against its bound. Abandoned, it is a failed save with reason `timeout` at once;
   * the writing goes on in the background, discards its generation when it sees the abort, and logs nothing more —
   * unless its promotion was already under way, in which case the complete generation it promotes is logged as such.
   */
  private async save(
    delivery: string | null,
    controller: AbortController,
    conversation: string | undefined,
  ): Promise<'promoted' | 'failed'> {
    const { state, key } = this.props;
    // What this checkpoint follows (R9 (b)): the ack's delivery, or — a stop's checkpoint with nothing in hand — the
    // newest acknowledged delivery a failed checkpoint left in the record; its promotion clears through it (the
    // lead's decision of 2026-09-29 made that path reachable; found by the bounded review of 8c8af95).
    const lastDelivery = delivery ?? this.newestAcknowledged();
    const dir = state.agentDir(this.props.identity);
    const signal = controller.signal;
    // Outside a stop, the checkpoint's own bound; a stop adds its tighter one (bound).
    const own = sleep(STATE_CHECKPOINT_MS);
    void own.done.then(() => {
      controller.abort(new CheckpointTimedOut());
    });
    const abandoned = whenAborted(signal);
    const outcome: Written = await Promise.race([
      this.write(signal, lastDelivery),
      abandoned.done.then((): Written => ({
        ok: false,
        asset: present(this.props.assets[0], "the persisted agent's first asset"),
        reason: 'timeout',
        error: signal.reason,
      })),
    ]);
    abandoned.cancel();
    own.cancel();
    if (!outcome.ok) {
      this.saveFailed(outcome.asset, outcome.reason, outcome.error, conversation);
      if (outcome.reason === 'over_bound')
        await state.setFull(dir, outcome.asset, true).catch((error: unknown) => {
          this.props.logger.error('state.cleanup_failed', { identity: key, error });
        });
      // R9 (b): an entry leaves the record only when a checkpoint that follows it is promoted. A failed one keeps the
      // acknowledged message, re-sent at the next run with the retry line (the owner's answer to resume-duplicate-actions,
      // "allow repeats, and tell the agent it is a retry"); the failure itself is state.save_failed above, at error.
      return 'failed';
    }
    for (const asset of this.props.assets)
      await state.setFull(dir, asset, false).catch((error: unknown) => {
        this.props.logger.error('state.cleanup_failed', { identity: key, error });
      });
    if (lastDelivery !== null) await this.clearThrough(lastDelivery);
    return 'promoted';
  }

  /** Copies every asset into a new generation and promotes it; never rejects. A failed generation is discarded. */
  private async write(signal: AbortSignal, lastDelivery: string | null): Promise<Written> {
    const { state, key } = this.props;
    const dir = state.agentDir(this.props.identity);
    let gen;
    try {
      gen = await state.begin(dir);
    } catch (error) {
      return {
        ok: false,
        asset: present(this.props.assets[0], "the persisted agent's first asset"),
        reason: 'write_failed',
        error,
      };
    }
    const discard = (g: typeof gen) =>
      g.discard().catch((error: unknown) => {
        this.props.logger.error('state.cleanup_failed', { identity: key, generation: g.generation, error });
      });
    let failure: { readonly asset: AgentAsset; readonly reason: SaveFailure; readonly error: unknown } | undefined;
    try {
      failure = await this.copyAssets(gen, signal);
      if (failure === undefined && signal.aborted) throw signal.reason;
    } catch (error) {
      failure = {
        asset: present(this.props.assets[0], "the persisted agent's first asset"),
        reason: failureReason(error, signal.aborted),
        error,
      };
    }
    if (failure !== undefined) {
      await discard(gen);
      return { ok: false, ...failure };
    }
    try {
      const pointer = await gen.promote<AgentPointer>(
        {
          kind: 'agent',
          recipe: this.props.recipe,
          image: this.props.image.name,
          source: this.props.image.source,
          schema: this.props.image.schema,
          lastDelivery,
          handle: this.props.handle() ?? '',
        },
        key,
      );
      this.generation = pointer.generation;
      return { ok: true };
    } catch (error) {
      // A failure before the pointer's rename leaves the previous pointer, and discard removes the new generation; one
      // after it (PromotionUnsynced) leaves the new pointer, and discard removes nothing. Either is said (R4, R6).
      await discard(gen);
      return {
        ok: false,
        asset: present(this.props.assets[0], "the persisted agent's first asset"),
        reason: 'write_failed',
        error,
      };
    }
  }

  /** Copies every configured asset out of the container into `gen`; the first failure, or undefined once all are copied. */
  private async copyAssets(
    gen: GenerationWriter,
    signal: AbortSignal,
  ): Promise<{ readonly asset: AgentAsset; readonly reason: SaveFailure; readonly error: unknown } | undefined> {
    const { runtime } = this.props;
    for (const asset of this.props.assets) {
      let copied: { ok: true } | { ok: false; detail: string } = { ok: true };
      const result = await gen.writeTar(asset, ASSET_BOUNDS[asset], async (push) => {
        copied = await runtime.copyOut(
          this.props.container,
          `/${asset}`,
          async (chunk) => ((await push(chunk)) === undefined ? 'more' : 'stop'),
          signal,
        );
      });
      if (!result.ok) return { asset, reason: result.reason, error: new Error(`${result.entry}: ${result.detail}`) };
      const c = copied as { ok: true } | { ok: false; detail: string };
      if (!c.ok) return { asset, reason: 'copy_failed', error: new Error(c.detail) };
    }
    return undefined;
  }

  /** The newest delivery in the record that was acknowledged, if any. */
  private newestAcknowledged(): string | null {
    const entries = this.props.pending.entries;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const id = present(entries[i], 'a pending entry at a valid index').deliveryId;
      if (this.acked.has(id)) return id;
    }
    return null;
  }

  /**
   * Removes the entry of `deliveryId` and every entry before it (R9 (b)) but the kept ones; a user's input among them
   * whose conversation is unfinished but for this delivery is kept instead, `state.pending_kept`, and its conversation's
   * settle watched (patterns-phase-5 R1–R3).
   */
  private async clearThrough(deliveryId: string): Promise<void> {
    this.unrecorded.delete(deliveryId);
    const entries = this.props.pending.entries;
    const at = entries.findIndex((e) => e.deliveryId === deliveryId);
    const keep = new Set(
      entries
        .slice(0, at + 1)
        .filter(
          (e) =>
            e.kind === 'input' &&
            e.kept !== true &&
            this.props.channel.unfinishedWithout(this.conversationOfEntry(e), deliveryId),
        )
        .map((e) => e.deliveryId),
    );
    const { removed, marked, written } = this.props.pending.clearThrough(deliveryId, keep);
    if (marked.length > 0) {
      this.props.logger.info('state.pending_kept', { identity: this.props.key, entries: marked.length });
      for (const conversation of new Set(marked.map((e) => this.conversationOfEntry(e))))
        this.props.channel.whenSettled(conversation, () => {
          this.settled(conversation);
        });
    }
    for (const e of removed) this.acked.delete(e.deliveryId);
    this.acked.delete(deliveryId);
    this.prune();
    const w = await written;
    if (!w.ok) this.saveFailed('pending', 'journal_failed', w.error);
  }

  /**
   * R6's degraded mode: `state.save_failed` at error, and — the first time per identity per daemon run — the
   * always-shown notice on the channel, in the conversation whose delivery the save followed when there is one.
   */
  private saveFailed(asset: AgentAsset | 'pending', reason: SaveFailure, error: unknown, conversation?: string): void {
    this.props.logger.error('state.save_failed', { identity: this.props.key, asset, reason, error });
    if (this.noticed) return;
    this.noticed = true;
    const handle = this.props.handle() ?? this.props.identity.name;
    this.props.channel.notice(
      `⚠ ${handle}'s state is not being saved (${reason}); what it does from now on is lost when it stops`,
      conversation,
    );
  }
}

/** What a launch does with the record's entries (R9 (b)–(e)): the re-sends, and whether any was skipped (for the notice). */
export interface ResendPlan {
  readonly resends: readonly (Resend & { readonly entry: PendingEntry })[];
  readonly skipped: number;
}

/**
 * At a launch, before anything is re-sent (R9 (b)–(e)): the entries up to the pointer's lastDelivery removed
 * (`state.pending_cleared`); `state.pending_found` for what remains; then each entry removed and logged when it
 * must not be re-sent — this run's (`same_run`), one re-sent before (`daemon_lost`), an agent's message or a call's
 * in a conversation whose input is re-sent (`state.redelivery_superseded`, patterns-phase-5 R4) or in another
 * (`state.redelivery_skipped`), a user the rule refuses (`user_invalid`) — and the rest returned, in order.
 */
export async function planResends(props: {
  readonly key: string;
  readonly pending: PendingRecord;
  readonly lastDelivery: string | null;
  readonly daemonStartedAt: string;
  readonly logger: Logger;
}): Promise<ResendPlan> {
  const { key, pending, logger } = props;
  if (props.lastDelivery !== null && pending.entries.some((e) => e.deliveryId === props.lastDelivery)) {
    const { removed, written } = pending.clearThrough(props.lastDelivery);
    await requireWritten(written);
    logger.info('state.pending_cleared', { identity: key, entries: removed.length });
  }
  if (pending.entries.length === 0) return { resends: [], skipped: 0 };
  logger.warn('state.pending_found', {
    identity: key,
    entries: pending.entries.length,
    savedAt: present(pending.entries[0], 'the first pending entry').savedAt,
  });
  const failed = (reason: string) => {
    logger.error('state.redelivery_failed', {
      identity: key,
      reason,
      error: new Error(`an unsaved delivery cannot be re-sent: ${reason}`),
    });
  };
  let skipped = 0;
  // The conversations whose user input this launch re-sends: an agent's message or a call's in one of them is
  // superseded — the re-sent input replays the conversation — and goes with no notice (patterns-phase-5 R4).
  const replayed = new Set(
    pending.entries
      .filter(
        (e) =>
          e.kind === 'input' &&
          e.attempts === 0 &&
          e.daemonStartedAt !== props.daemonStartedAt &&
          userIdProblem(present(e.user, "an input entry's user"), { isDefault: false }) === undefined,
      )
      .map((e) => e.conversation),
  );
  const { written } = pending.remove((e) => {
    if (e.attempts === 0 && e.daemonStartedAt === props.daemonStartedAt) {
      failed('same_run');
      return true;
    }
    if (e.kind !== 'input' && replayed.has(e.conversation)) {
      logger.info('state.redelivery_superseded', { identity: key, kind: e.kind });
      return true;
    }
    if (e.kind !== 'input') {
      skipped += 1;
      logger.warn('state.redelivery_skipped', { identity: key, kind: e.kind });
      return true;
    }
    if (e.attempts > 0) {
      failed('daemon_lost');
      return true;
    }
    if (userIdProblem(present(e.user, "an input entry's user"), { isDefault: false }) !== undefined) {
      failed('user_invalid');
      return true;
    }
    return false;
  });
  await requireWritten(written);
  return {
    resends: pending.entries.map((entry) => ({
      entry,
      originalMessage: entry.messageId,
      originalConversation: entry.conversation,
      user: present(entry.user, "an input entry's user"),
      text: present(entry.text, "an input entry's text"),
      savedAt: entry.savedAt,
      addressed: entry.to !== null && entry.to !== undefined,
    })),
    skipped,
  };
}

/** A launch cannot go on with a record it could not write: that would re-send what it just decided not to. */
async function requireWritten(written: Promise<{ ok: true } | { ok: false; error: unknown }>): Promise<void> {
  const w = await written;
  if (!w.ok) throw new Error('the record of unsaved deliveries could not be written', { cause: w.error });
}

/**
 * The restore archive (R11, R13): the stored generation's tars, each without its end marker, then the recipe's
 * documents the restored /workspace lacks — within R6's bound, the first that would pass it and every later one
 * skipped — then the end marker. Streamed from the stored files as it is read. Returns the documents added and
 * skipped, for the caller's log.
 */
export async function restoreArchive(props: {
  readonly state: StateStore;
  readonly dir: string;
  readonly pointer: AgentPointer;
  readonly documents: readonly { readonly path: string; readonly content: Uint8Array }[];
  readonly mtime: number;
}): Promise<{
  readonly archive: () => AsyncIterable<Uint8Array>;
  readonly added: readonly string[];
  readonly skipped: readonly string[];
}> {
  const { state, dir, pointer } = props;
  const stored = (Object.keys(pointer.assets) as AgentAsset[]).map((asset) => state.assetPath(dir, pointer, asset));
  const workspace =
    pointer.assets.workspace === undefined
      ? undefined
      : await readStoredEntries(state.assetPath(dir, pointer, 'workspace'), 'workspace');
  const present = new Map((workspace ?? []).map((e): [string, TarEntry] => [e.name, e]));
  let files = (workspace ?? []).filter((e) => e.type === 'file').length;
  let bytes = (workspace ?? []).reduce((n, e) => n + (e.type === 'file' ? e.size : 0), 0);
  const extra: Buffer[] = [];
  const added: string[] = [];
  const skipped: string[] = [];
  // Without a persisted /workspace, the documents still go in: the archive replaces the documents' own copy.
  if (workspace === undefined) extra.push(tarDirectory('workspace', props.mtime));
  for (const doc of props.documents) {
    const name = `workspace/${doc.path}`;
    if (present.has(name)) continue;
    if (
      workspace !== undefined &&
      (files + 1 > ASSET_BOUNDS.workspace.maxFiles || bytes + doc.content.byteLength > ASSET_BOUNDS.workspace.maxBytes)
    ) {
      skipped.push(doc.path);
      continue;
    }
    const parts = name.split('/');
    for (let i = 2; i < parts.length; i += 1) {
      const d = parts.slice(0, i).join('/');
      if (!present.has(d)) {
        extra.push(tarDirectory(d, props.mtime));
        present.set(d, { name: d, type: 'directory' });
      }
    }
    extra.push(tarFile(name, doc.content, props.mtime));
    present.set(name, { name, type: 'file', size: doc.content.byteLength, sha256: '' });
    files += 1;
    bytes += doc.content.byteLength;
    added.push(doc.path);
  }
  const archive = async function* (): AsyncIterable<Uint8Array> {
    for (const file of stored) {
      // Each stored tar ends with two zero blocks: everything before them is its entries.
      const size = await state.fileSize(file);
      yield* createReadStream(file, { start: 0, end: size - 2 * TAR_BLOCK - 1, highWaterMark: 1 << 20 });
    }
    for (const part of extra) yield part;
    yield Buffer.alloc(2 * TAR_BLOCK);
  };
  return { archive, added, skipped };
}

/** A persisted channel's own state and the collaborators its final checkpoint needs. */
export interface PersistedChannelProps {
  readonly channel: string;
  readonly team: string;
  /** What the team persists (R1): the board, the channel's file space (agent-files R15), or both. */
  readonly assets: readonly ChannelAsset[];
  /** The channel's file space, snapshotted under its lock with every unused upload left out (agent-files R15). */
  readonly files: FileSpaces;
  /** Posts the always-shown notice on the channel (R6: a failed save of the files, once per run). */
  readonly notice: (text: string) => void;
  readonly state: StateStore;
  readonly logger: Logger;
  readonly board: () => Blackboard;
  /** An agent that keeps memory is online on the channel now (R7). */
  readonly keepsMemoryOnline: () => boolean;
  readonly pointer: ChannelPointer | undefined;
  readonly stopDeadlines: () => StopDeadlines | undefined;
}

/**
 * A persisted channel's board (R14) and file space (agent-files R15): checkpointed after every ack on the channel, one
 * running and one waiting at most, both in one generation.
 */
export class PersistedChannel {
  private tainted: boolean;
  private running: Promise<void> | undefined;
  private waiting = false;
  /** Set once the stop's final checkpoint begins: no other checkpoint starts after it (R10). */
  private finalising = false;
  private fullLogged = false;
  /** A save of the files has failed in this run: its notice was posted (R6: once per run). */
  private filesNoticed = false;

  constructor(private readonly props: PersistedChannelProps) {
    this.tainted = props.pointer?.memoryTainted === true;
  }

  get team(): string {
    return this.props.team;
  }

  /** What the team persists on this channel (R14's mismatch check compares a joining team's with it). */
  get assets(): readonly ChannelAsset[] {
    return this.props.assets;
  }

  /** Whether its saved state was written while an agent that keeps memory was online (R7). */
  get memoryTainted(): boolean {
    return this.tainted;
  }

  /** Asks for a checkpoint: runs now, or once the running one ends; never more than one waiting. */
  request(): void {
    if (this.finalising) return;
    if (this.running !== undefined) {
      this.waiting = true;
      return;
    }
    this.running = this.run().finally(() => {
      this.running = undefined;
      if (this.waiting && !this.finalising) {
        this.waiting = false;
        this.request();
      }
    });
  }

  /** The stop's final checkpoint (R10): after the running one, bounded by 5 s and the stop's channel deadline. */
  async final(deadlines: StopDeadlines): Promise<void> {
    // From here no checkpoint starts but this one: a waiting request is folded into it, never run beside it.
    this.finalising = true;
    this.waiting = false;
    const controller = new AbortController();
    const until = Math.min(Date.now() + STATE_STOP_CHECKPOINT_MS, deadlines.channelBy);
    const timer = sleep(until - Date.now());
    void timer.done.then(() => {
      controller.abort(new CheckpointTimedOut());
    });
    try {
      // A checkpoint still running when the final one is due counts against the same bound.
      const abandoned = whenAborted(controller.signal);
      await Promise.race([this.running, abandoned.done]);
      abandoned.cancel();
      if (controller.signal.aborted) {
        this.props.logger.error('state.save_failed', {
          identity: this.props.channel,
          asset: present(this.props.assets[0], "the persisted channel's first asset"),
          reason: 'timeout',
          error: controller.signal.reason,
        });
        return;
      }
      await this.save(controller.signal);
    } finally {
      timer.cancel();
    }
  }

  /** Logs `state.channel_full` once per channel per run when the board is full (R14). */
  boardFull(): void {
    if (this.fullLogged) return;
    this.fullLogged = true;
    this.props.logger.warn('state.channel_full', {
      channel: this.props.channel,
      asset: 'board',
      reset: `asha --reset-state channel=${this.props.channel}`,
    });
  }

  private async run(): Promise<void> {
    const deadlines = this.props.stopDeadlines();
    const controller = new AbortController();
    const until =
      deadlines === undefined
        ? Date.now() + STATE_CHECKPOINT_MS
        : Math.min(Date.now() + STATE_STOP_CHECKPOINT_MS, deadlines.channelBy);
    const timer = sleep(until - Date.now());
    void timer.done.then(() => {
      controller.abort(new CheckpointTimedOut());
    });
    try {
      await this.save(controller.signal);
    } finally {
      timer.cancel();
    }
  }

  /**
   * The channel's checkpoint, raced against its bound as an agent's is: abandoned, it is a failed save with reason
   * `timeout` at once, and the writing, going on in the background, discards its generation and logs nothing more.
   * A failed save of the files says so on the channel once per run (R6), the previous generation kept.
   */
  private async save(signal: AbortSignal): Promise<void> {
    const { logger, channel } = this.props;
    const abandoned = whenAborted(signal);
    const outcome = await Promise.race([
      this.write(signal),
      abandoned.done.then(() => ({
        ok: false as const,
        asset: present(this.props.assets[0], "the persisted channel's first asset"),
        reason: 'timeout' as const,
        error: signal.reason as unknown,
      })),
    ]);
    abandoned.cancel();
    if (outcome.ok) return;
    logger.error('state.save_failed', {
      identity: channel,
      asset: outcome.asset,
      reason: outcome.reason,
      error: outcome.error,
    });
    if (outcome.asset === 'files' && !this.filesNoticed) {
      this.filesNoticed = true;
      this.props.notice(
        `⚠ channel ${channel}'s files are not being saved (${outcome.reason}); what changes in /channel from now on is lost when it stops`,
      );
    }
  }

  /** Writes the board and the file space into a new generation and promotes it; never rejects. A failed generation is discarded. */
  private async write(signal: AbortSignal): Promise<
    | { readonly ok: true }
    | {
        readonly ok: false;
        readonly asset: ChannelAsset;
        readonly reason: 'timeout' | 'write_failed' | 'over_bound' | 'invalid_entry' | 'copy_failed';
        readonly error: unknown;
      }
  > {
    const { state, logger, channel } = this.props;
    const dir = state.channelDir(channel);
    const snapshot: BoardSnapshot | undefined = this.props.assets.includes('board')
      ? this.props.board().snapshot()
      : undefined;
    const tainted = this.tainted || this.props.keepsMemoryOnline();
    let gen: GenerationWriter | undefined;
    let asset: ChannelAsset = present(this.props.assets[0], "the persisted channel's first asset");
    const discard = async (): Promise<void> => {
      if (gen === undefined) return;
      const g = gen;
      await g.discard().catch((cleanup: unknown) => {
        logger.error('state.cleanup_failed', { identity: channel, generation: g.generation, error: cleanup });
      });
    };
    try {
      gen = await state.begin(dir);
      if (snapshot !== undefined) {
        asset = 'board';
        await gen.writeJson('board', snapshot, snapshot.entries.length);
      }
      if (this.props.assets.includes('files')) {
        asset = 'files';
        const failed = await this.writeFilesAsset(gen, signal);
        if (failed !== undefined) {
          await discard();
          return { ok: false, asset: 'files', ...failed };
        }
      }
      if (signal.aborted) throw signal.reason;
      await gen.promote<ChannelPointer>(
        { kind: 'channel', team: this.props.team, lastDelivery: null, memoryTainted: tainted },
        channel,
      );
      this.tainted = tainted;
      return { ok: true };
    } catch (error) {
      await discard();
      return { ok: false, asset, reason: signal.aborted ? 'timeout' : 'write_failed', error };
    }
  }

  /**
   * Writes the files asset into `gen`, under the channel's snapshot lock (agent-files R15: every upload of this run
   * no posted message named is left out, its records with it — the space tells which under its lock, before the
   * first byte); the failure (without `asset`, which the caller already knows), or undefined once written.
   */
  private async writeFilesAsset(
    gen: GenerationWriter,
    signal: AbortSignal,
  ): Promise<
    { readonly reason: 'timeout' | 'invalid_entry' | 'over_bound' | 'copy_failed'; readonly error: unknown } | undefined
  > {
    const { channel } = this.props;
    let plan: SnapshotPlan | undefined;
    let taken: Awaited<ReturnType<FileSpaces['snapshot']>> | undefined;
    const result = await gen.writeTar(
      'files',
      FILES_BOUNDS,
      async (push) => {
        taken = await this.props.files.snapshot(
          channel,
          (given) => {
            plan = given;
            return async (chunk) => ((await push(chunk)) === undefined ? 'more' : 'stop');
          },
          signal,
        );
      },
      { skip: (name) => plan?.skip(name) ?? false },
    );
    if (!result.ok) return { reason: result.reason, error: new Error(`${result.entry}: ${result.detail}`) };
    const done = taken;
    if (done === undefined || !done.ok || plan === undefined)
      return {
        reason: signal.aborted ? 'timeout' : 'copy_failed',
        error: new Error(done === undefined || done.ok ? 'no snapshot was taken' : done.detail),
      };
    await gen.writeFilesTable(plan.table);
    return undefined;
  }
}

/**
 * A persisted channel's saved file space (agent-files R15), for the space its team's first member creates or an
 * empty one: its `channel/` tar, streamed from the stored file, and its file table; undefined when none is saved.
 */
export async function savedFiles(
  state: StateStore,
  pointer: ChannelPointer | undefined,
  channel: string,
): Promise<SpaceFill | undefined> {
  if (pointer?.assets.files === undefined) return undefined;
  const dir = state.channelDir(channel);
  const path = state.assetPath(dir, pointer, 'files');
  const table = await state.readFilesTable(dir, pointer);
  return {
    archive: async function* () {
      yield* createReadStream(path, { highWaterMark: 1 << 20 });
    },
    table,
  };
}

/** The board a persisted channel resumes from (R14), or undefined when none is saved. A malformed one is StateStoreCorrupt. */
export async function savedBoard(
  state: StateStore,
  pointer: ChannelPointer | undefined,
  channel: string,
): Promise<BoardSnapshot | undefined> {
  if (pointer?.assets.board === undefined) return undefined;
  const dir = state.channelDir(channel);
  const raw = await state.readAsset(dir, pointer, 'board');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new StateStoreCorrupt(state.assetPath(dir, pointer, 'board'), `not JSON (${(error as Error).name})`);
  }
  const board = parsed as { session?: unknown; entries?: unknown };
  const entryOk = (e: unknown): boolean => {
    const o = e as Record<string, unknown> | null;
    return (
      typeof o === 'object' &&
      o !== null &&
      typeof o['id'] === 'number' &&
      typeof o['author'] === 'string' &&
      typeof o['ts'] === 'string' &&
      typeof o['text'] === 'string' &&
      typeof o['session'] === 'number'
    );
  };
  if (
    typeof board.session !== 'number' ||
    !Number.isInteger(board.session) ||
    board.session < 1 ||
    !Array.isArray(board.entries) ||
    !board.entries.every(entryOk)
  ) {
    throw new StateStoreCorrupt(
      state.assetPath(dir, pointer, 'board'),
      'not a board: expected {session, entries: [{id, author, ts, text, session}]}',
    );
  }
  return board as BoardSnapshot;
}
