// Which tools an agent is offered, checked once at launch before any container
// starts (docs/plans/agent-tools.md R1, R2, R13): the recipe selects by name
// from its image's manifest and the SDK's common tools; the module tools it is
// granted are added (docs/plans/extension-modules.md R9 — no grant exists
// until that plan builds its allow list, so launches pass none today); the
// channel tools come first on every request. No name may come from two
// sources, and a recipe never selects a command or network tool from an image.

import { present } from '../../shared/assert-present.js';
import {
  CHANNEL_TOOL_NAMES,
  CHANNEL_TOOLS_RESERVED,
  COMMON_TOOL_NAMES,
  DECIDE_TOOL_NAME,
  SELECTABLE_CHANNEL_TOOL_NAMES,
  LAUNCH_AGENT_TOOL_NAME,
  MAX_SELECTED_AND_GRANTED,
  MAX_TOOLS,
  moduleToolWireName,
  type ImageManifest,
} from '../../shared/tools.js';

/** A module command a recipe grants: `<module>/<command>` in the allow list, `<module>__<command>` on the wire. */
export interface ModuleGrant {
  readonly module: string;
  readonly command: string;
}

export type ToolSelectionProblem = 'unknown_tool' | 'name_conflict' | 'class_forbidden' | 'too_many_tools';

/** A recipe's tool selection cannot be served. Names the recipe file and the tool(s); no container is started. */
export class ToolSelectionInvalid extends Error {
  constructor(
    readonly file: string,
    readonly problem: ToolSelectionProblem,
    detail: string,
  ) {
    super(`${file}: ${detail}`);
    this.name = 'ToolSelectionInvalid';
  }
}

export interface ResolveToolsProps {
  /** The recipe's id: its file is recipes/<id>.json. */
  readonly recipe: string;
  /** The names the recipe's `tools` selects. */
  readonly selected: readonly string[];
  readonly image: { readonly name: string; readonly manifest: ImageManifest };
  readonly granted: readonly ModuleGrant[];
  /** The recipe has a launch grant (docs/plans/patterns-phase-3.md R29): the gateway accepts `launch_agent` from it. */
  readonly launch?: boolean;
}

export interface ToolSelection {
  /** The selected names, in the recipe's order: what the welcome event carries. */
  readonly selected: readonly string[];
  /** The granted module tools' wire names. */
  readonly granted: readonly string[];
  /** Every name the gateway accepts from this agent: channel, selected, granted, and its image's answer tools. */
  readonly allowed: ReadonlySet<string>;
}

/** No name declared by two sources (part of `resolveTools`'s checks). */
function checkNoConflicts(file: string, sources: ReadonlyMap<string, readonly string[]>): void {
  for (const [name, from] of sources) {
    if (from.length > 1)
      throw new ToolSelectionInvalid(file, 'name_conflict', `tool "${name}" is declared by both ${from.join(' and ')}`);
  }
}

/** Every selected name is declared by a source a recipe may select from (part of `resolveTools`'s checks). */
function checkKnown(
  props: {
    readonly file: string;
    readonly selected: readonly string[];
    readonly imageSource: string;
    readonly answerSource: string;
  },
  sources: ReadonlyMap<string, readonly string[]>,
): void {
  for (const name of props.selected) {
    const from = sources.get(name);
    if (
      from === undefined ||
      from[0] === 'the channel tools' ||
      from[0] === 'the launch tool (a launch grant)' ||
      from[0] === props.answerSource ||
      present(from[0], 'the first source declaring this tool name').startsWith('module grant')
    ) {
      throw new ToolSelectionInvalid(
        props.file,
        'unknown_tool',
        `selects tool "${name}", which neither ${props.imageSource}, the common tools, the selectable channel tools nor the decide tool declare`,
      );
    }
  }
}

/** No selected name is an image tool of a class a recipe may never select (part of `resolveTools`'s checks). */
function checkClasses(props: {
  readonly file: string;
  readonly selected: readonly string[];
  readonly imageSource: string;
  readonly tools: ImageManifest['tools'];
}): void {
  for (const name of props.selected) {
    const tool = props.tools.find((t) => t.name === name);
    if (tool !== undefined && tool.class !== 'files') {
      throw new ToolSelectionInvalid(
        props.file,
        'class_forbidden',
        `selects tool "${name}", which ${props.imageSource} declares with class "${tool.class}": a tool that runs a command or reaches a network ` +
          'is never an image tool; make it a harness plugin module (docs/plans/extension-modules.md R28–R33) and grant it',
      );
    }
  }
}

/** Checks a recipe's selection against every source, in this order: conflicts, unknown names, forbidden classes, the count. */
export function resolveTools(props: ResolveToolsProps): ToolSelection {
  const file = `recipes/${props.recipe}.json`;
  const imageSource = `image "${props.image.name}" (images/${props.image.name}/image.json)`;
  const granted = props.granted.map((g) => ({
    wire: moduleToolWireName(g.module, g.command),
    source: `module grant ${g.module}/${g.command}`,
  }));
  const sources = new Map<string, string[]>();
  const declare = (name: string, source: string): void => {
    sources.set(name, [...(sources.get(name) ?? []), source]);
  };
  for (const name of CHANNEL_TOOL_NAMES) declare(name, 'the channel tools');
  for (const name of COMMON_TOOL_NAMES) declare(name, 'the common tools (the agent SDK)');
  // A channel tool a recipe may select (agent-files R12): selectable as a common tool is.
  for (const name of SELECTABLE_CHANNEL_TOOL_NAMES) declare(name, 'the selectable channel tools (the agent SDK)');
  // Offered by a launch grant, never selected (R29): no image tool may take its name.
  declare(LAUNCH_AGENT_TOOL_NAME, 'the launch tool (a launch grant)');
  // The decision model's tool (docs/plans/decider-tool.md R10, R11): selected as a common tool is; the recipe parser
  // already requires its `decisions` beside it.
  declare(DECIDE_TOOL_NAME, 'the decide tool (the agent SDK)');
  for (const tool of props.image.manifest.tools) declare(tool.name, imageSource);
  const answerSource = `image "${props.image.name}"'s answer tools (images/${props.image.name}/image.json)`;
  for (const name of props.image.manifest.answerTools) declare(name, answerSource);
  for (const g of granted) declare(g.wire, g.source);
  checkNoConflicts(file, sources);
  checkKnown({ file, selected: props.selected, imageSource, answerSource }, sources);
  checkClasses({ file, selected: props.selected, imageSource, tools: props.image.manifest.tools });
  const count = props.selected.length + granted.length;
  if (count > MAX_SELECTED_AND_GRANTED) {
    throw new ToolSelectionInvalid(
      file,
      'too_many_tools',
      `selects ${String(props.selected.length)} tools and grants ${String(granted.length)} module tools: ${String(count)}, over the limit of ${String(MAX_SELECTED_AND_GRANTED)} ` +
        `(${String(MAX_TOOLS)} per model request, less ${String(CHANNEL_TOOLS_RESERVED)} reserved for the ${String(CHANNEL_TOOL_NAMES.length)} channel tools)`,
    );
  }
  return {
    selected: [...props.selected],
    granted: granted.map((g) => g.wire),
    allowed: new Set([
      ...CHANNEL_TOOL_NAMES,
      ...props.selected,
      ...granted.map((g) => g.wire),
      ...props.image.manifest.answerTools,
      ...(props.launch === true ? [LAUNCH_AGENT_TOOL_NAME] : []),
    ]),
  };
}
