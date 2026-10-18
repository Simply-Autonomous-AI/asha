import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildFingerprint } from '../../src/shared/build.js';

async function dist(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asha-build-'));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, '..'), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  return dir;
}

describe('buildFingerprint', () => {
  it('is 12 hex digits, and the same for the same code wherever it lives', async () => {
    const a = await dist({ 'src/a.js': 'one', 'src/cli/b.js': 'two' });
    const b = await dist({ 'src/cli/b.js': 'two', 'src/a.js': 'one' });
    expect(buildFingerprint(a)).toMatch(/^[0-9a-f]{12}$/);
    expect(buildFingerprint(a)).toBe(buildFingerprint(b));
  });

  it("changes when any file's content or path changes, or a file is added", async () => {
    const base = buildFingerprint(await dist({ 'src/a.js': 'one', 'src/b.js': 'two' }));
    expect(buildFingerprint(await dist({ 'src/a.js': 'one!', 'src/b.js': 'two' }))).not.toBe(base);
    expect(buildFingerprint(await dist({ 'src/a.js': 'one', 'src/c.js': 'two' }))).not.toBe(base);
    expect(buildFingerprint(await dist({ 'src/a.js': 'one', 'src/b.js': 'two', 'src/d.js': '' }))).not.toBe(base);
  });

  it('counts only compiled .js files', async () => {
    const base = buildFingerprint(await dist({ 'src/a.js': 'one' }));
    expect(buildFingerprint(await dist({ 'src/a.js': 'one', 'src/a.js.map': '{}', 'notes.txt': 'x' }))).toBe(base);
  });

  // dist/agent-packages/ (debt-paydown R10) holds the agent packages' 378 .js files, which every image staging reads
  // afresh: hashing them on every CLI start cost 7 ms (9.6 ms against 2.8 ms, medians of 7, 2026-10-03).
  it('leaves out the agent packages under agent-packages/ at the top, and only there', async () => {
    const base = buildFingerprint(await dist({ 'src/a.js': 'one' }));
    expect(buildFingerprint(await dist({ 'src/a.js': 'one', 'agent-packages/node_modules/x/index.js': 'pkg' }))).toBe(
      base,
    );
    expect(buildFingerprint(await dist({ 'src/a.js': 'one', 'src/agent-packages/index.js': 'code' }))).not.toBe(base);
  });

  it('fails loudly on a directory with no compiled code', async () => {
    const empty = await dist({ 'readme.txt': 'x' });
    expect(() => buildFingerprint(empty)).toThrow(
      `no compiled code under ${empty}: this asha installation is incomplete; reinstall it (brew reinstall asha) or, in a checkout, run npm run build`,
    );
  });
});
