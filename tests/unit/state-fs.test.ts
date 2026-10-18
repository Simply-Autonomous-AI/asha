// The state store's real filesystem (docs/plans/agent-persistence.md R2, R4, R11): every chunk written whole — a
// short write continued, a write of nothing refused (R1-DESIGN-007) — an unreadable file never read as missing,
// and entries typed without following links.

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NodeStateFile, nodeStateFs, type WritableHandle } from '../../src/daemon/state/fs.js';
import { byCodeUnit } from '../../src/shared/order.js';

/** A handle that writes at most `per` bytes a call (0 writes nothing), recording each call's offset and length. */
function shortHandle(per: number): WritableHandle & { readonly calls: [number, number][]; readonly out: Buffer[] } {
  const calls: [number, number][] = [];
  const out: Buffer[] = [];
  return {
    calls,
    out,
    write: (buffer, offset, length) => {
      calls.push([offset, length]);
      const n = Math.min(per, length);
      out.push(Buffer.from(buffer.subarray(offset, offset + n)));
      return Promise.resolve({ bytesWritten: n });
    },
    sync: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
}

describe('a state file (R4; R1-DESIGN-007)', () => {
  it('continues a short write until the whole chunk is written, in order', async () => {
    const handle = shortHandle(4);
    await new NodeStateFile(handle, '/s/gen-2/memory.tar').write(Buffer.from('0123456789'));
    expect(handle.calls).toEqual([
      [0, 10],
      [4, 6],
      [8, 2],
    ]);
    expect(Buffer.concat(handle.out).toString()).toBe('0123456789');
  });

  it('refuses a write that writes nothing, naming the file and the bytes left, rather than reporting success', async () => {
    const handle = shortHandle(0);
    await expect(new NodeStateFile(handle, '/s/gen-2/memory.tar').write(Buffer.from('abc'))).rejects.toThrow(
      new Error('/s/gen-2/memory.tar: a write of 3 bytes wrote nothing (a full or failing disk)'),
    );
  });

  it('writes, syncs and closes a real file whole', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'asha-state-fs-')));
    const file = await nodeStateFs.createFile(join(dir, 'a.tar'));
    await file.write(Buffer.from('one'));
    await file.write(Buffer.from('two'));
    await file.sync();
    await file.close();
    expect(await readFile(join(dir, 'a.tar'), 'utf8')).toBe('onetwo');
  });
});

describe('reading and listing (R11)', () => {
  it('reads a missing file as undefined, and rethrows any other failure rather than calling it missing', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'asha-state-fs-')));
    expect(await nodeStateFs.readFile(join(dir, 'none.json'))).toBeUndefined();
    await mkdir(join(dir, 'a-directory'));
    await expect(nodeStateFs.readFile(join(dir, 'a-directory'))).rejects.toMatchObject({ code: 'EISDIR' });
    expect(await nodeStateFs.list(join(dir, 'none'))).toBeUndefined();
    await writeFile(join(dir, 'plain'), 'x');
    await expect(nodeStateFs.list(join(dir, 'plain'))).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('types every entry without following links: a directory, a file, a symbolic link, and anything else as other', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'asha-state-fs-')));
    await mkdir(join(dir, 'd'));
    await writeFile(join(dir, 'f'), 'x');
    await symlink(join(dir, 'd'), join(dir, 'l'));
    execFileSync('mkfifo', [join(dir, 'p')]);
    const listed = await nodeStateFs.list(dir);
    expect(listed?.sort((a, b) => byCodeUnit(a.name, b.name))).toEqual([
      { name: 'd', kind: 'directory' },
      { name: 'f', kind: 'file' },
      { name: 'l', kind: 'symlink' },
      { name: 'p', kind: 'other' },
    ]);
    expect(await nodeStateFs.size(join(dir, 'f'))).toBe(1);
  });
});
