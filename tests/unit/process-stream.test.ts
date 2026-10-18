// ExecCommandRunner.stream against real processes (docs/plans/agent-persistence.md R11): standard input from an
// iterable, standard output to a consumer that can stop the command, standard error to a file, every call bounded.

import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { CommandNotFound, CommandTimedOut, ExecCommandRunner } from '../../src/daemon/process/index.js';

const runner = new ExecCommandRunner();

async function* chunks(...parts: string[]): AsyncIterable<Uint8Array> {
  await Promise.resolve();
  for (const part of parts) yield Buffer.from(part);
}

describe('ExecCommandRunner.stream', () => {
  it('streams standard input in and standard output out, whole and in order', async () => {
    const out: Buffer[] = [];
    const big = 'x'.repeat(300_000);
    const result = await runner.stream('cat', [], {
      timeoutMs: 10_000,
      stdin: chunks('a', big, 'z'),
      onStdout: (chunk) => {
        out.push(chunk);
        return Promise.resolve('more');
      },
    });
    expect(result).toEqual({ code: 0, stderr: '', stopped: false });
    expect(Buffer.concat(out).toString()).toBe(`a${big}z`);
  });

  it('stops the command when the consumer answers stop, reading no further', async () => {
    let seen = 0;
    const result = await runner.stream('yes', [], {
      timeoutMs: 10_000,
      onStdout: (chunk) => {
        seen += chunk.length;
        return Promise.resolve(seen > 100_000 ? 'stop' : 'more');
      },
    });
    expect(result).toEqual({ code: 137, stderr: '', stopped: true });
    expect(seen).toBeGreaterThan(100_000);
  });

  it('returns a non-zero exit with its standard error as data', async () => {
    expect(await runner.stream('sh', ['-c', 'echo broke >&2; exit 3'], { timeoutMs: 10_000 })).toEqual({
      code: 3,
      stderr: 'broke\n',
      stopped: false,
    });
  });

  it('appends standard error to a file when told, and returns none of it', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'asha-stream-')), 'one-shot.log');
    expect(
      await runner.stream('sh', ['-c', 'echo zora >&2; echo out'], {
        timeoutMs: 10_000,
        stderrFile: file,
        onStdout: () => Promise.resolve('more'),
      }),
    ).toEqual({ code: 0, stderr: '', stopped: false });
    expect(await readFile(file, 'utf8')).toBe('zora\n');
  });

  it('kills a command past its bound and throws CommandTimedOut', async () => {
    await expect(runner.stream('sleep', ['5'], { timeoutMs: 100 })).rejects.toThrow(CommandTimedOut);
  });

  it("kills a command when its signal aborts, and rejects with the signal's reason", async () => {
    const controller = new AbortController();
    const running = runner.stream('sleep', ['5'], { timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => {
      controller.abort(new Error('checkpoint past its bound'));
    }, 50);
    await expect(running).rejects.toThrow('checkpoint past its bound');
  });

  it('throws CommandNotFound for a missing binary', async () => {
    await expect(runner.stream('asha-no-such-binary', [], { timeoutMs: 1_000 })).rejects.toThrow(CommandNotFound);
  });

  it('kills the command and rejects when its input fails, so it never runs on half an input', async () => {
    async function* broken(): AsyncIterable<Uint8Array> {
      await Promise.resolve();
      yield Buffer.from('half');
      throw new Error('the stored file could not be read');
    }
    await expect(
      runner.stream('cat', [], { timeoutMs: 10_000, stdin: broken(), onStdout: () => Promise.resolve('more') }),
    ).rejects.toThrow('the stored file could not be read');
  });

  it('rejects when the consumer throws, having killed the command', async () => {
    await expect(
      runner.stream('yes', [], {
        timeoutMs: 10_000,
        onStdout: () => Promise.reject(new Error('the disk is full')),
      }),
    ).rejects.toThrow('the disk is full');
  });
});
