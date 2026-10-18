// The `hold` tool (docs/plans/patterns-phase-2.md R7): an image tool that
// never returns a result. A recipe built to stall selects it — P14's `stuck`,
// whose delivery must expire with the tool still holding
// (docs/plans/orchestration-patterns.md R9: "a test tool that never acks
// within its bound"). It announces itself in the agent's log, so a scenario can
// prove the fault fired, then waits for its signal, which only the call's own
// bound aborts (60 s, image.json). A stop does not abort it: a kill (P14's case,
// the delivery past its bound) ends the process with the tool holding, and no
// hold.ended is logged; a drain waits for it up to its drain bound. It acts on no
// file, no network and no channel: only a timer's worth of waiting.

import type { AgentLog, ImageToolHandler } from '../../../src/agent-sdk/index.js';

/** The tool's name, as image.json declares it. */
export const HOLD = 'hold';

/**
 * The handler: logs `hold.started`, returns nothing until `signal` aborts, then logs `hold.ended` and returns the
 * failure `timeout` — the reason AgentTools also gives the model when the bound passes.
 */
export function holdHandler(log: AgentLog): ImageToolHandler {
  return async (_args, signal) => {
    log.info('hold.started', { tool: HOLD });
    if (!signal.aborted)
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve();
          },
          { once: true },
        );
      });
    log.info('hold.ended', { tool: HOLD });
    return { ok: false, reason: 'timeout' };
  };
}
