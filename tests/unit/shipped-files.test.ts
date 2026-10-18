// No shipped file names a machine (docs/plans/oss-release.md R11, A9): every file the export ships (tools/oss/
// manifest.json; in a published clone, every tracked file) is read, its bytes as Latin-1 so a binary file is read too,
// and fails on a home folder's path (`/Users/<name>/`, `/home/<name>/`) whose name is not a placeholder below, a path
// into a `.claude/` folder (where Claude Code keeps sessions, under a home folder) that is not a fabricated test value
// below, a macOS temporary folder of a real machine (`/var/folders/<2>/<20 or more>/`, the shape of `$TMPDIR`), a path
// into a home folder's Documents, Desktop or Downloads (`~/Documents/<…>`: a person's files; added 2026-10-16, after a
// probe copy held another project's model path there, PRINCIPLES §21), or a
// private IPv4 address (10/8, 172.16/12, 192.168/16) that is not allowed below in that file. Each allow-list entry
// carries its reason; this file may name every listed address, and builds its planted values from parts at run time,
// so it holds no offence itself. Each offence is named by file and line.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { readManifest, shipped } from '../../tools/oss/manifest.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const SELF = 'tests/unit/shipped-files.test.ts';

/** Home-folder names that are placeholders in docs and tests, never a person's login. */
const PLACEHOLDER_NAMES: Readonly<Record<string, string>> = {
  me: "the CLI page's and its tests' example user (`/Users/me/report.pdf`)",
  you: "the CLI page's example of a path in the reader's own home folder",
  someone: 'a fabricated home in the transcript and demo-selector tests',
  u: 'a fabricated home in the container, module, plugin and CLI tests',
  x: 'a fabricated home in the server-files tests',
  zora: 'a fabricated home in the demo-recorder and user-id tests',
};

/** Paths into a `.claude/` folder that are fabricated test values. */
const FABRICATED_CLAUDE_PATHS: Readonly<Record<string, string>> = {
  '.claude/worktrees/agent-x/src/x.ts': "the lint test's file in a repository-local agent worktree, which ESLint skips",
};

/** Each private address allowed, the files it is allowed in (a trailing / names a folder), and why. */
const ALLOWED_ADDRESSES: Readonly<Record<string, { readonly in: readonly string[]; readonly why: string }>> = {
  '192.168.5.0': {
    in: ['src/daemon/container-runtime/', 'src/egress-proxy/', 'docs/architecture/'],
    why: "colima's VM network, 192.168.5.0/24, the same on every Mac",
  },
  '192.168.5.1': { in: ['docs/', 'tests/', 'src/'], why: "colima's VM on its host network (lima's user-mode network)" },
  '192.168.5.2': {
    in: ['docs/', 'tests/', 'src/', 'images/', 'harness-images/', 'modules/'],
    why: "the host as colima's VM routes to it (HOST_GATEWAY)",
  },
  '192.168.5.9': {
    in: ['tests/unit/container-runtime.test.ts'],
    why: 'an address on the colima network, a test value',
  },
  '172.17.0.1': { in: ['docs/testing/', 'tests/', 'src/'], why: "Docker's default bridge gateway in the VM" },
  '10.0.0.1': {
    in: ['docs/testing/', 'tests/'],
    why: "the module sandbox's unroutable target (modules-sandbox.test.ts)",
  },
  '172.16.0.1': {
    in: ['docs/testing/', 'tests/'],
    why: "the module sandbox's unroutable target (modules-sandbox.test.ts)",
  },
  '10.0.0.0': {
    in: ['src/daemon/container-runtime/index.ts', 'src/egress-proxy/proxy.ts'],
    why: 'the base of RFC 1918 range 10.0.0.0/8, which the egress rules refuse',
  },
  '172.16.0.0': {
    in: ['src/daemon/container-runtime/index.ts', 'src/egress-proxy/proxy.ts'],
    why: 'the base of RFC 1918 range 172.16.0.0/12',
  },
  '192.168.0.0': {
    in: ['src/daemon/container-runtime/index.ts', 'src/egress-proxy/proxy.ts'],
    why: 'the base of RFC 1918 range 192.168.0.0/16',
  },
  '172.18.0.0': { in: ['tests/unit/container-runtime.test.ts'], why: "a Docker network's subnet, a test value" },
  '172.18.0.1': { in: ['tests/unit/container-runtime.test.ts'], why: "a Docker network's gateway, a test value" },
  '10.9.0.0': { in: ['tests/unit/container-runtime.test.ts'], why: "a Docker network's subnet, a test value" },
  '172.20.0.0': {
    in: ['tests/agents/p20-a/run-1.json'],
    why: "the recorded run's Docker network, created in colima's VM",
  },
  '172.30.0.3': { in: ['tests/unit/module-runtime.test.ts'], why: "a module container's address, a test value" },
  '172.31.0.2': { in: ['tests/unit/module-runtime.test.ts'], why: "a module container's address, a test value" },
  '10.99.0.2': { in: ['tests/unit/modules-host.test.ts'], why: "a module container's address, a test value" },
  '10.99.1.2': { in: ['tests/unit/modules-host.test.ts'], why: "a module container's address, a test value" },
  '10.1.2.3': { in: ['docs/quality/'], why: "the quality page's account of the agent-address guard's planted address" },
  '192.168.1.10': {
    in: ['docs/quality/'],
    why: "the quality page's account of the agent-address guard's planted LAN address",
  },
};

const HOME = /\/(?:Users|home)\/([^/\s'"`<>)\]]+)\//g;
const CLAUDE = /\.claude\/[\w.-][^\s'"`<>)\]]*/g;
const TEMP = /\/var\/folders\/[^/\s]{2}\/[^/\s]{20,}\//g;
/** A path into a home folder's own documents, as `~/`: a person's files, never the product's (`~/.colima/` is). */
const PERSONAL = /~\/(?:Documents|Desktop|Downloads)\/[^\s'"`<>)\]]+/g;
const PRIVATE = /(?<![\d.])((?:10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3})(?![\d.]*\d)/g;

const allowedIn = (file: string, places: readonly string[]): boolean =>
  places.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));

/** `file:line: what: match` for each offence in `text`, the content of the shipped file `file`. */
function machineData(file: string, text: string): string[] {
  const found: string[] = [];
  text.split('\n').forEach((line, i) => {
    const at = `${file}:${String(i + 1)}`;
    for (const m of line.matchAll(HOME))
      if (!Object.hasOwn(PLACEHOLDER_NAMES, present(m[1], 'HOME capture group 1')))
        found.push(`${at}: a home folder: ${m[0]}`);
    for (const m of line.matchAll(CLAUDE))
      if (!Object.hasOwn(FABRICATED_CLAUDE_PATHS, m[0])) found.push(`${at}: a .claude/ path: ${m[0]}`);
    for (const m of line.matchAll(TEMP)) found.push(`${at}: a machine's temporary folder: ${m[0]}`);
    for (const m of line.matchAll(PERSONAL)) found.push(`${at}: a path in a home folder's documents: ${m[0]}`);
    for (const m of line.matchAll(PRIVATE)) {
      const address = present(m[1], 'PRIVATE capture group 1');
      const allowed = Object.hasOwn(ALLOWED_ADDRESSES, address) ? ALLOWED_ADDRESSES[address] : undefined;
      if (allowed === undefined || !allowedIn(file, [...allowed.in, SELF]))
        found.push(`${at}: a private address: ${address}`);
    }
  });
  return found;
}

describe('no shipped file names a machine (oss-release R11, A9)', () => {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0')
    .filter((f) => f !== '');
  const files = shipped(readManifest(ROOT), tracked);

  it('reads every shipped file, binaries included, and none of the excluded ones', () => {
    expect(files).toEqual(expect.arrayContaining(['docs/testing/agent-tests.html', 'assets/portal-watch.png', 'asha']));
    expect(files.filter((f) => f.startsWith('docs/plans/') || f.startsWith('evals/probes/'))).toEqual([]);
  });

  it('finds no home folder, .claude/ path, temporary folder or private address but the allowed ones', () => {
    expect(files.flatMap((f) => machineData(f, readFileSync(join(ROOT, f), 'latin1')))).toEqual([]);
  });

  it('names a planted home path, .claude/ path, temporary folder and private address by file and line', () => {
    // Each planted value is built here from parts, so this file holds none of them.
    const users = ['', 'Users', 'pat', ''].join('/');
    const home = ['', 'home', 'kim', ''].join('/');
    const session = ['.claude', 'projects', '-Users-pat-repo', 'abc.jsonl'].join('/');
    const temp = ['', 'var', 'folders', '0q', `${'q'.repeat(28)}gn`, ''].join('/');
    const documents = ['~', 'Documents', 'Other', 'models', 'x.gguf'].join('/');
    const planted = [
      'ok: /Users/me/report.pdf and ~/.colima/ and /home/u/x',
      `log: ${users}Library/x and ${home}.ssh/`,
      `session: ~/${session}`,
      `tmp: ${temp}T/asha-x/ but not /var/folders/xy/abc/T/`,
      'lan: 192.168.1.10 and 10.0.0.1 and 192.0.2.1 and 1.10.0.0.1',
      `model: ${documents} but not macOS's protection of ~/Documents, ~/Desktop and ~/Downloads`,
    ].join('\n');
    expect(machineData('src/x.ts', planted)).toEqual([
      `src/x.ts:2: a home folder: ${users}`,
      `src/x.ts:2: a home folder: ${home}`,
      `src/x.ts:3: a .claude/ path: ${session}`,
      `src/x.ts:4: a machine's temporary folder: ${temp}`,
      'src/x.ts:5: a private address: 192.168.1.10',
      'src/x.ts:5: a private address: 10.0.0.1',
      `src/x.ts:6: a path in a home folder's documents: ${documents}`,
    ]);
    // An address allowed in one file is named in another.
    expect(machineData('tests/agents/egress.test.ts', "lan: '192.168.1.10'")).toEqual([
      'tests/agents/egress.test.ts:1: a private address: 192.168.1.10',
    ]);
    expect(machineData('docs/quality/index.md', "lan: '192.168.1.10'")).toEqual([]);
    // A name an object inherits is no placeholder.
    expect(machineData('src/x.ts', ['', 'Users', 'constructor', ''].join('/'))).toEqual([
      `src/x.ts:1: a home folder: ${['', 'Users', 'constructor', ''].join('/')}`,
    ]);
  });

  it('gives every allow-list entry its reason', () => {
    for (const reasons of [Object.values(PLACEHOLDER_NAMES), Object.values(FABRICATED_CLAUDE_PATHS)])
      for (const why of reasons) expect(why.length).toBeGreaterThan(10);
    for (const [address, { in: places, why }] of Object.entries(ALLOWED_ADDRESSES)) {
      expect(places.length, address).toBeGreaterThan(0);
      expect(why.length, address).toBeGreaterThan(10);
    }
  });
});
