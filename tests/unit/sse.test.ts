// The control API's one stream format (docs/plans/model-streaming.md R5): the daemon's writer and the CLI's reader.

import { describe, expect, it } from 'vitest';

import {
  SSE_HEARTBEAT,
  SSE_MAX_UNWRITTEN_BYTES,
  SseDecoder,
  SseProtocolError,
  sseEvent,
} from '../../src/shared/sse.js';
import { present } from '../../src/shared/assert-present.js';

describe('sseEvent', () => {
  it('writes an event as its event: and data: lines and a blank line, with no id: line', () => {
    expect(sseEvent({ type: 'status', working: ['a\nb'] } as { type: string })).toBe(
      'event: status\ndata: {"type":"status","working":["a\\nb"]}\n\n',
    );
  });

  it('writes the heartbeat as a comment, and bounds a stream at 1 MiB unwritten (R6)', () => {
    expect(SSE_HEARTBEAT).toBe(': heartbeat\n\n');
    expect(SSE_MAX_UNWRITTEN_BYTES).toBe(1_048_576);
  });
});

describe('SseDecoder', () => {
  it('reads what sseEvent writes, across any chunk boundary, skipping heartbeats', () => {
    const events = [
      { type: 'posted', n: 1 },
      { type: 'model_delta', text: 'é\n"' },
      { type: 'status', working: [] },
    ];
    const event0 = present(events[0], 'events[0]');
    const event1 = present(events[1], 'events[1]');
    const event2 = present(events[2], 'events[2]');
    const text = `${sseEvent(event0)}${SSE_HEARTBEAT}${sseEvent(event1)}${SSE_HEARTBEAT}${sseEvent(event2)}`;
    for (let cut = 0; cut <= text.length; cut += 1) {
      const decoder = new SseDecoder();
      expect([...decoder.push(text.slice(0, cut)), ...decoder.push(text.slice(cut))], `cut at ${String(cut)}`).toEqual(
        events,
      );
    }
  });

  it('accepts CRLF line endings', () => {
    expect(new SseDecoder().push('event: a\r\ndata: {"type":"a"}\r\n\r\n')).toEqual([{ type: 'a' }]);
  });

  it.each([
    ['an NDJSON line', '{"type":"posted"}\n', 'an unexpected line in the daemon\'s event stream: {"type":"posted"}'],
    ['an id: line', 'id: 7\n', "an unexpected line in the daemon's event stream: id: 7"],
    [
      'a second data: line',
      'event: a\ndata: {"type":"a"}\ndata: {}\n',
      "an unexpected line in the daemon's event stream: data: {}",
    ],
    [
      'data with no event line',
      'data: {"type":"a"}\n\n',
      'an event without both its event: and data: lines ({"type":"a"})',
    ],
    ['data that is not JSON', 'event: a\ndata: {nope\n\n', 'an event whose data is not JSON: {nope'],
    [
      'an event whose name is not its type',
      'event: a\ndata: {"type":"b"}\n\n',
      'an event named a whose data is {"type":"b"}',
    ],
  ])('throws SseProtocolError on %s', (_, text, message) => {
    const decoder = new SseDecoder();
    expect(() => decoder.push(text)).toThrow(SseProtocolError);
    expect(() => new SseDecoder().push(text)).toThrow(message);
  });
});
