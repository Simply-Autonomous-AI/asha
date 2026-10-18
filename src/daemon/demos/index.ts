// The pattern demos the portal's watch view can run (docs/plans/portal-scene-chat.md R16): each docs/patterns/pNN-*.md
// page under the daemon's root, read with the agent suite's own parser (src/shared/run-block.ts) at each request, its
// team, bound and scenarios given as requests the page sends, on the first channel `pNN-<k>` the daemon has not used —
// a channel new to it, so the team's members join as `<name>-1`, as the page's commands address them. A page holding
// a command the page cannot send (a stop, a relaunch) or a word the mapping does not cover is listed as not runnable,
// saying which; a page whose block does not parse is listed with its problem. An installed release ships no pages.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { present } from '../../shared/assert-present.js';
import { demoRequest } from '../../shared/demo-request.js';
import { byCodeUnit } from '../../shared/order.js';
import type { ConversationRequest, Demo, DemoProblem, DemoScenario, DemosResponse } from '../../shared/protocol.js';
import { RunBlockInvalid, isControl, parseRunBlock, type RunBlock } from '../../shared/run-block.js';

export interface DemoSourceProps {
  /** The daemon's root: the pages are under `docs/patterns/` there. */
  readonly root: string;
  /** Whether the daemon has a channel of this name (`Channels.existing`, which creates none). */
  readonly channelExists: (name: string) => boolean;
}

const PAGE = /^p(\d{2})-[a-z0-9-]+\.md$/;

/**
 * The demos whose scenarios need a fault the agent suite injects beside the page's commands (portal-scene-chat R16): the
 * page cannot inject one, so these are listed as not runnable, saying which. A unit test keeps this list equal to the
 * suites that pause or kill a container (tests/unit/demos-route.test.ts).
 */
export const INJECTED_FAULTS: Readonly<Record<string, string>> = {
  P25: "worker-1's container paused, then killed",
  P20: "worker-1's container paused while the daemon stops",
};

/** A page's scenarios, turned into requests (part of `listDemos`): each step, or why the page cannot run at all. */
function buildScenarios(
  scenarios: RunBlock['scenarios'],
  channel: string,
): { readonly scenarios: DemoScenario[]; readonly reason: string | undefined } {
  let reason: string | undefined;
  const out: DemoScenario[] = [];
  for (const [id, commands] of scenarios) {
    const steps: ConversationRequest[] = [];
    for (const args of commands) {
      if (isControl(args)) {
        reason ??= `scenario ${id} runs "./asha ${args.join(' ')}", which this page cannot (portal-restart)`;
        break;
      }
      const request = demoRequest(args, channel);
      if ('unmapped' in request) {
        reason ??= `scenario ${id} uses ${request.unmapped}, which this page does not send`;
        break;
      }
      steps.push(request);
    }
    out.push({ id, steps });
  }
  return { scenarios: out, reason };
}

/** One demo page (part of `listDemos`): its page number, title, scenarios, and why it cannot run when it cannot. */
async function demoForPage(props: DemoSourceProps, dir: string, name: string): Promise<Demo | DemoProblem> {
  const match = present(PAGE.exec(name), `${name}: PAGE did not match`);
  const nn = present(match[1], `${name}: the page number group`);
  const pattern = `P${String(Number(nn))}`;
  const page = `docs/patterns/${name}`;
  const markdown = await readFile(join(dir, name), 'utf8');
  let block: RunBlock;
  try {
    block = parseRunBlock(page, markdown);
  } catch (error) {
    if (!(error instanceof RunBlockInvalid)) throw error;
    return { pattern, page, problem: error.problem };
  }
  const channel = freshChannel(`p${nn}`, props.channelExists);
  // The page's `# ` heading, its `P<n> · ` dropped: the drop-down shows `<pattern> · <title>`. A page without one is malformed.
  // Outside fenced blocks: the run block's own `# bound:` and `# pNN-x` lines are not headings.
  const heading = /^# (.+)$/m.exec(markdown.replace(/^```[\s\S]*?^```$/gm, ''))?.[1];
  if (heading === undefined) return { pattern, page, problem: 'it has no "# " heading' };
  const title = heading.startsWith(`${pattern} · `) ? heading.slice(`${pattern} · `.length) : heading;
  const built = buildScenarios(block.scenarios, channel);
  const fault = INJECTED_FAULTS[pattern];
  const reason =
    built.reason ??
    (fault === undefined
      ? undefined
      : `its scenarios need a fault the agent suite injects (${fault}), which this page cannot`);
  return reason === undefined
    ? {
        pattern,
        title,
        page,
        team: block.team,
        boundMs: block.boundMs,
        channel,
        runnable: true,
        scenarios: built.scenarios,
      }
    : {
        pattern,
        title,
        page,
        team: block.team,
        boundMs: block.boundMs,
        channel,
        runnable: false,
        reason,
        scenarios: [],
      };
}

/** Every demo page, in page order; `{shipped: false, demos: []}` with no docs/patterns/ folder. */
export async function listDemos(props: DemoSourceProps): Promise<DemosResponse> {
  const dir = join(props.root, 'docs', 'patterns');
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => PAGE.test(n)).sort(byCodeUnit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { shipped: false, demos: [] };
    throw error;
  }
  const demos: (Demo | DemoProblem)[] = [];
  for (const name of names) demos.push(await demoForPage(props, dir, name));
  return { shipped: true, demos };
}

/** The first `<prefix>-<k>`, k = 1, 2, …, naming no channel on the daemon. */
function freshChannel(prefix: string, exists: (name: string) => boolean): string {
  for (let k = 1; ; k += 1) if (!exists(`${prefix}-${String(k)}`)) return `${prefix}-${String(k)}`;
}
