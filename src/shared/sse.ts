// The control API's streams as server-sent events (docs/plans/model-streaming.md R5): the one wire format of
// `POST /v1/conversations`, `POST /v1/agents` and `GET /v1/channel`, written by the daemon and read by the CLI.
// Each event is `event: <type>`, `data: <one-line JSON>` and a blank line, and carries no `id:` (a dropped stream
// is not resumed). The heartbeat is a comment line. The agents' own channel stream stays NDJSON (R5).

/** The content type of every streaming control route. */
export const SSE_CONTENT_TYPE = 'text/event-stream';

/** The heartbeat: a comment, which a reader counts as activity and otherwise ignores. */
export const SSE_HEARTBEAT = ': heartbeat\n\n';

/**
 * The most bytes a stream may hold unwritten (`res.writableLength`) before the daemon ends it with a `slow_reader`
 * error (R6): a reader that stops reading must not hold the daemon's memory, or slow a model call, without bound.
 */
export const SSE_MAX_UNWRITTEN_BYTES = 1024 * 1024;

/** One event, as the daemon writes it. `JSON.stringify` never writes a raw newline, so the data is one line. */
export function sseEvent(event: { readonly type: string }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The daemon wrote something that is not this format: a defect on one side or the other, never an expected failure. */
export class SseProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SseProtocolError';
  }
}

/**
 * Reads the daemon's events from the text of a stream, across chunk boundaries: `push` returns each event completed
 * by the text, parsed. An event's `event:` line must name the `type` of its JSON; comments (the heartbeat) are
 * skipped; any other line throws SseProtocolError.
 */
export class SseDecoder {
  private buffered = '';
  private type: string | undefined;
  private data: string | undefined;

  push(text: string): unknown[] {
    this.buffered += text;
    const events: unknown[] = [];
    let newline = this.buffered.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline).replace(/\r$/, '');
      this.buffered = this.buffered.slice(newline + 1);
      const event = this.line(line);
      if (event !== undefined) events.push(event);
      newline = this.buffered.indexOf('\n');
    }
    return events;
  }

  private line(line: string): unknown {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    if (line.startsWith('event: ') && this.type === undefined) {
      this.type = line.slice('event: '.length);
      return undefined;
    }
    if (line.startsWith('data: ') && this.data === undefined) {
      this.data = line.slice('data: '.length);
      return undefined;
    }
    throw new SseProtocolError(`an unexpected line in the daemon's event stream: ${line.slice(0, 200)}`);
  }

  private dispatch(): unknown {
    const { type, data } = this;
    this.type = undefined;
    this.data = undefined;
    if (type === undefined && data === undefined) return undefined;
    if (type === undefined || data === undefined)
      throw new SseProtocolError(`an event without both its event: and data: lines (${type ?? data ?? ''})`);
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      throw new SseProtocolError(`an event whose data is not JSON: ${data.slice(0, 200)}`);
    }
    if ((event as { type?: unknown } | null)?.type !== type)
      throw new SseProtocolError(`an event named ${type} whose data is ${data.slice(0, 200)}`);
    return event;
  }
}

/**
 * The daemon's events from an SSE response body, parsed; `onChunk` is called on every read, heartbeats included, so
 * the caller's inactivity bound restarts. An event that breaks the format throws SseProtocolError: a defect, not data.
 * Read with the stream's reader, which Node's fetch and every browser give a page (docs/plans/portal.md R15).
 */
export async function* sseEvents(body: ReadableStream<Uint8Array>, onChunk: () => void): AsyncGenerator {
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  const reader = body.getReader();
  // Whether the stream needs no cancel: it ended, or its read failed (cut, or its signal aborted), so it is errored.
  let settled = false;
  try {
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>;
      try {
        read = await reader.read();
      } catch (error) {
        settled = true;
        throw error;
      }
      if (read.done) {
        settled = true;
        return;
      }
      onChunk();
      yield* sse.push(decoder.decode(read.value, { stream: true }));
    }
  } finally {
    // The consumer stopped early, having what it needs, or the stream broke the format: the body is cancelled, which
    // hangs the request up, as leaving the body's own iterator does.
    if (!settled) await reader.cancel();
    reader.releaseLock();
  }
}
