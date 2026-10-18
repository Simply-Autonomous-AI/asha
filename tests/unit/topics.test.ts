// Publish / subscribe (docs/plans/patterns-phase-3.md R20–R22, A11): a team member's `topics` in team.json, checked at
// load naming the file, the member and the rule; a user's message to a topic delivered to exactly the online members
// subscribed to it, `to` null, so each agent frames it byte for byte as a message to everyone, `channel.posted`
// logging the topic; a message with no topic reaching every member as before; a topic no online member takes refused
// UnknownTopic, nothing posted; and the CLI's topic= — never with to=.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { describeMessage } from '../../src/agent-sdk/index.js';
import { parseConversationArgs } from '../../src/cli/commands.js';
import { Channel, UnknownTopic } from '../../src/daemon/channel/index.js';
import { TeamDefinitionError, loadTeam, parseTeam } from '../../src/daemon/definitions/index.js';
import { DaemonTracer } from '../../src/daemon/traces/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import type { Delivery } from '../../src/shared/protocol.js';
import { MemoryUserLedger, RecordingLogger } from '../helpers/fakes.js';

const FILE = '/r/teams/topics/team.json';
const team = (topics: unknown) => ({
  id: 'topics',
  description: 'News desks.',
  members: [
    { name: 'weather-desk', recipe: 'weather-desk.json', topics },
    { name: 'front-page', recipe: 'front-page.json' },
  ],
});

describe("a member's topics in team.json (R20)", () => {
  it.each([[['weather']], [['weather', 'sports']], [['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']]])(
    'accepts %j, and none when absent',
    (topics) => {
      const parsed = parseTeam(team(topics), FILE, 'topics');
      expect(parsed.members.map((m) => [m.name, m.topics])).toEqual([
        ['weather-desk', topics],
        ['front-page', []],
      ]);
    },
  );

  it.each([
    ['none', []],
    ['nine', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']],
    ['a capital', ['Bad']],
    ['a number', [7]],
    ['not a list', 'weather'],
    ['a name with a dot', ['news.weather']],
  ])('refuses %s, naming the file, the member and the rule', (_, topics) => {
    expect(() => parseTeam(team(topics), FILE, 'topics')).toThrow(TeamDefinitionError);
    expect(() => parseTeam(team(topics), FILE, 'topics')).toThrow(
      `${FILE}: member "weather-desk": topics must be a list of 1 to 8 distinct topic names, each matching /^[a-z][a-z0-9-]{0,31}$/`,
    );
  });

  it('refuses a topic named twice, naming it', () => {
    expect(() => parseTeam(team(['weather', 'weather']), FILE, 'topics')).toThrow(
      `member "weather-desk": topics must be a list of 1 to 8 distinct topic names, each matching /^[a-z][a-z0-9-]{0,31}$/: "weather" is named twice`,
    );
  });

  it("loads them with the team, each member's its own", async () => {
    const root = await mkdtemp(join(tmpdir(), 'asha-topics-'));
    const dir = join(root, 'topics');
    await mkdir(dir, { recursive: true });
    const recipe = (id: string) =>
      JSON.stringify({
        id,
        image: 'hello-world',
        description: 'x',
        prompt: 'x',
        model: 'm',
        startupTimeoutMs: 1,
        messageTimeoutMs: 1,
        chat: {},
        tools: [],
      });
    await writeFile(join(dir, 'team.json'), JSON.stringify(team(['weather'])));
    await writeFile(join(dir, 'weather-desk.json'), recipe('weather-desk'));
    await writeFile(join(dir, 'front-page.json'), recipe('front-page'));
    expect((await loadTeam(root, 'topics')).members.map((m) => [m.name, m.topics])).toEqual([
      ['weather-desk', ['weather']],
      ['front-page', []],
    ]);
  });
});

function channel() {
  const logger = new RecordingLogger();
  let n = 0;
  const c = new Channel({
    name: 'main',
    logger,
    clock: () => new Date('2026-10-02T00:00:00Z'),
    newId: () => `id${String(++n)}`,
    onDeliveryTimeout: () => undefined,
    maxAgentPostsPerConversation: 32,
    users: new MemoryUserLedger(),
    tracer: new DaemonTracer({
      clock: () => new Date('2026-10-02T00:00:00Z'),
      newSpanId: () => (++n).toString(16).padStart(16, '0'),
      record: () => undefined,
    }),
  });
  const inbox = new Map<string, Delivery[]>();
  const join_ = (base: string, topics?: readonly string[]) => {
    const handle = `${base}-1`;
    c.join(base, {
      deliver: (d) => inbox.set(handle, [...(inbox.get(handle) ?? []), d]),
      deliveryTimeoutMs: 60_000,
      ...(topics === undefined ? {} : { topics }),
    });
  };
  join_('weather-desk', ['weather']);
  join_('sports-desk', ['sports']);
  join_('front-page', ['weather', 'sports']);
  join_('other');
  const user = c.claimUser('alice');
  return { c, logger, inbox, user };
}

describe("a user's message to a topic (R21, R22)", () => {
  it.each([
    ['weather', ['front-page-1', 'weather-desk-1']],
    ['sports', ['front-page-1', 'sports-desk-1']],
  ])('topic %s reaches exactly its subscribers, to null, carrying the topic, logged with it', (topic, subscribers) => {
    const { c, logger, inbox, user } = channel();
    const message = c.postToConversation({ from: user.id, kind: 'input', text: 'Rain expected tomorrow.', topic });
    expect(message).toMatchObject({ to: null, topic, kind: 'input' });
    expect([...inbox.keys()].sort(byCodeUnit)).toEqual(subscribers);
    expect(c.working(message.conversation)).toEqual(subscribers);
    expect(logger.entries.filter((e) => e.event === 'channel.posted').map((e) => e.fields)).toEqual([
      {
        channel: 'main',
        id: message.id,
        conversation: message.conversation,
        from: 'alice',
        to: null,
        kind: 'input',
        length: 23,
        topic,
      },
    ]);
  });

  it("frames a topic's message byte for byte as a message to everyone: the topic changes nothing a model sees", () => {
    const { c, inbox, user } = channel();
    c.postToConversation({ from: user.id, kind: 'input', text: 'Rain expected tomorrow.', topic: 'weather' });
    const withTopic = present(
      present(inbox.get('weather-desk-1'), "inbox.get('weather-desk-1')")[0],
      'deliveries[0]',
    ).message;
    // A copy with no topic (the field is optional; every consumer below reads it by value, never by key
    // presence), to prove the topic changes nothing a model sees.
    const toEveryone = { ...withTopic, topic: undefined };
    expect(describeMessage(withTopic, 'weather-desk-1')).toBe(describeMessage(toEveryone, 'weather-desk-1'));
    expect(describeMessage(withTopic, 'weather-desk-1')).toBe('The user wrote:\nRain expected tomorrow.');
  });

  it('a message with no topic reaches every member, as before', () => {
    const { c, inbox, user } = channel();
    const message = c.postToConversation({ from: user.id, kind: 'input', text: 'Hello.' });
    expect([...inbox.keys()].sort(byCodeUnit)).toEqual(['front-page-1', 'other-1', 'sports-desk-1', 'weather-desk-1']);
    expect(message.topic).toBeUndefined();
  });

  it('refuses a topic no online member subscribes to, posting nothing (R22)', () => {
    const { c, logger, inbox, user } = channel();
    expect(() => c.postToConversation({ from: user.id, kind: 'input', text: 'x', topic: 'finance' })).toThrow(
      UnknownTopic,
    );
    expect(() => c.postToConversation({ from: user.id, kind: 'input', text: 'x', topic: 'finance' })).toThrow(
      'no agent on channel "main" subscribes to topic "finance"',
    );
    expect(inbox.size).toBe(0);
    expect(logger.entries.filter((e) => e.event === 'channel.posted')).toEqual([]);
  });

  it("a topic is only a user's input's, and never with to", () => {
    const { c, user } = channel();
    expect(() =>
      c.postToConversation({ from: user.id, kind: 'input', text: 'x', topic: 'weather', to: 'front-page-1' }),
    ).toThrow("only a user's input to no one agent carries a topic");
  });

  it('the CLI reads topic=, and refuses it beside to= or as no topic name', () => {
    expect(parseConversationArgs(['topic=weather', 'user=alice', 'message=Rain.'])).toEqual({
      user: 'alice',
      channel: 'main',
      topic: 'weather',
      message: 'Rain.',
    });
    expect(parseConversationArgs(['topic=weather', 'to=front-page-1', 'message=x'])).toBe(
      'topic= and to= cannot be given together: a message goes to a topic or to one agent',
    );
    expect(parseConversationArgs(['topic=Bad', 'message=x'])).toBe(
      'topic= must be a topic name (/^[a-z][a-z0-9-]{0,31}$/), not Bad',
    );
  });
});
