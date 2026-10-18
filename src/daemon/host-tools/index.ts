// Making sure a host tool (colima, docker, llama-server) is installed, and
// installing it with Homebrew when it is not. The one install path: Homebrew
// itself is never installed by the harness — it is a prerequisite the owner
// sets up.

import type { Logger } from '../log.js';
import { CommandNotFound, tail, type CommandResult, type CommandRunner } from '../process/index.js';

/** A binary asha needs on the host (colima, docker, llama-server): how it is probed, and the formula that installs it. */
export interface HostTool {
  /** The binary on PATH. */
  readonly binary: string;
  /** Arguments that make the binary print something and exit 0. */
  readonly probeArgs: readonly string[];
  /** The Homebrew formula that provides it. */
  readonly formula: string;
}

/** A prerequisite is missing and the harness cannot install it itself. */
export class PrerequisiteMissing extends Error {
  constructor(
    readonly prerequisite: string,
    readonly remedy: string,
  ) {
    super(`${prerequisite} is required and not installed: ${remedy}`);
    this.name = 'PrerequisiteMissing';
  }
}

/** Installing a tool with Homebrew failed. Carries brew's own output. */
export class ToolInstallFailed extends Error {
  constructor(
    readonly tool: string,
    readonly output: string,
  ) {
    super(`installing ${tool} with Homebrew failed:\n${output}`);
    this.name = 'ToolInstallFailed';
  }
}

const PROBE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 15 * 60_000;

/**
 * Returns `'present'` or `'installed'`; throws if the tool cannot be made present: PrerequisiteMissing without
 * Homebrew, ToolInstallFailed — with the failing command's exit code and output — when Homebrew does not run, the
 * install fails, or the tool still does not run after it.
 */
export async function ensureHostTool(
  runner: CommandRunner,
  logger: Logger,
  tool: HostTool,
): Promise<'present' | 'installed'> {
  if ((await probe(runner, tool)) === 'runs') return 'present';

  let brew;
  try {
    brew = await runner.run('brew', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof CommandNotFound) {
      throw new PrerequisiteMissing(
        'Homebrew',
        `install it from https://brew.sh, then retry (needed to install ${tool.binary})`,
      );
    }
    throw error;
  }
  // A Homebrew that does not run is said as such, never taken for one that does (PRINCIPLES §11).
  if (brew.code !== 0) throw new ToolInstallFailed(tool.binary, exited('brew --version', brew));

  logger.info('host_tool.installing', { tool: tool.binary, formula: tool.formula });
  const result = await runner.run('brew', ['install', tool.formula], { timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.code !== 0) {
    throw new ToolInstallFailed(tool.binary, tail(`${result.stdout}\n${result.stderr}`));
  }
  const after = await probe(runner, tool);
  if (after !== 'runs') {
    throw new ToolInstallFailed(
      tool.binary,
      `brew install ${tool.formula} exited 0 but ${tool.binary} is still not runnable: ${
        after === 'absent' ? `${tool.binary} is not on PATH` : exited([tool.binary, ...tool.probeArgs].join(' '), after)
      }`,
    );
  }
  logger.info('host_tool.installed', { tool: tool.binary, formula: tool.formula });
  return 'installed';
}

/** Whether the tool runs: `'runs'`, `'absent'` (not on PATH), or the failing probe's result, kept for the error. */
async function probe(runner: CommandRunner, tool: HostTool): Promise<'runs' | 'absent' | CommandResult> {
  try {
    const result = await runner.run(tool.binary, tool.probeArgs, { timeoutMs: PROBE_TIMEOUT_MS });
    return result.code === 0 ? 'runs' : result;
  } catch (error) {
    if (error instanceof CommandNotFound) return 'absent';
    throw error;
  }
}

/** A command's non-zero exit, said with its code and its output's tail. */
function exited(line: string, result: CommandResult): string {
  const output = tail(`${result.stdout}\n${result.stderr}`);
  return `${line} exited ${String(result.code)}:\n${output}`;
}
