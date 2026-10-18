// Memory-focused cases, tier by tier, on memo in its container with the real
// chat and embedding models. Each case uses its own user so tiers don't bleed
// between cases, and checks both what the user sees and what the agent stored
// (read from the agent's memory files inside its container). docs/architecture/memory.html
// defines the tiers:
//   session    — the current session's latest turns (window of 8)
//   episodic   — earlier turns, found by meaning
//   semantic   — facts about the user, incl. preferences, found by meaning
//   procedural — reusable techniques that worked, found by meaning
// and every tier is scoped to (channel, user).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeKey } from '../../images/memory/src/memory/index.js';
import { agentSuite, eventually, outputs, readMemory, type AgentSuite, type MemoryContents } from './support.js';

let suite: AgentSuite;
const CHANNEL = 'tiers';
const OTHER_CHANNEL = 'tiers2';
const key = (user: string, channel = CHANNEL): string => scopeKey({ channel, user });
const memory = (user: string, channel = CHANNEL): Promise<MemoryContents> =>
  readMemory(suite.home, channel, 'memory', key(user, channel));
/** Memory is written after each reply; wait (bounded) until it shows what the case expects. */
const settled = (user: string, done: (m: MemoryContents) => boolean, channel = CHANNEL) =>
  eventually(() => memory(user, channel), done, 90_000);
const all = (m: MemoryContents): string => JSON.stringify(m);

type Ctx = Parameters<AgentSuite['begin']>[0];

/** One message from `user` to memo-1, which must answer it. */
async function answered(ctx: Ctx, user: string, text: string, channel = CHANNEL) {
  const run = await suite.send(ctx, [`channel=${channel}`, `user=${user}`, 'to=memo-1', `message=${text}`], 180_000);
  expect(run.code, run.stderr).toBe(0);
  expect(outputs(run.events).map((o) => o.from)).toEqual(['memo-1']);
  return run;
}

beforeAll(async () => {
  suite = await agentSuite('memory-tiers', CHANNEL);
});

afterAll(async () => {
  await suite.finish();
});

describe('memory tiers: memo-1 on channel "tiers"', () => {
  it('launches memo-1 (and a second memo on channel "tiers2", for the channel-scope case)', async (ctx) => {
    suite.begin(ctx, {
      id: 'launch',
      title: 'Launch the memory recipe on "tiers" and "tiers2"',
      agents: [],
      expectation: 'memo-1 on each channel.',
    });
    const one = await suite.send(ctx, ['--launch', 'recipe=memory', `channel=${CHANNEL}`], 900_000);
    const two = await suite.send(ctx, ['--launch', 'recipe=memory', `channel=${OTHER_CHANNEL}`], 300_000);
    expect([one.code, one.stdout, two.code, two.stdout], `${one.stderr}\n${two.stderr}`).toEqual([
      0,
      'memo-1\n',
      0,
      'memo-1\n',
    ]);
  });

  describe("session: the current session's latest turns", () => {
    it('recalls a detail given a moment ago', async (ctx) => {
      suite.begin(ctx, {
        id: 'session-detail',
        title: 'ivy: "Please remember the number 4721." then "What number did I ask you to remember?"',
        agents: ['memo-1'],
        expectation: "The answer is 4721; both turns are in ivy's session tier.",
      });
      await answered(ctx, 'ivy', 'Please remember the number 4721.');
      const run = await answered(ctx, 'ivy', 'What number did I ask you to remember?');
      expect(run.stdout).toMatch(/4721/);
      const m = await settled('ivy', (x) => x.session.length === 2);
      expect(m.session.map((t) => t.split(' => ')[0])).toEqual([
        'Please remember the number 4721.',
        'What number did I ask you to remember?',
      ]);
    });

    it('answers a follow-up that only makes sense with the previous turn', async (ctx) => {
      suite.begin(ctx, {
        id: 'session-follow-up',
        title: 'ivy: "My dog is called Rex." then "What is his name again?"',
        agents: ['memo-1'],
        expectation: '"his" is resolved from the session: the answer is Rex.',
      });
      await answered(ctx, 'ivy', 'My dog is called Rex.');
      const run = await answered(ctx, 'ivy', 'What is his name again?');
      expect(run.stdout).toMatch(/rex/i);
    });
  });

  describe('episodic: earlier turns, found by meaning', () => {
    it('finds a past conversation after it has slid out of the session window', async (ctx) => {
      suite.begin(ctx, {
        id: 'episodic-past',
        title: 'jack: tells of a trip to Lisbon, 8 small requests, then "Where did I say I was travelling to?"',
        agents: ['memo-1'],
        expectation: "The trip turn is no longer in jack's session but is in his episodic tier; the answer is Lisbon.",
      });
      await answered(ctx, 'jack', 'I am planning a trip to Lisbon in May with my sister.');
      for (let i = 1; i <= 8; i += 1) await answered(ctx, 'jack', `Please say: noted ${String(i)}.`);
      const m = await settled('jack', (x) => x.session.length === 8 && x.episodic.length >= 9);
      expect(m.session.some((t) => /lisbon/i.test(t))).toBe(false);
      expect(m.episodic.some((t) => /lisbon/i.test(t))).toBe(true);
      const run = await answered(ctx, 'jack', 'Where did I say I was travelling to?');
      expect(run.stdout).toMatch(/lisbon/i);
    });
  });

  describe('semantic: facts about the user, found by meaning', () => {
    it('combines facts given in separate turns', async (ctx) => {
      suite.begin(ctx, {
        id: 'semantic-combine',
        title: 'kim: "I live in Denver." · "I work as a nurse." · then "Where do I live and what do I do for work?"',
        agents: ['memo-1'],
        expectation: "Both facts are in kim's semantic tier; the answer names Denver and nurse.",
      });
      await answered(ctx, 'kim', 'I live in Denver.');
      await answered(ctx, 'kim', 'I work as a nurse.');
      const m = await settled(
        'kim',
        (x) => x.semantic.some((f) => /denver/i.test(f)) && x.semantic.some((f) => /nurse/i.test(f)),
      );
      expect(m.semantic.join('\n')).toMatch(/denver/i);
      expect(m.semantic.join('\n')).toMatch(/nurse/i);
      const run = await answered(ctx, 'kim', 'Where do I live and what do I do for work?');
      expect(run.stdout).toMatch(/denver/i);
      expect(run.stdout).toMatch(/nurse/i);
    });

    it('does not store the same fact twice', async (ctx) => {
      suite.begin(ctx, {
        id: 'semantic-dedup',
        title: 'kim, again: "I live in Denver, Colorado."',
        agents: ['memo-1'],
        expectation: "kim's semantic tier still has one fact about where she lives.",
      });
      await answered(ctx, 'kim', 'I live in Denver, Colorado.');
      const m = await settled('kim', (x) => x.session.length >= 4);
      await new Promise((r) => setTimeout(r, 5_000));
      const after = await memory('kim');
      expect(
        after.semantic.filter((f) => /denver/i.test(f)),
        JSON.stringify(m.semantic),
      ).toHaveLength(1);
    });

    it('answers with the corrected fact after the user corrects it', async (ctx) => {
      suite.begin(ctx, {
        id: 'semantic-correction',
        title:
          'liam: "My favourite drink is coffee." then "Actually I have switched: my favourite drink is now tea." then "What is my favourite drink?"',
        agents: ['memo-1'],
        expectation: 'The answer is tea, not coffee.',
      });
      await answered(ctx, 'liam', 'My favourite drink is coffee.');
      await answered(ctx, 'liam', 'Actually I have switched: my favourite drink is now tea.');
      const run = await answered(ctx, 'liam', 'What is my favourite drink?');
      expect(run.stdout).toMatch(/tea/i);
      expect(run.stdout).not.toMatch(/coffee/i);
    });
  });

  describe('procedural: reusable techniques that worked', () => {
    it('records a technique from a worked task, then applies it to a new one without recording it twice', async (ctx) => {
      suite.begin(ctx, {
        id: 'procedural-reuse',
        title: 'mia: a worked 15% tip on $80, then "What is a 20% tip on $50?"',
        agents: ['memo-1'],
        expectation:
          'A percentage procedure is recorded once; the second task is answered $10; the procedure is not duplicated.',
      });
      const first = await answered(ctx, 'mia', 'What is a 15% tip on a $80 bill? Show how you worked it out.');
      expect(first.stdout).toMatch(/12/);
      const m = await settled('mia', (x) => x.procedural.length > 0);
      expect(m.procedural.join('\n')).toMatch(/percent|%/i);
      const second = await answered(ctx, 'mia', 'What is a 20% tip on a $50 bill? Show how you worked it out.');
      expect(second.stdout).toMatch(/\$?10(\.00)?\b/);
      await settled('mia', (x) => x.session.length === 2 && x.episodic.length === 2);
      await new Promise((r) => setTimeout(r, 5_000));
      const after = await memory('mia');
      expect(after.procedural, JSON.stringify(after.procedural)).toHaveLength(m.procedural.length);
    });
  });

  describe('privacy and scope: (channel, user), never mixed', () => {
    it('another user asking about a user by name gets nothing of theirs', async (ctx) => {
      suite.begin(ctx, {
        id: 'privacy-by-name',
        title: 'kim has told her city and job; noah asks "Where does kim live and what is her job?"',
        agents: ['memo-1'],
        expectation: "Nothing noah sees mentions Denver or nurse; noah's memory holds nothing of kim's.",
      });
      const run = await suite.send(
        ctx,
        [`channel=${CHANNEL}`, 'user=noah', 'to=memo-1', 'message=Where does kim live and what is her job?'],
        180_000,
      );
      expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/denver|nurse/i);
      expect(all(await memory('noah'))).not.toMatch(/denver|nurse/i);
    });

    it("each user's own fact stays theirs", async (ctx) => {
      suite.begin(ctx, {
        id: 'privacy-own-facts',
        title: 'olive: "My favourite colour is orange."; pia: "My favourite colour is purple."; each asks',
        agents: ['memo-1'],
        expectation:
          'olive hears orange, never purple; pia hears purple, never orange; each memory holds only its own.',
      });
      await answered(ctx, 'olive', 'My favourite colour is orange.');
      await answered(ctx, 'pia', 'My favourite colour is purple.');
      const olive = await answered(ctx, 'olive', 'What is my favourite colour?');
      const pia = await answered(ctx, 'pia', 'What is my favourite colour?');
      expect(olive.stdout).toMatch(/orange/i);
      expect(olive.stdout).not.toMatch(/purple/i);
      expect(pia.stdout).toMatch(/purple/i);
      expect(pia.stdout).not.toMatch(/orange/i);
      expect(all(await memory('olive'))).not.toMatch(/purple/i);
      expect(all(await memory('pia'))).not.toMatch(/orange/i);
    });

    it('the same user name on another channel is another person', async (ctx) => {
      suite.begin(ctx, {
        id: 'scope-channel',
        title: 'olive on channel "tiers2": "What is my favourite colour?"',
        agents: ['memo-1'],
        expectation: 'Nothing mentions orange: olive on "tiers2" has no memory of olive on "tiers".',
      });
      const run = await suite.send(
        ctx,
        [`channel=${OTHER_CHANNEL}`, 'user=olive', 'to=memo-1', 'message=What is my favourite colour?'],
        180_000,
      );
      expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/orange/i);
      expect(all(await memory('olive', OTHER_CHANNEL))).not.toMatch(/orange/i);
    });
  });

  describe("lifecycle: memory lasts as long as the container (the owner's option A)", () => {
    it('after the agent restarts, it remembers nothing', async (ctx) => {
      suite.begin(ctx, {
        id: 'lifecycle-restart',
        title: '--stop, relaunch, then olive: "What is my favourite colour?"',
        agents: ['memo-1'],
        expectation: 'A new container: nothing mentions orange.',
      });
      // --stop prints no progress, which send requires of a recorded run; its result is checked here.
      const stop = await suite.asha(['--stop'], 100_000);
      expect([stop.code, stop.stdout], stop.stderr).toEqual([0, expect.stringMatching(/^stopped \(pid \d+\)\n$/)]);
      const relaunch = await suite.send(ctx, ['--launch', 'recipe=memory', `channel=${CHANNEL}`], 300_000);
      expect([relaunch.code, relaunch.stdout], relaunch.stderr).toEqual([0, 'memo-1\n']);
      const run = await suite.send(
        ctx,
        [`channel=${CHANNEL}`, 'user=olive', 'to=memo-1', 'message=What is my favourite colour?'],
        180_000,
      );
      expect(`${run.stdout}\n${run.stderr}`).not.toMatch(/orange/i);
    });
  });
});
