// The built requests are the probed ones (docs/plans/patterns-phase-3.md R37, A7): each model turn the premise probes
// ran three times (evals/probes/patterns-phase-3-2026-10-02/probe/d102a45/), built here by the real SDK — the
// hello-world image's helloWorldTurn and decide()'s rebuild, the agent's tools as serveAgent offers them — from the
// built team folders as the daemon loads them (parseTeam, loadDocuments, guidanceOf), each message as the channel
// carries it, its request's sha256 equal to the one the probe recorded. Turns are added as each step builds them.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { helloWorldTurn } from '../../images/hello-world/src/agent.js';
import {
  ASK_USER,
  ASK_USER_TOOL,
  AgentTools,
  LAUNCH_AGENT,
  REPLY_WITH_FILES,
  REPLY_WITH_FILES_TOOL,
  blackboardTools,
  fileTools,
  launchAgentTool,
} from '../../src/agent-sdk/index.js';
import { Definitions, guidanceOf, loadDocuments } from '../../src/daemon/definitions/index.js';
import { present } from '../../src/shared/assert-present.js';
import type { ChatRequest, ConversationMessage } from '../../src/shared/protocol.js';
import { ROOT } from '../helpers/pattern-spec.js';
import { numberedBefore, renumberIds } from '../helpers/renumbering.js';

const PROBES = 'tests/fixtures/probes/patterns-phase-3-2026-10-02/probe/d102a45';
/** The turns of approval and escalation, probed again with the file tools (the plan's Premise probes, corrected 2026-10-02). */
const REPROBED = 'tests/fixtures/probes/patterns-phase-3-2026-10-02/probe/1161e29';
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** The probe's recorded sha256 of a turn's first request. */
function recorded(turn: string): string {
  // The probe named each turn by its pattern's number before the renumbering of 2026-10-16.
  const probed = renumberIds(turn, numberedBefore);
  const folder = /^(p16|p23)/.test(probed) ? REPROBED : PROBES;
  const record = JSON.parse(readFileSync(join(ROOT, folder, `${probed.replace('/', '--')}.json`), 'utf8')) as {
    readonly attempts: readonly { readonly requestSha256: string }[];
  };
  return present(record.attempts[0], `${turn}: probe's attempts[0]`).requestSha256;
}

/** sha256 of a request's JSON, as the probe hashed it. */
const sha = (request: ChatRequest): string => createHash('sha256').update(JSON.stringify(request)).digest('hex');

/**
 * A member as its agent knows it: its role, its guidance and its offered tools, from the built folder — or a recipe a
 * member's launch grant names (P19's helper), as the launched agent knows it. A grant's launch_agent comes after the
 * selected tools, as serveAgent offers it.
 */
async function persona(team: string, member: string) {
  const loaded = await new Definitions(ROOT).team(team);
  const m =
    loaded.members.find((x) => x.name === member) ??
    loaded.members
      .flatMap((x) => x.launchable)
      .map((l) => ({ recipe: l.recipe, recipeFile: l.recipeFile }))
      .find((l) => l.recipe.id === member);
  if (m === undefined) throw new Error(`teams/${team}: no member or launchable recipe ${member}`);
  const documents = await loadDocuments({ recipe: m.recipe, file: m.recipeFile, folder: join(ROOT, 'teams', team) });
  const available = new Map([
    ...fileTools({ workspace: '/workspace', channelSpace: null, handle: `${member}-1`, log: quiet }),
    ...blackboardTools({
      requestTimeoutMs: 1,
      blackboardRead: () => Promise.resolve({ ok: false, reason: 'invalid_arguments' }),
      blackboardPost: () => Promise.resolve({ ok: false, reason: 'invalid_arguments' }),
    }),
  ]);
  const launch = m.recipe.launch;
  const tools = new AgentTools({
    selected: [...m.recipe.tools, ...(launch === undefined ? [] : [LAUNCH_AGENT])],
    available,
    channel: new Map([
      [REPLY_WITH_FILES, REPLY_WITH_FILES_TOOL],
      [ASK_USER, ASK_USER_TOOL],
      ...(launch === undefined ? [] : [[LAUNCH_AGENT, launchAgentTool(launch.recipes)] as const]),
    ]),
    log: quiet,
  });
  return {
    role: m.recipe.prompt,
    guidance: guidanceOf(m.recipeFile, documents),
    tools: tools.definitions,
    ...(m.recipe.nestedCalls === true ? { nestedCalls: true } : {}),
  };
}

let n = 0;
/** A message as the channel carries it (the probe's fields; the frame reads only from, to, kind, text and the marks). */
function message(
  fields: Partial<ConversationMessage> & Pick<ConversationMessage, 'from' | 'to' | 'kind' | 'text'>,
): ConversationMessage {
  return {
    id: `m${String(++n)}`,
    channel: 'main',
    conversation: 'probe',
    user: 'alice',
    at: '2026-10-02T00:00:00.000Z',
    ...fields,
  };
}

describe("every probed turn's request, built by the real code from the built team folders, is the probed one (R37, A7)", () => {
  it('p25-a/worker-first', async () => {
    const p = await persona('restart', 'worker');
    const request = helloWorldTurn(
      message({ from: 'alice', to: 'worker-1', kind: 'input', text: 'Please say: Hello World.' }),
      'worker-1',
      [],
      p,
    );
    expect(sha(request)).toBe(recorded('p25-a/worker-first'));
  });

  it('p25-a/worker-redelivered: the message the channel re-sends after the restart, framed from its restarted field', async () => {
    const p = await persona('restart', 'worker');
    const request = helloWorldTurn(
      message({
        from: 'alice',
        to: 'worker-1',
        kind: 'input',
        text: 'Please say: Hello World.',
        restarted: { attempt: 1 },
      }),
      'worker-1',
      [],
      p,
    );
    expect(sha(request)).toBe(recorded('p25-a/worker-redelivered'));
  });

  it('p17/ping-first', async () => {
    const p = await persona('budget', 'ping');
    const request = helloWorldTurn(
      message({ from: 'alice', to: 'ping-1', kind: 'input', text: 'Start.' }),
      'ping-1',
      ['pong-1'],
      p,
    );
    expect(sha(request)).toBe(recorded('p17/ping-first'));
  });

  it('p17/pong-on-ping', async () => {
    const p = await persona('budget', 'pong');
    const request = helloWorldTurn(
      message({ from: 'ping-1', to: 'pong-1', kind: 'internal', text: 'ping' }),
      'pong-1',
      ['ping-1'],
      p,
    );
    expect(sha(request)).toBe(recorded('p17/pong-on-ping'));
  });

  it('p17/ping-on-pong', async () => {
    const p = await persona('budget', 'ping');
    const request = helloWorldTurn(
      message({ from: 'pong-1', to: 'ping-1', kind: 'internal', text: 'pong' }),
      'ping-1',
      ['pong-1'],
      p,
    );
    expect(sha(request)).toBe(recorded('p17/ping-on-pong'));
  });

  it.each([
    ['p21-a/weather-desk', 'weather-desk', 'Rain expected tomorrow.'],
    ['p21-a/front-page', 'front-page', 'Rain expected tomorrow.'],
    ['p21-b/sports-desk', 'sports-desk', 'The home team won.'],
    ['p21-b/front-page', 'front-page', 'The home team won.'],
  ])("%s: a topic's message, framed as one to everyone", async (turn, member, text) => {
    const p = await persona('topics', member);
    const handle = `${member}-1`;
    const others = ['weather-desk-1', 'sports-desk-1', 'front-page-1'].filter((h) => h !== handle);
    const request = helloWorldTurn(
      message({ from: 'alice', to: null, kind: 'input', text, topic: turn.includes('p21-a') ? 'weather' : 'sports' }),
      handle,
      others,
      p,
    );
    expect(sha(request)).toBe(recorded(turn));
  });

  /** P15's ask, as its first turn really made it (the probe's p15/clerk-first). */
  const APPROVAL = 'Approve posting "Office closed Friday."? Answer yes or no.';

  it('p15/clerk-first', async () => {
    const p = await persona('approval', 'clerk');
    const request = helloWorldTurn(
      message({ from: 'alice', to: 'clerk-1', kind: 'input', text: 'Post the announcement: Office closed Friday.' }),
      'clerk-1',
      [],
      p,
    );
    expect(sha(request)).toBe(recorded('p15/clerk-first'));
  });

  it.each([
    ['p15-a/clerk-yes', 'yes'],
    ['p15-b/clerk-no', 'no'],
  ])('%s: the answer framed from answers, with the ask as the question', async (turn, answer) => {
    const p = await persona('approval', 'clerk');
    const request = helloWorldTurn(
      message({ from: 'alice', to: 'clerk-1', kind: 'input', text: answer, answers: { ask: 'm1', text: APPROVAL } }),
      'clerk-1',
      [],
      p,
    );
    expect(sha(request)).toBe(recorded(turn));
  });

  const P19_INPUT = 'Bring in a helper and tell me its word.';

  it('p19-a/lead-first: lead-1 alone, offered launch_agent after its selected tools', async () => {
    const p = await persona('spawner', 'lead');
    const request = helloWorldTurn(
      message({ from: 'alice', to: 'lead-1', kind: 'input', text: P19_INPUT }),
      'lead-1',
      [],
      p,
    );
    expect(sha(request)).toBe(recorded('p19-a/lead-first'));
  });

  it('p19-a/lead-after-launch: the request rebuilt for the new roster, the launch round after it', async () => {
    const p = await persona('spawner', 'lead');
    const fresh = helloWorldTurn(
      message({ from: 'alice', to: 'lead-1', kind: 'input', text: P19_INPUT }),
      'lead-1',
      ['helper-1'],
      p,
    );
    const done = [
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'call-launch', name: 'launch_agent', arguments: { recipe: 'helper' } }],
      },
      { role: 'tool' as const, toolCallId: 'call-launch', content: JSON.stringify({ handle: 'helper-1' }) },
    ];
    expect(sha({ ...fresh, messages: [...fresh.messages, ...done] })).toBe(recorded('p19-a/lead-after-launch'));
  });

  it("p19-a/helper-call: the launched helper's call turn", async () => {
    const p = await persona('spawner', 'helper');
    const request = helloWorldTurn(
      message({
        from: 'lead-1',
        to: 'helper-1',
        kind: 'internal',
        text: 'What is your word?',
        call: { id: 'call-1', role: 'question' },
      }),
      'helper-1',
      ['lead-1'],
      p,
    );
    expect(sha(request)).toBe(recorded('p19-a/helper-call'));
  });

  it("p19-a/lead-gather: lead-1's gather, helper-1 on the roster", async () => {
    const p = await persona('spawner', 'lead');
    const gather = message({
      from: 'asha',
      to: 'lead-1',
      kind: 'internal',
      text: "Answers to lead-1's call: 1 answered.",
      call: {
        id: 'call-1',
        role: 'gather',
        context: { from: 'alice', text: P19_INPUT },
        requests: [{ to: 'helper-1', text: 'What is your word?' }],
        answers: [{ from: 'helper-1', outcome: 'answered', text: 'marigold' }],
      },
    });
    expect(sha(helloWorldTurn(gather, 'lead-1', ['helper-1'], p))).toBe(recorded('p19-a/lead-gather'));
  });

  // P7: two levels of calls, the leads granted nestedCalls.
  const P7_HANDLES = ['top-1', 'lead-warm-1', 'lead-cool-1', 'red-1', 'orange-1', 'blue-1', 'violet-1'];
  const othersOf = (h: string) => P7_HANDLES.filter((x) => x !== h);
  const P7_INPUT = 'Which numbers stand for the warm colours and for the cool colours?';
  const Q_LEAD = "What are your colours' numbers?";
  const Q_WORKER = 'What is your number?';
  const question = (from: string, to: string, text: string) =>
    message({ from, to, kind: 'internal', text, call: { id: 'call-1', role: 'question' } });
  const gather = (
    caller: string,
    context: { from: string; text: string },
    requests: [string, string][],
    answers: [string, string][],
    parent?: { id: string; asker: string },
  ) =>
    message({
      from: 'asha',
      to: caller,
      kind: 'internal',
      text: `Answers to ${caller}'s call: ${String(answers.length)} answered.`,
      call: {
        id: 'call-1',
        role: 'gather',
        context,
        requests: requests.map(([to, text]) => ({ to, text })),
        answers: answers.map(([from, text]) => ({ from, outcome: 'answered' as const, text })),
        ...(parent === undefined ? {} : { parent }),
      },
    });

  it('p07-a/top-first', async () => {
    const p = await persona('hierarchy', 'top');
    expect(
      sha(
        helloWorldTurn(
          message({ from: 'alice', to: 'top-1', kind: 'input', text: P7_INPUT }),
          'top-1',
          othersOf('top-1'),
          p,
        ),
      ),
    ).toBe(recorded('p07-a/top-first'));
  });

  it.each(['lead-warm', 'lead-cool'])("p07-a/%s-call: a granted callee's call turn", async (lead) => {
    const p = await persona('hierarchy', lead);
    const h = `${lead}-1`;
    expect(sha(helloWorldTurn(question('top-1', h, Q_LEAD), h, othersOf(h), p))).toBe(recorded(`p07-a/${lead}-call`));
  });

  it.each([
    ['red', 'lead-warm-1'],
    ['orange', 'lead-warm-1'],
    ['blue', 'lead-cool-1'],
    ['violet', 'lead-cool-1'],
  ])("p07-a/%s-call: a worker's call turn, as before", async (worker, lead) => {
    const p = await persona('hierarchy', worker);
    const h = `${worker}-1`;
    expect(sha(helloWorldTurn(question(lead, h, Q_WORKER), h, othersOf(h), p))).toBe(recorded(`p07-a/${worker}-call`));
  });

  it.each([
    ['lead-warm', ['red-1', 'orange-1'], ['4', '7']],
    ['lead-cool', ['blue-1', 'violet-1'], ['3', '2']],
  ] as const)('p07-a/%s-gather: the nested gather, a call turn answering top-1', async (lead, workers, numbers) => {
    const p = await persona('hierarchy', lead);
    const h = `${lead}-1`;
    const m = gather(
      h,
      { from: 'top-1', text: Q_LEAD },
      workers.map((w) => [w, Q_WORKER]),
      workers.map((w, i) => [w, present(numbers[i], `${lead}: numbers[${String(i)}]`)]),
      { id: 'call-0', asker: 'top-1' },
    );
    expect(sha(helloWorldTurn(m, h, othersOf(h), p))).toBe(recorded(`p07-a/${lead}-gather`));
  });

  it("p07-a/top-gather: top-1's gather, as any", async () => {
    const p = await persona('hierarchy', 'top');
    const m = gather(
      'top-1',
      { from: 'alice', text: P7_INPUT },
      [
        ['lead-warm-1', Q_LEAD],
        ['lead-cool-1', Q_LEAD],
      ],
      [
        ['lead-warm-1', '4, 7'],
        ['lead-cool-1', '3, 2'],
      ],
    );
    expect(sha(helloWorldTurn(m, 'top-1', othersOf('top-1'), p))).toBe(recorded('p07-a/top-gather'));
  });

  /** P22's escalation, as its first turn really made it (the probe's p22-a/helper-first). */
  const ESCALATION = 'ESCALATE: done: 3 metres = 300 centimetres; left: book a meeting room for 3 pm';

  it('p22-a/helper-first', async () => {
    const p = await persona('escalation', 'helper');
    const request = helloWorldTurn(
      message({
        from: 'alice',
        to: 'helper-1',
        kind: 'input',
        text: 'Convert 3 metres to centimetres, then book a meeting room for 3 pm.',
      }),
      'helper-1',
      [],
      p,
    );
    expect(sha(request)).toBe(recorded('p22-a/helper-first'));
  });

  it('p22-b/helper-answer: the answer framed from answers, with the escalation as the question', async () => {
    const p = await persona('escalation', 'helper');
    const request = helloWorldTurn(
      message({
        from: 'alice',
        to: 'helper-1',
        kind: 'input',
        text: 'Also convert 5 metres to centimetres.',
        answers: { ask: 'm1', text: ESCALATION },
      }),
      'helper-1',
      [],
      p,
    );
    expect(sha(request)).toBe(recorded('p22-b/helper-answer'));
  });
});

// P11 (docs/plans/patterns-phase-4.md R11, A7): every probed turn of p11-a and p11-b, its first request built from the
// built teams/blackboard/ as the daemon loads it, equal to the one recorded at c797439. A turn's board is read by its
// tools in later rounds, so the first request depends only on the message.
describe("every P11 turn's first request, built from the built team folder, is the probed one (patterns-phase-4 R11, A7)", () => {
  const P11_PROBES = 'tests/fixtures/probes/patterns-phase-4-2026-10-03/probe/c797439';
  const recordedP11 = (turn: string): string =>
    present(
      (
        JSON.parse(readFileSync(join(ROOT, P11_PROBES, `${turn.replace('/', '--')}.json`), 'utf8')) as {
          readonly attempts: readonly { readonly requestSha256: string }[];
        }
      ).attempts[0],
      `${turn}: probe's attempts[0]`,
    ).requestSha256;
  const HANDLES = [
    'editor-1',
    'contrib-a-1',
    'contrib-b-1',
    'contrib-c-1',
    'planner-1',
    'note-day-1',
    'note-room-1',
    'note-time-1',
  ];
  const others = (h: string) => HANDLES.filter((x) => x !== h);
  const ASK_ITEM = 'Post your item to the blackboard.';
  const ASK_PART = 'Add your part to the notice on the blackboard.';
  const question = (from: string, to: string, text: string) =>
    message({ from, to, kind: 'internal', text, call: { id: 'call-1', role: 'question' } });
  const gather = (caller: string, input: string, answered: readonly string[], ask: string) =>
    message({
      from: 'asha',
      to: caller,
      kind: 'internal',
      text: `Answers to ${caller}'s call: ${String(answered.length)} answered.`,
      call: {
        id: 'call-1',
        role: 'gather',
        context: { from: 'alice', text: input },
        requests: answered.map((to) => ({ to, text: ask })),
        answers: answered.map((from) => ({ from, outcome: 'answered', text: 'posted' })),
      },
    });
  const turn = async (member: string, m: ConversationMessage) =>
    sha(helloWorldTurn(m, `${member}-1`, others(`${member}-1`), await persona('blackboard', member)));

  it('p11-a/editor-first', async () => {
    expect(
      await turn(
        'editor',
        message({ from: 'alice', to: 'editor-1', kind: 'input', text: 'Assemble the shopping list.' }),
      ),
    ).toBe(recordedP11('p11-a/editor-first'));
  });

  it.each(['contrib-a', 'contrib-b', 'contrib-c'])('p11-a/%s-call', async (c) => {
    expect(await turn(c, question('editor-1', `${c}-1`, ASK_ITEM))).toBe(recordedP11(`p11-a/${c}-call`));
  });

  it.each(['abc', 'acb', 'bac', 'bca', 'cab', 'cba'])(
    'p11-a/editor-gather-%s: the same gather, whatever order the board holds',
    async (order) => {
      expect(
        await turn(
          'editor',
          gather('editor-1', 'Assemble the shopping list.', ['contrib-a-1', 'contrib-b-1', 'contrib-c-1'], ASK_ITEM),
        ),
      ).toBe(recordedP11(`p11-a/editor-gather-${order}`));
    },
  );

  it('p11-b/planner-first', async () => {
    expect(
      await turn(
        'planner',
        message({ from: 'alice', to: 'planner-1', kind: 'input', text: 'Write the meeting notice.' }),
      ),
    ).toBe(recordedP11('p11-b/planner-first'));
  });

  it.each(['note-day', 'note-room', 'note-time'])('p11-b/%s-call', async (n) => {
    expect(await turn(n, question('planner-1', `${n}-1`, ASK_PART))).toBe(recordedP11(`p11-b/${n}-call`));
  });

  it.each([
    ['day', 'note-day-1'],
    ['room', 'note-room-1'],
    ['time', 'note-time-1'],
  ])('p11-b/planner-gather-%s', async (which, answered) => {
    expect(await turn('planner', gather('planner-1', 'Write the meeting notice.', [answered], ASK_PART))).toBe(
      recordedP11(`p11-b/planner-gather-${which}`),
    );
  });
});

// P20 (docs/plans/patterns-phase-5.md R17, A7): every probed turn of p20-a and p20-b, its first request built from the
// built teams/resume/ as the daemon loads it, equal to the one recorded at a9567ca. A re-sent input carries
// `redelivered`, so it is framed with the retry line; tasks.json is read by the tasker's tools in later rounds, so the
// first request depends only on the message.
describe("every P20 turn's first request, built from the built team folder, is the probed one (patterns-phase-5 R17, A7)", () => {
  const P20_PROBES = 'tests/fixtures/probes/patterns-phase-5-2026-10-03/probe/a9567ca';
  const recordedP20 = (turn: string): string =>
    present(
      (
        JSON.parse(
          readFileSync(join(ROOT, P20_PROBES, `${renumberIds(turn, numberedBefore).replace('/', '--')}.json`), 'utf8'),
        ) as {
          readonly attempts: readonly { readonly requestSha256: string }[];
        }
      ).attempts[0],
      `${turn}: probe's attempts[0]`,
    ).requestSha256;
  const HANDLES = ['supervisor-1', 'worker-1', 'tasker-1'];
  const others = (h: string) => HANDLES.filter((x) => x !== h);
  const INPUT = 'Ask worker-1 for its word and tell me.';
  const ASK = 'What is your word?';
  const resent = (to: string, text: string) =>
    message({
      from: 'alice',
      to,
      kind: 'input',
      text,
      redelivered: { savedAt: '2026-10-03T00:00:00.000Z', originalConversation: 'before', originalMessage: 'before' },
    });
  const turn = async (member: string, m: ConversationMessage) =>
    sha(helloWorldTurn(m, `${member}-1`, others(`${member}-1`), await persona('resume', member)));

  it('p20-a/supervisor-first', async () => {
    expect(await turn('supervisor', message({ from: 'alice', to: 'supervisor-1', kind: 'input', text: INPUT }))).toBe(
      recordedP20('p20-a/supervisor-first'),
    );
  });

  it('p20-a/worker-call', async () => {
    expect(
      await turn(
        'worker',
        message({
          from: 'supervisor-1',
          to: 'worker-1',
          kind: 'internal',
          text: ASK,
          call: { id: 'call-1', role: 'question' },
        }),
      ),
    ).toBe(recordedP20('p20-a/worker-call'));
  });

  it('p20-a/supervisor-gather', async () => {
    const gather = message({
      from: 'asha',
      to: 'supervisor-1',
      kind: 'internal',
      text: "Answers to supervisor-1's call.",
      call: {
        id: 'call-1',
        role: 'gather',
        context: { from: 'alice', text: INPUT },
        requests: [{ to: 'worker-1', text: ASK }],
        answers: [{ from: 'worker-1', outcome: 'answered', text: 'marigold' }],
      },
    });
    expect(await turn('supervisor', gather)).toBe(recordedP20('p20-a/supervisor-gather'));
  });

  it('p20-a/supervisor-resent: the input re-sent after the restart, framed with the retry line', async () => {
    expect(await turn('supervisor', resent('supervisor-1', INPUT))).toBe(recordedP20('p20-a/supervisor-resent'));
  });

  it.each(['1', '2'])('p20-b/tasker-task-%s', async (i) => {
    expect(await turn('tasker', message({ from: 'alice', to: 'tasker-1', kind: 'input', text: `do task ${i}` }))).toBe(
      recordedP20(`p20-b/tasker-task-${i}`),
    );
  });

  it.each(['3', '4'])('p20-b/tasker-resent-%s', async (i) => {
    expect(await turn('tasker', resent('tasker-1', `do task ${i}`))).toBe(recordedP20(`p20-b/tasker-resent-${i}`));
  });
});
