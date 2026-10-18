// insideGitTree (docs/plans/agent-persistence.md R2, shared with extension-modules R7 and R28): true when the path or
// any directory above it, up to /, holds an entry named .git that is a directory or a file.

import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { harnessPaths, insideGitTree } from '../../src/shared/paths.js';

async function scratch(): Promise<string> {
  // realpath: /var → /private/var on macOS, so the walk up passes no symlinked parent.
  return realpath(await mkdtemp(join(tmpdir(), 'asha-git-tree-')));
}

describe('insideGitTree', () => {
  it('is false for a path with no .git at or above it', async () => {
    const dir = await scratch();
    expect(await insideGitTree(join(dir, 'home', 'state'))).toBe(false);
  });

  it('is true when a directory above holds a .git directory (a repository)', async () => {
    const dir = await scratch();
    await mkdir(join(dir, '.git'));
    expect(await insideGitTree(join(dir, 'home', 'state'))).toBe(true);
  });

  it('is true when a directory above holds a .git file (a worktree or a submodule)', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'home'));
    await writeFile(join(dir, 'home', '.git'), 'gitdir: /elsewhere\n');
    expect(await insideGitTree(join(dir, 'home', 'state'))).toBe(true);
  });

  it('is true when the path itself holds .git', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'state', '.git'), { recursive: true });
    expect(await insideGitTree(join(dir, 'state'))).toBe(true);
  });

  it('does not count a .git that is a symbolic link, a name that only contains .git, or a sibling tree', async () => {
    const dir = await scratch();
    await mkdir(join(dir, 'a'), { recursive: true });
    await mkdir(join(dir, 'other', '.git'), { recursive: true });
    await symlink(join(dir, 'other', '.git'), join(dir, 'a', '.git'));
    await mkdir(join(dir, 'a', 'b', '.gitx'), { recursive: true });
    expect(await insideGitTree(join(dir, 'a', 'b', 'state'))).toBe(false);
  });
});

describe('harnessPaths', () => {
  it('names the state directory under the home', () => {
    expect(harnessPaths({ ASHA_HOME: '/h' }).stateDir).toBe('/h/state');
  });
});
