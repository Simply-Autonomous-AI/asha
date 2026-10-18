// The plugin base's unpacker (docs/plans/extension-modules.md R28): harness-images/plugin-base/unzip.mjs, which unpacks
// a command plugin's release ZIP inside its image build, where there is no unzip and no network. Each archive here is
// made by the system's zip(1).

import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, symlink, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// @ts-expect-error a plain ES module with no types: the image runs it as it is.
import { unzip as unzipUntyped } from '../../harness-images/plugin-base/unzip.mjs';

type Unzip = (src: string, into: string) => number;
const unzip: Unzip = unzipUntyped as Unzip;

/** Runs the script as the plugin base's image build does: `node unzip.mjs <archive.zip> <into-dir>`. */
function unzipScript(src: string, into: string): { status: number | null; stdout: string; stderr: string } {
  const script = resolve('harness-images', 'plugin-base', 'unzip.mjs');
  const run = spawnSync(process.execPath, [script, src, into], { encoding: 'utf8', timeout: 30_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

async function zipOf(
  files: Record<string, string>,
  options: { store?: boolean; link?: [string, string] } = {},
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asha-zip-src-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), content);
  }
  if (options.link !== undefined) await symlink(options.link[1], join(dir, options.link[0]));
  const out = join(await mkdtemp(join(tmpdir(), 'asha-zip-')), 'a.zip');
  execFileSync('zip', ['-q', '-r', '-y', ...(options.store === true ? ['-0'] : []), out, '.'], { cwd: dir });
  return out;
}

describe('unzip.mjs (R28)', () => {
  it('unpacks stored and deflated entries, keeping an executable mode and a symbolic link as a link', async () => {
    const big = 'x'.repeat(10_000);
    for (const store of [true, false]) {
      const src = await zipOf(
        { 'aws/install': '#!/bin/sh\necho ok\n', 'aws/dist/big.txt': big },
        { store, link: ['aws/current', 'dist'] },
      );
      await chmod(src, 0o644);
      const into = await mkdtemp(join(tmpdir(), 'asha-unzip-'));
      expect(unzip(src, into)).toBeGreaterThanOrEqual(3);
      expect(await readFile(join(into, 'aws', 'dist', 'big.txt'), 'utf8')).toBe(big);
      expect(await readlink(join(into, 'aws', 'current'))).toBe('dist');
      expect((await lstat(join(into, 'aws', 'current'))).isSymbolicLink()).toBe(true);
    }
  });

  it('keeps the mode zip recorded: an installer stays executable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-zip-src-'));
    await writeFile(join(dir, 'install'), '#!/bin/sh\n');
    await chmod(join(dir, 'install'), 0o755);
    const out = join(dir, 'a.zip');
    execFileSync('zip', ['-q', out, 'install'], { cwd: dir });
    const into = await mkdtemp(join(tmpdir(), 'asha-unzip-'));
    unzip(out, into);
    expect((await lstat(join(into, 'install'))).mode & 0o777).toBe(0o755);
  });

  it('refuses an entry that climbs out, naming it, and writes nothing outside', async () => {
    const src = await zipOf({ 'ab/x.txt': 'escaped' });
    const bytes = await readFile(src);
    // Rename the entry ab/x.txt to ../x.txt (the same length) in its local header and the central directory.
    const patched = Buffer.from(bytes.toString('latin1').split('ab/x.txt').join('../x.txt'), 'latin1');
    await writeFile(src, patched);
    const parent = await mkdtemp(join(tmpdir(), 'asha-unzip-'));
    const into = join(parent, 'into');
    await mkdir(into);
    expect(() => unzip(src, into)).toThrow(`entry "../x.txt" would be written outside ${into}`);
    await expect(lstat(join(parent, 'x.txt'))).rejects.toThrow('ENOENT');
  });

  it('refuses a link to a place outside <into-dir>, and a file beneath it, naming the link: run as the image runs it, nothing is written outside (R1-SECURITY-001)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'asha-unzip-outside-'));
    // A zip of `link` -> <outside>, then a second pass appending `link/escaped.txt` from a folder where link is a folder.
    const src = await zipOf({}, { link: ['link', outside] });
    const second = await mkdtemp(join(tmpdir(), 'asha-zip-src-'));
    await mkdir(join(second, 'link'));
    await writeFile(join(second, 'link', 'escaped.txt'), 'written outside into-dir');
    execFileSync('zip', ['-q', src, 'link/escaped.txt'], { cwd: second });
    for (const run of ['node', 'in-process'] as const) {
      const into = await mkdtemp(join(tmpdir(), 'asha-unzip-'));
      const message = `entry "link" is a link to ${outside}, outside ${into}`;
      if (run === 'node')
        expect(unzipScript(src, into)).toMatchObject({ status: 1, stderr: expect.stringContaining(message) as string });
      else expect(() => unzip(src, into)).toThrow(message);
      expect(await readdir(outside)).toEqual([]);
    }
  });

  it('refuses a link that climbs out with .., naming it (R1-SECURITY-001)', async () => {
    const src = await zipOf({}, { link: ['up', '../../etc'] });
    const into = await mkdtemp(join(tmpdir(), 'asha-unzip-'));
    expect(() => unzip(src, into)).toThrow(`entry "up" is a link to ../../etc, outside ${into}`);
  });

  it('refuses a file written through an earlier link, even one inside <into-dir>, and a file replacing a link of its name (R1-SECURITY-001)', async () => {
    // inner -> sub, then inner/x.txt: written through the link.
    const through = await zipOf({ 'sub/keep.txt': 'k' }, { link: ['inner', 'sub'] });
    const second = await mkdtemp(join(tmpdir(), 'asha-zip-src-'));
    await mkdir(join(second, 'inner'));
    await writeFile(join(second, 'inner', 'x.txt'), 'through the link');
    execFileSync('zip', ['-q', through, 'inner/x.txt'], { cwd: second });
    const into = await mkdtemp(join(tmpdir(), 'asha-unzip-'));
    expect(unzipScript(through, into)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining('entry "inner/x.txt" would be written through the link "inner"') as string,
    });
    await expect(lstat(join(into, 'sub', 'x.txt'))).rejects.toThrow('ENOENT');
    // aaaa -> sub/real.txt, then a file renamed bbbb to aaaa: it would replace the link, following it. Zipped in that
    // order, one call each, so the link comes first whatever order the folder lists them in.
    const dir = await mkdtemp(join(tmpdir(), 'asha-zip-src-'));
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'real.txt'), 'real');
    await symlink('sub/real.txt', join(dir, 'aaaa'));
    await writeFile(join(dir, 'bbbb'), 'replacing');
    const same = join(await mkdtemp(join(tmpdir(), 'asha-zip-')), 'a.zip');
    for (const entry of ['sub/real.txt', 'aaaa', 'bbbb']) execFileSync('zip', ['-q', '-y', same, entry], { cwd: dir });
    const bytes = await readFile(same);
    await writeFile(same, Buffer.from(bytes.toString('latin1').split('bbbb').join('aaaa'), 'latin1'));
    const into2 = await mkdtemp(join(tmpdir(), 'asha-unzip-'));
    expect(() => unzip(same, into2)).toThrow('entry "aaaa" would be written through the link "aaaa"');
    expect(await readFile(join(into2, 'sub', 'real.txt'), 'utf8')).toBe('real');
  });

  it('refuses a file that is not a ZIP archive', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-zip-'));
    await writeFile(join(dir, 'a.zip'), 'not a zip at all, just text long enough to be searched');
    expect(() => unzip(join(dir, 'a.zip'), dir)).toThrow('not a ZIP archive (no end-of-central-directory record)');
  });
});
