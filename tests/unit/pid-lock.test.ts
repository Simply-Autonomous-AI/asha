import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { LockHeld, acquirePidLock, isAlive } from '../../src/daemon/process/pid-lock.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { RecordingLogger } from '../helpers/fakes.js';

async function absent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

describe('acquirePidLock', () => {
  let file: string;
  let logger: RecordingLogger;
  let asked: number[];

  beforeEach(async () => {
    file = join(await mkdtemp(join(tmpdir(), 'asha-lock-')), '.lock');
    logger = new RecordingLogger();
    asked = [];
  });

  const alive = (answer: boolean) => (pid: number) => {
    asked.push(pid);
    return answer;
  };

  it('writes our own pid into a new lock file and asks nobody about liveness', async () => {
    await acquirePidLock({ file, pid: 4242, isAlive: alive(true), logger });

    expect(await readFile(file, 'utf8')).toBe('4242');
    expect(asked).toEqual([]);
    expect(logger.entries).toEqual([]);
  });

  it('leaves no file of its own beside the lock (the pid file it links into place), taken or refused', async () => {
    await writeFile(join(dirname(file), 'other'), 'x');
    await acquirePidLock({ file, pid: 4242, isAlive: alive(true), logger });
    expect((await readdir(dirname(file))).sort(byCodeUnit)).toEqual(['.lock', 'other']);
    expect((await stat(file)).nlink).toBe(1);
    expect(await readFile(file, 'utf8')).toBe('4242');

    // Refused, it leaves no file of its own either.
    await expect(acquirePidLock({ file, pid: 5151, isAlive: alive(true), logger })).rejects.toBeInstanceOf(LockHeld);
    expect((await readdir(dirname(file))).sort(byCodeUnit)).toEqual(['.lock', 'other']);
  });

  it('release leaves a lock another process has taken since, and says so', async () => {
    const release = await acquirePidLock({ file, pid: 4242, isAlive: alive(true), logger });
    await writeFile(file, '5151');
    await expect(release()).rejects.toThrow(
      `${file} holds "5151", not our pid 4242: another process took it; left in place`,
    );
    expect(await readFile(file, 'utf8')).toBe('5151');
  });

  it('release removes the lock file, after which it can be taken again', async () => {
    const release = await acquirePidLock({ file, pid: 4242, isAlive: alive(true), logger });
    await release();
    expect(await absent(file)).toBe(true);

    await acquirePidLock({ file, pid: 5151, isAlive: alive(true), logger });
    expect(await readFile(file, 'utf8')).toBe('5151');
  });

  it('throws LockHeld naming the holder when a live process holds it, leaving its file alone', async () => {
    await writeFile(file, '777');

    const error = await acquirePidLock({ file, pid: 4242, isAlive: alive(true), logger }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LockHeld);
    expect((error as LockHeld).holderPid).toBe(777);
    expect((error as LockHeld).file).toBe(file);
    expect((error as Error).message).toBe(`${file} is held by live process 777`);
    expect(asked).toEqual([777]);
    expect(await readFile(file, 'utf8')).toBe('777');
    expect(logger.entries).toEqual([]);
  });

  it('clears a lock left by a dead process, warns, and retakes it with our pid', async () => {
    await writeFile(file, '777');

    await acquirePidLock({ file, pid: 4242, isAlive: alive(false), logger });

    expect(await readFile(file, 'utf8')).toBe('4242');
    expect(asked).toEqual([777]);
    expect(logger.entries).toEqual([{ level: 'warn', event: 'lock.stale_cleared', fields: { file, holder: 777 } }]);
  });

  it('treats an unreadable pid as stale without asking whether it is alive', async () => {
    await writeFile(file, '');

    await acquirePidLock({ file, pid: 4242, isAlive: alive(true), logger });

    expect(await readFile(file, 'utf8')).toBe('4242');
    expect(asked).toEqual([]);
    expect(logger.entries).toEqual([
      { level: 'warn', event: 'lock.stale_cleared', fields: { file, holder: Number.NaN } },
    ]);
  });
});

describe('isAlive', () => {
  // Above macOS's and Linux's default pid_max, so no process can hold it.
  const UNUSED_PID = 2 ** 22 - 1;

  beforeAll(() => {
    let code: string | undefined;
    try {
      process.kill(UNUSED_PID, 0);
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    // Precondition: if this fails, the pid below is in use and the test proves nothing.
    expect(code).toBe('ESRCH');
  });

  it('is true for this process', () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  it('is false for a pid no process holds', () => {
    expect(isAlive(UNUSED_PID)).toBe(false);
  });
});
