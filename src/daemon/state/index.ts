// Saved agent and channel state (docs/plans/agent-persistence.md): the store's public surface. The store keeps
// each persisted agent's /memory and /workspace, and each persisted channel's board and, with persist files, its file
// space and file table (agent-files R15), as promoted generations under
// ASHA_HOME/state/, with each agent's record of unsaved deliveries beside them; the supervisor decides when to
// checkpoint and restore, and copies to and from containers through the container runtime.

export { nodeStateFs, type StateFile, type StateFs } from './fs.js';
export {
  PENDING_MAX_BYTES,
  PENDING_MAX_ENTRIES,
  PendingRecord,
  PendingRecordInvalid,
  parsePending,
  type PendingEntry,
  type PendingKind,
} from './pending.js';
export {
  ASSET_BOUNDS,
  FILES_BOUNDS,
  GenerationWriter,
  StateInsideGitTree,
  StateStore,
  StateStoreCorrupt,
  identityKey,
  parsePointer,
  selectorProblem,
  type AgentIdentity,
  type AgentPointer,
  type ChannelPointer,
} from './store.js';
// The tar reader and writer are also the channel file space's and command plugins' (files/, modules/plugins.ts):
// they import them from here, never from tar.js (PRINCIPLES §10).
export {
  STATE_OWNER,
  TAR_BLOCK,
  TarParser,
  padOf,
  readStoredEntries,
  tarDirectory,
  tarEntryHeader,
  tarFile,
  type TarEntry,
  type TarFormatFailure,
  type TarHeader,
  type TarReader,
} from './tar.js';
