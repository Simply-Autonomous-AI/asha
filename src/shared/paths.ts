// Where the harness keeps its state on the host. Shared by the CLI (to find or
// start the daemon) and the daemon (to write it).

import { createHash } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface HarnessPaths {
  readonly home: string;
  /**
   * The first 8 hex characters of the sha256 of the absolute home: names this
   * home's container network (`asha-<homeId>`) and tags its isolation rules.
   */
  readonly homeId: string;
  /** Held (pid inside) by the one daemon that owns this home. */
  readonly daemonLock: string;
  /** `{pid, port, credential}`, mode 0600, written once the daemon is listening. */
  readonly daemonFile: string;
  /** The key every llama-server this daemon starts requires; mode 0600. */
  readonly modelServerKey: string;
  /** `asha --portal`'s forwarding page (docs/plans/portal.md R1): 0600, holding the credential in its URL fragment. */
  readonly portalFile: string;
  readonly logsDir: string;
  /** stdout/stderr of a daemon the CLI started in the background. */
  readonly serverLog: string;
  readonly agentLogsDir: string;
  readonly stagingDir: string;
  readonly modelsDir: string;
  /** Saved agent and channel state (docs/plans/agent-persistence.md R2): created only by the first persisted save. */
  readonly stateDir: string;
  /** Installed extension modules, one directory each (docs/plans/extension-modules.md R1): written only by the CLI. */
  readonly modulesDir: string;
  /** Module secrets, one 0600 file per module in a 0700 directory (R7). */
  readonly secretsDir: string;
  /** The append-only audit of consequential calls (R14). */
  readonly auditDir: string;
  /** Metered modules' opt-in caps and spend (R18b): written by the daemon, or by --enable-module with no daemon. */
  readonly meteringFile: string;
}

/**
 * `ASHA_HOME` defaults to ~/.simplyautonomous/harness and `ASHA_MODELS_DIR` to
 * <home>/models. Both are documented defaults for the common case (one harness
 * per user), not environment selection; tests set both explicitly.
 */
export function harnessPaths(env: NodeJS.ProcessEnv): HarnessPaths {
  const home = env['ASHA_HOME'] || join(homedir(), '.simplyautonomous', 'harness');
  const logsDir = join(home, 'logs');
  return {
    home,
    homeId: createHash('sha256').update(resolve(home)).digest('hex').slice(0, 8),
    daemonLock: join(home, 'daemon.lock'),
    daemonFile: join(home, 'daemon.json'),
    // Absolute (debt-paydown R13): every llama-server names it on its command line, where the orphan sweep finds this
    // home's servers by it; a relative path would name every home given the same relative ASHA_HOME.
    modelServerKey: join(resolve(home), 'model-server.key'),
    portalFile: join(home, 'portal.html'),
    logsDir,
    serverLog: join(logsDir, 'server.log'),
    agentLogsDir: join(logsDir, 'agents'),
    stagingDir: join(home, 'staging'),
    modelsDir: env['ASHA_MODELS_DIR'] || join(home, 'models'),
    stateDir: join(home, 'state'),
    modulesDir: join(home, 'modules'),
    secretsDir: join(home, 'secrets'),
    auditDir: join(home, 'audit'),
    meteringFile: join(home, 'metering.json'),
  };
}

/**
 * Whether `path` is inside a git tree (docs/plans/agent-persistence.md R2; extension-modules R7, R28): true when the
 * path, or any directory above it up to `/`, holds an entry named `.git` that is a directory (a repository) or a
 * regular file (a worktree's or a submodule's). Symbolic links are not followed. The path need not exist.
 */
export async function insideGitTree(path: string): Promise<boolean> {
  for (let dir = resolve(path); ; dir = dirname(dir)) {
    try {
      const entry = await lstat(join(dir, '.git'));
      if (entry.isDirectory() || entry.isFile()) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Absent, or a parent absent or not a directory: nothing named .git here.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
    if (dirname(dir) === dir) return false;
  }
}

/**
 * Creates the home, when it does not exist, readable by this user only (0700),
 * since it holds the daemon's credential. An existing home keeps its mode.
 */
export async function ensureHome(paths: HarnessPaths): Promise<void> {
  await mkdir(paths.home, { recursive: true, mode: 0o700 });
}
