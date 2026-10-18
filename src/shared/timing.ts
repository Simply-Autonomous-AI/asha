// The bounds the CLI and the portal's page both wait with (docs/plans/portal.md R18): one module, imported by both,
// so the page can never wait longer, or less, than the command it stands for. Browser-safe: it imports nothing.

/** A JSON request to the daemon's control API: health, telemetry, state, a report, a stop. */
export const HEALTH_TIMEOUT_MS = 3_000;
/** Silence on a stream — no event and no heartbeat — that ends it (the daemon's heartbeats come every 10 s). */
export const STREAM_IDLE_MS = 60_000;
/** An upload's answer (docs/plans/agent-files.md R3a): the daemon answers within 240 s; a client waits 20 s more. */
export const UPLOAD_ANSWER_MS = 260_000;
/** A returned file's body: no bytes for this long ends the download (agent-files R12a). */
export const DOWNLOAD_IDLE_MS = 30_000;
/**
 * How long a stop may take before the client says the daemon is still running: a daemon's slowest clean stop is an
 * agent's stop grace (AGENT_STOP_GRACE_MS, 70 s), the isolation reclaim (about 1 s), then a model server's 10 s
 * SIGTERM grace (docs/plans/agent-persistence.md R10).
 */
export const SERVER_STOP_MS = 90_000;
