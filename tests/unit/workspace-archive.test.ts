// The archive that carries a recipe's documents into an agent's /workspace
// (docs/plans/collaborating-agents.md R2), read back by the host's own `tar`
// (bsdtar on macOS), an independent reader: a check that parsed it with our
// own code would prove nothing about what docker cp will make of it.

import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import { workspaceArchive } from '../../src/daemon/container-runtime/archive.js';
import { present } from '../../src/shared/assert-present.js';

const OWNER = { uid: 1000, gid: 1000 };
const MTIME = Date.UTC(2026, 8, 29) / 1000;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asha-archive-'));
});

/** Runs the host's tar on the archive: `options`, then `-f <file>`, then `members`. Times shown in UTC. */
async function tar(archive: Buffer, options: string[], members: string[] = []): Promise<string> {
  const file = join(dir, 'a.tar');
  await writeFile(file, archive);
  return execFileSync('tar', [...options, '-f', file, ...members], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, TZ: 'UTC' },
  });
}

describe('workspaceArchive', () => {
  const files = [
    { path: 'guidance.md', content: Buffer.from('1. Reply with the words.\n') },
    { path: 'flows/deep/steps.md', content: Buffer.from('ünïcode — ok\n'.repeat(60)) },
    { path: 'flows/other.md', content: Buffer.alloc(0) },
  ];

  it('lists every directory above a file before it, then the file, each owned by the agent user, 0755 and 0644', async () => {
    const listing = await tar(workspaceArchive(files, OWNER, MTIME), ['-tv', '--numeric-owner']);
    const rows = listing
      .trim()
      .split('\n')
      .map((line) => line.split(/\s+/))
      .map((f) => ({
        mode: f[0],
        owner: `${present(f[2], "the listing row's owner-uid column")}:${present(f[3], "the listing row's owner-gid column")}`,
        size: f[4],
        name: f.at(-1),
      }));
    expect(rows).toEqual([
      { mode: '-rw-r--r--', owner: '1000:1000', size: '25', name: 'guidance.md' },
      { mode: 'drwxr-xr-x', owner: '1000:1000', size: '0', name: 'flows/' },
      { mode: 'drwxr-xr-x', owner: '1000:1000', size: '0', name: 'flows/deep/' },
      {
        mode: '-rw-r--r--',
        owner: '1000:1000',
        size: String(present(files[1], 'files[1]').content.byteLength),
        name: 'flows/deep/steps.md',
      },
      { mode: '-rw-r--r--', owner: '1000:1000', size: '0', name: 'flows/other.md' },
    ]);
  });

  it('carries each file byte for byte, and ends on a block boundary', async () => {
    const archive = workspaceArchive(files, OWNER, MTIME);
    expect(archive.byteLength % 512).toBe(0);
    for (const f of files) expect(Buffer.from(await tar(archive, ['-xO'], [f.path]), 'utf8')).toEqual(f.content);
  });

  it('dates every entry by the clock it is given', async () => {
    const listing = await tar(workspaceArchive(files.slice(0, 1), OWNER, MTIME), ['-tv', '--numeric-owner']);
    expect(listing).toContain('Sep 29 00:00 guidance.md');
  });

  it('an empty set is an empty archive', async () => {
    expect(await tar(workspaceArchive([], OWNER, MTIME), ['-t'])).toBe('');
  });

  it.each(['/etc/passwd', '../escape.md', 'a/../b.md', 'a//b.md', './a.md', `${'x'.repeat(98)}.md`])(
    'refuses "%s": not a plain relative path of at most 100 bytes',
    (path) => {
      expect(() => workspaceArchive([{ path, content: Buffer.from('x') }], OWNER, MTIME)).toThrow(
        `workspace archive: "${path}" is not a plain relative path of at most 100 bytes`,
      );
    },
  );
});
