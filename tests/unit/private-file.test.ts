// writePrivateFile and its synchronous twin (PRINCIPLES §13): written whole to a unique 0600 temporary, renamed over
// the target; a failed write leaves no temporary, and the caller sees the write's own error — as the cause, beside
// the removal's, when removing the temporary fails too (R1-DESIGN-016).

import { mkdtemp, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Each failure a test arms is thrown by the next call of that function; every other call is the real one.
const armed = vi.hoisted(() => ({
  rm: undefined as Error | undefined,
  rename: undefined as Error | undefined,
  rmSync: undefined as Error | undefined,
  renameSync: undefined as Error | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rm: (...args: Parameters<typeof real.rm>) => {
      const error = armed.rm;
      armed.rm = undefined;
      return error === undefined ? real.rm(...args) : Promise.reject(error);
    },
    rename: (...args: Parameters<typeof real.rename>) => {
      const error = armed.rename;
      armed.rename = undefined;
      return error === undefined ? real.rename(...args) : Promise.reject(error);
    },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    rmSync: (...args: Parameters<typeof real.rmSync>) => {
      const error = armed.rmSync;
      armed.rmSync = undefined;
      if (error !== undefined) throw error;
      real.rmSync(...args);
    },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      const error = armed.renameSync;
      armed.renameSync = undefined;
      if (error !== undefined) throw error;
      real.renameSync(...args);
    },
  };
});

const { TemporaryNotRemoved, writePrivateFile, writePrivateFileSync } =
  await import('../../src/daemon/private-file/index.js');

const failure = (code: string, message: string) => Object.assign(new Error(message), { code });

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'asha-private-')));
  armed.rm = armed.rename = armed.rmSync = armed.renameSync = undefined;
});

describe.each([
  ['writePrivateFile', (t: string, c: string) => writePrivateFile(t, c), 'rename', 'rm'],
  [
    'writePrivateFileSync',
    // A throw inside the executor rejects the promise, so both variants are asserted alike.
    (t: string, c: string) =>
      new Promise<void>((resolve) => {
        writePrivateFileSync(t, c);
        resolve();
      }),
    'renameSync',
    'rmSync',
  ],
] as const)('%s', (_name, write, renameFn, rmFn) => {
  it('writes the content whole, mode 0600, leaving no temporary', async () => {
    await write(join(dir, 'key'), 'secret');
    expect(await readFile(join(dir, 'key'), 'utf8')).toBe('secret');
    expect((await stat(join(dir, 'key'))).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['key']);
  });

  it('a failed rename removes the temporary and throws the rename’s own error', async () => {
    const renameFailed = failure('EXDEV', 'rename failed');
    armed[renameFn] = renameFailed;
    await expect(write(join(dir, 'key'), 'secret')).rejects.toBe(renameFailed);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a failed rename whose temporary cannot be removed either throws TemporaryNotRemoved: the rename’s error its cause, the removal’s beside it', async () => {
    const renameFailed = failure('EXDEV', 'rename failed');
    const rmFailed = failure('EACCES', 'remove failed');
    armed[renameFn] = renameFailed;
    armed[rmFn] = rmFailed;
    const error = (await write(join(dir, 'key'), 'secret').catch((e: unknown) => e)) as InstanceType<
      typeof TemporaryNotRemoved
    >;
    expect(error).toBeInstanceOf(TemporaryNotRemoved);
    const [temp] = await readdir(dir);
    expect(temp).toMatch(/^\.key\.\d+\.[0-9a-f]{16}\.tmp$/);
    expect([error.name, error.message, error.cause, error.cleanup, error.temp]).toEqual([
      'TemporaryNotRemoved',
      `rename failed; and the temporary ${join(dir, String(temp))} could not be removed: remove failed`,
      renameFailed,
      rmFailed,
      join(dir, String(temp)),
    ]);
  });
});
