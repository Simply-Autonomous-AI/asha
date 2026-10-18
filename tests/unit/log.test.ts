import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { JsonLinesLogger } from '../../src/daemon/log.js';
import { present } from '../../src/shared/assert-present.js';

/** The `error` field of a parsed log line; the rest of the line is checked by hand where it matters. */
function parsedError(line: string): unknown {
  return (JSON.parse(line) as { error?: unknown }).error;
}

const T0 = new Date('2026-09-26T12:00:00.000Z');
const T1 = new Date('2026-09-26T12:00:01.500Z');

describe('JsonLinesLogger', () => {
  let file: string;
  let echoed: string[];
  let times: Date[];
  let logger: JsonLinesLogger;

  beforeEach(async () => {
    file = join(await mkdtemp(join(tmpdir(), 'asha-log-')), 'daemon.jsonl');
    echoed = [];
    times = [T0, T1, T1, T1];
    logger = new JsonLinesLogger({
      file,
      echo: (line) => echoed.push(line),
      clock: () => present(times.shift(), 'times'),
    });
  });

  async function fileLines(): Promise<string[]> {
    return (await readFile(file, 'utf8')).split('\n');
  }

  it("makes its own folder on the first write into a home that has none (logs/ inside an existing home): `asha --install-module` into a new home crashed ENOENT (extension-modules' launch suite, 2026-10-02)", async () => {
    const home = await mkdtemp(join(tmpdir(), 'asha-log-home-'));
    const inLogs = join(home, 'logs', 'daemon.jsonl');
    const fresh = new JsonLinesLogger({ file: inLogs, echo: () => undefined, clock: () => T0 });
    fresh.info('module.installed', { module: 'x' });
    fresh.info('daemon.started', {});
    expect(
      (await readFile(inLogs, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => (JSON.parse(l) as { event: string }).event),
    ).toEqual(['module.installed', 'daemon.started']);
  });

  it('never makes the home itself: with no home, the write fails ENOENT (a home is made 0700 by ensureHome, never by a log line)', async () => {
    const missing = join(await mkdtemp(join(tmpdir(), 'asha-log-none-')), 'no-home', 'logs', 'daemon.jsonl');
    const homeless = new JsonLinesLogger({ file: missing, echo: () => undefined, clock: () => T0 });
    expect(() => {
      homeless.info('daemon.started', {});
    }).toThrow(/ENOENT/);
  });

  it('appends one JSON line per call, with ts from the clock, level, event and fields', async () => {
    logger.info('daemon.started', { port: 5000, home: '/h' });
    logger.warn('lock.stale_cleared', { holder: 7 });

    const lines = await fileLines();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(present(lines[0], 'lines[0]'))).toEqual({
      ts: '2026-09-26T12:00:00.000Z',
      level: 'info',
      event: 'daemon.started',
      port: 5000,
      home: '/h',
    });
    expect(JSON.parse(present(lines[1], 'lines[1]'))).toEqual({
      ts: '2026-09-26T12:00:01.500Z',
      level: 'warn',
      event: 'lock.stale_cleared',
      holder: 7,
    });
    // Key order is part of the record: ts, level, event first.
    expect(lines[0]).toBe(
      '{"ts":"2026-09-26T12:00:00.000Z","level":"info","event":"daemon.started","port":5000,"home":"/h"}',
    );
  });

  it('echoes exactly the line it wrote, once per call', async () => {
    logger.info('a');
    logger.warn('b', { x: 1 });
    logger.error('c', { error: 'boom' });

    const lines = await fileLines();
    expect(echoed).toEqual(lines.slice(0, 3));
    expect(echoed).toHaveLength(3);
    expect(JSON.parse(present(echoed[0], 'echoed[0]'))).toEqual({
      ts: '2026-09-26T12:00:00.000Z',
      level: 'info',
      event: 'a',
    });
  });

  it('serializes an Error with name, message, stack and its whole cause chain', () => {
    const inner = new TypeError('socket hang up', { cause: 'ECONNRESET' });
    const outer = new Error('download failed', { cause: inner });
    outer.name = 'ModelFetchFailed';

    logger.error('model.fetch_failed', { model: 'm', error: outer });

    expect(JSON.parse(present(echoed[0], 'echoed[0]'))).toEqual({
      ts: '2026-09-26T12:00:00.000Z',
      level: 'error',
      event: 'model.fetch_failed',
      model: 'm',
      error: {
        name: 'ModelFetchFailed',
        message: 'download failed',
        stack: outer.stack,
        cause: { name: 'TypeError', message: 'socket hang up', stack: inner.stack, cause: 'ECONNRESET' },
      },
    });
    expect(typeof outer.stack).toBe('string');
    expect(typeof inner.stack).toBe('string');
  });

  it('omits stack and cause keys an Error does not have', () => {
    const error = new Error('bare');
    delete (error as { stack?: string }).stack;

    logger.error('e', { error });

    expect(parsedError(present(echoed[0], 'echoed[0]'))).toEqual({ name: 'Error', message: 'bare' });
  });

  it('never lets a field overwrite ts, level or event', () => {
    logger.error('real.failure', { level: 'info', event: 'fake', ts: 'then', error: 'x' });
    expect(echoed[0]).toBe('{"ts":"2026-09-26T12:00:00.000Z","level":"error","event":"real.failure","error":"x"}');
  });

  it('serializes a thrown plain object as JSON, and a circular one by its type', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    logger.error('e1', { error: { code: 'EPIPE', errno: -32 } });
    logger.error('e2', { error: circular });
    expect(echoed.map(parsedError)).toEqual(['{"code":"EPIPE","errno":-32}', '[object Object]']);
  });

  it('turns a non-Error error into its string form', () => {
    logger.error('e1', { error: 42 });
    logger.error('e2', { error: 'plain text' });
    logger.error('e3', { error: null });
    logger.error('e4', { error: new Error('x', { cause: 7 }) });

    expect(echoed.map(parsedError)).toEqual([
      '42',
      'plain text',
      'null',
      { name: 'Error', message: 'x', stack: expect.any(String) as string, cause: '7' },
    ]);
  });
});
