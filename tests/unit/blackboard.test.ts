// One channel's blackboard (docs/plans/agent-tools.md R10), directly: a read's JSON — what enters an agent's
// context — is at most 8 KiB, and an entry is refused unless a read of it alone fits (completion review finding 4).

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { Blackboard } from '../../src/daemon/blackboard/index.js';
import { RecordingLogger } from '../helpers/fakes.js';

const board = () =>
  new Blackboard({ channel: 'lab', clock: () => new Date('2026-09-27T00:00:00.000Z'), logger: new RecordingLogger() });
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

describe('Blackboard', () => {
  it('reads 256 one-character entries in parts of at most 8 KiB of JSON, counting the framing, not the text', () => {
    const b = board();
    for (let i = 0; i < 256; i++) expect(b.post('hewo-1', 'x').ok).toBe(true);
    const pages = [b.read(0)];
    while (present(pages.at(-1), 'last page').more) {
      const entries = present(pages.at(-1), 'last page').entries;
      pages.push(b.read(present(entries.at(-1), 'last entry of last page').id));
    }
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(bytes(page)).toBeLessThanOrEqual(8192);
    expect(pages.flatMap((p) => p.entries.map((e) => e.id))).toEqual(Array.from({ length: 256 }, (_, i) => i + 1));
  });

  it('refuses entry_too_large an entry whose read alone would pass 8 KiB of JSON — escapes counted — and stores the largest that fits', () => {
    const b = board();
    expect(b.post('hewo-1', '\u0001'.repeat(2000))).toEqual({ ok: false, reason: 'entry_too_large' }); // 2,000 bytes of text, 12,000 of JSON
    expect(b.post('hewo-1', 'x'.repeat(8192))).toEqual({ ok: false, reason: 'entry_too_large' });
    let n = 8192;
    while (!b.post('hewo-1', 'y'.repeat(n)).ok) n -= 1;
    const read = b.read(0);
    expect(read.entries.map((e) => e.text.length)).toEqual([n]);
    expect(bytes(read)).toBeLessThanOrEqual(8192);
    expect(
      bytes({ ...read, entries: [{ ...present(read.entries[0], 'read.entries[0]'), text: 'y'.repeat(n + 1) }] }),
    ).toBeGreaterThan(8192);
  });
});

describe('Blackboard sessions and a resumed board (docs/plans/agent-persistence.md R14, A12)', () => {
  it('a new board is session 1, and every entry carries it', () => {
    const b = board();
    const posted = b.post('hewo-1', 'x');
    expect(posted).toEqual({
      ok: true,
      entry: { id: 1, author: 'hewo-1', ts: '2026-09-27T00:00:00.000Z', text: 'x', session: 1 },
    });
    expect(b.snapshot()).toEqual({
      session: 1,
      entries: [{ id: 1, author: 'hewo-1', ts: '2026-09-27T00:00:00.000Z', text: 'x', session: 1 }],
    });
  });

  it('a resumed board keeps its entries with their ids and sessions, continues the ids from the last, and posts in the next session', () => {
    const saved = {
      session: 2,
      entries: [
        { id: 1, author: 'a-1', ts: 't1', text: 'one', session: 1 },
        { id: 2, author: 'a-1', ts: 't2', text: 'two', session: 2 },
      ],
    };
    const b = Blackboard.resumed(
      { channel: 'lab', clock: () => new Date('2026-09-27T00:00:00.000Z'), logger: new RecordingLogger() },
      saved,
    );
    expect(b.read(0).entries).toEqual(saved.entries);
    expect(b.post('a-1', 'three')).toEqual({
      ok: true,
      entry: { id: 3, author: 'a-1', ts: '2026-09-27T00:00:00.000Z', text: 'three', session: 3 },
    });
    expect(b.snapshot().session).toBe(3);
  });

  it('says when it is full: at 256 entries, the bound a resumed board keeps until reset', () => {
    const b = board();
    for (let i = 0; i < 255; i++) b.post('hewo-1', 'x');
    expect(b.full()).toBe(false);
    b.post('hewo-1', 'x');
    expect(b.full()).toBe(true);
    expect(b.post('hewo-1', 'x')).toEqual({ ok: false, reason: 'blackboard_full' });
  });
});
