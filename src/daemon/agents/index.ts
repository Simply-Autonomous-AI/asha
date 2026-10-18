// Agents: bringing one online on a channel (runtime, model, model server,
// image, container, channel connection), keeping track of it while it runs,
// and carrying its channel and model calls. An agent is online once its
// container has opened its channel stream and been given its handle; it stays
// online until its container exits or the daemon stops.
//
// The agent API identifies an agent only by its random per-agent token, held
// in this instance; the handle is its name on the channel.

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { dirname, join } from 'node:path';

import {
  AGENT_STOP_GRACE_MS,
  RESTART_EXIT_WAIT_MS,
  STATE_STOP_MIN_GRACE_MS,
  AgentEnv,
  type AgentAsset,
  type AgentInfo,
  type BlackboardReadResponse,
  type AgentSummary,
  type CallRequest,
  type ChannelMessage,
  type ResumedFrom,
  type ConsultResponse,
  type ChatMessage,
  type ChatRequest,
  type ChatResponse,
  type ConversationErrorReason,
  type ConversationMessage,
  type EmbedRequest,
  type EmbedResponse,
  type Delivery,
  type ApprovedCall,
  type ModelDoneEvent,
  type ModelFailureReason,
  type ModuleCallResponse,
  type ModuleToolOffer,
  type OnlinePhase,
  type PostRequest,
  type EraseFailureReason,
  type StateEraseEvent,
  type StateListResponse,
  type StateRefusalReason,
  type StateRemoved,
  type StateSelector,
  type ToolDefinition,
  type TraceParent,
  type LaunchGrant,
  type LaunchRefusalReason,
  isHarnessStatus,
  launchFailedStatus,
  launchingStatus,
  resentStatus,
  restartFailedStatus,
  restartingStatus,
  restartLimitStatus,
  restartResentLimitStatus,
  traceReasonOf,
} from '../../shared/protocol.js';
import { traceIdFor } from '../../shared/trace-id.js';
import { present } from '../../shared/assert-present.js';
import { byCodeUnit } from '../../shared/order.js';
import { MAX_TOOLS, SELECTABLE_CHANNEL_TOOL_NAMES, TOOL_NAME_PATTERN, argumentsProblem } from '../../shared/tools.js';
import { canonicalJson } from '../../shared/jcs.js';
import {
  ModuleRefused,
  ModuleUnavailable,
  buildArguments,
  checkLaunchModules,
  comparableRoot,
  cutResult,
  isCloudGrantedRecipe,
  sharedRootRefusal,
  realSetTimer,
  settledWithin,
  type ComparedRecipe,
  type GrantedTool,
  type LaunchModules,
  type ModuleServices,
  type ProviderModelRef,
  enableRefusal,
  type ApprovalRefusal,
  type ApprovalRequest,
  type CallOutcome,
  type Caps,
  type EnableRefusal,
  type Reservation,
} from '../modules/index.js';
import type { CommandDeclaration } from '../../shared/modules.js';
import { Blackboard, type BlackboardPostResult } from '../blackboard/index.js';
import {
  CallRefused,
  ChannelNameInvalid,
  PendingFull,
  UnknownHandle,
  type CallAnswer,
  type Channel,
} from '../channel/index.js';
import {
  ContainerRuntimeError,
  ContainerStoppedBeforeStart,
  ImageBuildFailed,
  SOURCE_LABEL,
  type ContainerRuntime,
  type CopyOutcome,
  type EnsuredImage,
  type OneShot,
  type StopMode,
} from '../container-runtime/index.js';
import { ImageManifestInvalid } from '../../shared/tools.js';
import {
  UnknownImage,
  UnknownRecipe,
  UnknownTeam,
  checkPersistence,
  guidanceOf,
  loadDocuments,
  type ChatModelEntry,
  type EmbeddingModelEntry,
  type ServedEntry,
  type Definitions,
  type GuidanceText,
  type ImageDefinition,
  type LoadedDocument,
  type LaunchableRecipe,
  type Recipe,
  type RestartPolicy,
  type RootSpec,
  type Team,
  type ToolSelection,
  resolveTools,
} from '../definitions/index.js';
import { FileSpaceUnavailable, SpaceHoldsFiles, type FileSpaces, type SpaceFill } from '../files/index.js';
import { PrerequisiteMissing, ToolInstallFailed } from '../host-tools/index.js';
import { ERASE_USER_LABEL, ImageSourceMissing, STATE_SCHEMA_LABEL, stageAgentImage } from '../images/index.js';
import type { Logger } from '../log.js';
import {
  ABANDONED,
  CHAT_QUEUE_BOUND_MS,
  REQUEST_CLOSED,
  STORE_ABANDONED,
  chatCompletion,
  embeddings,
  storeIdlePrompts,
  type ChatCompletion,
  type ChatStats,
  type ModelDelta,
} from '../model-gateway/index.js';
import { providerChat, providerEmbed, type ProviderCallProps } from '../modules/provider.js';
import { ModelServerFailed, type ModelLease, type ModelServer } from '../model-server/index.js';
import { ModelDigestMismatch, ModelFetchFailed, type CachedModel, type ModelStore } from '../model-store/index.js';
import type { OpenSpan, Tracer } from '../traces/index.js';
import { tail } from '../process/index.js';
import { LockHeld } from '../process/index.js';
import {
  ASSET_BOUNDS,
  StateInsideGitTree,
  TAR_BLOCK,
  identityKey,
  readStoredEntries,
  type AgentIdentity,
  type AgentPointer,
  type ChannelPointer,
  type StateStore,
  type TarEntry,
} from '../state/index.js';
import {
  PersistedAgent,
  PersistedChannel,
  fullStopDeadlines,
  planResends,
  restoreArchive,
  savedBoard,
  savedFiles,
  type ResendPlan,
  type StopDeadlines,
} from './persisted.js';

/** The one selectable channel tool (agent-files R12). */
const REPLY_WITH_FILES_TOOL_NAME = SELECTABLE_CHANNEL_TOOL_NAMES[0];
/** The selectable channel tool that asks the user (patterns-phase-3 R23). */
const ASK_USER_TOOL_NAME = SELECTABLE_CHANNEL_TOOL_NAMES[1];

export { boundedStopDeadlines, type StopDeadlines } from './persisted.js';

/** A launch's runtime dependencies: definitions, the container runtime, the model gateway and store, and every other collaborator AgentSupervisor calls through, injected rather than imported. */
export interface AgentSupervisorProps {
  readonly definitions: Definitions;
  readonly store: ModelStore;
  readonly modelServer: ModelServer;
  readonly runtime: ContainerRuntime;
  readonly logger: Logger;
  readonly fetch: typeof fetch;
  /** Repo root, for staging images. */
  readonly root: string;
  readonly stagingDir: string;
  /** Each agent's container output goes to <agentLogsDir>/<agent id>.log. */
  readonly agentLogsDir: string;
  /** The daemon's port; known only once it is listening. */
  readonly daemonPort: () => number;
  /**
   * Bound on one embedding call made on an agent's behalf. A chat call is bounded by inactivity instead, by the
   * gateway's queue and idle bounds (model-streaming R2).
   */
  readonly chatTimeoutMs: number;
  /** Starts the asha.chat and asha.embed spans. */
  readonly tracer: Tracer;
  /** Timestamps blackboard entries. */
  readonly clock: () => Date;
  /** Saved agent and channel state (docs/plans/agent-persistence.md). */
  readonly state: StateStore;
  /** This daemon run's start, ISO 8601: an unsaved delivery of this run is never re-sent (R9 (c)). */
  readonly daemonStartedAt: string;
  /** The channel file spaces (docs/plans/agent-files.md): one per channel, before its first agent starts (R10). */
  readonly files: FileSpaces;
  /**
   * The extension modules (docs/plans/extension-modules.md): what is installed, the host that runs their containers,
   * the plugin runner, the approvals, the meter and the audit. With none installed, nothing of it is used (R38).
   */
  readonly modules: ModuleServices;
  /** The user's home folder: what a root's `~/` names (R30). */
  readonly userHome: string;
  /** ASHA_HOME, resolved: no root may lie in or around it, and no plugin path under it (R30, R32). */
  readonly ashaHome: string;
}

/** A channel's stop failed (docs/plans/portal-demo-stop.md R2): logged `agent.channel_stop_failed`, with its cause. */
export class ChannelStopFailed extends Error {
  constructor(
    /** The channel whose stop failed. */
    readonly channel: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`the stop of channel ${channel} failed: ${detail}`, options);
    this.name = 'ChannelStopFailed';
  }
}

/**
 * The agent's container exited, or did not connect in time. Its message names the container, its log file and
 * its exit code; the log's last lines are in `tail`, never in the message (agent-persistence R15's privacy rule:
 * the tail holds model-written and users' text), and only the launching command's `✗` line shows them.
 */
export class AgentStartFailed extends Error {
  constructor(
    /** The container that did not come online. */
    readonly container: string,
    detail: string,
    /** The last lines of its log, for the CLI user who launched it; '' when there is no log to show. */
    readonly tail = '',
  ) {
    super(`agent ${container} did not come online: ${detail}`);
    this.name = 'AgentStartFailed';
  }
}

/**
 * What kept a restart from coming online, as its chat line says it (docs/plans/demo-scene-refresh.md R16; the code
 * review's round 3), and the container's exit code when it was an exit: the agent's own container exited, it was not
 * online within its startup bound, its container was lost (its `docker start` killed, or never made), or the start
 * failed before any container ran — an image, a model, a module, the runtime. Only an agent start's failure names an
 * exit: a module's proxy that exited is no exit of the agent's.
 */
function restartFailureKind(error: unknown): { readonly why: string; readonly code: number | null } {
  const detail = error instanceof AgentStartFailed ? error.message : '';
  const exited = /: container exited with code (\d+) before coming online/.exec(detail)?.[1];
  if (exited !== undefined) return { why: 'its container exited before coming online', code: Number(exited) };
  if (/: not online within \d+ ms$/.test(detail)) return { why: 'it did not come online in time', code: null };
  if (/: container failed: /.test(detail)) return { why: 'its container failed before coming online', code: null };
  return { why: 'it could not be started', code: null };
}

/** A launch from an agent's grant whose caller stopped waiting before it was online (docs/plans/patterns-phase-3.md R30): it was killed. */
class LaunchAbandoned extends Error {
  constructor(
    /** The launched agent's container, killed. */
    readonly container: string,
  ) {
    super(`agent ${container}'s launch was abandoned: the agent that asked for it stopped waiting`);
    this.name = 'LaunchAbandoned';
  }
}

/** What an agent's launch from its grant came to (R30): the new handle, or a refusal reason with its detail. */
export type LaunchOutcome =
  | { readonly ok: true; readonly handle: string }
  | { readonly ok: false; readonly reason: LaunchRefusalReason | 'stopping' | 'abandoned'; readonly detail: string };

/** A launch failure's kind, for `agent.launch_failed` (its detail goes to the caller). */
function classifyLaunch(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** A launch that did not bring its agent online. */
type LaunchFailure = Extract<LaunchOutcome, { readonly ok: false }>;

/** `launchFor`'s prepare-and-start step: the online agent, or the failure already classified as a `LaunchOutcome`. */
type StartForLaunchResult =
  { readonly ok: true; readonly online: OnlineAgent } | { readonly ok: false; readonly outcome: LaunchFailure };

/** A persisted launch whose identity is already online, launching, or being erased (agent-persistence R2, R16). */
export class IdentityInUse extends Error {
  constructor(
    /** The agent identity already in use, `<channel>/<team or ->/<name>`. */
    readonly identity: string,
  ) {
    super(`agent ${identity} is already online, being launched or being erased on this daemon; one identity runs once`);
    this.name = 'IdentityInUse';
  }
}

/** Saved state from another image (R12). */
export class StateImageMismatch extends Error {
  constructor(
    /** The agent identity whose saved state it is. */
    readonly identity: string,
    /** The image its saved state is from. */
    readonly saved: string,
    /** The image its recipe names now. */
    readonly image: string,
    /** The command that removes the saved state. */
    readonly reset: string,
  ) {
    super(
      `agent ${identity}'s saved state is from image "${saved}", and its recipe now names image "${image}"; remove it with ${reset}`,
    );
    this.name = 'StateImageMismatch';
  }
}

/** Saved state of another state schema (R12). */
export class StateSchemaChanged extends Error {
  constructor(
    /** The agent identity whose saved state it is. */
    readonly identity: string,
    /** The state schema its saved state is of. */
    readonly saved: string,
    /** The state schema its image keeps now. */
    readonly schema: string,
    /** The command that removes the saved state. */
    readonly reset: string,
  ) {
    super(
      `agent ${identity}'s saved state is of state schema ${saved}, and its image now keeps schema ${schema}; remove it with ${reset}`,
    );
    this.name = 'StateSchemaChanged';
  }
}

/** A cloud-granted launch onto a channel whose saved state was written while memory was online (R7). */
export class MemoryEgressForbidden extends Error {
  /** `separation`: extension-modules R25's refusal on the channel as it runs, naming both agents; absent, R7's on its saved state. */
  constructor(
    /** The channel the launch would join. */
    readonly channel: string,
    separation?: string,
  ) {
    super(
      separation === undefined
        ? `channel ${channel}'s saved state was written while an agent that keeps memory was online on it, so no agent granted a cloud service may join it; remove it with asha --reset-state channel=${channel}`
        : `channel ${channel}: ${separation}: memory never leaves the machine, so the two never share a channel (extension-modules R25)`,
    );
    this.name = 'MemoryEgressForbidden';
  }
}

/** A team whose persist differs from the online channel's (R14). */
export class PersistMismatch extends Error {
  constructor(
    /** The channel online. */
    readonly channel: string,
    /** What the channel online persists. */
    readonly online: readonly string[],
    /** The team being launched onto it. */
    readonly team: string,
    /** What that team persists. */
    readonly persist: readonly string[],
  ) {
    super(
      `channel ${channel} is online persisting [${online.join(', ')}], and team ${team} persists [${persist.join(', ')}]; stop it first (asha --stop)`,
    );
    this.name = 'PersistMismatch';
  }
}

/** A team whose `persist` leaves out an asset the channel's saved state holds: its next save would drop it (R15). */
class SavedAssetsDropped extends Error {
  constructor(
    /** The channel whose saved state it is. */
    readonly channel: string,
    /** The assets its saved state holds. */
    readonly saved: readonly string[],
    /** The team being launched onto it. */
    readonly team: string,
    /** What that team persists. */
    readonly persist: readonly string[],
  ) {
    const dropped = saved.filter((asset) => !persist.includes(asset));
    super(
      `channel ${channel}'s saved state holds [${saved.join(', ')}], and team ${team} persists [${persist.join(', ')}]: its next save would drop ${dropped.join(', ')}; launch a team that persists them, or remove them with asha --reset-state channel=${channel}`,
    );
    this.name = 'SavedAssetsDropped';
  }
}

/**
 * A persisted team's saved files onto a channel whose space already holds entries (agent-files R15): filling would
 * discard what this run put there, and a merge could pass the space's bounds. Nothing is replaced.
 */
class FilesSpaceInUse extends Error {
  constructor(
    /** The channel whose file space already holds this run's files. */
    readonly channel: string,
  ) {
    super(
      `channel ${channel}'s file space already holds files this run put there, and the team's saved files would replace them; stop the daemon first (asha --stop)`,
    );
    this.name = 'FilesSpaceInUse';
  }
}

/** The command that removes an agent's saved state (R5). */
function resetCommand(id: AgentIdentity): string {
  const team = id.team === null ? '' : ` team=${id.team}`;
  return `asha --reset-state channel=${id.channel} name=${id.name}${team}`;
}

/** A team member did not come online: names the team, the member and why. The members already started are stopped. */
export class TeamLaunchFailed extends Error {
  constructor(
    /** The team whose launch failed. */
    readonly team: string,
    /** The member that did not start. */
    readonly member: string,
    /** Why it did not start. */
    override readonly cause: unknown,
    /** Members started before it that the rollback could not stop: still online. */
    readonly stillOnline: readonly string[] = [],
  ) {
    super(
      `team ${team}: member "${member}" did not start: ${cause instanceof Error ? cause.message : String(cause)}` +
        (stillOnline.length === 0 ? '' : `; and the rollback could not stop ${stillOnline.join(', ')}, still online`),
      { cause },
    );
    this.name = 'TeamLaunchFailed';
  }
}

/** A request on the agent API was malformed. */
export class AgentRequestInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRequestInvalid';
  }
}

/** An agent that has connected to its channel. */
export interface OnlineAgent {
  /** Its name on the channel, e.g. `hewo-1`. */
  readonly handle: string;
  readonly channel: string;
  readonly recipe: Recipe;
  readonly image: ImageDefinition;
  readonly container: string;
  readonly logFile: string;
  /** The tools its recipe selects, in order: what its welcome event carries (docs/plans/agent-tools.md R1). */
  readonly tools: readonly string[];
  /** Its recipe's full-text documents, in order: what its welcome event carries into its system prompt (collaborating-agents R2). */
  readonly guidance: readonly GuidanceText[];
  /** What its recipe persists, for a persisted agent: its welcome carries it (agent-persistence R10). */
  readonly persist?: readonly AgentAsset[];
  /** When it resumed saved state: when that was saved, and its handle then (R8). */
  readonly resumed?: { readonly savedAt: string; readonly previousHandle: string };
  /** It is cloud-granted and its channel's file space held a file when it came online (agent-files R7). */
  readonly exposesFiles?: true;
  /** Its granted module tools, as its welcome carries them (extension-modules R10). */
  readonly modules: readonly ModuleToolOffer[];
  /** Its recipe's launch grant, as its welcome carries it (docs/plans/patterns-phase-3.md R29); absent without one. */
  readonly launch?: LaunchGrant;
  /** Its recipe names `nestedCalls: true`, as its welcome carries it (R33); absent otherwise. */
  readonly nestedCalls?: true;
}

/** A space route for a channel with no agent online and no recipe named: a message there reaches nobody (agent-files R3a). */
export class NoAgentToRead extends Error {
  constructor(
    /** The channel with no agent online to read the file. */
    readonly channel: string,
  ) {
    super(`no agent on channel ${channel} to read the file`);
    this.name = 'NoAgentToRead';
  }
}

/**
 * What to launch: a recipe, the file it was read from and the folder its documents are relative to, and — for a
 * team member — the name it joins the channel under (collaborating-agents R11) and its team's id; null for a
 * recipe launched alone, which joins under its image's name.
 */
interface LaunchTarget {
  readonly recipe: Recipe;
  readonly recipeFile: string;
  readonly folder: string;
  readonly name: string | null;
  /** The team's id, carried into the record so a member's identity is known (agent-persistence R2); null alone. */
  readonly team: string | null;
  /** Its team file's roots (extension-modules R30); [] for a recipe launched alone. */
  readonly teamRoots: readonly RootSpec[];
  /** The topics its team member subscribes to on the channel (docs/plans/patterns-phase-3.md R20); [] for a recipe launched alone. */
  readonly topics: readonly string[];
  /** The recipes its launch grant names, read and checked with its team (R29); [] without a grant. */
  readonly launchable: readonly LaunchableRecipe[];
}

/** A target checked in full before any container starts: its image, tools, models, documents and modules. */
interface PreparedLaunch extends LaunchTarget {
  readonly image: ImageDefinition;
  readonly tools: ToolSelection;
  /** Its local chat model; undefined when its model is a provider's (extension-modules R19). */
  readonly entry: ChatModelEntry | undefined;
  readonly embeddingEntry: EmbeddingModelEntry | null;
  readonly documents: readonly LoadedDocument[];
  readonly guidance: readonly GuidanceText[];
  readonly modules: LaunchModules;
}

interface AgentRecord {
  readonly token: string;
  readonly channel: Channel;
  readonly recipe: Recipe;
  readonly image: ImageDefinition;
  /**
   * Its chat model: a local one — its entry and cached files, each call leasing its server, which may have been unloaded
   * and started again since the launch (docs/plans/idle-shutdown.md R2) — or a provider's (extension-modules R19).
   */
  readonly chatModel:
    | { readonly kind: 'local'; readonly entry: ChatModelEntry; readonly cached: CachedModel }
    | { readonly kind: 'provider'; readonly ref: ProviderModelRef };
  /** The recipe's embedding model, local (leased per call, as the chat model) or a provider's; null when it names none. */
  readonly embedding:
    | { readonly kind: 'local'; readonly entry: EmbeddingModelEntry; readonly cached: CachedModel }
    | { readonly kind: 'provider'; readonly ref: ProviderModelRef }
    | null;
  /** Its modules (extension-modules): grants, cloud reach, roots, and what it acquired. */
  readonly modules: LaunchModules;
  /** The modules it acquired from the host, released once when it is gone (R34). */
  modulesHeld: readonly string[];
  readonly container: string;
  readonly logFile: string;
  /** Its selected and granted tools, and every name the gateway accepts from it. */
  readonly tools: ToolSelection;
  /** Its recipe's full-text documents, for its welcome. */
  readonly guidance: readonly GuidanceText[];
  /** The base name it joins the channel under whatever its image asks for: a team member's name; null for a recipe launched alone. */
  readonly baseName: string | null;
  /** Set when the agent connects its channel stream. */
  handle: string | undefined;
  /** The agent's first status message: its announcement that it is online. */
  announcement: ChannelMessage | undefined;
  /** Settles once the container has exited and left the channel. */
  gone: Promise<unknown>;
  /** Aborted when the container has exited: its model calls still in flight are abandoned (ABANDONED). */
  readonly exited: AbortController;
  /** How it is being stopped, once it is. */
  stopMode: StopMode | undefined;
  /** traceIdFor of every conversation delivered to it, for its lifetime: the traces it may send and call models in. */
  readonly traces: Set<string>;
  /** The same conversations by their trace id: where a model call's output is published (model-streaming R3). */
  readonly conversations: Map<string, string>;
  stopping: boolean;
  markOnline: () => void;
  /** Its team's id; null for a recipe launched alone (agent-persistence R2). */
  readonly team: string | null;
  /** The persisted agent's identity key, held in use from its launch until it is gone (R2); null when it persists nothing. */
  readonly identityKey: string | null;
  /** Its persistence, once its state is restored; undefined when it persists nothing. */
  persisted: PersistedAgent | undefined;
  /** When it resumed saved state (R8). */
  resumed: { readonly savedAt: string; readonly previousHandle: string } | undefined;
  /** What its launch re-sends at its join, or — a team member — at the team's release (R9 (e)). */
  resendPlan: ResendPlan;
  /** A team member whose deliveries are held until the whole team is online (R9 (e)). */
  readonly held: boolean;
  /** Where its launch reports: its re-sends reach it through `resent` (R9 (i)). */
  readonly sink: OnlineSink;
  /** Its image declares it keeps memory (R7). */
  readonly keepsMemory: boolean;
  /** Its stop, once begun: a second stop joins it (R10). */
  stopSequence: Promise<void> | undefined;
  /** Settles once its stop's checkpoint is promoted or given up (R10: the channel's final checkpoint waits for it). */
  stopCheckpointed: Promise<void> | undefined;
  /** The grace, in whole seconds, its drain was given: `agent.stop_killed` names it. */
  graceS: number | undefined;
  /** It came online cloud-granted onto a space holding a file (agent-files R7). */
  exposesFiles: boolean;
  /** What it was launched from: a restart starts the same again (docs/plans/patterns-phase-3.md R12). */
  readonly launch: PreparedLaunch;
  /** A restart's container: the suspended handle it rejoins under, never `join` (R12); undefined for any other launch. */
  readonly rejoin: string | undefined;
  /** Its stream closed with no stop begun: the wait for its container's exit before it is stopped (R11). */
  exitWait: NodeJS.Timeout | undefined;
}

/** `restoreFor`'s result: a persisted agent's saved state, ready for `start` to use once it has a record. */
interface RestoredLaunch {
  readonly make: (record: AgentRecord) => PersistedAgent;
  readonly pointer: AgentPointer | undefined;
  readonly plan: ResendPlan;
  readonly archive: (() => AsyncIterable<Uint8Array>) | undefined;
  readonly imageChanged: boolean;
  readonly resumed: ResumedFrom | undefined;
}

/** The restarts of one agent, by channel and handle (R12, R13): when each began, and how many have begun in all. */
interface RestartHistory {
  readonly begun: number[];
  attempts: number;
}

/** A model call in flight, as a reader sees it: its asha.chat or asha.embed span, without the means to end it. */
export interface InFlightCall {
  readonly name: OpenSpan['name'];
  readonly traceId: string;
  readonly spanId: string;
  readonly channel: string;
  readonly handle: string;
  readonly start: string;
}

/** Where bringing an agent online reports its progress, and the agent's own announcement. */
export interface OnlineSink {
  phase(phase: OnlinePhase, detail: string): void;
  /**
   * The agent's announcement; `resumed` when it resumed saved state (agent-persistence R8); `exposesFiles` when it is
   * cloud-granted and the channel's file space holds a file (agent-files R7).
   */
  announced(message: ChannelMessage, resumed?: ResumedFrom, exposesFiles?: true): void;
  /**
   * A user's message from before the restart is being re-sent to the agent, in `conversation` (agent-persistence
   * R9 (i)): called in the tick the channel starts or joins it, so the caller can watch it from its first event.
   */
  resent(conversation: string, savedAt: string): void;
}

/** Where launching a team reports its progress: each member as it starts and as it comes online, besides each one's phases. */
export interface TeamSink extends OnlineSink {
  member(name: string, recipe: string): void;
  launched(agent: OnlineAgent): void;
  /** Every member is online: said before any member's re-sends are released (R9 (i)). */
  teamLaunched(agents: readonly OnlineAgent[]): void;
}

const MAX_TOKENS_CAP = 4096;
/** How a container killed by SIGKILL exits: 128 + 9. */
const KILLED_EXIT_CODE = 137;
/** Bound on a stopped container's exit being seen, once `runtime.stop` has returned. */
const STOP_WAIT_MS = 30_000;

/** A channel's stop in progress (portal-demo-stop R2). */
interface ChannelStopRun {
  readonly done: Promise<readonly string[]>;
  readonly told: string[];
  readonly listeners: Set<(handle: string) => void>;
}

/** Adds `by` to a counter by key, dropping the key at zero. */
function count(counts: Map<string, number>, key: string, by: 1 | -1): void {
  const n = (counts.get(key) ?? 0) + by;
  if (n <= 0) counts.delete(key);
  else counts.set(key, n);
}

/**
 * What a channel's final checkpoint waits for from one of its agents once every stop has begun: a persisted agent's
 * stop checkpoint, which stopRecord sets as the stop begins, or any other agent's exit.
 */
function finalWaitFor(record: AgentRecord): Promise<unknown> {
  return record.persisted === undefined
    ? record.gone
    : present(record.stopCheckpointed, "a persisted agent's stop checkpoint, set as its stop began");
}

/** The catalogue ids of the local models a launch asks servers for: its chat model and its embedding model, when local. */
function localModels(launch: PreparedLaunch): string[] {
  return [launch.entry?.id, launch.embeddingEntry?.id].filter((m): m is string => m !== undefined);
}

/** Brings agents online, keeps track of them, and carries their channel, model and module calls, restarts and stops. */
export class AgentSupervisor {
  /** By token: the agent API identifies callers only by their token. */
  private readonly records = new Map<string, AgentRecord>();
  private readonly launching = new Map<string, Promise<OnlineAgent>>();
  /** The asha.chat and asha.embed spans of model calls in flight: whether a call is in flight comes from here, not the trace files. */
  private readonly inFlight = new Set<OpenSpan>();
  /** Woken each time no model call is in flight. */
  private idleWaiters: (() => void)[] = [];
  /** Set by stopAll: from then on nothing is launched. */
  private closing = false;
  /** One blackboard per channel, for as long as the daemon keeps the channel (docs/plans/agent-tools.md R10). */
  private readonly blackboards = new WeakMap<Channel, Blackboard>();
  /** Persisted identities in use — launching, online, stopping — or being erased, by key (agent-persistence R2, R16). */
  private readonly inUse = new Map<string, 'agent' | 'erase'>();
  /** The persistence of each channel a team persisting its board is on (R14). */
  private readonly persistedChannels = new Map<Channel, PersistedChannel>();
  /** The deadlines of the stop begun, once one has (R10). */
  private stopDeadlines: StopDeadlines | undefined;
  /**
   * Each channel stopping on its own, by name, and its stop's deadlines (portal-demo-stop R2): its persisted agents and
   * board see a stop of the daemon — entries left for the next run, checkpoints bounded by these deadlines.
   */
  private readonly channelStopDeadlines = new Map<string, StopDeadlines>();
  /** Saved state's routes (agent-persistence R5, R16). */
  readonly state: StateOperations;
  /**
   * The chat model servers, each with a recipe, whose idle prompts have been stored since that recipe's first answered
   * call there (`<baseUrl> <recipe>`): one store request per pair, since a recipe's agents share one prompt prefix (D44).
   */
  private readonly promptsStored = new Set<string>();
  /** Every store request made, one per entry of promptsStored, each settled once logged; stopAll waits for them. */
  private readonly stores: Promise<void>[] = [];
  /** Aborted when stopAll begins: a store request still going ends at once (no later call could use the store). */
  private readonly storesAbandoned = new AbortController();
  /** A persisted team's saved files, for the space its first member's start creates (agent-files R15). */
  private readonly pendingFills = new Map<Channel, SpaceFill>();
  /** Channels an agent that keeps memory has come online on in this run (extension-modules R25): tainted until the stop. */
  private readonly memoryChannels = new Set<Channel>();
  /**
   * Each approved call asha is making (R12 (e)), in flight: how to abandon it — each is abandoned, and logged so, when
   * the daemon stops — and the fields its `module.failed` line carries (B-18).
   */
  private readonly approvedInFlight = new Map<
    AbortController,
    {
      readonly agent: string;
      readonly channel: string;
      readonly module: string;
      readonly tool: string;
      readonly approval: string;
    }
  >();
  /** Each approved call being made, until its outcome is audited (R12 (e)): the stop waits for them after the reclaim. */
  private readonly approvedCalls = new Set<Promise<unknown>>();
  /** Each restartable agent's restarts, by `<channel> <handle>` (patterns-phase-3 R12, R13). */
  private readonly restartHistory = new Map<string, RestartHistory>();
  /**
   * The restarts going on, each settled once it has restarted the agent, reached the limit, or given up (R14), with
   * its channel's name: a channel's stop waits for its own (docs/plans/portal-demo-stop.md R2).
   */
  private readonly restartJobs = new Map<Promise<void>, string>();
  /**
   * The channels being stopped one by one (portal-demo-stop R2), each with its stop, the handles it has told of, and
   * every caller to tell of the rest: a second stop of the channel joins the first and hears every handle.
   */
  private readonly channelStops = new Map<string, ChannelStopRun>();
  /** Launches in progress, by channel name, from their start until they hand over to their record or fail (R1). */
  private readonly launchingOn = new Map<string, number>();
  /** Each launch in progress, by its channel's name, until its start settles: a channel's stop waits for its own (R2). */
  private readonly launchJobs = new Map<Promise<void>, string>();
  /**
   * Local models a launch or a restart in progress needs before its record holds them, counted by catalogue id
   * (portal-demo-stop R3): registered before the launch asks for a server, so stopIdle never stops one it is given.
   */
  private readonly modelHolds = new Map<string, number>();
  /**
   * Launches from agents' grants (patterns-phase-3 R30), by channel, launcher and conversation: begun and not failed.
   * An entry is dropped when its conversation settles.
   */
  private readonly launchCounts = new Map<string, number>();
  /** The records whose failure has been said (sayFailed, demo-scene-refresh R6): once each. */
  private readonly failuresSaid = new WeakSet<AgentRecord>();

  constructor(private readonly props: AgentSupervisorProps) {
    this.state = new StateOperations(props, {
      inUse: this.inUse,
      channelBusy: (channel) => [...this.records.values()].some((r) => r.channel.name === channel),
    });
  }

  /** Every agent online, as `GET /v1/agents` lists it — handle, channel, recipe, image, any cloud grant — by channel and handle. */
  list(): AgentSummary[] {
    return this.online()
      .map((r) => ({
        handle: present(r.handle, "an online agent's handle"),
        channel: r.channel.name,
        recipe: r.recipe.id,
        image: r.image.name,
        ...(r.modules.cloud.length === 0 ? {} : { cloud: r.modules.cloud }),
      }))
      .sort((a, b) => (a.channel + a.handle < b.channel + b.handle ? -1 : 1));
  }

  /** The agents online on a channel, each with its recipe and its recipe's model, for the portal's telemetry (docs/plans/portal.md R10). */
  telemetryAgents(
    channel: Channel,
  ): { readonly handle: string; readonly recipe: string; readonly team: string | null; readonly model: string }[] {
    return this.online()
      .filter((r) => r.channel === channel)
      .map((r) => ({
        handle: present(r.handle, "an online agent's handle"),
        recipe: r.recipe.id,
        team: r.team,
        model: r.recipe.model,
      }));
  }

  /**
   * Whether `stopAll` has begun. A method, not a direct read of the field: a concurrent `stopAll` can set it while
   * this call is suspended at an `await`, a race the type checker's control-flow analysis cannot see across — so a
   * direct read right after an earlier check of the same field is (wrongly) typed as always false.
   */
  private isClosing(): boolean {
    return this.closing;
  }

  /** Whether `token` is a token this supervisor issued to an agent it started (the agent API's authentication). */
  isAgentToken(token: string): boolean {
    return this.records.has(token);
  }

  /**
   * The space route (agent-files R3a): makes the channel's file space ready and reports its usage and the cloud-granted
   * agents its files may reach (R7). A space that exists is measured; one that does not is created from `recipe`'s
   * image, made ready as a launch makes it (the runtime, then the image, each a phase); with no agent online and no
   * recipe, NoAgentToRead, creating nothing.
   */
  async prepareSpace(
    channel: Channel,
    recipeName: string | undefined,
    sink: Pick<OnlineSink, 'phase'>,
  ): Promise<{ readonly bytes: number; readonly entries: number; readonly cloudAgents: readonly string[] }> {
    const online = this.online().filter((r) => r.channel === channel && !r.stopping);
    if (online.length === 0 && recipeName === undefined) throw new NoAgentToRead(channel.name);
    const prepared =
      recipeName === undefined
        ? undefined
        : await this.prepare({
            recipe: await this.props.definitions.recipe(recipeName),
            recipeFile: join(this.props.definitions.recipesDir, `${recipeName}.json`),
            folder: this.props.definitions.recipesDir,
            name: null,
            team: null,
            teamRoots: [],
            topics: [],
            launchable: [],
          });
    if (!this.props.files.exists(channel.name)) {
      if (prepared === undefined) throw new NoAgentToRead(channel.name);
      sink.phase('container_runtime', await this.props.runtime.ensureReady(this.props.daemonPort()));
      const staged = await stageAgentImage({
        root: this.props.root,
        image: prepared.image,
        stagingParent: this.props.stagingDir,
      });
      let ensured: EnsuredImage;
      try {
        ensured = await this.props.runtime.ensureImage(staged.spec);
        sink.phase('image', `${prepared.image.repository} ${ensured.status}`);
      } finally {
        await staged.cleanup();
      }
      await this.props.files.ensure(channel.name, ensured.tag);
    }
    const usage = await this.props.files.usage(channel.name);
    const cloudAgents = [
      ...online.filter((r) => r.modules.cloudGranted).map((r) => present(r.handle, "an online agent's handle")),
      ...(prepared !== undefined && prepared.modules.cloudGranted ? [prepared.recipe.id] : []),
    ];
    return { bytes: usage.bytes, entries: usage.entries, cloudAgents };
  }

  /**
   * An output with files (agent-files R12, `reply_with_files`): the files copied out of the space and checked under
   * its lock, then the message posted carrying their records — or, the first file refused, nothing posted.
   */
  async postWithFiles(
    token: string,
    request: { readonly conversation: string; readonly text: string; readonly files: readonly string[] },
    parentSpanId: string,
  ): Promise<
    | { readonly ok: true; readonly message: ChannelMessage }
    | { readonly ok: false; readonly file: string; readonly rule: string }
  > {
    const record = this.requireOnline(token);
    const user = record.channel.askerOf(request.conversation);
    if (user === undefined) throw new AgentRequestInvalid(`unknown conversation ${request.conversation}`);
    // Only an agent offered reply_with_files may return files (R12; completion review, finding 11): refused like any
    // other return, before anything is copied.
    if (!record.tools.selected.includes(REPLY_WITH_FILES_TOOL_NAME)) {
      const file = request.files[0] ?? '';
      const rule = `recipe ${record.recipe.id} does not select ${REPLY_WITH_FILES_TOOL_NAME}`;
      this.props.logger.error('files.refused', {
        channel: record.channel.name,
        reason: 'file_refused',
        name: file.split('/').at(-1) ?? file,
        error: new Error(rule),
      });
      return { ok: false, file, rule };
    }
    const returned = await this.props.files.returnFiles({
      channel: record.channel.name,
      conversation: request.conversation,
      user,
      handle: present(record.handle, "the agent's handle"),
      paths: request.files,
    });
    if (!returned.ok) return returned;
    const message = record.channel.post({
      from: present(record.handle, "the agent's handle"),
      kind: 'output',
      text: request.text,
      conversation: request.conversation,
      parentSpanId,
      files: returned.files,
    });
    return { ok: true, message };
  }

  /**
   * An agent launches a recipe its grant names onto its channel, for the conversation of the delivery it holds
   * (docs/plans/patterns-phase-3.md R29, R30, R32): under its team identity, the recipe id its base name. Refused, with
   * nothing started, when it does not hold the delivery (`not_holding_delivery`), the recipe is not in its grant
   * (`not_granted`), or it has launched `maxPerConversation` agents for that conversation (`launch_cap`); a start that
   * fails is `launch_failed`, and one whose caller hung up first (`abandon`) is killed and `abandoned`. Once online,
   * the launched agent is stopped when that conversation settles or its launcher leaves the channel, whichever is first.
   */
  async launchFor(
    token: string,
    request: { readonly delivery: string; readonly recipe: string },
    abandon: AbortSignal,
  ): Promise<LaunchOutcome> {
    const launcher = this.requireOnline(token);
    if (this.closing) return { ok: false, reason: 'stopping', detail: 'the daemon is stopping' };
    const { channel } = launcher;
    const by = present(launcher.handle, "the agent's handle");
    // A channel stopping launches nothing, as the daemon stopping does (the code review's round 2).
    if (this.channelStopDeadlines.has(channel.name))
      return { ok: false, reason: 'stopping', detail: `channel ${channel.name} is stopping` };
    // A launcher down for its restart launches nothing: its word would clear its failure's mark (R8).
    if (channel.isSuspended(by)) return { ok: false, reason: 'stopping', detail: `${by} is down for its restart` };
    let conversation: string;
    try {
      conversation = channel.heldConversation(by, request.delivery);
    } catch (error) {
      if (error instanceof CallRefused)
        return { ok: false, reason: 'not_holding_delivery', detail: `${by} holds no delivery ${request.delivery}` };
      throw error;
    }
    const grant = launcher.recipe.launch;
    const launchable = launcher.launch.launchable.find((l) => l.recipe.id === request.recipe);
    if (grant === undefined || launchable === undefined) {
      return {
        ok: false,
        reason: 'not_granted',
        detail:
          grant === undefined
            ? `recipe ${launcher.recipe.id} grants no launch`
            : `recipe ${launcher.recipe.id}'s launch grant names ${grant.recipes.join(', ')}, not ${request.recipe}`,
      };
    }
    const key = `${channel.name}\u0000${by}\u0000${conversation}`;
    const launched = this.launchCounts.get(key) ?? 0;
    if (launched >= grant.maxPerConversation)
      return {
        ok: false,
        reason: 'launch_cap',
        detail: `${by} has launched ${String(launched)} of its ${String(grant.maxPerConversation)} agents for conversation ${conversation}`,
      };
    // Reserved before anything awaits, so two launches at once cannot both pass the cap; given back if the launch fails.
    if (launched === 0) channel.whenSettled(conversation, () => this.launchCounts.delete(key));
    this.launchCounts.set(key, launched + 1);
    const giveBack = (): void => {
      const now = this.launchCounts.get(key);
      if (now !== undefined) this.launchCounts.set(key, now - 1);
    };
    const giveBackAndStart = async (): Promise<StartForLaunchResult> => {
      try {
        const prepared = await this.prepare({
          recipe: launchable.recipe,
          recipeFile: launchable.recipeFile,
          folder: dirname(launchable.recipeFile),
          name: launchable.recipe.id,
          team: launcher.team,
          teamRoots: launcher.launch.teamRoots,
          topics: [],
          launchable: [],
        });
        const quiet: OnlineSink = { phase: () => undefined, announced: () => undefined, resent: () => undefined };
        const online = await this.start(prepared, channel, quiet, undefined, abandon);
        return { ok: true, online };
      } catch (error) {
        giveBack();
        return { ok: false, outcome: this.launchFailure(error, channel, by, request.recipe, conversation) };
      }
    };
    // The chat says what the launcher does before the new agent joins and greets (docs/plans/demo-scene-refresh.md R14).
    channel.post({ from: by, kind: 'status', text: launchingStatus(request.recipe) });
    const started = await giveBackAndStart();
    if (!started.ok) {
      this.sayLaunchFailed(channel, by, request.recipe, started.outcome);
      return started.outcome;
    }
    const { online } = started;
    const record = [...this.records.values()].find((r) => r.container === online.container);
    if (record === undefined) throw new Error(`launchFor: ${online.container} came online and has no record`);
    // Online as the caller hung up: no agent is left that the model was told failed.
    if (abandon.aborted) {
      giveBack();
      this.props.logger.warn('agent.launch_abandoned', {
        by,
        recipe: request.recipe,
        conversation,
        container: online.container,
      });
      await this.stopRecord(record, 'its launch was abandoned', 'kill');
      const outcome = {
        ok: false,
        reason: 'abandoned',
        detail: `agent ${online.container}'s launch was abandoned`,
      } as const;
      this.sayLaunchFailed(channel, by, request.recipe, outcome);
      return outcome;
    }
    this.props.logger.info('agent.launched', {
      by,
      handle: online.handle,
      recipe: request.recipe,
      conversation,
      team: launcher.team,
    });
    this.wireLaunchStop(record, channel, by, conversation);
    return { ok: true, handle: online.handle };
  }

  /**
   * The launcher's word that its launch failed (docs/plans/demo-scene-refresh.md R14), with the launch's reason — said
   * only while it is on the channel, and online, to say it, and never for a stop, which ends the launcher too.
   */
  private sayLaunchFailed(channel: Channel, by: string, recipe: string, outcome: LaunchFailure): void {
    // A launcher suspended for its restart is down: its word would clear its failure's mark (R8). A stop, the daemon's
    // or its channel's, is said by the stop itself, and whether the launcher is still a member as it ends is timing.
    if (outcome.reason !== 'stopping' && channel.isMember(by) && !channel.isSuspended(by))
      channel.post({ from: by, kind: 'status', text: launchFailedStatus(recipe, outcome.reason) });
  }

  /** `launchFor`'s start failure, classified (R30): abandoned, stopping, or a plain launch failure, logged as such. */
  private launchFailure(
    error: unknown,
    channel: Channel,
    by: string,
    recipe: string,
    conversation: string,
  ): LaunchFailure {
    if (error instanceof LaunchAbandoned) {
      this.props.logger.warn('agent.launch_abandoned', { by, recipe, conversation, container: error.container });
      return { ok: false, reason: 'abandoned', detail: error.message };
    }
    // The daemon, or the launcher's channel, began to stop while it launched: the caller is told so, as the route tells
    // it once stopping (R30) — a stop is no launch failure (the code review's round 3 on demo-scene-refresh).
    if (this.isClosing()) return { ok: false, reason: 'stopping', detail: 'the daemon is stopping' };
    if (this.channelStopDeadlines.has(channel.name))
      return { ok: false, reason: 'stopping', detail: `channel ${channel.name} is stopping` };
    // Every start failure is the caller's data (R30), and a failure to find: at error, with its cause and stack.
    this.props.logger.error('agent.launch_failed', { by, recipe, conversation, reason: classifyLaunch(error), error });
    return { ok: false, reason: 'launch_failed', detail: error instanceof Error ? error.message : String(error) };
  }

  /**
   * R32: the launched agent stopped (drain) when the conversation settles or its launcher leaves, whichever comes
   * first — at once when either happened while it came online (the conversation settled as its launcher's delivery
   * ended, or the launcher left). `stopped` is a property of an object, not a plain variable: `stop` below can set
   * it from the synchronous call at `isMember` just below, and a direct read of a plain variable right after that
   * call is (wrongly) typed by the checker as always false — it cannot see that the closure's own assignment is
   * reachable from here.
   */
  private wireLaunchStop(record: AgentRecord, channel: Channel, by: string, conversation: string): void {
    const launchStop = { stopped: false };
    const hooks: { drop?: () => void; unwatch?: () => void } = {};
    const stop = (reason: string): void => {
      if (launchStop.stopped) return;
      launchStop.stopped = true;
      hooks.drop?.();
      hooks.unwatch?.();
      // stopRecord reports its own failures (agent.stop_failed); a rejection would be a defect, said here.
      this.stopRecord(record, reason, 'drain').catch((error: unknown) => {
        this.props.logger.error('agent.stop_failed', { container: record.container, error });
      });
    };
    hooks.unwatch = channel.watchAll((event) => {
      if (event.type === 'agent_left' && event.agent === by) stop(`its launcher ${by} left the channel`);
    });
    hooks.drop = channel.whenSettled(conversation, () => {
      stop(`the conversation ${conversation} it was launched for settled`);
    });
    if (!channel.isMember(by)) stop(`its launcher ${by} left the channel`);
    if (launchStop.stopped) {
      hooks.drop();
      hooks.unwatch();
    }
    void record.gone.then(() => {
      hooks.drop?.();
      hooks.unwatch?.();
    });
  }

  /** Brings the recipe's agent online on the channel, or reuses the one already online there. */
  async ensureOnline(recipeName: string, channel: Channel, sink: OnlineSink): Promise<OnlineAgent> {
    const key = `${channel.name}|${recipeName}`;
    const existing = this.online().find((r) => !r.stopping && r.channel === channel && r.recipe.id === recipeName);
    if (existing) {
      sink.phase('agent', `${present(existing.handle, "an online agent's handle")} already online on ${channel.name}`);
      return describe(existing);
    }
    const inFlight = this.launching.get(key);
    if (inFlight) {
      const agent = await inFlight;
      sink.phase('agent', `${agent.handle} already online on ${channel.name}`);
      return agent;
    }
    const launch = this.launch(recipeName, channel, sink);
    this.launching.set(key, launch);
    try {
      return await launch;
    } finally {
      this.launching.delete(key);
    }
  }

  /** Starts a new instance of the recipe's agent on the channel, even if one is already online. */
  async launchNew(recipeName: string, channel: Channel, sink: OnlineSink): Promise<OnlineAgent> {
    return this.launch(recipeName, channel, sink);
  }

  /**
   * Launches every member of teams/<team>/ on the channel, in team.json's order, each under its own name
   * (collaborating-agents R5, R11). Every member's recipe, image, tools, models and documents are checked before
   * any container starts; a member that then fails to come online stops the members already started, so a team
   * is on the channel whole or not at all, and the failure names the member. A persisted member's deliveries — its
   * re-sends from before a restart among them — are held until the whole team is online, and released only after
   * `teamLaunched` (agent-persistence R9 (e)); a team that persists its board restores it before its first member
   * starts, and is refused onto an online channel persisting something else (R14).
   */
  async launchTeam(teamName: string, channel: Channel, sink: TeamSink): Promise<OnlineAgent[]> {
    const team = await this.props.definitions.team(teamName);
    const prepared: PreparedLaunch[] = [];
    for (const member of team.members) {
      try {
        prepared.push(
          await this.prepare({
            recipe: member.recipe,
            recipeFile: member.recipeFile,
            folder: dirname(member.recipeFile),
            name: member.name,
            team: team.id,
            teamRoots: team.roots,
            topics: member.topics,
            launchable: member.launchable,
          }),
        );
      } catch (error) {
        throw new TeamLaunchFailed(team.id, member.name, error);
      }
    }
    await this.persistChannel(channel, team, prepared);
    const started: OnlineAgent[] = [];
    for (const launch of prepared) {
      sink.member(present(launch.name, "a team member's name"), launch.recipe.id);
      try {
        const agent = await this.start(launch, channel, sink);
        started.push(agent);
        sink.launched(agent);
      } catch (error) {
        this.props.logger.error('team.launch_failed', {
          team: team.id,
          channel: channel.name,
          member: launch.name,
          stopping: started.map((a) => a.handle),
          error,
        });
        await Promise.all(
          started.map((agent) => {
            const record = [...this.records.values()].find((r) => r.channel === channel && r.handle === agent.handle);
            // A persisted member held nothing (its deliveries are held until the team is whole): it is checkpointed at once, then drained (R10).
            return record === undefined
              ? Promise.resolve()
              : this.stopRecord(record, `team ${team.id} did not start whole`, 'drain');
          }),
        );
        // A member the rollback could not stop (agent.stop_failed) is still online: the failure says so.
        const left = started.filter((a) => this.online().some((r) => r.channel === channel && r.handle === a.handle));
        throw new TeamLaunchFailed(
          team.id,
          present(launch.name, "a team member's name"),
          error,
          left.map((a) => a.handle),
        );
      }
    }
    this.props.logger.info('team.launched', {
      team: team.id,
      channel: channel.name,
      handles: started.map((a) => a.handle),
    });
    sink.teamLaunched(started);
    // Whole: each persisted member's re-sends, then its held deliveries, released in team order (R9 (e), (i)).
    for (const agent of started) {
      const record = [...this.records.values()].find((r) => r.channel === channel && r.handle === agent.handle);
      if (record?.persisted === undefined) continue;
      this.resend(record);
      channel.release(present(record.handle, "the agent's handle"));
    }
    return started;
  }

  /** `persistChannel`'s R1 check: onto an online channel, the team's persist must already be the channel's. */
  private checkPersistMismatch(channel: Channel, team: Team, online: boolean): void {
    if (!online) return;
    const current = this.persistedChannels.get(channel);
    // The channel's persisted assets, board and files alike (agent-files R15), never a fixed list.
    const persisting = current === undefined ? [] : [...current.assets];
    if (persisting.join() !== [...team.persist].join())
      throw new TeamLaunchFailed(
        team.id,
        present(team.members[0], "the team's first member").name,
        new PersistMismatch(channel.name, persisting, team.id, team.persist),
      );
  }

  /** `persistChannel`'s egress check (R7): a cloud-granted member refused onto a channel whose saved state held memory. */
  private async checkCloudEgress(channel: Channel, team: Team, prepared: readonly PreparedLaunch[]): Promise<void> {
    const cloudGranted = prepared.find((p) => p.modules.cloudGranted);
    const refusal = egressRefusal(
      channel.name,
      cloudGranted !== undefined,
      cloudGranted !== undefined && (await this.channelTainted(channel)),
    );
    if (refusal === undefined) return;
    const culprit = present(cloudGranted, 'the cloud-granted team member');
    throw new TeamLaunchFailed(team.id, present(culprit.name, "a team member's name"), refusal);
  }

  /** `persistChannel`'s R25 check: no member of the team itself keeps memory beside one that is cloud-granted. */
  private checkMemoryCloudMix(channel: Channel, team: Team, prepared: readonly PreparedLaunch[]): void {
    const kindOf = (p: (typeof prepared)[number]): 'memory' | 'cloud' | 'neither' => {
      if (p.image.manifest.keepsMemory) return 'memory';
      return p.modules.cloudGranted ? 'cloud' : 'neither';
    };
    const kinds = new Set(prepared.map(kindOf));
    if (!kinds.has('memory') || !kinds.has('cloud')) return;
    const memory = present(
      prepared.find((p) => p.image.manifest.keepsMemory),
      'the team member whose image keeps memory',
    );
    const cloud = present(
      prepared.find((p) => p.modules.cloudGranted),
      'the cloud-granted team member',
    );
    const memoryName = present(memory.name, "a team member's name");
    const cloudName = present(cloud.name, "a team member's name");
    throw new TeamLaunchFailed(
      team.id,
      cloudName,
      new MemoryEgressForbidden(
        channel.name,
        `team ${team.id} puts ${memoryName}, whose image keeps memory, beside ${cloudName}, which is cloud-granted`,
      ),
    );
  }

  /**
   * `persistChannel`'s check on a channel nobody is online on, whose saved pointer exists: the team's persist
   * becomes the channel's, so a saved asset it does not persist would be gone at its next save, the previous
   * generation deleted on promotion (agent-files R15; completion review, finding 6). Refused instead.
   */
  private checkSavedAssetsDropped(channel: Channel, team: Team, pointer: ChannelPointer): void {
    const saved = Object.keys(pointer.assets).sort(byCodeUnit);
    if (saved.some((asset) => !team.persist.includes(asset as never)))
      throw new TeamLaunchFailed(
        team.id,
        present(team.members[0], "the team's first member").name,
        new SavedAssetsDropped(channel.name, saved, team.id, team.persist),
      );
  }

  /**
   * `persistChannel`'s saved files, filled first so a refusal replaces nothing (agent-files R15): into the space
   * the first member creates; into an existing space only when it is empty — one holding anything is refused
   * files_space_in_use. A generation that saved no files leaves the space as it is.
   */
  private async fillSavedFiles(channel: Channel, team: Team, pointer: ChannelPointer | undefined): Promise<void> {
    if (!team.persist.includes('files')) return;
    const files = await savedFiles(this.props.state, pointer, channel.name);
    if (files === undefined) return;
    if (!this.props.files.exists(channel.name)) this.pendingFills.set(channel, files);
    else if (!(await this.props.files.fillIfEmpty(channel.name, files)))
      throw new TeamLaunchFailed(
        team.id,
        present(team.members[0], "the team's first member").name,
        new FilesSpaceInUse(channel.name),
      );
  }

  /**
   * A team's channel persistence (R1, R7, R14), before any member starts: onto an online channel, the team's
   * persist must be the channel's; onto a channel with nobody online, the team's persist becomes the channel's, and
   * a persisted board is restored from its saved state. A cloud-granted member is refused onto a channel whose
   * saved state held memory.
   */
  private async persistChannel(channel: Channel, team: Team, prepared: readonly PreparedLaunch[]): Promise<void> {
    const online = this.online().some((r) => r.channel === channel);
    this.checkPersistMismatch(channel, team, online);
    await this.checkCloudEgress(channel, team, prepared);
    // R25: no member sits beside an agent of the other kind, nor joins a channel memory has been on, if cloud-granted.
    for (const p of prepared) {
      const separated = this.separation(channel, p);
      if (separated !== undefined)
        throw new TeamLaunchFailed(team.id, present(p.name, "a team member's name"), separated);
    }
    this.checkMemoryCloudMix(channel, team, prepared);
    if (team.persist.length === 0) {
      if (!online) this.persistedChannels.delete(channel);
      return;
    }
    const pointer = await this.props.state.readChannelPointer(channel.name);
    if (online) return;
    if (pointer !== undefined) {
      this.checkSavedAssetsDropped(channel, team, pointer);
      await this.props.state.verify(this.props.state.channelDir(channel.name), pointer);
    }
    await this.fillSavedFiles(channel, team, pointer);
    const saved = team.persist.includes('board')
      ? await savedBoard(this.props.state, pointer, channel.name)
      : undefined;
    if (saved !== undefined)
      this.blackboards.set(
        channel,
        Blackboard.resumed({ channel: channel.name, clock: this.props.clock, logger: this.props.logger }, saved),
      );
    this.persistedChannels.set(
      channel,
      new PersistedChannel({
        channel: channel.name,
        team: team.id,
        assets: team.persist,
        files: this.props.files,
        notice: (text) => {
          channel.notice(text);
        },
        state: this.props.state,
        logger: this.props.logger,
        board: () => this.blackboardOf(channel),
        keepsMemoryOnline: () => this.online().some((r) => r.channel === channel && r.keepsMemory),
        pointer,
        stopDeadlines: () => this.stopDeadlines ?? this.channelStopDeadlines.get(channel.name),
      }),
    );
  }

  /**
   * extension-modules R25's separation: a cloud-granted launch onto a channel an agent that keeps memory is on, or has
   * been on in this run; a launch whose image keeps memory onto a channel a cloud-granted agent is on. Names both.
   */
  private separation(channel: Channel, prepared: PreparedLaunch): MemoryEgressForbidden | undefined {
    const label = prepared.name ?? prepared.recipe.id;
    const online = [...this.records.values()].filter((r) => r.channel === channel && !r.stopping);
    if (prepared.modules.cloudGranted) {
      const memory = online.find((r) => r.keepsMemory);
      if (memory !== undefined)
        return new MemoryEgressForbidden(
          channel.name,
          `${label} is cloud-granted, and ${memory.handle ?? memory.recipe.id} on it keeps memory`,
        );
      if (this.memoryChannels.has(channel))
        return new MemoryEgressForbidden(
          channel.name,
          `${label} is cloud-granted, and an agent that keeps memory has been on it in this run`,
        );
    }
    if (prepared.image.manifest.keepsMemory) {
      const cloud = online.find((r) => r.modules.cloudGranted);
      if (cloud !== undefined)
        return new MemoryEgressForbidden(
          channel.name,
          `${label}'s image keeps memory, and ${cloud.handle ?? cloud.recipe.id} on it is cloud-granted`,
        );
    }
    return undefined;
  }

  /** Whether the channel's saved state holds memory, for a cloud-granted launch (R7). */
  private async channelTainted(channel: Channel): Promise<boolean> {
    if (this.persistedChannels.get(channel)?.memoryTainted === true) return true;
    if (!(await this.props.state.exists())) return false;
    return (await this.props.state.readChannelPointer(channel.name))?.memoryTainted === true;
  }

  /** The other online agents on the calling agent's channel, with what their recipes say they do. */
  roster(token: string): AgentInfo[] {
    const record = this.requireConnected(token);
    return this.online()
      .filter((r) => r.channel === record.channel && r !== record)
      .map((r) => ({
        handle: present(r.handle, "an online agent's handle"),
        recipe: r.recipe.id,
        description: r.recipe.description,
      }))
      .sort((a, b) => (a.handle < b.handle ? -1 : 1));
  }

  /**
   * The agent opened its channel stream under the base name it chose. Returns its handle. A persisted agent joins
   * with its journal (agent-persistence R9, R10); alone, its re-sends from before a restart are queued at once,
   * ahead of anything else, before it is shown online; as a team member, it is held until the team is whole.
   */
  connect(token: string, base: string, deliver: (delivery: Delivery) => void): OnlineAgent {
    const record = this.require(token);
    if (record.handle !== undefined)
      throw new AgentRequestInvalid(`${record.handle} already has a channel stream open`);
    const delivered = (delivery: Delivery): void => {
      const traceId = traceIdFor(delivery.message.conversation);
      record.traces.add(traceId);
      record.conversations.set(traceId, delivery.message.conversation);
      record.persisted?.delivered(delivery);
      deliver(delivery);
    };
    const member = {
      deliver: delivered,
      deliveryTimeoutMs: record.recipe.messageTimeoutMs,
      topics: record.launch.topics,
      nestedCalls: record.recipe.nestedCalls === true,
      ...(record.persisted === undefined ? {} : { journal: record.persisted.journal() }),
    };
    // A team member joins under its name, whatever its image asked for (collaborating-agents R11); a restarted agent
    // takes its suspended member's place under the same handle (patterns-phase-3 R12).
    record.handle =
      record.rejoin !== undefined
        ? record.channel.rejoin(record.rejoin, member)
        : record.channel.join(record.baseName ?? base, member, { held: record.held });
    this.props.logger.info('agent.connected', {
      handle: record.handle,
      asked: base,
      channel: record.channel.name,
      container: record.container,
      logFile: record.logFile,
    });
    if (record.persisted !== undefined && !record.held) this.resend(record);
    return describe(record);
  }

  /**
   * Queues a persisted agent's re-sends (R9 (d), (e)): the notice when some of its unsaved messages could not be
   * resumed, then each user's input in order, each reported to its launch's sink in the tick it starts.
   */
  private resend(record: AgentRecord): void {
    const plan = record.resendPlan;
    record.resendPlan = { resends: [], skipped: 0 };
    if (plan.skipped > 0)
      record.channel.notice(
        `⚠ ${present(record.handle, "the agent's handle")} could not resume an agent's message from before the restart`,
      );
    if (plan.resends.length === 0) return;
    for (const { conversation, savedAt } of record.channel.redeliver(
      present(record.handle, "the agent's handle"),
      plan.resends,
    ))
      record.sink.resent(conversation, savedAt);
  }

  /**
   * The agent's channel stream closed. When a stop the daemon began closed it, the agent leaves its channel and its
   * stop goes on — but a restart's container not yet online, stopped at its startup bound, leaves the member it was to
   * take to the restart, whose failure is said on it (R16). Otherwise its container may have crashed (docs/plans/patterns-phase-3.md R11): an online
   * agent's failure is said as its status (demo-scene-refresh R6), then it leaves its channel
   * — or, restartable, its member is suspended (R12), and a restart's container not yet online keeps the member it is to
   * take — and its exit is awaited, up to RESTART_EXIT_WAIT_MS, before anything is stopped: an exit then is the exit
   * handler's to report; none begins today's drain stop, given its grace since it is ending already, its suspended
   * member removed. A persisted one is not checkpointed — no ack can come — and its unsaved deliveries ended with the
   * leave (agent-persistence R10).
   */
  disconnect(token: string): void {
    const record = this.records.get(token);
    if (record?.handle === undefined) return;
    if (record.stopSequence !== undefined) {
      if (!this.ownedByRestart(record)) record.channel.leave(record.handle, 'channel stream closed');
      return;
    }
    // An online agent gone with no stop of it begun — the daemon's and a channel's stops begin one for each agent — is a
    // failure, said once as its status before it is suspended or leaves (docs/plans/demo-scene-refresh.md R6).
    this.sayFailed(record);
    if (this.restartable(record)) record.channel.suspend(record.handle);
    else if (!this.ownedByRestart(record)) record.channel.leave(record.handle, 'channel stream closed');
    if (record.exitWait !== undefined) return;
    record.exitWait = setTimeout(() => {
      record.exitWait = undefined;
      // A stop begun meanwhile (the daemon's, a timeout's) goes on as it is.
      if (record.stopSequence !== undefined) return;
      if (!this.ownedByRestart(record))
        record.channel.leave(present(record.handle, "the agent's handle"), 'channel stream closed');
      record.stopSequence = this.stopContainer(record, 'channel stream closed', 'drain', AGENT_STOP_GRACE_MS / 1_000);
      record.stopCheckpointed = Promise.resolve();
    }, RESTART_EXIT_WAIT_MS);
  }

  /**
   * An online agent gone with no stop of it begun — the daemon's and a channel's stops begin one for each agent — is a
   * failure, said once as its status before it is suspended or leaves (docs/plans/demo-scene-refresh.md R6): from the
   * stream's close or the exit, whichever the daemon sees first.
   */
  private sayFailed(record: AgentRecord): void {
    if (record.announcement === undefined || record.handle === undefined || this.failuresSaid.has(record)) return;
    this.failuresSaid.add(record);
    record.channel.failed(record.handle);
  }

  /**
   * Whether an agent that exits on its own now is restarted (R12, R14): its recipe names `restart`, it is online, the
   * daemon is not stopping, and no stop of it has begun.
   */
  private restartable(record: AgentRecord): boolean {
    return (
      record.recipe.restart !== undefined &&
      record.announcement !== undefined &&
      !this.closing &&
      !this.channelStopDeadlines.has(record.channel.name) &&
      record.stopSequence === undefined &&
      record.handle !== undefined
    );
  }

  /** A restart's container not yet online: its suspended member is the restart's, which removes it or resumes it (R12). */
  private ownedByRestart(record: AgentRecord): boolean {
    return record.rejoin !== undefined && record.announcement === undefined;
  }

  /**
   * `parentSpanId` is the agent's `post` span, from its traceparent; the
   * server requires it, checked against the conversation's trace, on every
   * post with a conversation.
   */
  post(token: string, request: PostRequest, parentSpanId?: string): ChannelMessage {
    const record = this.requireConnected(token);
    if (record.announcement === undefined && request.kind !== 'status') {
      throw new AgentRequestInvalid('announce yourself with a status message before posting');
    }
    // The harness's statuses for an agent are its alone (docs/plans/demo-scene-refresh.md R6, R14).
    if (request.kind === 'status' && isHarnessStatus(request.text))
      throw new AgentRequestInvalid(`"${request.text}" is a status only the harness posts`);
    // Only an agent offered ask_user asks the user (patterns-phase-3 R23), as only one offered reply_with_files returns files.
    if (request.asks === true && !record.tools.selected.includes(ASK_USER_TOOL_NAME)) {
      throw new AgentRequestInvalid(`recipe ${record.recipe.id} does not select ${ASK_USER_TOOL_NAME}`);
    }
    const message = record.channel.post({
      from: present(record.handle, "the agent's handle"),
      kind: request.kind,
      text: request.text,
      ...(request.conversation === undefined ? {} : { conversation: request.conversation }),
      ...(request.to === undefined ? {} : { to: request.to }),
      ...(parentSpanId === undefined ? {} : { parentSpanId }),
      ...(request.asks === true ? { asks: true as const } : {}),
    });
    // The agent's first status message announces it: from here it is online.
    if (record.announcement === undefined) {
      record.announcement = message;
      record.markOnline();
    }
    return message;
  }

  /** The token's agent acknowledges a delivery it holds, and a persisted channel is checkpointed after it (R10, R14). */
  ack(token: string, deliveryId: string): void {
    const record = this.requireOnline(token);
    record.channel.ack(present(record.handle, "the agent's handle"), deliveryId);
    // A persisted channel is checkpointed after every acknowledged delivery on it, coalesced (R10, R14).
    this.persistedChannels.get(record.channel)?.request();
  }

  /** The conversation of a delivery the token's agent holds pending; refused not_holding_delivery otherwise. */
  heldConversation(token: string, deliveryId: string): string {
    const record = this.requireOnline(token);
    return record.channel.heldConversation(present(record.handle, "the agent's handle"), deliveryId);
  }

  /**
   * Opens a call from the token's agent while it handles `deliveryId`
   * (docs/plans/agent-calls.md R2, R3). `parentSpanId` is its post span, from
   * its traceparent, already checked to be in the conversation's trace.
   */
  consult(token: string, deliveryId: string, requests: readonly CallRequest[], parentSpanId: string): ConsultResponse {
    const record = this.requireOnline(token);
    const { call, messages } = record.channel.openCall(
      present(record.handle, "the agent's handle"),
      deliveryId,
      requests,
      parentSpanId,
    );
    return { call, messages: messages.map((m) => m.id) };
  }

  /** The token's agent answers, or passes, the call question it holds as `deliveryId` (R5). */
  answerCall(token: string, deliveryId: string, answer: CallAnswer): ChannelMessage {
    const record = this.requireOnline(token);
    return record.channel.answerCall(present(record.handle, "the agent's handle"), deliveryId, answer);
  }

  /**
   * Who a token's spans belong to, and the traces it may send: the conversations delivered to it.
   * The traces route takes handle and channel from here, never from the request.
   */
  traceScope(token: string): {
    readonly handle: string;
    readonly channel: string;
    readonly traces: ReadonlySet<string>;
  } {
    const record = this.requireConnected(token);
    return {
      handle: present(record.handle, "the agent's handle"),
      channel: record.channel.name,
      traces: record.traces,
    };
  }

  /** The model calls in flight now: the gateway's open asha.chat and asha.embed spans. */
  modelCallsInFlight(): InFlightCall[] {
    // A read-only view: whoever reads it can see the calls, not end their spans.
    return [...this.inFlight].map(({ name, traceId, spanId, channel, handle, start }) => ({
      name,
      traceId,
      spanId,
      channel,
      handle,
      start,
    }));
  }

  /**
   * `parent` is the agent's chat span, from its traceparent: its trace must be a conversation delivered to this agent.
   * `requestClosed` is aborted when the agent's request closes before the answer (model-streaming R2).
   */
  async chat(token: string, body: unknown, parent: TraceParent, requestClosed: AbortSignal): Promise<ChatResponse> {
    const record = this.requireOnline(token);
    this.requireDeliveredTrace(record, parent);
    const request = parseChatRequest(body);
    // R1: an agent is offered, and the gateway serves, only its channel, selected and granted tools (and its image's answer tools).
    const outside = (request.tools ?? []).map((t) => t.function.name).filter((name) => !record.tools.allowed.has(name));
    if (outside.length > 0) {
      throw new AgentRequestInvalid(
        `tools ${outside.map((n) => JSON.stringify(n)).join(', ')} are not among ${present(record.handle, "the agent's handle")}'s channel, selected, granted and answer tools`,
      );
    }
    // model-streaming R3: the conversation comes from the validated trace, never from the agent. Filled with record.traces,
    // which requireDeliveredTrace has just checked: a trace in one and not the other is a harness defect.
    const conversation = record.conversations.get(parent.traceId);
    if (conversation === undefined)
      throw new Error(
        `trace ${parent.traceId} is delivered to ${present(record.handle, "the agent's handle")} but maps to no conversation`,
      );
    const handle = present(record.handle, "the agent's handle");
    const started = Date.now();
    /** The local model's server this call reached, for the prompt store (idle-shutdown R2: it may be a new one). */
    let used: number | undefined;
    const completion = await this.modelCall(
      record,
      'asha.chat',
      parent,
      async (span) => {
        // R4: each piece of output to the conversation's stream and the channel's watchers as it is parsed, then
        // exactly one model_done, from the finally, whatever the outcome.
        let seq = 0;
        let outcome: ModelDoneEvent['outcome'] = 'bad_response';
        try {
          const onDelta = (delta: ModelDelta): void => {
            record.channel.publishModel({
              type: 'model_delta',
              handle,
              conversation,
              call: span.spanId,
              seq: seq++,
              ...delta,
            });
          };
          const model = record.chatModel;
          const done =
            model.kind === 'local'
              ? await this.onLeased(
                  model,
                  { abandon: record.exited.signal, requestClosed },
                  ({ endpoint, server }, waitedMs) => {
                    used = server;
                    return chatCompletion({
                      fetch: this.props.fetch,
                      endpoint,
                      // The recipe's settings win over the model's catalogue defaults.
                      chatDefaults: { ...model.entry.chat, ...record.recipe.chat },
                      toolCallStart: model.entry.toolCallStart,
                      request,
                      abandon: record.exited.signal,
                      requestClosed,
                      onDelta,
                      waitedMs,
                    });
                  },
                  (reason, detail): ChatCompletion => ({ response: { ok: false, reason, detail }, stats: NO_STATS }),
                )
              : // A provider's model (extension-modules R19): through its container, never llama.cpp's means.
                await providerChat(
                  this.providerProps(
                    record,
                    model.ref,
                    conversation,
                    AbortSignal.any([record.exited.signal, requestClosed]),
                  ),
                  request,
                  onDelta,
                );
          outcome = done.response.ok ? 'ok' : done.response.reason;
          return done;
        } finally {
          record.channel.publishModel({ type: 'model_done', handle, conversation, call: span.spanId, outcome });
        }
      },
      (c) => c.response,
    );
    const { response, stats } = completion;
    // patterns-phase-3 R17: the call's tokens count against its conversation's tokens budget, if it has one — a count the
    // call did not reach as 0 — which may end the conversation; the call's own result is returned either way.
    record.channel.spend(conversation, (stats.promptTokens ?? 0) + (stats.completionTokens ?? 0));
    // R8: when the first output came, how many chunks, and the usage chunk's counts — the prompt tokens and how many the
    // server's prompt cache supplied (prompt-prefix R10, R13); null where the stream did not get that far. Never the text.
    const fields = {
      handle,
      channel: record.channel.name,
      model: modelName(record),
      ms: Date.now() - started,
      ...stats,
    };
    if (response.ok) {
      // And the names of the tools the model called, in order — names only, never arguments: which tools a turn used
      // is otherwise invisible outside the agent (agent-tools A10's scenario reads it; prompt-prefix, gate at 988045f).
      this.props.logger.info('model.chat', { ...fields, toolCalls: response.toolCalls.map((c) => c.name) });
      if (used !== undefined) this.storePromptOnce(record, used);
      return response;
    }
    // An exited agent's call is abandoned; so is one whose request closed while the daemon stops its agent, since the
    // container's exit and its connection closing come in either order (model-streaming, amendment 2).
    if (record.exited.signal.aborted || (record.stopping && requestClosed.aborted)) {
      // The agent exited mid-call: its own log says what it left undone (agent.drain_incomplete), or the daemon's (agent.stop_killed).
      this.props.logger.warn('model.call_abandoned', { ...fields, call: 'chat', detail: response.detail });
    } else {
      this.props.logger.error('model.chat_failed', {
        ...fields,
        reason: response.reason,
        error: new Error(`${response.reason}: ${response.detail}`),
      });
    }
    return response;
  }

  /**
   * After a recipe's first answered call on a chat model server, has the server store its idle slots' prompts, so
   * that a later call landing on an empty slot restores the recipe's prompt prefix instead of computing it (D44,
   * storeIdlePrompts). Not awaited: it can queue behind other calls, and the reply is already complete. Its outcome is
   * logged: `model.prompt_stored` once the server has answered (which says the task ran, not what was saved),
   * `model.prompt_store_failed` at error level, or `model.prompt_store_abandoned` (a warning) when the daemon began to
   * stop first; it is not retried, not sent once the daemon is stopping, and ended when it begins to. `server` is the
   * server the call reached (ModelLease.server): a model unloaded and started again is a new server, with a store of
   * its own to fill (docs/plans/idle-shutdown.md R2). The request holds that server for its duration; when it is no
   * longer the model's server — unloaded meanwhile — the store is not sent, and logged `model.prompt_store_skipped`:
   * it never starts a server, and the next server's first answered call sends its own.
   */
  private storePromptOnce(record: AgentRecord, server: number): void {
    // A provider's model has no prompt store: the request would be a paid call (extension-modules R19).
    if (record.chatModel.kind !== 'local') return;
    const model = record.chatModel;
    const key = `${model.entry.id} ${String(server)} ${record.recipe.id}`;
    // Once the daemon is stopping no later call can use the store: a call answered during the stop sends nothing.
    if (this.closing || this.promptsStored.has(key)) return;
    this.promptsStored.add(key);
    const fields = { model: model.entry.id, recipe: record.recipe.id };
    const started = Date.now();
    this.stores.push(
      (async () => {
        const held = this.props.modelServer.holdServer(model.entry.id, server);
        if (held === undefined) {
          this.props.logger.info('model.prompt_store_skipped', { ...fields, ms: Date.now() - started });
          return;
        }
        try {
          const result = await storeIdlePrompts({
            fetch: this.props.fetch,
            endpoint: held.endpoint,
            abandon: this.storesAbandoned.signal,
          });
          if (result.ok) this.props.logger.info('model.prompt_stored', { ...fields, ms: Date.now() - started });
          else if (result.detail === STORE_ABANDONED)
            this.props.logger.warn('model.prompt_store_abandoned', { ...fields, ms: Date.now() - started });
          else
            this.props.logger.error('model.prompt_store_failed', {
              ...fields,
              ms: Date.now() - started,
              reason: result.reason,
              error: new Error(`${result.reason}: ${result.detail}`),
            });
        } catch (error) {
          // storeIdlePrompts returns every expected failure as data: a throw is a harness defect, logged with its cause.
          this.props.logger.error('model.prompt_store_failed', {
            ...fields,
            ms: Date.now() - started,
            reason: 'internal',
            error,
          });
        } finally {
          held.release();
        }
      })(),
    );
  }

  /**
   * A granted module tool's call (docs/plans/extension-modules.md R8): its conversation from the call's validated
   * trace, never the body; 403 `module_forbidden` for a tool the recipe does not grant, logged; 400 `bad_request` for a
   * body or arguments its schema refuses; otherwise 200 with every outcome, failures included. A consequential call —
   * or one that sends local files off the machine after untrusted input (R15) — is held for the user's approval and
   * never sent (R12 (a)).
   */
  async moduleCall(
    token: string,
    body: unknown,
    parent: TraceParent,
  ): Promise<
    | { readonly status: 200; readonly body: ModuleCallResponse }
    | {
        readonly status: 400 | 403;
        readonly body: { readonly error: string; readonly reason: 'bad_request' | 'module_forbidden' };
      }
  > {
    const record = this.requireOnline(token);
    this.requireDeliveredTrace(record, parent);
    const conversation = record.conversations.get(parent.traceId);
    if (conversation === undefined)
      throw new Error(
        `trace ${parent.traceId} is delivered to ${present(record.handle, "the agent's handle")} but maps to no conversation`,
      );
    const bad = (error: string) => ({ status: 400 as const, body: { error, reason: 'bad_request' as const } });
    if (typeof body !== 'object' || body === null || Array.isArray(body))
      return bad('the body is not a JSON object {tool, arguments}');
    const { tool, arguments: args, ...rest } = body as Record<string, unknown>;
    if (Object.keys(rest).length > 0) return bad(`unknown field(s): ${Object.keys(rest).join(', ')}`);
    if (typeof tool !== 'string' || typeof args !== 'object' || args === null || Array.isArray(args))
      return bad('the body is {tool: <wire name>, arguments: {…}}');
    const granted = record.modules.tools.get(tool);
    if (granted === undefined) {
      this.props.logger.error('module.failed', {
        agent: record.handle,
        channel: record.channel.name,
        tool: tool.slice(0, 64),
        reason: 'module_forbidden',
        error: new Error(
          `${present(record.handle, "the agent's handle")}'s recipe ${record.recipe.id} grants no ${tool.slice(0, 64)}`,
        ),
      });
      return {
        status: 403,
        body: {
          error: `${tool.slice(0, 64)} is not a tool recipe ${record.recipe.id} grants`,
          reason: 'module_forbidden',
        },
      };
    }
    let readsLocal = false;
    if (granted.kind === 'tool') {
      const problem = argumentsProblem(granted.parameters, args);
      if (problem !== null) return bad(`${tool}: ${problem}`);
    } else {
      const built = buildArguments(granted.declaration as CommandDeclaration, args);
      if (!built.ok) return bad(`${tool}: argument ${built.field} ${built.problem}`);
      readsLocal = built.paths.some((p) => p.mode === 'read');
    }
    // R15: in a recipe granting an untrusted-input tool, a call that sends local file content off the machine is consequential.
    const consequential =
      granted.classes.includes('consequential') ||
      (granted.kind === 'command' && readsLocal && granted.classes.includes('egress') && record.modules.untrustedInput);
    if (consequential)
      return {
        status: 200,
        body: this.requestApproval(record, granted, args as Record<string, unknown>, conversation),
      };
    const outcome = await this.performModuleCall(record, granted, args as Record<string, unknown>, conversation, {
      consequential: false,
      abandon: record.exited.signal,
    });
    return { status: 200, body: outcome };
  }

  /** R12 (a): a pending request, its `⚠` notice on the call's conversation (never its arguments), and `approval_required`. */
  private requestApproval(
    record: AgentRecord,
    granted: GrantedTool,
    args: Record<string, unknown>,
    conversation: string,
  ): ModuleCallResponse {
    const { approvals } = this.props.modules;
    const agent = present(record.handle, "the agent's handle");
    const user = record.channel.askerOf(conversation);
    if (user === undefined)
      throw new Error(`conversation ${conversation} has no asker on channel ${record.channel.name}`);
    const made = approvals.request(
      {
        agent,
        channel: record.channel.name,
        user,
        module: granted.module,
        tool: granted.tool,
        arguments: canonicalJson(args),
        conversation,
        timeoutMs: granted.timeoutMs,
      },
      record.token,
    );
    if (!made.ok) {
      this.props.logger.error('module.failed', {
        agent,
        channel: record.channel.name,
        module: granted.module,
        tool: granted.tool,
        reason: 'approval_required',
        error: new Error('too many pending approvals: the call was refused, nothing recorded'),
      });
      record.channel.notice(
        `⚠ ${agent}'s call to ${granted.module}/${granted.tool} was refused: too many approvals are pending`,
        conversation,
      );
      return { ok: false, reason: 'approval_required', detail: 'too many pending approvals' };
    }
    const { request } = made;
    this.props.logger.info('module.approval_requested', {
      agent,
      channel: record.channel.name,
      module: granted.module,
      tool: granted.tool,
      approval: request.id,
      sha256: request.sha256,
    });
    record.channel.notice(
      `⚠ ${agent} asks to call ${granted.module}/${granted.tool} (arguments sha256 ${request.sha256.slice(0, 12)}); see and approve with: asha --approve id=${request.id}`,
      conversation,
    );
    return { ok: false, reason: 'approval_required', detail: `approval ${request.id}` };
  }

  /**
   * `performModuleCall`'s reservation (R8): a metered module's cost reserved against the meter before the call is
   * made; a refusal ends the call there. Not metered: nothing to reserve.
   */
  private async reserveModuleCall(granted: GrantedTool, conversation: string, agent: string) {
    const manifest = granted.installed.manifest;
    const perCall =
      manifest.cost.model === 'metered' && manifest.kind === 'ToolModule' ? manifest.cost.perCall : undefined;
    if (perCall === undefined) return { ok: true as const, reservation: undefined, perCall: undefined };
    const reserved = await this.props.modules.meter.reserve(
      granted.module,
      conversation,
      perCall.units * perCall.unitUsd,
    );
    // The launch refuses a metered module not enabled, and nothing disables one: not_enabled here is a defect.
    if (!reserved.ok && reserved.reason === 'not_enabled')
      throw new Error(`module ${granted.module} is metered and not enabled, yet ${agent} was launched granting it`);
    // The meter logged its own refusal (budget.exceeded, budget.meter_failed): one line per event (R35).
    if (!reserved.ok)
      return {
        ok: false as const,
        outcome: {
          ok: false as const,
          reason: reserved.reason,
          detail:
            reserved.reason === 'budget_exceeded'
              ? `the ${reserved.cap} cap of ${String(reserved.limit)} USD would be passed`
              : 'metering.json does not parse',
        },
      };
    return { ok: true as const, reservation: reserved.reservation, perCall };
  }

  /** `performModuleCall`'s settlement (R8): a metered call's reservation settled by its usage, or charged in full. */
  private async settleModuleCall(
    reservation: Reservation | undefined,
    perCall: { readonly units: number; readonly unitUsd: number } | undefined,
    outcome: CallOutcome,
    fields: Record<string, string>,
  ): Promise<void> {
    if (reservation === undefined || perCall === undefined) return;
    const units = outcome.ok ? (outcome.usage as { units?: unknown } | undefined)?.units : undefined;
    if (typeof units === 'number' && units >= 0) {
      await this.props.modules.meter.settle(reservation, units * perCall.unitUsd);
      return;
    }
    this.props.logger.error('module.failed', {
      ...fields,
      reason: outcome.ok ? 'no_usage' : outcome.reason,
      error: new Error('the call reported no usage: charged its whole reservation'),
    });
    await this.props.modules.meter.settle(reservation, 'full');
  }

  /** `performModuleCall`'s call itself: the host for a tool, the plugin runner for a plugin command. */
  private async runModuleCall(
    record: AgentRecord,
    granted: GrantedTool,
    args: Record<string, unknown>,
    agent: string,
    opts: { readonly consequential: boolean; readonly abandon: AbortSignal },
    idempotencyKey: string | undefined,
  ): Promise<CallOutcome> {
    const { host, plugins } = this.props.modules;
    if (granted.kind === 'tool')
      return host.call({
        module: granted.module,
        channel: record.channel.name,
        tool: granted.tool,
        arguments: args,
        timeoutMs: granted.timeoutMs,
        consequential: opts.consequential,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        abandon: opts.abandon,
      });
    return plugins.call({
      agent,
      channel: record.channel.name,
      plugin: granted.installed,
      command: granted.declaration as CommandDeclaration,
      arguments: args,
      roots: record.modules.roots,
      consequential: opts.consequential,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      abandon: opts.abandon,
    });
  }

  /** `performModuleCall`'s failed outcome: the host and the plugin runner log their own failures; a module's own answer `{ok: false}` is logged here. */
  private moduleCallFailure(
    outcome: CallOutcome & { readonly ok: false },
    granted: GrantedTool,
    fields: Record<string, string>,
    started: number,
  ): ModuleCallResponse {
    if (outcome.detail !== 'abandoned' && granted.kind === 'tool')
      this.props.logger.error('module.failed', {
        ...fields,
        reason: outcome.reason,
        durationMs: Date.now() - started,
        error: new Error(outcome.detail.slice(0, 500)),
      });
    return { ok: false, reason: outcome.reason, detail: outcome.detail };
  }

  /**
   * One module call, made (R8, R13, R14, R18b, R34): reserved against the meter when metered, audited before it is sent
   * and with its outcome when consequential, run by the host or the plugin runner, settled, its result cut (R10 (a)),
   * and logged `module.call` or `module.failed`.
   */
  private async performModuleCall(
    record: AgentRecord,
    granted: GrantedTool,
    args: Record<string, unknown>,
    conversation: string,
    opts: { readonly consequential: boolean; readonly approval?: string; readonly abandon: AbortSignal },
  ): Promise<ModuleCallResponse> {
    const { audit } = this.props.modules;
    const agent = record.handle ?? record.recipe.id;
    const started = Date.now();
    const argumentsSha256 = createHash('sha256').update(canonicalJson(args)).digest('hex');
    const fields = { agent, channel: record.channel.name, module: granted.module, tool: granted.tool };
    const reserved = await this.reserveModuleCall(granted, conversation, agent);
    if (!reserved.ok) return reserved.outcome;
    const { reservation, perCall } = reserved;
    const idempotencyKey = opts.consequential ? randomBytes(16).toString('hex') : undefined;
    const line = (outcome: string) => ({
      time: new Date().toISOString(),
      agent,
      conversation,
      module: granted.module,
      tool: granted.tool,
      argumentsSha256,
      approval: opts.approval ?? '',
      idempotencyKey: idempotencyKey ?? '',
      outcome,
    });
    if (opts.consequential) await audit.append(line('sending'));
    const outcome = await this.runModuleCall(record, granted, args, agent, opts, idempotencyKey);
    if (opts.consequential) await audit.append(line(outcome.ok ? 'ok' : outcome.reason));
    await this.settleModuleCall(reservation, perCall, outcome, fields);
    if (!outcome.ok) return this.moduleCallFailure(outcome, granted, fields, started);
    this.props.logger.info('module.call', { ...fields, durationMs: Date.now() - started, outcome: 'ok' });
    return { ok: true, result: granted.kind === 'tool' ? cutResult(outcome.result) : outcome.result };
  }

  /** `GET /v1/approvals/<id>` (R12 (b)): the pending request with its tool's bound, or why its id is refused. */
  readApproval(
    id: string,
  ):
    | { readonly ok: true; readonly request: ApprovalRequest }
    | { readonly ok: false; readonly reason: ApprovalRefusal } {
    const read = this.props.modules.approvals.read(id);
    return read.ok ? { ok: true, request: read.request } : read;
  }

  /**
   * `POST /v1/approvals/<id>` after its checks (R12 (b)–(e)): the request taken at once — so it is performed at most
   * once — and `module.approved` logged; then `perform` makes exactly the approved call, and `deliver` gives its result
   * to the agent as asha's message in a new conversation, or says why it cannot.
   */
  approve(id: string):
    | { readonly ok: false; readonly reason: ApprovalRefusal }
    | {
        readonly ok: true;
        readonly request: ApprovalRequest;
        readonly perform: () => Promise<ApprovedCall['outcome']>;
        readonly deliver: (
          outcome: ApprovedCall['outcome'],
        ) =>
          | { readonly ok: true; readonly message: ConversationMessage; readonly channel: Channel }
          | { readonly ok: false; readonly reason: 'unknown_handle' | 'pending_full'; readonly detail: string };
      } {
    // Read and taken with no await between: of two approvals of one id at once, one takes it, the other finds it unknown.
    const read = this.props.modules.approvals.read(id);
    if (!read.ok) return read;
    const { request, token } = read;
    this.props.modules.approvals.take(id);
    this.props.logger.info('module.approved', {
      agent: request.agent,
      channel: request.channel,
      module: request.module,
      tool: request.tool,
      approval: id,
      sha256: request.sha256,
    });
    const record = this.records.get(token);
    const inFlight = new AbortController();
    return {
      ok: true,
      request,
      perform: async () => {
        if (record === undefined) return { ok: false, reason: 'module_unavailable' };
        const granted = record.modules.tools.get(`${request.module}__${request.tool}`);
        if (granted === undefined)
          throw new Error(
            `approval ${id} names ${request.module}/${request.tool}, which ${request.agent} is not granted`,
          );
        // Exactly the arguments shown: the request's RFC 8785 string, parsed (R12 (c)). No model is asked anything.
        const args = JSON.parse(request.arguments) as Record<string, unknown>;
        this.approvedInFlight.set(inFlight, {
          agent: request.agent,
          channel: request.channel,
          module: request.module,
          tool: request.tool,
          approval: id,
        });
        const call = this.performModuleCall(record, granted, args, request.conversation, {
          consequential: true,
          approval: id,
          abandon: inFlight.signal,
        });
        this.approvedCalls.add(call);
        try {
          const result = await call;
          return result.ok ? { ok: true, result: result.result } : { ok: false, reason: result.reason };
        } finally {
          this.approvedInFlight.delete(inFlight);
          this.approvedCalls.delete(call);
        }
      },
      deliver: (outcome) => {
        const why = (reason: 'unknown_handle' | 'pending_full', detail: string) => {
          const said = outcome.ok ? 'ok' : `failed (${outcome.reason})`;
          this.props.logger.warn('module.approval_undelivered', {
            agent: request.agent,
            channel: request.channel,
            module: request.module,
            tool: request.tool,
            approval: id,
            sha256: request.sha256,
            outcome: outcome.ok ? 'ok' : outcome.reason,
            reason: reason === 'unknown_handle' ? 'agent_gone' : 'pending_full',
          });
          return {
            ok: false as const,
            reason,
            detail: `${request.agent} could not be given the result of approval ${id} (${detail}); the call's outcome: ${said}`,
          };
        };
        const live = this.records.get(token);
        if (live === undefined || live.handle === undefined || this.closing)
          return why('unknown_handle', 'it has left');
        const outcomeText = outcome.ok ? 'ok' : `failed (${outcome.reason})`;
        const text = `asha made the approved call ${request.module}/${request.tool} (approval ${id}): ${outcomeText}`;
        try {
          const message = live.channel.postApproved({
            to: live.handle,
            user: request.user,
            text,
            approved: {
              approval: id,
              module: request.module,
              tool: request.tool,
              arguments: request.arguments,
              outcome,
            },
          });
          return { ok: true, message, channel: live.channel };
        } catch (error) {
          if (error instanceof UnknownHandle) return why('unknown_handle', 'it has left');
          if (error instanceof PendingFull) return why('pending_full', 'its record of unsaved deliveries is full');
          throw error;
        }
      },
    };
  }

  /**
   * The stop's last wait for approved calls (R12 (e)): called after the reclaim, whose removal of their containers
   * ends each `unknown_outcome` unless its answer came first, so each is audited before the daemon exits. Bounded by
   * `ms`; a call still unsettled then is logged at error, its audit line missing.
   */
  async approvedSettled(ms: number): Promise<void> {
    const unsettled = await settledWithin([...this.approvedCalls], ms, realSetTimer);
    if (unsettled > 0)
      this.props.logger.error('module.audit_unsettled', {
        calls: unsettled,
        error: new Error(
          `${String(unsettled)} approved call(s) had not ended ${String(ms)} ms after the reclaim: their outcome is not audited`,
        ),
      });
  }

  /** `POST /v1/modules/enable` (R18b, R36): a metered module's caps, checked against its approved cap. */
  async enableModule(
    id: string,
    caps: Caps,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: EnableRefusal; readonly detail: string }> {
    const refusal = enableRefusal(this.props.modules.installed.get(id)?.manifest, caps);
    if (refusal !== undefined) return { ok: false, ...refusal };
    await this.props.modules.meter.enable(id, caps);
    this.props.logger.info('module.enabled', { module: id, caps });
    return { ok: true };
  }

  /** --status's spend lines (R21): each enabled metered module's day and month. */
  spend(): {
    readonly module: string;
    readonly day: number;
    readonly dayCap: number;
    readonly month: number;
    readonly monthCap: number;
  }[] {
    return [...this.props.modules.installed.keys()].flatMap((module) => {
      const s = this.props.modules.meter.status(module);
      return s === undefined ? [] : [{ module, ...s }];
    });
  }

  /** The caller's channel's blackboard entries after `since` (docs/plans/agent-tools.md R10). */
  blackboardRead(token: string, since: number): BlackboardReadResponse {
    const record = this.requireOnline(token);
    return this.blackboardOf(record.channel).read(since);
  }

  /** Appends to the caller's channel's blackboard, as the caller: the author is the token's handle, never the body's. */
  blackboardPost(token: string, text: string): BlackboardPostResult {
    const record = this.requireOnline(token);
    const posted = this.blackboardOf(record.channel).post(present(record.handle, "the agent's handle"), text);
    // A persisted board's bound lasts until reset: said once per channel per run (R14).
    if (!posted.ok && posted.reason === 'blackboard_full') this.persistedChannels.get(record.channel)?.boardFull();
    return posted;
  }

  /**
   * A channel's board as the control API reads it (docs/plans/patterns-phase-4.md R1, R3): the same read as an agent's,
   * of the board the channel holds now — a resumed one included — and, for a channel with no board, an empty answer
   * without making one (a read never creates state).
   */
  channelBlackboard(channel: Channel, since: number): BlackboardReadResponse {
    return this.blackboards.get(channel)?.read(since) ?? { entries: [], more: false };
  }

  private blackboardOf(channel: Channel): Blackboard {
    let board = this.blackboards.get(channel);
    if (board === undefined) {
      board = new Blackboard({ channel: channel.name, clock: this.props.clock, logger: this.props.logger });
      this.blackboards.set(channel, board);
    }
    return board;
  }

  /** An agent's embedding call, through its recipe's embedding model. */
  async embed(token: string, body: unknown, parent: TraceParent): Promise<EmbedResponse> {
    const record = this.requireOnline(token);
    this.requireDeliveredTrace(record, parent);
    const request = parseEmbedRequest(body);
    const embedding = record.embedding;
    if (embedding === null) throw new AgentRequestInvalid(`recipe "${record.recipe.id}" names no embeddingModel`);
    const started = Date.now();
    const conversation = record.conversations.get(parent.traceId);
    if (conversation === undefined)
      throw new Error(
        `trace ${parent.traceId} is delivered to ${present(record.handle, "the agent's handle")} but maps to no conversation`,
      );
    const response = await this.modelCall(
      record,
      'asha.embed',
      parent,
      () =>
        embedding.kind === 'local'
          ? this.onLeased(
              embedding,
              { abandon: record.exited.signal },
              ({ endpoint }, waitedMs) =>
                embeddings({
                  fetch: this.props.fetch,
                  endpoint,
                  entry: embedding.entry,
                  request,
                  // Its bound counts from the call's start: the wait for its model's server comes off it (R2).
                  timeoutMs: Math.max(1, this.props.chatTimeoutMs - waitedMs),
                  abandon: record.exited.signal,
                }),
              (reason, detail): EmbedResponse => ({ ok: false, reason, detail }),
            )
          : providerEmbed(this.providerProps(record, embedding.ref, conversation, record.exited.signal), request),
      (r) => r,
    );
    const fields = {
      handle: record.handle,
      channel: record.channel.name,
      model: embedding.kind === 'local' ? embedding.entry.id : `${embedding.ref.module}/${embedding.ref.model.name}`,
      texts: request.texts.length,
      ms: Date.now() - started,
    };
    if (response.ok) {
      this.props.logger.info('model.embed', fields);
    } else if (record.exited.signal.aborted) {
      this.props.logger.warn('model.call_abandoned', { ...fields, call: 'embed', detail: response.detail });
    } else {
      this.props.logger.error('model.embed_failed', {
        ...fields,
        reason: response.reason,
        error: new Error(`${response.reason}: ${response.detail}`),
      });
    }
    return response;
  }

  /**
   * R2a: a model call belongs to a conversation delivered to the calling agent. Checked first, before the
   * body or the recipe, so a call outside the agent's conversations is refused for that, whatever else it is.
   */
  private requireDeliveredTrace(record: AgentRecord, parent: TraceParent): void {
    if (!record.traces.has(parent.traceId)) {
      throw new AgentRequestInvalid(
        `traceparent names trace ${parent.traceId}, which is no conversation delivered to ${present(record.handle, "the agent's handle")}`,
      );
    }
  }

  /**
   * `call` on a local model's endpoint, leased for the call's whole duration, so an idle unload never stops the model
   * under it, and a model unloaded since the launch is started again here (docs/plans/idle-shutdown.md R1, R2). The
   * wait for the lease is part of the call's first-chunk bound, CHAT_QUEUE_BOUND_MS: `call` is given how long it
   * waited. A wait past that bound, or cut short by the agent's exit or its request closing, ends the call as `ended`
   * makes it, and so does a model that cannot be started again: data, not a throw. A lease that comes after its call
   * has given up is released at once, and a start that fails after it is logged, `model.start_failed`.
   */
  private async onLeased<T>(
    model: { readonly entry: ServedEntry; readonly cached: CachedModel },
    stops: { readonly abandon: AbortSignal; readonly requestClosed?: AbortSignal },
    call: (lease: ModelLease, waitedMs: number) => Promise<T>,
    ended: (reason: ModelFailureReason, detail: string) => T,
  ): Promise<T> {
    const started = Date.now();
    const leasing = this.props.modelServer.lease(model.entry, model.cached);
    let lease: ModelLease;
    try {
      const first = await leaseWithin(leasing, stops);
      if (!('endpoint' in first)) {
        leasing.then(
          (late) => {
            late.release();
          },
          (error: unknown) => {
            this.props.logger.error('model.start_failed', { model: model.entry.id, error });
          },
        );
        return ended(first.reason, first.detail);
      }
      lease = first;
    } catch (error) {
      if (error instanceof ModelServerFailed) return ended('unavailable', error.message);
      throw error;
    }
    try {
      return await call(lease, Date.now() - started);
    } finally {
      lease.release();
    }
  }

  /**
   * One model call through the gateway, as an asha.chat or asha.embed span:
   * refused before the model is called when the agent's span is not in a
   * conversation delivered to it (R2a); held in flight until the gateway
   * answers; ended with the answer's outcome.
   */
  private async modelCall<T>(
    record: AgentRecord,
    name: 'asha.chat' | 'asha.embed',
    parent: TraceParent,
    /** The call, given its span: a chat's `call` id is the span's (model-streaming R4). */
    call: (span: OpenSpan) => Promise<T>,
    /** What the agent receives from the call's result: its outcome ends the span. */
    responseOf: (result: T) => ChatResponse | EmbedResponse,
  ): Promise<T> {
    this.requireDeliveredTrace(record, parent);
    const span = this.props.tracer.start({
      name,
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      channel: record.channel.name,
      handle: present(record.handle, "the agent's handle"),
    });
    this.inFlight.add(span);
    try {
      const result = await call(span);
      const response = responseOf(result);
      span.end(response.ok ? { status: 'ok' } : { status: 'error', reason: traceReasonOf(response.reason) });
      return result;
    } catch (error) {
      // The gateway returns every expected failure as data; a throw is a harness defect (logged as
      // http.handler_failed by the server). The span still ends, saying no usable response came.
      span.end({ status: 'error', reason: 'bad_response' });
      throw error;
    } finally {
      this.inFlight.delete(span);
      if (this.inFlight.size === 0) for (const wake of this.idleWaiters.splice(0)) wake();
    }
  }

  /**
   * `restartAfter`'s one attempt: closing or over intensity ends the restart (`done: true`); otherwise started
   * again, its container rejoining the suspended member — online, `agent.restarted` and the channel re-sends what
   * the member held (`done: true`); failed, the next exit its failure stands for (`done: false`, to try again).
   */
  private async restartOnce(
    record: AgentRecord,
    channel: Channel,
    handle: string,
    policy: RestartPolicy,
    history: { begun: number[]; attempts: number },
    quiet: OnlineSink,
    exit: { readonly code: number | null; readonly at: number },
  ): Promise<
    | { readonly done: true }
    | { readonly done: false; readonly exit: { readonly code: number | null; readonly at: number } }
  > {
    // The daemon stopping ends the restart: its suspended member goes with it (R14); so does its channel's stop.
    if (this.closing || this.channelStopDeadlines.has(channel.name)) {
      channel.leave(handle, this.closing ? 'the daemon is stopping' : `channel ${channel.name} is stopping`);
      return { done: true };
    }
    const recent = history.begun.filter((t) => exit.at - t < policy.withinMs);
    const resends = channel.mostResent(handle);
    if (recent.length >= policy.max || resends >= policy.max) {
      // Which limit it is: the restarts within the window, or else the held message's re-sends (the code review's round 3).
      this.restartLimit(channel, handle, recent.length, policy.withinMs, recent.length >= policy.max ? null : resends);
      return { done: true };
    }
    history.begun.push(exit.at);
    history.attempts += 1;
    const attempt = history.attempts;
    // Which of the restarts its policy allows in the window this is — counted as the limit counts them.
    const nth = recent.length + 1;
    channel.suspend(handle);
    // The chat says the supervisor is at work, the agent still down (docs/plans/demo-scene-refresh.md R16).
    channel.failed(handle, restartingStatus(nth, policy.max, policy.withinMs));
    this.props.logger.warn('agent.restarting', {
      handle,
      attempt,
      max: policy.max,
      withinMs: policy.withinMs,
      code: exit.code,
    });
    try {
      await this.start(record.launch, channel, quiet, handle);
    } catch (error) {
      return { done: false, exit: this.restartFailure(error, channel, { handle, attempt, nth }, exit) };
    }
    this.props.logger.info('agent.restarted', { handle, attempt, ms: Date.now() - exit.at });
    const resent = channel.resume(handle, attempt);
    if (resent > 0) channel.post({ from: handle, kind: 'status', text: resentStatus(resent) });
    return { done: true };
  }

  /**
   * `restartOnce`'s failed attempt: the stop ended it (AgentStartFailed: "the daemon is stopping", or its container
   * stopped) — the stop's own, said by the stop, and the same exit tried again, which the loop's own top then ends.
   * Anything else is said here (`agent.restart_failed`), stopping or not, and the next exit it stands for: its code,
   * when the restart's container exited by itself; null when it was killed for its timeout.
   */
  private restartFailure(
    error: unknown,
    channel: Channel,
    which: { readonly handle: string; readonly attempt: number; readonly nth: number },
    exit: { readonly code: number | null; readonly at: number },
  ): { readonly code: number | null; readonly at: number } {
    const { handle, attempt, nth } = which;
    if ((this.isClosing() || this.channelStopDeadlines.has(channel.name)) && error instanceof AgentStartFailed)
      return exit;
    const detail = error instanceof Error ? error.message : String(error);
    if (!(error instanceof AgentStartFailed && /before coming online|container failed/.test(detail))) {
      this.props.logger.error('agent.restart_failed', {
        handle,
        attempt,
        reason: error instanceof AgentStartFailed ? detail.slice(detail.indexOf(': ') + 2) : classify(error),
        error,
      });
    }
    const { why, code } = restartFailureKind(error);
    // Said in the chat, the agent still down (R16), by what kept it from coming online.
    channel.failed(handle, restartFailedStatus(nth, why));
    return { code, at: Date.now() };
  }

  /**
   * An online agent whose recipe names `restart` exited on its own (patterns-phase-3 R12, R13): restarted under its
   * handle unless its intensity is spent — `max` restarts begun in the last `withinMs` ms (one begun exactly `withinMs`
   * ago no longer counts), or a delivery it holds already re-sent `max` times — or the daemon is stopping. Each attempt
   * logs `agent.restarting` and starts the same recipe again, its container rejoining the suspended member; online, it
   * logs `agent.restarted` and the channel re-sends what the member held. A restart that exits before it is online (its
   * own exit logged `agent.exited_unexpectedly`) or is not online within the recipe's startupTimeoutMs
   * (`agent.restart_failed`, its container killed) counts as the agent's next exit. A background job: its failure is
   * logged, never thrown into `gone`.
   */
  private restartAfter(record: AgentRecord, code: number, exitAt: number): void {
    const handle = present(record.handle, "the agent's handle");
    const channel = record.channel;
    const policy = present(record.recipe.restart, "a restartable agent's restart policy");
    const key = `${channel.name} ${handle}`;
    const history = this.restartHistory.get(key) ?? { begun: [], attempts: 0 };
    this.restartHistory.set(key, history);
    const quiet: OnlineSink = { phase: () => undefined, announced: () => undefined, resent: () => undefined };
    // Its models are held for the whole restart, waits between attempts included (portal-demo-stop R3).
    const models = localModels(record.launch);
    for (const m of models) count(this.modelHolds, m, 1);
    const job = (async () => {
      let exit: { readonly code: number | null; readonly at: number } = { code, at: exitAt };
      for (;;) {
        const outcome = await this.restartOnce(record, channel, handle, policy, history, quiet, exit);
        if (outcome.done) return;
        exit = outcome.exit;
      }
    })().catch((error: unknown) => {
      // A defect in the restart itself: said, and the member taken off, so no conversation waits on it for ever.
      this.props.logger.error('agent.restart_failed', { handle, attempt: history.attempts, reason: 'internal', error });
      channel.leave(handle, 'its restart failed');
    });
    this.restartJobs.set(job, channel.name);
    void job.finally(() => {
      this.restartJobs.delete(job);
      for (const m of models) count(this.modelHolds, m, -1);
    });
  }

  /** Settles once every restart going on now has ended (R14): stopAll waits for them, after its stops. */
  restartsSettled(): Promise<void> {
    return Promise.all([...this.restartJobs.keys()]).then(() => undefined);
  }

  /**
   * The restart limit (R13): `agent.restart_limit` at error, every conversation in which the agent held a delivery ended
   * `restart_limit`, then its member taken off the channel.
   */
  /**
   * An agent down once more than its restart policy allows (R12, R16): logged, said in the chat, its held conversations
   * ended and the agent taken off. `resent` is null when the window's restarts are the limit, and otherwise how many
   * times the message it held was sent again, the limit that was reached.
   */
  private restartLimit(
    channel: Channel,
    handle: string,
    restarts: number,
    withinMs: number,
    resent: number | null,
  ): void {
    const within = `${String(Math.round(withinMs / 1_000))} s`;
    this.props.logger.error('agent.restart_limit', {
      handle,
      restarts,
      withinMs,
      resent,
      error: new Error(
        resent === null
          ? `${handle} exited again after ${String(restarts)} restart(s) within ${String(withinMs)} ms: not restarted`
          : `${handle} exited again holding a message sent again ${String(resent)} time(s): not restarted`,
      ),
    });
    const detail =
      resent === null
        ? `${handle} exited ${String(restarts + 1)} times within ${within}; not restarted`
        : `${handle} exited again, its held message sent again ${String(resent)} times; not restarted`;
    // Said in the chat before it is taken off (R16), naming the limit reached.
    channel.failed(handle, resent === null ? restartLimitStatus(restarts, withinMs) : restartResentLimitStatus(resent));
    for (const conversation of channel.heldConversations(handle)) channel.end(conversation, 'restart_limit', detail);
    channel.leave(handle, 'restart limit reached');
  }

  /** Stops the agent with this handle on this channel (a delivery-timeout offender): killed, with no grace, since it is the work it would drain that overran. */
  async stopHandle(channel: string, handle: string, reason: string): Promise<void> {
    const record = [...this.records.values()].find((r) => r.channel.name === channel && r.handle === handle);
    if (record) await this.stopRecord(record, reason, 'kill');
  }

  /**
   * Stops every agent, each given its grace to finish the work it has started, and launches nothing more; a
   * persisted agent is released no delivery from now on, its ack awaited without a signal, checkpointed, then
   * drained with the grace left to the stop's container deadline — at least STATE_STOP_MIN_GRACE_MS — or killed
   * with no ack (agent-persistence R10). A persisted channel's final checkpoint starts once each of its persisted
   * agents is checkpointed or given up and its other agents have exited, or at the stop's deadline. `deadlines`: the
   * full stop's from now by default; persistent-macos R20's bounded stop passes its own. Resolves once every
   * container is gone and no model call is in flight: a call whose agent has exited is abandoned
   * (`model.call_abandoned`), every other chat is bounded by the gateway's queue and idle bounds, and every
   * embedding by `chatTimeoutMs`; and once no prompt-store request (storePromptOnce) is, each abandoned as the stop
   * begins.
   */
  async stopAll(reason: string, deadlines: StopDeadlines = fullStopDeadlines(Date.now())): Promise<void> {
    this.closing = true;
    // extension-modules R34: nothing released one by one from here (the reclaim removes every module object); the
    // approvals' expiry timers cleared; an approved call in flight abandoned (R12 (e)).
    this.props.modules.host.stop();
    this.props.modules.approvals.stop();
    for (const [call, fields] of this.approvedInFlight) {
      this.props.logger.error('module.failed', {
        ...fields,
        reason: 'abandoned',
        error: new Error(
          'the daemon is stopping: an approved call in flight is abandoned; its audit records its outcome, or unknown_outcome',
        ),
      });
      call.abort();
    }
    // Uploads and returns in flight end now, and no expiry's rollback runs: the channels' final checkpoints take the
    // spaces' locks at once (agent-files R3a), and the reclaim removes the volumes.
    this.props.files.stop();
    this.storesAbandoned.abort();
    this.stopDeadlines = deadlines;
    const records = [...this.records.values()];
    // No delivery is released to a persisted agent from here on (R10).
    for (const record of records)
      if (record.persisted !== undefined && record.handle !== undefined) record.channel.freeze(record.handle);
    const stops = records.map((r) => this.stopRecord(r, reason, 'drain'));
    // A channel stopping on its own takes its own final checkpoint (portal-demo-stop R2): waited for, never run twice. Its
    // failure is its own stop's, logged there as agent.channel_stop_failed.
    const channelStops = [...this.channelStops.values()].map((run) =>
      run.done.then(
        () => undefined,
        () => undefined,
      ),
    );
    const finals = [...this.persistedChannels]
      .filter(([channel]) => !this.channelStopDeadlines.has(channel.name))
      .map(async ([channel, persisted]) => {
        const mine = records.filter((r) => r.channel === channel);
        // Every stop above began in this same turn, and stopRecord sets stopCheckpointed as a stop begins: its absence
        // would be a broken invariant, which fails here rather than reading as already settled (PRINCIPLES §9).
        const ready = Promise.all(mine.map(finalWaitFor));
        const latest = sleepUntil(deadlines.channelStartBy);
        await Promise.race([ready, latest.done]);
        latest.cancel();
        await persisted.final(deadlines);
      });
    await Promise.all([...stops, ...finals, ...channelStops]);
    // A restart begun before the stop ends now (R14): its start refuses to begin once the daemon is closing, or its
    // container was among the records stopped above; its suspended member is removed either way.
    await this.restartsSettled();
    // A container whose exit was never seen (agent.stop_failed) is treated as gone: its calls are abandoned too.
    for (const record of this.records.values()) record.exited.abort();
    if (this.inFlight.size > 0) await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    // The prompt-store requests, abandoned above, have ended before the model servers stop.
    await Promise.all(this.stores);
  }

  /** The handles of the agents on a channel, a launching one by its member's or recipe's name (portal-demo-stop R1). */
  agentsOn(channel: string): string[] {
    return [...this.records.values()]
      .filter((r) => r.channel.name === channel)
      .map((r) => r.handle ?? r.baseName ?? r.recipe.id);
  }

  /** Whether any agent is on the channel, launching or online (docs/plans/portal-demo-stop.md R1). */
  hasAgentsOn(channel: string): boolean {
    return this.launchingOn.has(channel) || [...this.records.values()].some((r) => r.channel.name === channel);
  }

  /**
   * Whether the agents have work, for the daemon's idle stop (docs/plans/idle-shutdown.md R3): an agent in any phase —
   * launching, online, stopping — a launch or restart in progress, a channel's stop, an approved module call being
   * made, or a persisted identity in use or being erased.
   */
  busy(): boolean {
    return (
      this.records.size > 0 ||
      this.launching.size > 0 ||
      this.launchJobs.size > 0 ||
      this.restartJobs.size > 0 ||
      this.channelStops.size > 0 ||
      this.approvedCalls.size > 0 ||
      this.inUse.size > 0
    );
  }

  /**
   * Every local model an agent needs (portal-demo-stop R3): each record's, whether launching, online or stopping, and
   * each launch's or restart's in progress, by catalogue id.
   */
  modelsInUse(): ReadonlySet<string> {
    const used = new Set(this.modelHolds.keys());
    for (const r of this.records.values()) {
      if (r.chatModel.kind === 'local') used.add(r.chatModel.entry.id);
      if (r.embedding?.kind === 'local') used.add(r.embedding.entry.id);
    }
    return used;
  }

  /**
   * Stops every agent on one channel and leaves the rest of the daemon running (portal-demo-stop R2). The channel is
   * marked stopping first, so nothing launches or restarts onto it. Then:
   * - its agents' pending approvals are dropped, another channel's kept; its approved call in flight ends when its module
   *   is stopped with its last agent;
   * - each agent is drained as stopAll drains it, to stopAll's deadlines from now: a persisted agent's ack awaited,
   *   then its checkpoint, every container within AGENT_STOP_GRACE_MS; `stopped` told each handle as it is gone;
   * - the channel's final checkpoint, once its persisted agents are checkpointed and its others gone;
   * - its restarts ended, and its file space removed.
   * A second stop of the same channel joins the first. Logged `agent.channel_stopped`; a failure is logged
   * `agent.channel_stop_failed` and thrown as ChannelStopFailed. Resolves with the handles stopped.
   */
  stopChannel(name: string, source: 'portal' | 'cli', stopped: (handle: string) => void): Promise<readonly string[]> {
    const running = this.channelStops.get(name);
    if (running !== undefined) {
      // A caller that joins hears the handles already stopped, then the rest as they go.
      for (const handle of running.told) stopped(handle);
      running.listeners.add(stopped);
      return running.done;
    }
    if (this.closing) return Promise.reject(new ChannelStopFailed(name, 'the daemon is stopping'));
    const told: string[] = [];
    const listeners = new Set([stopped]);
    const tell = (handle: string): void => {
      told.push(handle);
      for (const listener of listeners) listener(handle);
    };
    const done = this.runChannelStop(name, source, tell).finally(() => this.channelStops.delete(name));
    this.channelStops.set(name, { done, told, listeners });
    return done;
  }

  private async runChannelStop(
    name: string,
    source: 'portal' | 'cli',
    stopped: (handle: string) => void,
  ): Promise<readonly string[]> {
    const started = Date.now();
    const deadlines = fullStopDeadlines(started);
    this.channelStopDeadlines.set(name, deadlines);
    // From here no launch begins on the channel, and one in progress starts no container (start): each is awaited below.
    const launches = [...this.launchJobs].filter(([, channel]) => channel === name).map(([job]) => job);
    const records = [...this.records.values()].filter((r) => r.channel.name === name);
    const handleOf = (r: AgentRecord): string => r.handle ?? r.baseName ?? r.recipe.id;
    const handles = records.map(handleOf);
    try {
      // Its pending approvals go now. An approved call in flight ends when the channel's module is stopped with its last
      // agent (the host's teardown: module.failed abandoned, the outcome unknown_outcome), as when its agents leave.
      this.props.modules.approvals.dropFor(new Set(records.map((r) => r.token)));
      // No delivery is released to a persisted agent from here on (agent-persistence R10): its stop below freezes it as it
      // begins, in this same turn.
      // An agent still listed once its stop returns was not seen to exit (agent.stop_failed): its calls are abandoned,
      // as stopAll treats one, and the channel's stop fails naming it, its file space left for the reclaim.
      const unstopped: string[] = [];
      const stops = records.map(async (r) => {
        await this.stopRecord(r, `channel ${name} stopping`, 'drain', deadlines);
        if (this.records.has(r.token)) {
          unstopped.push(handleOf(r));
          r.exited.abort();
          return;
        }
        stopped(handleOf(r));
      });
      const persisted = [...this.persistedChannels].find(([channel]) => channel.name === name);
      const final =
        persisted === undefined
          ? Promise.resolve()
          : (async () => {
              const [channel, persistence] = persisted;
              // As stopAll's finals above: every stop began in this same turn (PRINCIPLES §9).
              const ready = Promise.all(records.map(finalWaitFor));
              const latest = sleepUntil(deadlines.channelStartBy);
              await Promise.race([ready, latest.done]);
              latest.cancel();
              await persistence.final(deadlines);
              this.persistedChannels.delete(channel);
            })();
      await Promise.all([...stops, final]);
      if (unstopped.length > 0)
        throw new Error(`${unstopped.toSorted(byCodeUnit).join(', ')} still running after the stop`);
      // A restart begun before the stop ends now: it starts nothing on a stopping channel, and its member leaves. So does a
      // launch: refused when it reaches its record, so nothing it made ready survives the space's removal below.
      await Promise.all([
        ...[...this.restartJobs].filter(([, channel]) => channel === name).map(([job]) => job),
        ...launches,
      ]);
      for (const key of [...this.restartHistory.keys()])
        if (key.startsWith(`${name} `)) this.restartHistory.delete(key);
      if (this.props.files.exists(name)) await this.props.files.remove(name);
      this.props.logger.info('agent.channel_stopped', { channel: name, handles, source, ms: Date.now() - started });
      return handles;
    } catch (error) {
      this.props.logger.error('agent.channel_stop_failed', { channel: name, handles, source, error });
      throw new ChannelStopFailed(name, error instanceof Error ? error.message : String(error), { cause: error });
    } finally {
      this.channelStopDeadlines.delete(name);
    }
  }

  /** Releases the modules a record acquired, once (extension-modules R34). */
  private releaseModules(record: AgentRecord): void {
    const held = record.modulesHeld;
    if (held.length === 0) return;
    record.modulesHeld = [];
    for (const module of held) {
      void this.props.modules.host.release(module, record.channel.name).catch((error: unknown) => {
        this.props.logger.error('module.release_failed', { module, channel: record.channel.name, error });
      });
    }
  }

  /** What a provider call needs of a record (extension-modules R19). */
  private providerProps(
    record: AgentRecord,
    ref: ProviderModelRef,
    conversation: string,
    abandon: AbortSignal,
  ): ProviderCallProps {
    return {
      host: this.props.modules.host,
      meter: this.props.modules.meter,
      logger: this.props.logger,
      ref,
      channel: record.channel.name,
      conversation,
      abandon,
      now: () => Date.now(),
    };
  }

  private online(): AgentRecord[] {
    return [...this.records.values()].filter((r) => r.announcement !== undefined);
  }

  private require(token: string): AgentRecord {
    const record = this.records.get(token);
    if (!record) throw new AgentRequestInvalid('token is not a running agent');
    return record;
  }

  private requireConnected(token: string): AgentRecord {
    const record = this.require(token);
    if (record.handle === undefined) throw new AgentRequestInvalid('connect to the channel before using it');
    return record;
  }

  private requireOnline(token: string): AgentRecord {
    const record = this.requireConnected(token);
    if (record.announcement === undefined)
      throw new AgentRequestInvalid('announce yourself with a status message first');
    return record;
  }

  /**
   * Stops an agent's container — SIGTERM, so it can finish the work it has started, then SIGKILL after the
   * runtime's grace — and waits, bounded, for it to be gone. Its exit handler takes it off the channel. One stop per
   * agent: a second stop joins the first (agent-persistence R10). A persisted agent being drained runs the persisted
   * stop: during the daemon's stop, to its deadlines; otherwise — a team's rollback — from now, with the full grace.
   */
  private stopRecord(record: AgentRecord, reason: string, mode: StopMode, deadlines?: StopDeadlines): Promise<void> {
    if (record.stopSequence !== undefined) return record.stopSequence;
    // A stop begun during the wait for a closed stream's exit ends the wait: this stop is the daemon's (R11, R14).
    clearTimeout(record.exitWait);
    record.exitWait = undefined;
    if (record.persisted !== undefined && mode === 'drain') {
      // A channel's stop passes its own deadlines, stopAll's from its start (portal-demo-stop R2); a rollback has none.
      const own = deadlines ?? this.stopDeadlines;
      record.stopSequence = this.persistedStop(record, reason, own ?? fullStopDeadlines(Date.now()), own === undefined);
      return record.stopSequence;
    }
    record.stopCheckpointed = Promise.resolve();
    record.stopSequence =
      mode === 'drain'
        ? this.stopContainer(record, reason, 'drain', AGENT_STOP_GRACE_MS / 1_000)
        : this.stopContainer(record, reason, 'kill');
    return record.stopSequence;
  }

  /**
   * A persisted agent's stop (R10): no signal until its delivery in hand is acknowledged — until the ack wait's
   * deadline — then its checkpoint (the one that ack began, or one at once with nothing in hand), bounded; then
   * `drain` with the whole seconds left to the container deadline, never fewer than STATE_STOP_MIN_GRACE_MS; with no
   * ack, `state.stop_unsaved` and `kill` at once. A rollback's drain is given the full 70 s grace.
   */
  private async persistedStop(
    record: AgentRecord,
    reason: string,
    deadlines: StopDeadlines,
    rollback: boolean,
  ): Promise<void> {
    let checkpointed!: () => void;
    record.stopCheckpointed = new Promise<void>((resolve) => (checkpointed = resolve));
    const persisted = present(record.persisted, "a persisted agent's persistence");
    record.stopping = true;
    if (record.handle !== undefined) record.channel.freeze(record.handle);
    try {
      // Not yet online: nothing has changed since its restore, so there is nothing to save.
      if (record.announcement === undefined) {
        checkpointed();
        await this.stopContainer(
          record,
          reason,
          'drain',
          Math.max(STATE_STOP_MIN_GRACE_MS / 1_000, Math.floor((deadlines.containerBy - Date.now()) / 1_000)),
        );
        return;
      }
      this.props.logger.info('agent.stopping', {
        handle: record.handle ?? null,
        container: record.container,
        reason,
        mode: 'drain',
        persisted: true,
      });
      if (persisted.inHand !== undefined && !(await persisted.ackBy(deadlines.ackBy))) {
        await persisted.stopUnsaved();
        checkpointed();
        await this.stopContainer(record, reason, 'kill', undefined, false);
        return;
      }
      // The ack began its checkpoint, or one ran before the stop; with neither, one at once (R10).
      const running = persisted.checkpointing;
      if (running !== undefined) {
        persisted.bound(deadlines);
        await running;
      } else {
        await persisted.checkpoint(null);
      }
      checkpointed();
      const graceS = rollback
        ? AGENT_STOP_GRACE_MS / 1_000
        : Math.max(STATE_STOP_MIN_GRACE_MS / 1_000, Math.floor((deadlines.containerBy - Date.now()) / 1_000));
      await this.stopContainer(record, reason, 'drain', graceS, false);
    } finally {
      checkpointed();
    }
  }

  /**
   * `runtime.stop` with its mode and grace, then a bounded wait for the container to be gone; STOP_WAIT_MS starts
   * only once `runtime.stop` has returned, for every caller (R10). `log`: false when the persisted stop has logged
   * `agent.stopping` itself.
   */
  private async stopContainer(
    record: AgentRecord,
    reason: string,
    mode: StopMode,
    graceS?: number,
    log = true,
  ): Promise<void> {
    record.stopping = true;
    record.stopMode = mode;
    record.graceS = graceS;
    if (log)
      this.props.logger.info('agent.stopping', {
        handle: record.handle ?? record.rejoin ?? null,
        container: record.container,
        reason,
        mode,
      });
    try {
      if (mode === 'drain')
        await this.props.runtime.stop(record.container, 'drain', present(graceS, 'the drain grace period'));
      else await this.props.runtime.stop(record.container, 'kill');
    } catch (error) {
      this.props.logger.error('agent.stop_failed', { container: record.container, error });
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout');
      }, STOP_WAIT_MS);
    });
    const outcome = await Promise.race([record.gone, bound]);
    clearTimeout(timer);
    if (outcome === 'timeout') {
      this.props.logger.error('agent.stop_failed', {
        container: record.container,
        error: new Error(`container still running ${String(STOP_WAIT_MS)} ms after it was stopped`),
      });
    }
  }

  private async launch(recipeName: string, channel: Channel, sink: OnlineSink): Promise<OnlineAgent> {
    const { definitions } = this.props;
    const recipe = await definitions.recipe(recipeName);
    const prepared = await this.prepare({
      recipe,
      recipeFile: join(definitions.recipesDir, `${recipeName}.json`),
      folder: definitions.recipesDir,
      name: null,
      team: null,
      teamRoots: [],
      topics: [],
      launchable: [],
    });
    // A cloud-granted agent never joins a channel whose saved state held memory (R7).
    const refusal = egressRefusal(
      channel.name,
      prepared.modules.cloudGranted,
      prepared.modules.cloudGranted && (await this.channelTainted(channel)),
    );
    if (refusal !== undefined) throw refusal;
    // Nor one memory has been on in this run, nor sits beside an agent of the other kind (extension-modules R25).
    const separated = this.separation(channel, prepared);
    if (separated !== undefined) throw separated;
    return this.start(prepared, channel, sink);
  }

  /** Everything about a launch that can be checked before a container starts; throws, starting nothing, on the first problem. */
  private async prepare(target: LaunchTarget): Promise<PreparedLaunch> {
    const { definitions } = this.props;
    const { recipe } = target;
    const image = await definitions.image(recipe.image);
    // extension-modules R9, R18b, R18c, R19, R25, R29, R30, R34: the recipe's modules, provider models and roots, and
    // the memory rule, checked before anything is started (each refusal `module_refused`).
    const modules = await checkLaunchModules(
      {
        installed: this.props.modules.installed,
        meter: (m) => this.props.modules.meter.state(m),
        ashaHome: this.props.ashaHome,
        home: this.props.userHome,
      },
      recipe,
      target.recipeFile,
      target.teamRoots,
      image.manifest.keepsMemory,
      image.name,
    );
    if (modules.roots.length > 0 && (image.manifest.keepsMemory || modules.cloudGranted)) {
      const launched: ComparedRecipe = {
        file: target.recipeFile,
        keepsMemory: image.manifest.keepsMemory,
        cloudGranted: modules.cloudGranted,
        roots: modules.roots.map((r) => ({ name: r.name, host: r.host })),
      };
      const refusal = sharedRootRefusal(launched, await this.comparedRecipes());
      if (refusal !== undefined) throw new ModuleRefused(`${target.recipeFile}: ${refusal}`);
    }
    // agent-tools R1, R2, R13: the recipe's tools are checked before anything is started, its granted module tools
    // counted with its selected ones (extension-modules R9).
    const tools = resolveTools({
      recipe: recipe.id,
      selected: recipe.tools,
      image,
      granted: modules.grants,
      launch: recipe.launch !== undefined,
    });
    // agent-persistence R1, R12: what the recipe persists, against what its image declares.
    checkPersistence({ recipe, recipeFile: target.recipeFile, image, solo: target.name === null });
    const entry = modules.chat === undefined ? await definitions.chatModel(recipe.model) : undefined;
    const embeddingEntry =
      recipe.embeddingModel === null || modules.embedding !== undefined
        ? null
        : await definitions.embeddingModel(recipe.embeddingModel);
    // collaborating-agents R2, R12: every named document read and checked, and the full-text ones decoded, now.
    const documents = await loadDocuments({ recipe, file: target.recipeFile, folder: target.folder });
    const guidance = guidanceOf(target.recipeFile, documents);
    return { ...target, image, tools, entry, embeddingEntry, documents, guidance, modules };
  }

  /**
   * Every recipe that could be launched, as R25's shared-root rule compares them: whether its image keeps memory,
   * whether it is cloud-granted, and its roots resolved. One that does not load, or grants a module not installed, is
   * left out: it cannot launch.
   */
  private async comparedRecipes(): Promise<ComparedRecipe[]> {
    const out: ComparedRecipe[] = [];
    for (const { file, recipe, teamRoots } of await this.props.definitions.everyRecipe()) {
      let keepsMemory: boolean;
      try {
        keepsMemory = (await this.props.definitions.image(recipe.image)).manifest.keepsMemory;
      } catch (error) {
        if (error instanceof UnknownImage || error instanceof ImageManifestInvalid) continue;
        throw error;
      }
      const granted = recipe.modules.map((g) => present(g.split('/')[0], "a granted module reference's module id"));
      if (granted.some((m) => !this.props.modules.installed.has(m))) continue;
      const roots = [];
      for (const r of [...recipe.roots, ...teamRoots])
        roots.push({ name: r.name, host: await comparableRoot(r.path, this.props.userHome) });
      out.push({ file, keepsMemory, cloudGranted: isCloudGrantedRecipe(recipe, this.props.modules.installed), roots });
    }
    return out;
  }

  /** `start`'s models: the recipe's chat model, local (staged and served) or a provider's; its embedding model, if any. */
  private async prepareModels(
    launch: PreparedLaunch,
    phase: (p: OnlinePhase, detail: string) => void,
  ): Promise<{ readonly chatModel: AgentRecord['chatModel']; readonly embedding: AgentRecord['embedding'] }> {
    const { entry, embeddingEntry, modules } = launch;
    // A provider's model has no model or model_server phase: nothing is downloaded or served (extension-modules R19).
    let chatModel: AgentRecord['chatModel'];
    if (entry !== undefined) {
      const cached = await this.props.store.ensure(entry);
      phase('model', `${entry.id} ${cached.status}`);
      // Served now, for the launch's phases; each call leases it again (idle-shutdown R2), so it may be unloaded later.
      await this.props.modelServer.ensureServing(entry, cached);
      phase('model_server', `${entry.id} serving`);
      chatModel = { kind: 'local', entry, cached };
    } else {
      chatModel = { kind: 'provider', ref: present(modules.chat, "the provider recipe's chat model reference") };
    }
    let embedding: AgentRecord['embedding'] = null;
    if (embeddingEntry !== null) {
      const embeddingCached = await this.props.store.ensure(embeddingEntry);
      phase('model', `${embeddingEntry.id} ${embeddingCached.status}`);
      await this.props.modelServer.ensureServing(embeddingEntry, embeddingCached);
      embedding = { kind: 'local', entry: embeddingEntry, cached: embeddingCached };
      phase('model_server', `${embeddingEntry.id} serving`);
    } else if (modules.embedding !== undefined) {
      embedding = { kind: 'provider', ref: modules.embedding };
    }
    return { chatModel, embedding };
  }

  /**
   * `wireExit`'s log of a container's exit, before `agent.restarted` or the next attempt is decided: killed by the
   * stop's own grace (whatever it held is lost), the stop's own plain exit, or unexpected.
   */
  private logExit(record: AgentRecord, container: string, code: number): void {
    const handle = record.handle ?? record.rejoin ?? null;
    if (record.stopping && record.stopMode === 'drain' && code === KILLED_EXIT_CODE) {
      this.props.logger.error('agent.stop_killed', {
        handle,
        container,
        code,
        logFile: record.logFile,
        error: new Error(
          `killed ${String(record.graceS ?? AGENT_STOP_GRACE_MS / 1_000)} s after SIGTERM, before it exited by itself; its log: ${record.logFile}`,
        ),
      });
    } else if (record.stopping) {
      this.props.logger.info('agent.exited', { handle, container, code });
    } else {
      this.props.logger.error('agent.exited_unexpectedly', {
        handle,
        container,
        code,
        logFile: record.logFile,
        error: new Error(`container exited with code ${String(code)}; its log: ${record.logFile}`),
      });
    }
  }

  /**
   * `start`'s exit handler: `gone` is what a stop waits on. `leave` takes the record off its channel — unless a
   * restart keeps it suspended, or a restart's own container not yet online owns it (patterns-phase-3 R12) — and
   * releases its exit wait; a restart is decided and begun as the exit is seen, before anything about the record
   * changes, as a job of its own that stopAll ends (R14), never awaited here.
   */
  private wireExit(
    record: AgentRecord,
    channel: Channel,
    container: string,
    exited: Promise<number>,
  ): Promise<{ readonly detail: string; readonly logTail: boolean }> {
    let restarting = false;
    const leave = (detail: string): void => {
      record.exited.abort();
      this.records.delete(record.token);
      if (record.identityKey !== null) this.inUse.delete(record.identityKey);
      clearTimeout(record.exitWait);
      record.exitWait = undefined;
      if (record.handle !== undefined && !restarting && !this.ownedByRestart(record))
        channel.leave(record.handle, detail);
    };
    return exited.then(
      (code) => {
        // An exit seen before the stream's close is a failure too, said once (demo-scene-refresh R6).
        if (record.stopSequence === undefined) this.sayFailed(record);
        restarting = this.restartable(record);
        const exitAt = Date.now();
        leave(`container exited with code ${String(code)}`);
        // The log file is named, never quoted: its lines hold model-written and users' text (agent-persistence R15).
        this.logExit(record, container, code);
        if (restarting) this.restartAfter(record, code, exitAt);
        // Its log's tail is read only by a launch that failed (below), never on the way to `gone`: a stop waits on
        // `gone`, and a stop's timeline must not wait on reading a file nobody uses.
        return {
          detail: `container exited with code ${String(code)} before coming online; its log: ${record.logFile}`,
          logTail: true,
        };
      },
      (error: unknown) => {
        // An online agent's container lost with no stop begun is a failure too, said first (R6; the code review's round 2).
        if (record.stopSequence === undefined) this.sayFailed(record);
        leave('container failed');
        // Stopped before it ever started (a startup timeout, a team's rollback, the daemon stopping): the stop's, not a failure.
        if (error instanceof ContainerStoppedBeforeStart && record.stopping)
          this.props.logger.info('agent.exited', { handle: null, container, code: null, detail: error.message });
        else this.props.logger.error('agent.container_failed', { container, error });
        return { detail: `container failed: ${(error as Error).message}`, logTail: false };
      },
    );
  }

  /**
   * `start`'s wait for the agent to come online, bounded by the recipe's startupTimeoutMs and ended early by a
   * caller that stopped waiting (patterns-phase-3 R30); throws the launch's failure (`AgentStartFailed`, or
   * `LaunchAbandoned` for an abandoned caller) when it does not come online in time, the container killed either way.
   */
  private async awaitOnline(
    online: Promise<void>,
    gone: Promise<{ readonly detail: string; readonly logTail: boolean }>,
    recipe: Recipe,
    abandon: AbortSignal | undefined,
    record: AgentRecord,
    container: string,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<{ detail: string; logTail: boolean }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ detail: `not online within ${String(recipe.startupTimeoutMs)} ms`, logTail: false });
      }, recipe.startupTimeoutMs);
    });
    // A launch from a grant whose caller stopped waiting (patterns-phase-3 R30): killed, never left online.
    const abandoned =
      abandon === undefined
        ? []
        : [
            new Promise<'abandoned'>((resolve) => {
              if (abandon.aborted) resolve('abandoned');
              else
                abandon.addEventListener(
                  'abort',
                  () => {
                    resolve('abandoned');
                  },
                  { once: true },
                );
            }),
          ];
    try {
      const outcome = await Promise.race([online.then(() => undefined), gone, timedOut, ...abandoned]);
      if (outcome === 'abandoned') {
        await this.stopRecord(record, 'its launch was abandoned', 'kill');
        throw new LaunchAbandoned(container);
      }
      if (outcome !== undefined) {
        await this.stopRecord(record, 'failed to come online', 'kill');
        throw new AgentStartFailed(
          container,
          outcome.detail,
          outcome.logTail ? await logTail(record.logFile, this.props.logger) : '',
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `start`'s image and channel space, readied before the container is created: staged, ensured, the channel's file
   * volume (agent-files R10, filled from a persisted team's saved files when its restore asked, R15), and every
   * granted module acquired on the channel — pushed onto `acquired` as each is, so the caller can release them if
   * the launch fails before its record holds them (extension-modules R34).
   */
  private async prepareImageAndSpace(
    launch: PreparedLaunch,
    channel: Channel,
    phase: (p: OnlinePhase, detail: string) => void,
    acquired: string[],
  ): Promise<{ readonly ensured: EnsuredImage; readonly channelVolume: string }> {
    const { runtime, logger } = this.props;
    const { image, modules } = launch;
    const stagingStarted = Date.now();
    const staged = await stageAgentImage({ root: this.props.root, image, stagingParent: this.props.stagingDir });
    // Staging is paid at every launch, warm or cold: its time is on record (otel-traces R13, A10), with the
    // host's 1, 5 and 15 minute load averages, so a slow one can be told from a busy machine.
    logger.info('image.staged', { image: image.name, ms: Date.now() - stagingStarted, loadavg: loadavg() });
    let ensured: EnsuredImage;
    try {
      ensured = await runtime.ensureImage(staged.spec);
      phase('image', `${image.repository} ${ensured.status}`);
    } finally {
      await staged.cleanup();
    }
    const pendingFill = this.pendingFills.get(channel);
    this.pendingFills.delete(channel);
    const channelVolume = await this.props.files
      .ensure(channel.name, ensured.tag, pendingFill)
      .catch((error: unknown) => {
        throw error instanceof SpaceHoldsFiles ? new FilesSpaceInUse(channel.name) : error;
      });
    for (const module of modules.acquire) {
      await this.props.modules.host.acquire(module, channel.name);
      acquired.push(module);
    }
    return { ensured, channelVolume };
  }

  /**
   * `start`'s record, joined to the channel once nothing separates it (R25) — never between the check and the
   * join, so two launches of the other kind racing each other cannot both pass it (review of 2026-10-02, H3) —
   * its exit handler releasing the modules it holds once its exit is seen (extension-modules R34). Throws, handing
   * nothing over, when the join is refused.
   */
  private buildAgentRecord(props: {
    readonly launch: PreparedLaunch;
    readonly channel: Channel;
    readonly sink: OnlineSink;
    readonly rejoin: string | undefined;
    readonly chatModel: AgentRecord['chatModel'];
    readonly embedding: AgentRecord['embedding'];
    readonly acquired: string[];
    readonly container: string;
    readonly restored: RestoredLaunch | undefined;
    readonly identity: AgentIdentity | null;
    readonly key: string | null;
  }): { readonly record: AgentRecord; readonly online: Promise<void> } {
    const { launch, channel, sink, rejoin, chatModel, embedding, acquired, container, restored, identity, key } = props;
    let markOnline: () => void = () => undefined;
    const online = new Promise<void>((resolve) => {
      markOnline = resolve;
    });
    const record: AgentRecord = {
      token: randomBytes(32).toString('hex'),
      channel,
      recipe: launch.recipe,
      image: launch.image,
      chatModel,
      embedding,
      modules: launch.modules,
      modulesHeld: acquired,
      container,
      logFile: join(this.props.agentLogsDir, `${container}.log`),
      tools: launch.tools,
      guidance: launch.guidance,
      baseName: launch.name,
      handle: undefined,
      announcement: undefined,
      gone: Promise.resolve(),
      exited: new AbortController(),
      stopMode: undefined,
      traces: new Set(),
      conversations: new Map(),
      stopping: false,
      markOnline,
      team: launch.team,
      identityKey: key,
      persisted: undefined,
      resumed: restored?.resumed,
      resendPlan: restored?.plan ?? { resends: [], skipped: 0 },
      held: launch.team !== null && identity !== null,
      sink,
      keepsMemory: launch.image.manifest.keepsMemory,
      stopSequence: undefined,
      stopCheckpointed: undefined,
      graceS: undefined,
      exposesFiles: false,
      launch,
      rejoin,
      exitWait: undefined,
    };
    if (restored !== undefined) record.persisted = restored.make(record);
    // R25 again, with no await between the check and the record joining the channel: two launches of the other kind
    // that both passed the first check (each awaited images, spaces and modules since) cannot both join — whichever
    // joins second sees the first (review of 2026-10-02, H3).
    const separatedNow = this.separation(channel, launch);
    if (separatedNow !== undefined) throw separatedNow;
    this.records.set(record.token, record);
    // From here the record holds the identity and the modules it acquired; its exit handler releases them — the
    // modules once, when its exit is seen or treated as gone (extension-modules R34).
    record.exited.signal.addEventListener(
      'abort',
      () => {
        this.releaseModules(record);
      },
      { once: true },
    );
    return { record, online };
  }

  /**
   * `start`'s identity reservation (R2): a persisted agent's identity runs once — refused before anything starts —
   * and held from here until it is gone; null for a recipe launched alone, which has none.
   */
  private reserveIdentity(
    channel: Channel,
    launch: PreparedLaunch,
  ): { readonly identity: AgentIdentity | null; readonly key: string | null } {
    const identity: AgentIdentity | null =
      launch.recipe.persist.length === 0
        ? null
        : { channel: channel.name, team: launch.team, name: launch.name ?? launch.recipe.id };
    const key = identity === null ? null : identityKey(identity);
    if (key !== null) {
      if (this.inUse.has(key)) throw new IdentityInUse(key);
      this.inUse.set(key, 'agent');
    }
    return { identity, key };
  }

  /**
   * `start`'s container: named, logged `agent.starting`, started with its restore's archive streamed in when there
   * is one (R11, R13; otherwise its documents copied in as ever), and its exit wired (`wireExit`) — a restartable
   * agent's crash keeps its member, suspended, for its restart (patterns-phase-3 R12); a restart's container not
   * yet online leaves its member to the restart that started it.
   */
  private launchContainer(
    record: AgentRecord,
    channel: Channel,
    container: string,
    imageTag: string,
    launch: PreparedLaunch,
    restored: RestoredLaunch | undefined,
    channelVolume: string,
  ): Promise<{ readonly detail: string; readonly logTail: boolean }> {
    const { runtime, logger } = this.props;
    logger.info('agent.starting', {
      channel: channel.name,
      recipe: launch.recipe.id,
      image: launch.image.name,
      tag: imageTag,
      container,
      member: launch.name,
      documents: launch.documents.map((d) => d.path),
    });
    const { exited } = runtime.start({
      name: container,
      image: imageTag,
      env: {
        [AgentEnv.harnessUrl]: `http://${runtime.hostAddress}:${String(this.props.daemonPort())}`,
        [AgentEnv.agentToken]: record.token,
      },
      logFile: record.logFile,
      // A restore streams the documents in its own archive (R11, R13); otherwise they are copied in as ever.
      files: restored?.archive === undefined ? launch.documents.map((d) => ({ path: d.path, content: d.content })) : [],
      ...(restored?.archive === undefined ? {} : { archive: restored.archive }),
      channelVolume,
    });
    return this.wireExit(record, channel, container, exited);
  }

  /**
   * `start`'s check, once its record has joined the channel: the daemon or its channel began to stop between the
   * join and here starts nothing (portal-demo-stop R2) — the stop has already listed the agents to stop — so the
   * record and its identity are given back and its modules released, as they would be by its own exit.
   */
  private checkNotClosingAfterHandover(
    record: AgentRecord,
    channel: Channel,
    key: string | null,
    container: string,
  ): void {
    if (!this.closing && !this.channelStopDeadlines.has(channel.name)) return;
    this.records.delete(record.token);
    if (key !== null) this.inUse.delete(key);
    this.releaseModules(record);
    throw new AgentStartFailed(
      container,
      this.closing ? 'the daemon is stopping' : `channel ${channel.name} is stopping`,
    );
  }

  /**
   * `start`'s finish, once the agent is online: `agent.resumed` logged when a restore found something, whether it
   * may send the channel's files off the machine decided (R7), the channel's memory taint recorded if it keeps
   * memory (R25), and its sink told it is online.
   */
  private async finishStart(
    record: AgentRecord,
    channel: Channel,
    key: string | null,
    modules: LaunchModules,
    restored: RestoredLaunch | undefined,
  ): Promise<void> {
    if (record.persisted !== undefined && restored?.pointer !== undefined) {
      this.props.logger.info('agent.resumed', {
        identity: key,
        handle: record.handle,
        savedAt: restored.pointer.savedAt,
        generation: restored.pointer.generation,
        bytes: Object.values(restored.pointer.assets).reduce((n, a) => n + a.bytes, 0),
        files: Object.values(restored.pointer.assets).reduce((n, a) => n + a.files, 0),
        imageChanged: restored.imageChanged,
      });
    }
    // A cloud-granted agent onto a space holding any file may send those files off the machine (agent-files R7).
    record.exposesFiles = exposesFiles(
      modules.cloudGranted,
      modules.cloudGranted ? (await this.props.files.usage(channel.name)).entries : 0,
    );
    // A channel an agent that keeps memory has been on is memory-tainted until the daemon stops (extension-modules R25).
    if (record.keepsMemory) this.memoryChannels.add(channel);
    record.sink.announced(
      present(record.announcement, "the now-online record's first status message"),
      record.resumed,
      record.exposesFiles ? true : undefined,
    );
  }

  private async start(
    launch: PreparedLaunch,
    channel: Channel,
    sink: OnlineSink,
    rejoin?: string,
    abandon?: AbortSignal,
  ): Promise<OnlineAgent> {
    const phase = (p: OnlinePhase, detail: string): void => {
      sink.phase(p, detail);
    };
    const { runtime, logger } = this.props;
    const { recipe, modules } = launch;

    // A launch onto a channel that is stopping starts nothing (portal-demo-stop R2).
    if (this.channelStopDeadlines.has(channel.name))
      throw new AgentStartFailed(launch.name ?? recipe.id, `channel ${channel.name} is stopping`);
    const { identity, key } = this.reserveIdentity(channel, launch);
    let handedOver = false;
    const acquired: string[] = [];
    // A launch in progress, and the models it will ask servers for, are counted from here (portal-demo-stop R1, R3), and
    // its channel's stop waits for it (R2).
    const models = localModels(launch);
    count(this.launchingOn, channel.name, 1);
    for (const m of models) count(this.modelHolds, m, 1);
    let settled!: () => void;
    const job = new Promise<void>((resolve) => (settled = resolve));
    this.launchJobs.set(job, channel.name);
    try {
      // Confines the container to the daemon's port before it exists; a runtime that cannot throws, and nothing starts.
      phase('container_runtime', await runtime.ensureReady(this.props.daemonPort()));

      const { chatModel, embedding } = await this.prepareModels(launch, phase);
      const { ensured, channelVolume } = await this.prepareImageAndSpace(launch, channel, phase, acquired);
      const imageTag = ensured.tag;

      // The container is named before the agent picks its handle; the daemon log
      // (agent.connected) maps one to the other.
      const container = `asha-${channel.name}-${recipe.id}-${randomBytes(3).toString('hex')}`;
      await mkdir(this.props.agentLogsDir, { recursive: true });

      // Saved state (agent-persistence R3, R11–R13): checked, then restored between create and start.
      const restored =
        identity === null ? undefined : await this.restoreFor(identity, launch, ensured, container, channel);

      const { record, online } = this.buildAgentRecord({
        launch,
        channel,
        sink,
        rejoin,
        chatModel,
        embedding,
        acquired,
        container,
        restored,
        identity,
        key,
      });
      // From here the record holds the identity and the modules it acquired; its exit handler releases them — the
      // modules once, when its exit is seen or treated as gone (extension-modules R34).
      handedOver = true;
      this.checkNotClosingAfterHandover(record, channel, key, container);
      const gone = this.launchContainer(record, channel, container, imageTag, launch, restored, channelVolume);
      record.gone = gone;
      await this.awaitOnline(online, gone, recipe, abandon, record, container);
      logger.info('agent.online', { handle: record.handle, channel: channel.name, container });
      await this.finishStart(record, channel, key, modules, restored);
      return describe(record);
    } finally {
      count(this.launchingOn, channel.name, -1);
      for (const m of models) count(this.modelHolds, m, -1);
      this.launchJobs.delete(job);
      settled();
      if (!handedOver && key !== null) this.inUse.delete(key);
      // Modules acquired before the record held them: released here, once each.
      if (!handedOver) for (const module of acquired) await this.props.modules.host.release(module, channel.name);
    }
  }

  /**
   * A persisted launch's saved state (R3, R9, R11–R13): its pointer checked against the image (another image refused,
   * another schema refused, another source resumed and said), the store walked and every asset's sha256 checked, the
   * record of unsaved deliveries sorted into what is re-sent, and the restore archive with the documents R13 adds.
   */
  private async restoreFor(
    identity: AgentIdentity,
    launch: PreparedLaunch,
    ensured: EnsuredImage,
    container: string,
    channel: Channel,
  ): Promise<RestoredLaunch> {
    const { state, logger } = this.props;
    const key = identityKey(identity);
    const schema = launch.image.manifest.stateSchema === null ? 'none' : String(launch.image.manifest.stateSchema);
    const source = ensured.labels[SOURCE_LABEL] ?? '';
    await state.guard();
    const pointer = await state.readAgentPointer(identity);
    const dir = state.agentDir(identity);
    let imageChanged = false;
    if (pointer !== undefined) {
      if (pointer.image !== launch.image.name)
        throw new StateImageMismatch(key, pointer.image, launch.image.name, resetCommand(identity));
      if (pointer.schema !== schema) throw new StateSchemaChanged(key, pointer.schema, schema, resetCommand(identity));
      imageChanged = pointer.source !== source;
      await state.verify(dir, pointer);
    }
    const pending = await state.pending(identity);
    const plan = await planResends({
      key,
      pending,
      lastDelivery: pointer?.lastDelivery ?? null,
      daemonStartedAt: this.props.daemonStartedAt,
      logger,
    });
    let archive: (() => AsyncIterable<Uint8Array>) | undefined;
    if (pointer !== undefined) {
      const restore = await restoreArchive({
        state,
        dir,
        pointer,
        documents: launch.documents,
        mtime: Math.floor(this.props.clock().getTime() / 1_000),
      });
      if (restore.added.length > 0) logger.info('state.documents_added', { identity: key, paths: restore.added });
      if (restore.skipped.length > 0)
        logger.warn('state.documents_skipped', { identity: key, paths: restore.skipped, reason: 'over_bound' });
      archive = restore.archive;
    }
    const make = (record: AgentRecord): PersistedAgent =>
      new PersistedAgent({
        identity,
        key,
        assets: launch.recipe.persist,
        state,
        runtime: this.props.runtime,
        logger,
        clock: this.props.clock,
        daemonStartedAt: this.props.daemonStartedAt,
        pending,
        pointer,
        recipe: launch.recipe.id,
        image: { name: launch.image.name, source, schema },
        container,
        channel,
        handle: () => record.handle,
        closing: () => this.closing || this.channelStopDeadlines.has(channel.name),
        stopDeadlines: () => this.stopDeadlines ?? this.channelStopDeadlines.get(channel.name),
      });
    return {
      make,
      pointer,
      plan,
      archive,
      imageChanged,
      resumed: pointer === undefined ? undefined : { savedAt: pointer.savedAt, previousHandle: pointer.handle },
    };
  }
}

/** Why a reset or an erase was refused before anything was removed (R5, R16). */
export type StateRefusal = { readonly ok: false; readonly reason: StateRefusalReason; readonly detail: string };

/**
 * Saved state's routes, as the supervisor answers them (R5, R16): what is saved, a reset, and a per-user erase. A
 * reset or an erase naming an identity or a channel that is online — or an identity being erased — is refused,
 * removing nothing.
 */
export class StateOperations {
  constructor(
    private readonly props: AgentSupervisorProps,
    /** Keys of identities in use (online, launching, stopping) or being erased, and whether a channel has an agent. */
    private readonly usage: {
      readonly inUse: Map<string, 'agent' | 'erase'>;
      readonly channelBusy: (channel: string) => boolean;
    },
  ) {}

  /** What is saved, by identity and channel (`GET /v1/state`, R5). */
  list(): Promise<StateListResponse> {
    return this.props.state.list();
  }

  /** Removes exactly what the selector names, or refuses: `online`, `nothing_matches` (R5). */
  async reset(
    selector: StateSelector,
  ): Promise<{ readonly ok: true; readonly removed: readonly StateRemoved[] } | StateRefusal> {
    const { busy, agents } = await this.busy(selector);
    if (busy !== undefined)
      return { ok: false, reason: 'online', detail: `${busy} is online; stop it first (asha --stop)` };
    // Held in use while it runs, set in the same tick as the check: a launch that starts meanwhile is refused
    // identity_in_use rather than reading a pointer the reset then deletes (the completion review, finding 7).
    for (const identity of agents) this.usage.inUse.set(identity, 'erase');
    try {
      const removed = await this.props.state.reset(selector);
      if (removed === 'nothing_matches')
        return { ok: false, reason: 'nothing_matches', detail: `nothing saved matches ${describeSelector(selector)}` };
      return { ok: true, removed };
    } finally {
      for (const identity of agents) if (this.usage.inUse.get(identity) === 'erase') this.usage.inUse.delete(identity);
    }
  }

  /**
   * R16's erase, checked before it begins: every identity the selector names whose saved state holds memory, each
   * offline and not being erased (else `online`, nothing erased for any), or `nothing_matches`. The returned run
   * erases each in turn, holding it in use until it finishes, and reports every event.
   */
  async prepareErase(
    selector: { readonly channel: string; readonly name?: string; readonly team?: string },
    user: string,
  ): Promise<
    StateRefusal | { readonly ok: true; readonly run: (write: (event: StateEraseEvent) => void) => Promise<void> }
  > {
    const listed = await this.props.state.list();
    const agentOf = (identity: string) => identity.split('/');
    const named = listed.assets.filter(
      (a) => a.kind === 'agent' && a.asset === 'memory' && matchesAgent(agentOf(a.identity), selector),
    );
    if (named.length === 0)
      return { ok: false, reason: 'nothing_matches', detail: `nothing saved matches ${describeSelector(selector)}` };
    for (const a of named)
      if (this.usage.inUse.has(a.identity))
        return { ok: false, reason: 'online', detail: `${a.identity} is online; stop it first (asha --stop)` };
    // Held in use for the whole erase: a launch is refused identity_in_use, a reset or a second erase as online.
    for (const a of named) this.usage.inUse.set(a.identity, 'erase');
    // An unreadable identity is not erased and not "kept": a reset is its remedy, and --list-state shows it.
    const kept = listed.assets.flatMap((a) =>
      a.asset !== 'unreadable' &&
      ((a.kind === 'agent' && a.asset === 'workspace' && matchesAgent(agentOf(a.identity), selector)) ||
        (a.kind === 'channel' && selector.name === undefined && a.identity === selector.channel))
        ? [{ ...a, asset: a.asset }]
        : [],
    );
    return {
      ok: true,
      run: async (write) => {
        try {
          for (const a of named) {
            const [channel, team, name] = agentOf(a.identity) as [string, string, string];
            write(await this.eraseOne({ channel, team: team === '-' ? null : team, name }, user));
            this.usage.inUse.delete(a.identity);
          }
          for (const k of kept) write({ type: 'kept', kind: k.kind, identity: k.identity, asset: k.asset });
          write({ type: 'erase_done' });
        } finally {
          for (const a of named) if (this.usage.inUse.get(a.identity) === 'erase') this.usage.inUse.delete(a.identity);
        }
      },
    };
  }

  /**
   * `eraseOne`'s generation: its /memory copied out and checked, without knowing its layout, to be the current
   * generation less exactly what the erase reported; only then promoted, with its workspace carried over unchanged.
   * Anything else keeps the previous generation byte-identical (its discard logged, never allowed to replace the
   * erase's own outcome) and says why. The user's unsaved messages removed from the record either way, counted into
   * `pendingRemoved` as soon as they are, so a later failure here still reports them.
   */
  private async eraseGeneration(props: {
    readonly identity: AgentIdentity;
    readonly user: string;
    readonly key: string;
    readonly dir: string;
    readonly pointer: AgentPointer;
    readonly before: readonly TarEntry[];
    readonly reported: { readonly files: number; readonly bytes: number };
    readonly oneShot: OneShot;
    readonly pendingRemoved: { count: number };
    readonly failed: (reason: EraseFailureReason, error: unknown) => StateEraseEvent;
    readonly cleanupFailed: (what: string) => (error: unknown) => void;
  }): Promise<StateEraseEvent> {
    const { identity, user, key, dir, pointer, before, reported, oneShot, pendingRemoved, failed, cleanupFailed } =
      props;
    const { state, logger } = this.props;
    const gen = await state.begin(dir);
    let promoted = false;
    try {
      let copied: CopyOutcome = { ok: true };
      const after = await gen.writeTar('memory', ASSET_BOUNDS.memory, async (push) => {
        copied = await oneShot.copyOut('/memory', async (chunk) =>
          (await push(chunk)) === undefined ? 'more' : 'stop',
        );
      });
      const c = copied as CopyOutcome;
      if (!after.ok) return failed('save_failed', new Error(`${after.entry}: ${after.detail}`));
      if (!c.ok) return failed('save_failed', new Error(c.detail));
      const problem = subsetProblem(before, after.entries, reported);
      if (problem !== undefined) return failed('erase_not_subset', new Error(problem));
      const pending = await state.pending(identity);
      const { removed, written } = pending.remove((e) => e.kind === 'input' && e.user === user);
      const w = await written;
      if (!w.ok) return failed('save_failed', w.error);
      pendingRemoved.count = removed.length;
      if (reported.files === 0 && reported.bytes === 0) {
        logger.info('state.user_erased', { identity: key, files: 0, bytes: 0 });
        return { type: 'no_memory', identity: key, pendingMessages: removed.length };
      }
      if (pointer.assets.workspace !== undefined)
        await gen.writeBytes(
          'workspace',
          await state.readAsset(dir, pointer, 'workspace'),
          pointer.assets.workspace.files,
        );
      await gen.promote<AgentPointer>(
        {
          kind: 'agent',
          recipe: pointer.recipe,
          image: pointer.image,
          source: pointer.source,
          schema: pointer.schema,
          lastDelivery: pointer.lastDelivery,
          handle: pointer.handle,
        },
        key,
      );
      promoted = true;
      // The smaller memory is under its bound again, whatever the last checkpoint said (the completion review, finding 8).
      await state.setFull(dir, 'memory', false).catch(cleanupFailed('full.json'));
      logger.info('state.user_erased', { identity: key, files: reported.files, bytes: reported.bytes });
      return {
        type: 'erased',
        identity: key,
        files: reported.files,
        bytes: reported.bytes,
        pendingMessages: removed.length,
      };
    } catch (error) {
      return failed('save_failed', error);
    } finally {
      // A clean-up that fails is logged, never allowed to replace the erase's own outcome.
      if (!promoted) await gen.discard().catch(cleanupFailed('generation'));
    }
  }

  /**
   * One identity's erase (R16): the recorded image built as a launch builds it and its erase label re-checked; run
   * once over a copy of its saved /memory, with no network, no environment and no --rm, bounded at 60 s; its one
   * stdout line read (at most 4 KiB); its /memory copied out and checked, without knowing its layout, to be the
   * current generation less exactly what it reported; only then promoted. Anything else keeps the previous
   * generation byte-identical and says why. The container is removed on every path. The user's inputs are removed
   * from the agent's record of unsaved deliveries too. No event carries the user ID.
   */
  private async eraseOne(identity: AgentIdentity, user: string): Promise<StateEraseEvent> {
    const { state, runtime, logger } = this.props;
    const key = identityKey(identity);
    // The user's unsaved messages removed so far: said even when the memory's erase then fails (the completion
    // review, finding 9) — a box, not a plain variable, so `eraseGeneration` can update it once it knows.
    const pendingRemoved = { count: 0 };
    const failed = (reason: EraseFailureReason, error: unknown): StateEraseEvent => {
      logger.error('state.erase_failed', { identity: key, reason, error });
      return { type: 'erase_failed', identity: key, reason, pendingMessages: pendingRemoved.count };
    };
    const cleanupFailed = (what: string) => (error: unknown) => {
      logger.error('state.cleanup_failed', { identity: key, what, error });
    };
    const pointer = await state.readAgentPointer(identity);
    if (pointer?.assets.memory === undefined)
      return failed('save_failed', new Error('its saved memory went while the erase was waiting'));
    const dir = state.agentDir(identity);
    await state.verify(dir, pointer);
    // The recorded image, as a launch builds it (R12): its erase label, and its state schema, must fit what is saved.
    let image;
    try {
      image = await this.props.definitions.image(pointer.image);
    } catch (error) {
      if (error instanceof UnknownImage) return failed('erase_unsupported', error);
      throw error;
    }
    await runtime.ensureReady(this.props.daemonPort());
    const staged = await stageAgentImage({ root: this.props.root, image, stagingParent: this.props.stagingDir });
    let ensured: EnsuredImage;
    try {
      ensured = await runtime.ensureImage(staged.spec);
    } finally {
      await staged.cleanup();
    }
    if (ensured.labels[ERASE_USER_LABEL] !== 'true')
      return failed('erase_unsupported', new Error(`image ${ensured.tag} carries no ${ERASE_USER_LABEL}=true`));
    if ((ensured.labels[STATE_SCHEMA_LABEL] ?? 'none') !== pointer.schema)
      return failed(
        'erase_unsupported',
        new Error(
          `image ${ensured.tag} keeps state schema ${ensured.labels[STATE_SCHEMA_LABEL] ?? 'none'}, not the saved ${pointer.schema}`,
        ),
      );
    const memoryFile = state.assetPath(dir, pointer, 'memory');
    const memorySize = await state.fileSize(memoryFile);
    const before = await readStoredEntries(memoryFile, 'memory');
    const name = `asha-erase-${identity.channel}-${randomBytes(3).toString('hex')}`;
    const oneShot = runtime.oneShot({
      name,
      image: ensured.tag,
      args: ['erase-user', '--channel', identity.channel, '--user', user],
      logFile: join(this.props.agentLogsDir, `${name}.log`),
      archive: async function* () {
        yield* createReadStream(memoryFile, { start: 0, end: memorySize - 2 * TAR_BLOCK - 1, highWaterMark: 1 << 20 });
        yield Buffer.alloc(2 * TAR_BLOCK);
      },
      timeoutMs: ERASE_TIMEOUT_MS,
      maxStdoutBytes: ERASE_MAX_STDOUT_BYTES,
    });
    logger.info('state.erase_started', { identity: key });
    try {
      const run = await oneShot.run();
      if (run.kind === 'timeout')
        return failed('timeout', new Error(`the erase did not finish within ${String(ERASE_TIMEOUT_MS)} ms`));
      if (run.code !== 0) {
        const logFile = join(this.props.agentLogsDir, `${name}.log`);
        return failed('exit_nonzero', new Error(`the erase exited ${String(run.code)}; its log: ${logFile}`));
      }
      const reported = run.overflow ? undefined : parseErased(run.stdout);
      // The line is never quoted: an image could echo what it was given.
      if (reported === undefined)
        return failed(
          'bad_output',
          new Error(
            `the erase did not print exactly one {"erased":{"files":<n>,"bytes":<b>}} line within ${String(ERASE_MAX_STDOUT_BYTES)} bytes`,
          ),
        );
      return await this.eraseGeneration({
        identity,
        user,
        key,
        dir,
        pointer,
        before,
        reported,
        oneShot,
        pendingRemoved,
        failed,
        cleanupFailed,
      });
    } finally {
      // Left behind, the container carries this home's label: the next network set-up removes it (R16).
      await oneShot.remove().catch(cleanupFailed('container'));
    }
  }

  /** The first identity or channel the selector names that is online or being erased, if any; and the agent identities it names. */
  private async busy(
    selector: StateSelector,
  ): Promise<{ readonly busy: string | undefined; readonly agents: readonly string[] }> {
    const listed = await this.props.state.list();
    const identities = [
      ...listed.assets.map((a) => ({ kind: a.kind, identity: a.identity })),
      ...listed.pending.map((p) => ({ kind: 'agent' as const, identity: p.identity })),
    ];
    const agents = new Set<string>();
    for (const { kind, identity } of identities) {
      const parts = identity.split('/');
      const named =
        'all' in selector ||
        (kind === 'channel'
          ? selector.name === undefined && identity === selector.channel
          : matchesAgent(parts, selector));
      if (!named) continue;
      if (kind === 'agent' && this.usage.inUse.has(identity)) return { busy: identity, agents: [] };
      if (kind === 'channel' && this.usage.channelBusy(identity)) return { busy: `channel ${identity}`, agents: [] };
      if (kind === 'agent') agents.add(identity);
    }
    return { busy: undefined, agents: [...agents] };
  }
}

/** Whether an agent identity's parts (`channel`, `team or -`, `name`) are named by a selector. */
function matchesAgent(parts: readonly string[], selector: StateSelector): boolean {
  if ('all' in selector) return true;
  const [channel, team, name] = parts;
  if (channel !== selector.channel) return false;
  if (selector.name === undefined) return true;
  return name === selector.name && team === (selector.team ?? '-');
}

/** A selector as the CLI would type it. */
function describeSelector(selector: StateSelector): string {
  if ('all' in selector) return 'all';
  return [
    `channel=${selector.channel}`,
    ...(selector.name === undefined ? [] : [`name=${selector.name}`]),
    ...(selector.team === undefined ? [] : [`team=${selector.team}`]),
  ].join(' ');
}

/** Bound on one erase's one-shot container (R16). */
const ERASE_TIMEOUT_MS = 60_000;
/** The most of a one-shot's stdout the daemon reads (R16). */
const ERASE_MAX_STDOUT_BYTES = 4 * 1024;

/** The erase mode's one line, `{"erased":{"files":<n>,"bytes":<b>}}` and its newline, exactly; undefined otherwise. */
export function parseErased(stdout: string): { readonly files: number; readonly bytes: number } | undefined {
  const m = /^\{"erased":\{"files":(0|[1-9]\d{0,9}),"bytes":(0|[1-9]\d{0,15})\}\}\n?$/.exec(stdout);
  return m === null ? undefined : { files: Number(m[1]), bytes: Number(m[2]) };
}

/**
 * Checks an erase's result against the generation before it, knowing nothing of the image's layout (R16): every
 * entry after must be before, the same kind, a file with the same sha256; and the files and bytes before and not
 * after must be exactly what the image reported. Undefined when it holds; else what does not.
 */
export function subsetProblem(
  before: readonly TarEntry[],
  after: readonly TarEntry[],
  reported: { readonly files: number; readonly bytes: number },
): string | undefined {
  const was = new Map(before.map((e) => [e.name, e]));
  for (const e of after) {
    const b = was.get(e.name);
    if (b === undefined) return `${e.name} is new`;
    if (b.type !== e.type) return `${e.name} changed from a ${b.type} to a ${e.type}`;
    if (b.type === 'file' && e.type === 'file' && b.sha256 !== e.sha256) return `${e.name} changed`;
  }
  const kept = new Set(after.map((e) => e.name));
  const gone = before.filter((e): e is Extract<TarEntry, { type: 'file' }> => e.type === 'file' && !kept.has(e.name));
  const files = gone.length;
  const bytes = gone.reduce((n, e) => n + e.size, 0);
  if (files !== reported.files || bytes !== reported.bytes)
    return `${String(files)} files and ${String(bytes)} bytes were removed, and the erase reported ${String(reported.files)} and ${String(reported.bytes)}`;
  return undefined;
}

/** Resolves at `deadline` (ms since the epoch; never for +Infinity); cancelled with the returned function. */
function sleepUntil(deadline: number): { readonly done: Promise<void>; readonly cancel: () => void } {
  if (!Number.isFinite(deadline)) return { done: new Promise<void>(() => undefined), cancel: () => undefined };
  let timer: NodeJS.Timeout | undefined;
  const done = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
  });
  return {
    done,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

/** R7's refusal: a cloud-granted launch onto a channel whose saved state held memory; undefined otherwise. */
export function egressRefusal(
  channel: string,
  cloudGranted: boolean,
  tainted: boolean,
): MemoryEgressForbidden | undefined {
  if (cloudGranted && tainted) return new MemoryEgressForbidden(channel);
  return undefined;
}

/** A chat call's statistics when no request reached a model: its server could not be started again (idle-shutdown R2). */
const NO_STATS: ChatStats = { ttfcMs: null, chunks: 0, promptTokens: null, completionTokens: null, cachedTokens: null };

/** Why a call stopped waiting for its model's server to start: the reason and detail it ends with (idle-shutdown R2). */
interface GaveUp {
  readonly reason: ModelFailureReason;
  readonly detail: string;
}

/**
 * `leasing`'s lease, or why the call gave up on it first — the agent's exit (`unavailable`, ABANDONED), its request
 * closing (`timeout`, REQUEST_CLOSED), or CHAT_QUEUE_BOUND_MS passing (`timeout`): the same reasons and order a chat
 * call that reached its model ends with. A failure to start rejects, as `leasing` does.
 */
async function leaseWithin(
  leasing: Promise<ModelLease>,
  stops: { readonly abandon: AbortSignal; readonly requestClosed?: AbortSignal },
): Promise<ModelLease | GaveUp> {
  let timer: NodeJS.Timeout | undefined;
  let check: (() => void) | undefined;
  const gaveUp = new Promise<GaveUp>((resolve) => {
    check = () => {
      if (stops.abandon.aborted) resolve({ reason: 'unavailable', detail: ABANDONED });
      else if (stops.requestClosed?.aborted === true) resolve({ reason: 'timeout', detail: REQUEST_CLOSED });
    };
    stops.abandon.addEventListener('abort', check);
    stops.requestClosed?.addEventListener('abort', check);
    check();
    timer = setTimeout(() => {
      resolve({
        reason: 'timeout',
        detail: `its model's server did not start within the queue bound of ${String(CHAT_QUEUE_BOUND_MS)} ms`,
      });
    }, CHAT_QUEUE_BOUND_MS);
  });
  try {
    return await Promise.race([leasing, gaveUp]);
  } finally {
    clearTimeout(timer);
    const listener = present(check, 'the stop check');
    stops.abandon.removeEventListener('abort', listener);
    stops.requestClosed?.removeEventListener('abort', listener);
  }
}

/** The model a record's chat calls go to, as a log line names it: a catalogue id, or `<module>/<name>`. */
function modelName(record: AgentRecord): string {
  return record.chatModel.kind === 'local'
    ? record.chatModel.entry.id
    : `${record.chatModel.ref.module}/${record.chatModel.ref.model.name}`;
}

function describe(record: AgentRecord): OnlineAgent {
  return {
    handle: present(record.handle, "the agent's handle"),
    channel: record.channel.name,
    recipe: record.recipe,
    image: record.image,
    container: record.container,
    logFile: record.logFile,
    tools: record.tools.selected,
    guidance: record.guidance,
    ...(record.persisted === undefined ? {} : { persist: record.persisted.assets }),
    ...(record.resumed === undefined ? {} : { resumed: record.resumed }),
    ...(record.exposesFiles ? { exposesFiles: true as const } : {}),
    modules: moduleOffers(record.modules),
    ...(record.recipe.launch === undefined ? {} : { launch: record.recipe.launch }),
    ...(record.recipe.nestedCalls === true ? { nestedCalls: true as const } : {}),
  };
}

/** A record's granted module tools as its welcome carries them, in its recipe's order (extension-modules R10). */
function moduleOffers(modules: LaunchModules): ModuleToolOffer[] {
  return [...modules.tools.values()].map((t) => ({
    name: t.wire,
    description: t.description,
    parameters: t.parameters as unknown as Readonly<Record<string, unknown>>,
    timeoutMs: t.timeoutMs,
  }));
}

/** R7: an agent may send a channel's files off the machine when it is cloud-granted and the space holds any entry. */
export function exposesFiles(cloudGranted: boolean, entries: number): boolean {
  return cloudGranted && entries > 0;
}

/** Bound on texts in one embedding call. */
export const MAX_EMBED_TEXTS = 64;

/** An agent's embedding request body, checked: its texts (1 to MAX_EMBED_TEXTS) and their purpose; throws on anything else. */
export function parseEmbedRequest(body: unknown): EmbedRequest {
  if (typeof body !== 'object' || body === null) throw new AgentRequestInvalid('embed body must be an object');
  const { texts, purpose, ...rest } = body as { [key: string]: unknown };
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new AgentRequestInvalid(`unknown embed field(s): ${extra.join(', ')}`);
  if (
    !Array.isArray(texts) ||
    texts.length === 0 ||
    texts.length > MAX_EMBED_TEXTS ||
    !texts.every((t) => typeof t === 'string' && t !== '')
  ) {
    throw new AgentRequestInvalid(`texts must be 1..${String(MAX_EMBED_TEXTS)} non-empty strings`);
  }
  if (purpose !== 'query' && purpose !== 'document')
    throw new AgentRequestInvalid('purpose must be "query" or "document"');
  return { texts, purpose };
}

/** An agent's chat request body, checked against the wire's shape; throws on anything else. */
export function parseChatRequest(body: unknown): ChatRequest {
  if (typeof body !== 'object' || body === null) throw new AgentRequestInvalid('chat body must be an object');
  const { messages, maxTokens, tools, requireToolCall, ...rest } = body as { [key: string]: unknown };
  const extra = Object.keys(rest);
  if (extra.length > 0) throw new AgentRequestInvalid(`unknown chat field(s): ${extra.join(', ')}`);
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AgentRequestInvalid('messages must be a non-empty array');
  }
  const parsed: ChatMessage[] = messages.map((m: unknown, i) => parseChatMessage(m, i));
  if (typeof maxTokens !== 'number' || !Number.isInteger(maxTokens) || maxTokens <= 0 || maxTokens > MAX_TOKENS_CAP) {
    throw new AgentRequestInvalid(`maxTokens must be an integer in 1..${String(MAX_TOKENS_CAP)}`);
  }
  if (requireToolCall !== undefined && typeof requireToolCall !== 'boolean') {
    throw new AgentRequestInvalid('requireToolCall must be true or false');
  }
  if (requireToolCall === true && tools === undefined) throw new AgentRequestInvalid('requireToolCall needs tools');
  // A required call opens a new assistant turn (the gateway's toolCallStart); llama-server refuses two in a row.
  if (requireToolCall === true && parsed.at(-1)?.role === 'assistant') {
    throw new AgentRequestInvalid('requireToolCall needs messages that do not end with an assistant turn');
  }
  return {
    messages: parsed,
    maxTokens,
    ...(tools === undefined ? {} : { tools: parseTools(tools) }),
    ...(requireToolCall === undefined ? {} : { requireToolCall }),
  };
}

function parseChatMessage(raw: unknown, i: number): ChatMessage {
  const o = raw as { [key: string]: unknown } | null;
  const bad = (what: string) => new AgentRequestInvalid(`messages[${String(i)}] ${what}`);
  if (typeof o !== 'object' || o === null || typeof o['content'] !== 'string') throw bad('must have string content');
  const content = o['content'];
  switch (o['role']) {
    case 'system':
    case 'user':
      return { role: o['role'], content };
    case 'assistant': {
      if (o['toolCalls'] === undefined) return { role: 'assistant', content };
      if (!Array.isArray(o['toolCalls'])) throw bad('toolCalls must be an array');
      const toolCalls = o['toolCalls'].map((c: unknown) => {
        const call = c as { id?: unknown; name?: unknown; arguments?: unknown } | null;
        if (
          typeof call?.id !== 'string' ||
          typeof call.name !== 'string' ||
          typeof call.arguments !== 'object' ||
          call.arguments === null ||
          Array.isArray(call.arguments)
        ) {
          throw bad('toolCalls entries must be {id, name, arguments: object}');
        }
        return { id: call.id, name: call.name, arguments: call.arguments as Record<string, unknown> };
      });
      return { role: 'assistant', content, toolCalls };
    }
    case 'tool':
      if (typeof o['toolCallId'] !== 'string' || o['toolCallId'] === '')
        throw bad('a tool message needs its toolCallId');
      return { role: 'tool', toolCallId: o['toolCallId'], content };
    default:
      throw bad('must have role system, user, assistant or tool');
  }
}

function parseTools(raw: unknown): ToolDefinition[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TOOLS) {
    throw new AgentRequestInvalid(`tools must be an array of 1..${String(MAX_TOOLS)} tool definitions`);
  }
  return raw.map((t: unknown, i) => {
    const tool = t as {
      type?: unknown;
      function?: { name?: unknown; description?: unknown; parameters?: unknown };
    } | null;
    const fn = tool?.function;
    if (
      tool?.type !== 'function' ||
      typeof fn?.name !== 'string' ||
      !TOOL_NAME_PATTERN.test(fn.name) ||
      typeof fn.description !== 'string' ||
      typeof fn.parameters !== 'object' ||
      fn.parameters === null ||
      Array.isArray(fn.parameters)
    ) {
      throw new AgentRequestInvalid(
        `tools[${String(i)}] must be {type: "function", function: {name, description, parameters}}`,
      );
    }
    return {
      type: 'function' as const,
      function: { name: fn.name, description: fn.description, parameters: fn.parameters as Record<string, unknown> },
    };
  });
}

/** `classify`'s table: the first test an error satisfies names its reason; data, not control flow, so a long chain of equally-weighted checks does not read as one intricate decision. */
const CLASSIFIERS: readonly (readonly [(error: unknown) => boolean, ConversationErrorReason])[] = [
  [(error) => error instanceof UnknownTeam, 'unknown_team'],
  [(error) => error instanceof UnknownImage, 'unknown_image'],
  [(error) => error instanceof UnknownRecipe, 'unknown_recipe'],
  [(error) => error instanceof PrerequisiteMissing || error instanceof ToolInstallFailed, 'prerequisite'],
  [(error) => error instanceof ContainerRuntimeError || error instanceof FileSpaceUnavailable, 'container_runtime'],
  [
    (error) => error instanceof ModelFetchFailed || error instanceof ModelDigestMismatch || error instanceof LockHeld,
    'model_fetch',
  ],
  [(error) => error instanceof ModelServerFailed, 'model_server'],
  [(error) => error instanceof ImageBuildFailed || error instanceof ImageSourceMissing, 'image_build'],
  [(error) => error instanceof AgentStartFailed, 'agent_start'],
  [(error) => error instanceof IdentityInUse, 'identity_in_use'],
  [(error) => error instanceof StateImageMismatch, 'state_image_mismatch'],
  [(error) => error instanceof StateSchemaChanged, 'state_schema_changed'],
  [(error) => error instanceof MemoryEgressForbidden, 'memory_egress_forbidden'],
  [(error) => error instanceof ModuleRefused, 'module_refused'],
  [(error) => error instanceof ModuleUnavailable, 'module_unavailable'],
  [(error) => error instanceof PersistMismatch || error instanceof SavedAssetsDropped, 'persist_mismatch'],
  [(error) => error instanceof FilesSpaceInUse, 'files_space_in_use'],
  [(error) => error instanceof StateInsideGitTree, 'state_inside_git_tree'],
  [(error) => error instanceof PendingFull, 'pending_full'],
  [(error) => error instanceof UnknownHandle, 'unknown_handle'],
  [(error) => error instanceof ChannelNameInvalid || error instanceof NoAgentToRead, 'bad_request'],
];

/** Maps a failure to bring an agent online onto the wire's reason set. */
export function classify(error: unknown): ConversationErrorReason {
  // A team's failure is its member's: the reason is the cause's; the message names the member.
  if (error instanceof TeamLaunchFailed) return classify(error.cause);
  const matched = CLASSIFIERS.find(([test]) => test(error));
  // Anything else — a malformed checked-in definition included — is a harness
  // defect, not an expected failure.
  return matched === undefined ? 'internal' : matched[1];
}

/**
 * The tail of an agent's log, for a start failure's error; one that cannot be read is said in its place and logged
 * (agent.log_read_failed), never only said (PRINCIPLES §11; the code review's round 4, R4-DESIGN-007).
 */
async function logTail(logFile: string, logger: Logger): Promise<string> {
  try {
    return tail(await readFile(logFile, 'utf8'));
  } catch (error) {
    logger.warn('agent.log_read_failed', { logFile, error });
    return `(could not read ${logFile}: ${(error as Error).message})`;
  }
}
