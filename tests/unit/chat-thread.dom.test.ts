// The Watch view's chat thread (src/portal/chat-thread.ts; docs/plans/portal-scene-chat.md R8, demo-scene-refresh R7,
// R14, R16), against a fake DOM (tests/helpers/fake-dom.ts): each message's bubble or note by its row — its classes,
// its sender and addressee, a call's label, its time, its text and files — the consult-refused words, the agent-offline
// mark on a failure status and on no other, the `is writing…` lines kept last, and the scroll that follows the newest
// entry unless the user has scrolled up more than FOLLOW_WITHIN_PX.

import { describe, expect, it } from 'vitest';

import { ChatThread, consultRefusedWords, FOLLOW_WITHIN_PX } from '../../src/portal/chat-thread.js';
import type { ConversationMessage, PresenceMessage } from '../../src/shared/protocol.js';
import { asElement, FakeDocument, type FakeElement } from '../helpers/fake-dom.js';

const AT = '2026-10-16T12:34:56.789Z';

/** A conversation message from `alice`, for everyone, an output, unless `fields` say otherwise. */
const said = (fields: Partial<ConversationMessage> = {}): ConversationMessage => ({
  id: 'm1',
  channel: 'c',
  from: 'alice',
  to: null,
  kind: 'output',
  text: 'hello',
  at: AT,
  conversation: 'conv-1',
  user: 'user',
  ...fields,
});

/** A presence status of `from`'s, outside any conversation. */
const presence = (from: string, text: string, failure?: true): PresenceMessage => ({
  id: 'p1',
  channel: 'c',
  from,
  to: null,
  kind: 'status',
  text,
  at: AT,
  conversation: null,
  ...(failure === undefined ? {} : { failure }),
});

/** A thread in a fresh fake document, its root, and the root's entries but the writing lines. */
function thread(): { readonly chat: ChatThread; readonly root: FakeElement; readonly entries: () => FakeElement[] } {
  const doc = new FakeDocument();
  const root = doc.createElement('div');
  const chat = new ChatThread(doc.asDocument(), asElement(root));
  return { chat, root, entries: () => root.children.filter((c) => c.className !== 'writing-lines') };
}

/** An entry as one line: its tag and class, then each child's tag, class and text, as a reader of the page sees it. */
function shown(entry: FakeElement): string {
  const parts = entry.descendants().map((d) => {
    const cls = d.className === '' ? '' : `.${d.className.split(' ').join('.')}`;
    return d.children.length > 0
      ? `${d.tagName.toLowerCase()}${cls}`
      : `${d.tagName.toLowerCase()}${cls}"${d.textContent}"`;
  });
  return [`${entry.tagName.toLowerCase()}.${entry.className.split(' ').join('.')}`, ...parts].join(' ');
}

describe('the chat thread (portal-scene-chat R8)', () => {
  it('starts with its writing lines alone, not announced; clear() leaves them alone and empty', () => {
    const { chat, root } = thread();
    expect(root.children.map((c) => [c.className, c.getAttribute('aria-live')])).toEqual([['writing-lines', 'off']]);
    chat.joined('alice');
    chat.setWriting(['alice']);
    chat.clear();
    expect(root.children.map((c) => [c.className, c.children.length])).toEqual([['writing-lines', 0]]);
  });

  it('notes an agent joining and leaving, and does nothing for watching, a delta, done or an error', () => {
    const { chat, root, entries } = thread();
    chat.watching();
    chat.delta();
    chat.done();
    chat.error();
    expect(root.children).toHaveLength(1);
    chat.joined('alice');
    chat.left('bob');
    expect(entries().map(shown)).toEqual(['div.note p"alice joined"', 'div.note p"bob left"']);
  });

  it("shows a user's message on the right and an agent's on the left, by kind, with sender, addressee, time and text", () => {
    const { chat, entries } = thread();
    chat.message(said({ from: 'user', kind: 'input', to: 'alice', text: 'Please say hi.' }));
    chat.message(said({ kind: 'internal', to: 'bob' }));
    chat.message(said({ kind: 'output', topic: 'plans' }));
    expect(entries().map(shown)).toEqual([
      'article.chat-msg.from-user header span.who"user → alice" time"12:34:56Z" p.text"Please say hi."',
      'article.chat-msg.from-agent.kind-internal header span.who"alice → bob" time"12:34:56Z" p.text"hello"',
      'article.chat-msg.from-agent.kind-output header span.who"alice → topic plans" time"12:34:56Z" p.text"hello"',
    ]);
    const first = entries()[0];
    expect([
      first?.getAttribute('data-from'),
      first
        ?.descendants()
        .find((d) => d.tagName === 'TIME')
        ?.getAttribute('datetime'),
    ]).toEqual(['user', AT]);
  });

  it("labels a call's question 'asks' and its answer 'answers', and lists a message's files, one line each", () => {
    const { chat, entries } = thread();
    chat.message(said({ kind: 'internal', to: 'bob', call: { id: 'k1', role: 'question' } }));
    chat.message(said({ from: 'bob', kind: 'internal', call: { id: 'k1', role: 'answer', outcome: 'answered' } }));
    chat.message(said({ files: [{ id: 'f1', name: 'notes.md', size: 12, sha256: 'ab' }] }));
    expect(entries().map(shown)).toEqual([
      'article.chat-msg.from-agent.kind-internal.call-question header span.who"alice → bob" span.chat-label"asks" time"12:34:56Z" p.text"hello"',
      'article.chat-msg.from-agent.kind-internal.call-answer header span.who"bob → everyone" span.chat-label"answers" time"12:34:56Z" p.text"hello"',
      'article.chat-msg.from-agent.kind-output header span.who"alice → everyone" time"12:34:56Z" p.text"hello" p.file-line"  file notes.md (12 bytes, sha256 ab)"',
    ]);
  });

  it("shows an agent's presence status as its bubble, marked agent-offline when the harness marks it a failure, and only then", () => {
    const { chat, entries } = thread();
    chat.message(presence('alice', 'Hi'));
    chat.message(presence('alice', 'system failure — offline', true));
    expect(entries().map((e) => e.className)).toEqual([
      'chat-msg from-agent kind-status',
      'chat-msg from-agent kind-status agent-offline',
    ]);
    expect(entries().map((e) => e.descendants().at(-1)?.textContent)).toEqual(['Hi', 'system failure — offline']);
  });

  it("notes a status within a conversation, and the harness's, as `<from>: <text>`", () => {
    const { chat, entries } = thread();
    chat.message(said({ kind: 'status', text: 'thinking' }));
    chat.message(presence('asha', 'restart 1 failed: it did not come online in time', true));
    expect(entries().map(shown)).toEqual([
      'div.note p"alice: thinking"',
      'div.note p"asha: restart 1 failed: it did not come online in time"',
    ]);
  });

  it("says an agent's refused consult in words, as a warning; an unknown reason, or the harness's, is a plain status", () => {
    const { chat, entries } = thread();
    chat.message(said({ kind: 'status', text: 'consult refused: nested_call' }));
    chat.message(said({ kind: 'status', text: 'consult refused: constructor' }));
    chat.message(said({ from: 'asha', kind: 'status', text: 'consult refused: nested_call' }));
    expect(entries().map(shown)).toEqual([
      'div.note.warning p"alice could not ask: a call here may not open another call (consult refused: nested_call)"',
      'div.note p"alice: consult refused: constructor"',
      'div.note p"asha: consult refused: nested_call"',
    ]);
  });

  it("gives every reason's words, and none for another status, a reason with none, or the table's inherited keys", () => {
    expect(consultRefusedWords('a', 'consult refused: self_addressed')).toBe(
      'a could not ask: it asked itself (consult refused: self_addressed)',
    );
    expect(consultRefusedWords('a', 'consult refused: post_budget')).toBe(
      'a could not ask: this conversation has used up its posts budget (32 agent posts unless the message set Posts budget; each agent asked takes 2) (consult refused: post_budget)',
    );
    for (const text of [
      'thinking',
      'consult refused:',
      'consult refused: toString',
      'consult refused: a b',
      'consult refused: nope',
    ])
      expect(consultRefusedWords('a', text), text).toBeUndefined();
  });

  it("notes the harness's gather with each addressee's outcome, and its other words to an agent or to everyone", () => {
    const { chat, entries } = thread();
    chat.message(
      said({
        from: 'asha',
        kind: 'internal',
        to: 'alice',
        call: {
          id: 'k1',
          role: 'gather',
          context: { from: 'user', text: 'q' },
          requests: [
            { to: 'bob', text: 'q1' },
            { to: 'carol', text: 'q2' },
            { to: 'dave', text: 'q3' },
          ],
          answers: [
            { from: 'bob', outcome: 'answered', text: 'yes' },
            { from: 'carol', outcome: 'passed', reason: 'not mine' },
          ],
        },
      }),
    );
    chat.message(said({ from: 'asha', kind: 'internal', to: 'bob', text: 'your answer is due' }));
    chat.message(said({ from: 'asha', kind: 'output', to: 'user', text: 'the conversation ended' }));
    chat.message(said({ from: 'asha', kind: 'internal', to: null, text: 'to everyone' }));
    expect(entries().map(shown)).toEqual([
      'div.note.gather p"collected 2/3 answers" p.note-line"bob: yes" p.note-line"carol: passed: not mine"',
      'div.note p"asha → bob: your answer is due"',
      'div.note p"asha: the conversation ended"',
      'div.note p"asha: to everyone"',
    ]);
  });

  it('notes a failure or a warning by its kind, its lines under it', () => {
    const { chat, entries } = thread();
    chat.note('the watch stopped', ['one', 'two'], 'failure');
    expect(entries().map(shown)).toEqual(['div.note.failure p"the watch stopped" p.note-line"one" p.note-line"two"']);
  });

  it('keeps one `is writing…` line per amber agent, always last, and leaves them be when the list is the same', () => {
    const { chat, root } = thread();
    chat.setWriting(['alice', 'bob']);
    chat.joined('carol');
    const lines = root.children.at(-1);
    expect(lines?.children.map((c) => [c.getAttribute('data-handle'), c.textContent])).toEqual([
      ['alice', 'alice is writing…'],
      ['bob', 'bob is writing…'],
    ]);
    expect(root.children.map((c) => c.className)).toEqual(['note', 'writing-lines']);
    const before = lines?.children;
    chat.setWriting(['alice', 'bob']);
    expect(lines?.children).toEqual(before);
    expect(lines?.children[0]).toBe(before?.[0]);
    chat.setWriting([]);
    expect(lines?.children).toEqual([]);
  });

  it(`follows the newest entry when the user is within ${String(FOLLOW_WITHIN_PX)} px of the end, and not when further up`, () => {
    const { chat, root } = thread();
    Object.assign(root, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 - FOLLOW_WITHIN_PX });
    chat.joined('a');
    expect(root.scrollTop).toBe(1_000);
    Object.assign(root, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 - FOLLOW_WITHIN_PX - 1 });
    chat.joined('b');
    expect(root.scrollTop).toBe(600 - FOLLOW_WITHIN_PX - 1);
    Object.assign(root, { scrollHeight: 1_000, clientHeight: 400, scrollTop: 600 });
    chat.setWriting(['a']);
    expect(root.scrollTop).toBe(1_000);
  });
});
