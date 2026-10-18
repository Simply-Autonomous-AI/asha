// The launch stream's follower of re-sent conversations (docs/plans/agent-persistence.md R9 (i); A8 test 11): events
// held until `launched`, then `resending`, the held events in order and `settled`; live after that; a hang-up (the
// route's stream ending calls close) drops every watch and settled-callback; held events past the stream's unwritten
// bound end it with `slow_reader`, logged at error (the completion review, finding 6).

import { describe, expect, it } from 'vitest';

import type { Channel } from '../../src/daemon/channel/index.js';
import { ResentFollower, type ControlStream, type StreamError } from '../../src/daemon/server.js';
import { present } from '../../src/shared/assert-present.js';
import type { ConversationEvent, ConversationMessage, LaunchEvent } from '../../src/shared/protocol.js';
import { SSE_MAX_UNWRITTEN_BYTES } from '../../src/shared/sse.js';
import { RecordingLogger } from '../helpers/fakes.js';

/** A channel whose watches and settled-callbacks the test fires, counting how many are live. */
function fakeChannel() {
  const watchers = new Map<string, Set<(e: ConversationEvent) => void>>();
  const settled = new Map<string, Set<() => void>>();
  const add = <T>(map: Map<string, Set<T>>, key: string, value: T) => {
    const set = map.get(key) ?? new Set<T>();
    map.set(key, set);
    set.add(value);
    return () => {
      set.delete(value);
    };
  };
  return {
    channel: {
      watch: (c: string, w: (e: ConversationEvent) => void) => add(watchers, c, w),
      whenSettled: (c: string, cb: () => void) => add(settled, c, cb),
    } as unknown as Channel,
    emit: (c: string, e: ConversationEvent) => {
      [...(watchers.get(c) ?? [])].forEach((w) => {
        w(e);
      });
    },
    settle: (c: string) => {
      [...(settled.get(c) ?? [])].forEach((cb) => {
        cb();
      });
    },
    live: () => [...watchers.values(), ...settled.values()].reduce((n, s) => n + s.size, 0),
  };
}

function fakeStream() {
  const written: (LaunchEvent | StreamError)[] = [];
  let ended = false;
  const stream: ControlStream<LaunchEvent | StreamError> = {
    write: (e) => {
      if (!ended) written.push(e);
    },
    end: () => {
      ended = true;
    },
    ended: () => ended,
  };
  return { stream, written, isEnded: () => ended };
}

const reply = (conversation: string, text: string): ConversationEvent => ({
  type: 'message',
  message: {
    id: `m-${String(text.length)}`,
    conversation,
    from: 'keep-1',
    to: 'ivy',
    kind: 'output',
    text,
    at: '2026-09-29T10:00:00.000Z',
    user: 'ivy',
  } as unknown as ConversationMessage,
  working: [],
});

describe('ResentFollower', () => {
  it("holds a re-sent conversation's events until launched, then writes resending, them in order, and settled; ends when all settle", async () => {
    const c = fakeChannel();
    const s = fakeStream();
    const follower = new ResentFollower(c.channel, s.stream, new RecordingLogger());
    follower.add('c1', '2026-09-28T09:00:00.000Z');
    c.emit('c1', reply('c1', 'one'));
    c.settle('c1');
    expect(s.written).toEqual([]);
    follower.go();
    expect(s.written.map((e) => e.type)).toEqual(['resending', 'message', 'settled']);
    await follower.done;
    expect(c.live()).toBe(0);
  });

  it('writes a conversation joined after launched live, and waits for every one to settle', async () => {
    const c = fakeChannel();
    const s = fakeStream();
    const follower = new ResentFollower(c.channel, s.stream, new RecordingLogger());
    follower.add('c1', 'a');
    follower.go();
    follower.add('c2', 'b');
    c.settle('c1');
    let done = false;
    void follower.done.then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    c.emit('c2', reply('c2', 'two'));
    c.settle('c2');
    await follower.done;
    expect(
      s.written.map((e) => (e.type === 'resending' || e.type === 'settled' ? `${e.type} ${e.conversation}` : e.type)),
    ).toEqual(['resending c1', 'resending c2', 'settled c1', 'message', 'settled c2']);
  });

  it('a hang-up (close) drops every watch and settled-callback, and later events write nothing', async () => {
    const c = fakeChannel();
    const s = fakeStream();
    const follower = new ResentFollower(c.channel, s.stream, new RecordingLogger());
    follower.add('c1', 'a');
    follower.add('c2', 'b');
    follower.go();
    expect(c.live()).toBe(4);
    follower.close();
    await follower.done;
    expect(c.live()).toBe(0);
    const before = s.written.length;
    c.emit('c1', reply('c1', 'late'));
    expect(s.written).toHaveLength(before);
  });

  it('held events past the unwritten bound end the stream with slow_reader, logged at error with no user text', () => {
    const c = fakeChannel();
    const s = fakeStream();
    const logger = new RecordingLogger();
    const follower = new ResentFollower(c.channel, s.stream, logger);
    follower.add('c1', 'a');
    const big = 'zora '.repeat(Math.ceil(SSE_MAX_UNWRITTEN_BYTES / 5));
    c.emit('c1', reply('c1', big));
    expect(s.written).toEqual([
      {
        type: 'error',
        reason: 'slow_reader',
        detail: `the stream held more than ${String(SSE_MAX_UNWRITTEN_BYTES)} bytes of re-sent conversations' events before its launch ended, and was ended`,
      },
    ]);
    expect(s.isEnded()).toBe(true);
    expect(logger.entries.map((e) => [e.level, e.event, e.fields['route']])).toEqual([
      ['error', 'stream.slow_reader', '/v1/agents'],
    ]);
    const entry = present(logger.entries[0], 'logger.entries[0]');
    expect(
      JSON.stringify({
        ...entry.fields,
        error: (entry.fields['error'] as Error).message,
      }),
    ).not.toContain('zora');
  });
});
