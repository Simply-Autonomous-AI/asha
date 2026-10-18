// The secret scans fail on a planted secret (docs/plans/oss-release.md R5, R7, R8; A6), with the real gitleaks: a fake
// AWS access key id and a fake PEM private-key block, each built here from parts at run time so no source file holds a
// match, planted in a temporary folder (R5's scan) and in a commit that a later commit deletes (R8's); each scan names
// the rule and the file (and the commit), and no output carries the value. GITLEAKS_CONFIG naming an empty rule set
// does not switch the rules off, a `.gitleaksignore` among the files is refused, and a gitleaks that is missing or
// outside 8.30.1 to below 9 is refused, naming `brew install gitleaks`. Needs gitleaks installed (`brew install
// gitleaks`), as the gate does.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { byCodeUnit } from '../../src/shared/order.js';

import {
  SecretScanRefused,
  findingLine,
  gitleaksVersion,
  scanFolder,
  scanHistory,
  scanTracked,
} from '../../tools/oss/secrets.mjs';

/** A fake AWS access key id: the prefix and sixteen of A–Z and 2–7, joined at run time. */
const AWS_KEY = ['AK', 'IA', 'Q3ZT7KX2', 'WM5RVJN4'].join('');
/** A fake PEM private key: its header, a body of 64-column base64 and its footer, joined at run time. */
const PEM = (() => {
  const body = Buffer.from(
    Array.from({ length: 12 }, (_, i) =>
      createHash('sha256')
        .update(`fake key ${String(i)}`)
        .digest(),
    ).reduce((all, b) => Buffer.concat([all, b]), Buffer.alloc(0)),
  )
    .toString('base64')
    .match(/.{1,64}/g)
    ?.join('\n');
  const edge = (which: string): string => ['-----', which, ' RSA ', 'PRIVATE', ' KEY-----'].join('');
  return `${edge('BEGIN')}\n${body ?? ''}\n${edge('END')}\n`;
})();

const temp = (): string => mkdtempSync(join(tmpdir(), 'asha-secret-scan-'));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

/** Every line the scans print about `found`, joined. */
const printed = (found: Parameters<typeof findingLine>[0][]): string => found.map(findingLine).join('\n');

describe('the secret scans fail on a planted secret, naming where, never what (oss-release R5, R7, R8; A6)', () => {
  const saved = { config: process.env['GITLEAKS_CONFIG'], toml: process.env['GITLEAKS_CONFIG_TOML'] };
  afterEach(() => {
    if (saved.config === undefined) delete process.env['GITLEAKS_CONFIG'];
    else process.env['GITLEAKS_CONFIG'] = saved.config;
    if (saved.toml === undefined) delete process.env['GITLEAKS_CONFIG_TOML'];
    else process.env['GITLEAKS_CONFIG_TOML'] = saved.toml;
  });

  it('runs a gitleaks of 8.30.1 to below 9', () => {
    expect(gitleaksVersion()).toMatch(/^8\.(?:3\d|[4-9]\d)\.\d+$/);
  });

  it("the folder scan names each planted value's rule and file, and prints neither value", () => {
    const dir = temp();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'aws.ts'), `export const id = '${AWS_KEY}';\n`);
    writeFileSync(join(dir, 'key.pem'), PEM);
    writeFileSync(join(dir, 'clean.md'), 'nothing here\n');
    const found = scanFolder(dir);
    expect(found.map((f) => [f.rule, f.file, f.line]).sort((a, b) => byCodeUnit(String(a[0]), String(b[0])))).toEqual([
      ['aws-access-token', 'src/aws.ts', 1],
      ['private-key', 'key.pem', 1],
    ]);
    expect(printed(found)).not.toContain(AWS_KEY);
    expect(printed(found)).not.toContain(PEM.split('\n')[1]);
  });

  it('the history scan names the commit that held a value a later commit deleted, and prints no value', () => {
    const repo = temp();
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'creds.txt'), `aws ${AWS_KEY}\n`);
    git(repo, 'add', 'creds.txt');
    git(repo, 'commit', '-q', '-m', 'add');
    const planted = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'rm', '-q', 'creds.txt');
    git(repo, 'commit', '-q', '-m', 'remove');
    const found = scanHistory(repo);
    expect(found.map((f) => [f.rule, f.file, f.commit])).toEqual([['aws-access-token', 'creds.txt', planted]]);
    expect(printed(found)).toBe(`${planted.slice(0, 12)} creds.txt:1 aws-access-token`);
  });

  it("the tracked-file scan copies exactly git's files: a planted untracked file is not among them, a tracked one is", () => {
    const repo = temp();
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'tracked.txt'), `id ${AWS_KEY}\n`);
    writeFileSync(join(repo, 'untracked.txt'), `id ${AWS_KEY}\n`);
    git(repo, 'add', 'tracked.txt');
    expect(scanTracked(repo).map((f) => f.file)).toEqual(['tracked.txt']);
  });

  it('GITLEAKS_CONFIG and GITLEAKS_CONFIG_TOML naming an empty rule set switch no rule off', () => {
    const dir = temp();
    const empty = join(temp(), 'empty.toml');
    writeFileSync(empty, 'title = "no rules"\n');
    writeFileSync(join(dir, 'aws.txt'), `id ${AWS_KEY}\n`);
    process.env['GITLEAKS_CONFIG'] = empty;
    process.env['GITLEAKS_CONFIG_TOML'] = 'title = "no rules"\n';
    expect(scanFolder(dir).map((f) => f.rule)).toEqual(['aws-access-token']);
  });

  it('a .gitleaksignore or .gitleaks.toml among the files is refused, so neither can hide a finding', () => {
    for (const name of ['.gitleaksignore', '.gitleaks.toml']) {
      const dir = temp();
      writeFileSync(join(dir, 'aws.txt'), `id ${AWS_KEY}\n`);
      writeFileSync(join(dir, name), 'aws.txt:aws-access-token:1\n');
      expect(() => scanFolder(dir), name).toThrow(
        new SecretScanRefused(`${name} is among the scanned files: no tracked file may be one (R5)`),
      );
    }
    const repo = temp();
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', '.gitleaksignore'), 'x\n');
    git(repo, 'add', '.');
    expect(() => scanTracked(repo)).toThrow(
      new SecretScanRefused('sub/.gitleaksignore: no tracked file may be a gitleaks configuration (R5)'),
    );
  });

  it('no tracked file outside the plans holds an in-file allowance, nor is a gitleaks configuration (R5, A4)', () => {
    const root = join(import.meta.dirname, '..', '..');
    // The marker is built from parts, so this file does not hold it.
    const marker = ['gitleaks', 'allow'].join(':');
    // git grep exits 1 when nothing matches, 0 when something does.
    const grep = spawnSync('git', ['grep', '-l', '-F', marker, '--', '.', ':!docs/plans'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect([grep.status, grep.stdout]).toEqual([1, '']);
  });

  it('a gitleaks missing, or outside 8.30.1 to below 9, is refused, naming brew install gitleaks', () => {
    expect(() => gitleaksVersion({ bin: join(temp(), 'gitleaks') })).toThrow(
      new SecretScanRefused('gitleaks is not installed: brew install gitleaks'),
    );
    for (const [version, message] of [
      ['8.30.0', 'gitleaks 8.30.0 is outside 8.30.1 to below 9: brew install gitleaks'],
      ['9.0.0', 'gitleaks 9.0.0 is outside 8.30.1 to below 9: brew install gitleaks'],
      ['dev', 'gitleaks version printed no version (exit 0): brew install gitleaks'],
    ] as const) {
      const bin = join(temp(), 'gitleaks');
      writeFileSync(bin, `#!/bin/sh\necho ${version}\n`);
      chmodSync(bin, 0o755);
      expect(() => gitleaksVersion({ bin }), version).toThrow(new SecretScanRefused(message));
    }
  });
});
