// The opt-in live-vendor check (docs/plans/extension-modules.md R17, R18a, R19, R20; A18, A20): `npm run live:modules`,
// outside the gate. It refuses, before anything reaches the network, a module whose manifest carries no owner's
// approval of its cost (`cost.approved`). Then, through the module's own container and the egress proxy (the module
// host, as a launch uses it): for a ModelProvider, each chat model's lifecycle state read first — anything but ACTIVE
// refused before any chat call — then one chat that requires a tool call, recording whether the vendor honoured the
// forced tool choice and reported its usage (R19's probe); for a ToolModule, one call of the tool and arguments the
// user names. What it finds is returned as a record for the caller to write (PRINCIPLES §13).

import { present } from '../../shared/assert-present.js';
import type { ChatMessage, ToolDefinition } from '../../shared/protocol.js';
import type { ModelProviderManifest, ProviderModel } from '../../shared/modules.js';
import type { CallOutcome, ModuleHost } from './host.js';
import type { InstalledModule } from './images.js';

/** The channel the live check's module container runs on: a name no recipe's channel takes (it holds a space). */
export const LIVE_CHANNEL = 'live-check';
/** The chat the check sends: one tool, a required call, a small bound. */
export const LIVE_TOOL: ToolDefinition = {
  type: 'function',
  function: {
    name: 'reply',
    description: 'Reply to the user.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'The reply' } },
      required: ['text'],
    },
  },
};
const LIVE_MESSAGES: readonly ChatMessage[] = [{ role: 'user', content: 'Say hello to the user with the reply tool.' }];
const LIVE_MAX_TOKENS = 64;

export type LiveCheckRecord =
  | { readonly ok: false; readonly module: string; readonly refused: string; readonly networkCalls: 0 }
  | { readonly ok: true; readonly module: string; readonly steps: readonly LiveStep[] };

interface LiveStep {
  readonly step: string;
  readonly outcome: CallOutcome;
  /** For a chat: whether a tool call came back (the forced tool choice honoured) and whether usage was reported. */
  readonly toolChoiceHonoured?: boolean;
  readonly usageReported?: boolean;
}

export interface LiveCheckProps {
  readonly installed: InstalledModule;
  readonly host: Pick<ModuleHost, 'acquire' | 'release' | 'provider' | 'call'>;
  /** For a ToolModule: the tool and arguments to call. */
  readonly tool?: { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> };
}

/**
 * Whether a live check passed: it ran, every step's call answered ok, and every chat came back with the forced tool
 * call and its usage. A refused model (not ACTIVE) or a failed call is a record worth keeping, and not a pass (B-28).
 */
export function livePassed(record: LiveCheckRecord): boolean {
  return (
    record.ok && record.steps.every((s) => s.outcome.ok && s.toolChoiceHonoured !== false && s.usageReported !== false)
  );
}

/**
 * One chat model's lifecycle-then-chat check (R19, R20), extracted from {@link liveCheck} to keep its cognitive
 * complexity down: the lifecycle call's step, then either the refused step (not ACTIVE: `stopped` true, no chat
 * call) or the chat call's step (`stopped` false). The caller decides, on `stopped`, whether to keep looping.
 */
async function checkChatModel(
  manifest: ModelProviderManifest,
  model: ProviderModel,
  host: LiveCheckProps['host'],
  abandon: AbortSignal,
): Promise<{ readonly steps: readonly LiveStep[]; readonly stopped: boolean }> {
  const lifecycle = await host.provider({
    module: manifest.id,
    channel: LIVE_CHANNEL,
    tool: 'lifecycle',
    arguments: { model: model.id },
    onDelta: () => undefined,
    abandon,
  });
  const lifecycleStep: LiveStep = { step: `lifecycle ${model.id}`, outcome: lifecycle };
  const status = lifecycle.ok ? (lifecycle.result as { status?: unknown } | null)?.status : undefined;
  if (status !== 'ACTIVE')
    return {
      stopped: true,
      steps: [
        lifecycleStep,
        {
          step: `refused ${model.id}`,
          outcome: {
            ok: false,
            reason: 'unavailable',
            detail: `its lifecycle status is ${String(status)}, not ACTIVE: no chat call is made (R20)`,
          },
        },
      ],
    };
  const chat = await host.provider({
    module: manifest.id,
    channel: LIVE_CHANNEL,
    tool: 'chat',
    arguments: {
      model: model.id,
      messages: LIVE_MESSAGES,
      maxTokens: LIVE_MAX_TOKENS,
      tools: [LIVE_TOOL],
      requireToolCall: true,
      settings: { ...model.chat },
    },
    onDelta: () => undefined,
    abandon,
  });
  const result = chat.ok ? (chat.result as { toolCalls?: unknown[] } | null) : null;
  const usage = chat.ok ? (chat.usage as { inputTokens?: unknown; outputTokens?: unknown } | undefined) : undefined;
  const chatStep: LiveStep = {
    step: `chat ${model.id}`,
    outcome: chat,
    toolChoiceHonoured: Array.isArray(result?.toolCalls) && result.toolCalls.length > 0,
    usageReported: typeof usage?.inputTokens === 'number' && typeof usage.outputTokens === 'number',
  };
  return { stopped: false, steps: [lifecycleStep, chatStep] };
}

export async function liveCheck(props: LiveCheckProps): Promise<LiveCheckRecord> {
  const { manifest } = props.installed;
  const refuse = (refused: string): LiveCheckRecord => ({ ok: false, module: manifest.id, refused, networkCalls: 0 });
  // R18a: before any network call.
  const cost = manifest.cost;
  if ((cost.model === 'metered' || cost.model === 'external-unmetered') && cost.approved === undefined)
    return refuse(
      `module ${manifest.id}'s manifest has no cost.approved: the owner's approval of its cost is recorded there before any live call (R18a)`,
    );
  if (manifest.kind === 'CommandTool')
    return refuse(
      `module ${manifest.id} is a command plugin: the live check runs ToolModules and ModelProviders (debt D52)`,
    );
  if (manifest.kind === 'ToolModule' && props.tool === undefined)
    return refuse(`module ${manifest.id} is a ToolModule: name the tool and its arguments (tool=<name> args=<json>)`);
  const steps: LiveStep[] = [];
  const never = new AbortController().signal;
  await props.host.acquire(manifest.id, LIVE_CHANNEL);
  try {
    if (manifest.kind === 'ModelProvider') {
      for (const model of manifest.models.filter((m) => m.kind === 'chat')) {
        const checked = await checkChatModel(manifest, model, props.host, never);
        steps.push(...checked.steps);
        if (checked.stopped) return { ok: true, module: manifest.id, steps };
      }
    } else {
      const tool = present(props.tool, 'the tool to call (ToolModule)');
      const declared = manifest.tools.find((t) => t.name === tool.name);
      if (declared === undefined) return refuse(`module ${manifest.id} declares no tool ${tool.name}`);
      const outcome = await props.host.call({
        module: manifest.id,
        channel: LIVE_CHANNEL,
        tool: tool.name,
        arguments: tool.arguments,
        timeoutMs: declared.timeoutMs,
        consequential: false,
        abandon: never,
      });
      steps.push({ step: `call ${tool.name}`, outcome });
    }
    return { ok: true, module: manifest.id, steps };
  } finally {
    await props.host.release(manifest.id, LIVE_CHANNEL);
  }
}
