// The release script (tools/release/pack.mts, `npm run release`), run for real
// against a temporary git repository, and the guard that src/ has no install-mode
// branch. Plan: docs/plans/brew-install.md, R2–R4, R6, R8–R12, R14; A9, A11. Its check of
// the local tap's trust is in release-tap.test.ts, run beside this file: one of its cases
// waits out the release's 30 s bound on brew. The fixture: tests/helpers/release-fixture.ts.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { copyAgentPackages } from '../../src/daemon/images/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import {
  ENTRIES,
  LEAKED_BY_NPM_RUN,
  REPO_ROOT,
  VERSION,
  formula,
  git,
  useReleaseFixture,
  write,
} from '../helpers/release-fixture.js';

const { cache, repos, npmEnv, makeRepo, release } = useReleaseFixture();

describe('npm run release (tools/release/pack.mts)', () => {
  it('ships every directory the daemon reads its definitions from (Definitions in src/daemon/definitions/index.ts)', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'daemon', 'definitions', 'index.ts'),
      'utf8',
    );
    const read = [
      ...new Set(
        [...source.matchAll(/join\(this\.root, '([a-z]+)'/g)].map((m) => present(m[1], "the directory name's group")),
      ),
    ].sort(byCodeUnit);
    // Found by the same pattern that would find a new one: a directory added there and not shipped fails here.
    expect(read).toEqual(['catalogue', 'images', 'recipes', 'teams']);
    expect(read.filter((dir) => !ENTRIES.includes(dir))).toEqual([]);
  });

  it("fails when the build left out the portal's compiled modules, naming what is missing (docs/plans/portal.md R17)", () => {
    const repo = makeRepo();
    // A build that compiles everything but the page.
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')) as { scripts: { build: string } };
    pkg.scripts.build = pkg.scripts.build.replace(
      ";f.mkdirSync('dist/portal-build/src/portal',{recursive:true});f.writeFileSync('dist/portal-build/src/portal/app.js','built\\n')",
      '',
    );
    write(repo, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
    git(repo, 'commit', '--quiet', '--all', '-m', 'no portal build');
    git(repo, 'tag', '-f', '-a', `v${VERSION}`, '-m', `v${VERSION}`);
    const result = release(repo);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/lacks the portal's dist\/portal-build\/src\/portal\/app\.js/);
  });

  it('refuses a dirty working tree, writing nothing', () => {
    const repo = makeRepo();
    write(repo, 'stray.txt', 'uncommitted\n');
    const result = release(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('release: the working tree is not clean (git status --porcelain):\n?? stray.txt\n');
    expect(existsSync(join(repo, 'build'))).toBe(false);
    expect(existsSync(join(repo, 'dist'))).toBe(false);
  });

  it('refuses a modified tracked file, writing nothing', () => {
    const repo = makeRepo();
    write(repo, 'LICENSE', 'changed\n');
    const result = release(repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('release: the working tree is not clean (git status --porcelain):\n M LICENSE\n');
    expect(existsSync(join(repo, 'build'))).toBe(false);
  });

  it('refuses when HEAD is not the commit tagged v<version>, writing nothing', () => {
    const repo = makeRepo();
    write(repo, 'LICENSE', 'changed\n');
    git(repo, 'commit', '--quiet', '-am', 'after the tag');
    const head = git(repo, 'rev-parse', 'HEAD');
    const tagged = git(repo, 'rev-parse', `v${VERSION}^{commit}`);
    const result = release(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`release: HEAD (${head}) is not the commit tagged v${VERSION} (${tagged})\n`);
    expect(existsSync(join(repo, 'build'))).toBe(false);
    expect(existsSync(join(repo, 'dist'))).toBe(false);
  });

  it('refuses when there is no tag v<version>, writing nothing', () => {
    const repo = makeRepo();
    git(repo, 'tag', '-d', `v${VERSION}`);
    const result = release(repo);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`release: there is no tag v${VERSION} (package.json version ${VERSION})\n`);
    expect(existsSync(join(repo, 'build'))).toBe(false);
  });

  it('builds, writes the tarball and the formula, promotes the run directory, and prints the four values', () => {
    const repo = makeRepo();
    const commit = git(repo, 'rev-parse', 'HEAD');
    const result = release(repo);
    expect(result.stderr).not.toMatch(/^release:/m);
    expect(result.status).toBe(0);

    const out = join(repo, 'build', 'release', `v${VERSION}`);
    const tarball = join(out, `asha-${VERSION}.tar.gz`);
    const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
    const url = `file://${tarball}`;
    expect(result.stdout).toBe(`version: ${VERSION}\ncommit: ${commit}\nsha256: ${sha256}\nurl: ${url}\n`);

    // The run directory was promoted: only v<version>/ remains, holding exactly the two files.
    expect(readdirSync(join(repo, 'build', 'release'))).toEqual([`v${VERSION}`]);
    expect(readdirSync(out).sort(byCodeUnit)).toEqual([`asha-${VERSION}.tar.gz`, 'asha.rb']);

    // One top-level directory, holding exactly the seven entries of R2, and the built code.
    const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
    expect(entries.filter((entry) => !entry.startsWith(`asha-${VERSION}/`))).toEqual([]);
    const topLevel = new Set(
      entries
        .map((entry) => present(entry.split('/')[1], `${entry}: no path segment after the top directory`))
        .filter((name) => name !== ''),
    );
    expect([...topLevel].sort(byCodeUnit)).toEqual(ENTRIES);
    expect(entries).toContain(`asha-${VERSION}/dist/src/cli/main.js`);
    expect(entries).toContain(`asha-${VERSION}/images/agent/Dockerfile`);
    // Exactly the committed files and the build: ignored files in the checkout are left out.
    expect(entries.filter((entry) => !entry.endsWith('/')).sort(byCodeUnit)).toEqual(
      [
        'LICENSE',
        'README.md',
        'THIRD_PARTY_LICENSES.md',
        'asha',
        'catalogue/model.json',
        // The decision model's launcher (docs/plans/decider-tool.md R3).
        'decider/launch.py',
        // What an installation stages agent images from (debt-paydown R11).
        'dist/agent-packages/node_modules/dep/index.js',
        'dist/agent-packages/node_modules/dep/package.json',
        'dist/agent-packages/node_modules/sub/lib.js',
        'dist/agent-packages/node_modules/sub/package.json',
        'dist/agent-packages/package-lock.json',
        'dist/agent-packages/package.json',
        'dist/images/agent/src/main.js',
        'dist/portal-build/src/portal/app.js',
        'dist/src/cli/main.js',
        'harness-images/module-base/Dockerfile',
        'images/agent/Dockerfile',
        'modules/tavily/module.json',
        'node_modules/dep/index.js',
        'node_modules/dep/package.json',
        'node_modules/sub/lib.js',
        'node_modules/sub/package.json',
        'package-lock.json',
        'package.json',
        'portal/index.html',
        'recipes/hello.json',
        'teams/demo/team.json',
      ].map((file) => `asha-${VERSION}/${file}`),
    );

    // The packages are the registry's: not the checkout's edited file, and none of its stray files (listed above).
    const read = (file: string): string =>
      execFileSync('tar', ['-xOzf', tarball, `asha-${VERSION}/${file}`], { encoding: 'utf8' });
    expect(read('node_modules/dep/index.js')).toBe('module.exports = 1;\n');
    expect(read('node_modules/sub/lib.js')).toBe('module.exports = 2;\n');

    expect(readFileSync(join(out, 'asha.rb'), 'utf8')).toBe(formula({ url, sha256, commit }));
  });

  // Debt D15: an installation stages agent images from its own node_modules and lockfile, so the release must hold
  // exactly what staging needs. Unpack it and run staging's own copy against it.
  it('unpacks to an installation that staging can copy the agent packages from', async () => {
    const repo = makeRepo();
    expect(release(repo).status).toBe(0);
    const unpacked = realpathSync(mkdtempSync(join(tmpdir(), 'asha-unpacked-')));
    repos.push(unpacked);
    execFileSync('tar', [
      '-xzf',
      join(repo, 'build', 'release', `v${VERSION}`, `asha-${VERSION}.tar.gz`),
      '-C',
      unpacked,
    ]);
    const installation = join(unpacked, `asha-${VERSION}`);
    const staged = join(unpacked, 'staged');
    // What an installation stages from (debt-paydown R11): dist/agent-packages/, shipped inside dist/.
    expect(await copyAgentPackages(join(installation, 'dist', 'agent-packages'), staged)).toEqual([
      'node_modules/dep',
      'node_modules/sub',
    ]);
    expect(readdirSync(join(staged, 'node_modules')).sort(byCodeUnit)).toEqual(['dep', 'sub']);
  });

  it("ships the lockfile's version of a package the checkout has installed at another", () => {
    const repo = makeRepo();
    write(repo, 'node_modules/sub/package.json', '{"name":"sub","version":"2.0.1"}\n');
    expect(release(repo).status).toBe(0);
    const tarball = join(repo, 'build', 'release', `v${VERSION}`, `asha-${VERSION}.tar.gz`);
    const shipped = execFileSync('tar', ['-xOzf', tarball, `asha-${VERSION}/node_modules/sub/package.json`], {
      encoding: 'utf8',
    });
    expect(shipped).toBe('{"name":"sub","version":"2.0.0"}\n');
  });

  // `npm run --silent release` (the documented command) and `npm run release --dry-run` pass npm_config_loglevel and
  // npm_config_dry_run to every npm the script starts, its build's included; the install must not inherit them
  // (adversarial review of d231ad0).
  for (const [label, extraEnv] of [
    ['', {}],
    [' under npm run --silent --dry-run', LEAKED_BY_NPM_RUN],
  ] as const) {
    it(`fails at its build, writing no release, when the npm cache lacks a locked package, naming npm ci as the fix${label}`, () => {
      const repo = makeRepo();
      const result = release(repo, cache.noSub, extraEnv);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      // The build's agent-packages step refused (debt-paydown R10), so the build failed, and the release with it.
      expect(result.stderr.split('\n')).toContain(
        'build: the npm cache does not hold an intact copy of https://registry.invalid/sub/-/sub-2.0.0.tgz, which package-lock.json locks; run npm ci in the checkout, then retry',
      );
      expect(result.stderr).toMatch(/npm run build exited 1/);
      expect(existsSync(join(repo, 'build'))).toBe(false);
    });
  }

  it('releases under npm run --silent --dry-run, its agent packages from the build', () => {
    const repo = makeRepo();
    const result = release(repo, cache.full, LEAKED_BY_NPM_RUN);
    expect(result.stderr).not.toMatch(/^release:/m);
    expect(result.status).toBe(0);
    const tarball = join(repo, 'build', 'release', `v${VERSION}`, `asha-${VERSION}.tar.gz`);
    const shipped = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
      .split('\n')
      .filter((entry) => entry.startsWith(`asha-${VERSION}/node_modules/`) && !entry.endsWith('/'));
    expect(shipped.toSorted(byCodeUnit)).toEqual(
      ['dep/index.js', 'dep/package.json', 'sub/lib.js', 'sub/package.json'].map(
        (file) => `asha-${VERSION}/node_modules/${file}`,
      ),
    );
  });

  it('fails at its build, writing no release, when the lockfile marks an agent package dev', () => {
    const repo = makeRepo();
    const lock = JSON.parse(readFileSync(join(repo, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { dev?: boolean }>;
    };
    present(lock.packages['node_modules/sub'], "lock.packages['node_modules/sub']").dev = true;
    write(repo, 'package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
    git(repo, 'commit', '--quiet', '-am', 'sub is dev');
    git(repo, 'tag', '-f', '-a', `v${VERSION}`, '-m', `v${VERSION}`);
    const result = release(repo);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.split('\n')).toContain(
      'build: package-lock.json: node_modules/sub is marked dev, but an agent image needs it at run time',
    );
    expect(existsSync(join(repo, 'build'))).toBe(false);
  });

  it('refuses a second release of the same version, leaving the first untouched', () => {
    const repo = makeRepo();
    expect(release(repo).status).toBe(0);
    const out = join(repo, 'build', 'release', `v${VERSION}`);
    const before = readFileSync(join(out, `asha-${VERSION}.tar.gz`));

    const again = release(repo);
    expect(again.status).toBe(1);
    expect(again.stdout).toBe('');
    expect(again.stderr).toBe(`release: ${out} already exists; a release is never overwritten\n`);
    expect(readdirSync(join(repo, 'build', 'release'))).toEqual([`v${VERSION}`]);
    expect(readFileSync(join(out, `asha-${VERSION}.tar.gz`)).equals(before)).toBe(true);
  });
});

describe("npm run build's agent-packages step (tools/agent-packages/build.mts; debt-paydown R10, R11, A9)", () => {
  /** Runs the fixture's `npm run build`, with npm's environment as a caller's npm run leaves it. */
  function build(
    repo: string,
    npmCache: string,
    extraEnv: NodeJS.ProcessEnv = {},
  ): { status: number | null; stderr: string } {
    const result = spawnSync('npm', ['run', 'build'], {
      cwd: repo,
      env: npmEnv(npmCache, extraEnv),
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (result.error) throw result.error;
    return { status: result.status, stderr: result.stderr };
  }
  const filesUnder = (dir: string): string[] =>
    execFileSync('find', ['.', '-type', 'f'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').sort(byCodeUnit);

  it('fills dist/agent-packages from a clean install: the locked packages as published, their lockfile beside them, no install folder left', () => {
    const repo = makeRepo();
    const result = build(repo, cache.full);
    expect(result.status, result.stderr).toBe(0);
    const out = join(repo, 'dist', 'agent-packages');
    expect(readdirSync(join(repo, 'dist')).sort(byCodeUnit)).toEqual([
      'agent-packages',
      'images',
      'portal-build',
      'src',
    ]);
    expect(filesUnder(out)).toEqual([
      './node_modules/dep/index.js',
      './node_modules/dep/package.json',
      './node_modules/sub/lib.js',
      './node_modules/sub/package.json',
      './package-lock.json',
      './package.json',
    ]);
    // The registry's file, not the checkout's edited one; the checkout's .DS_Store and .env are not there (listed above).
    expect(readFileSync(join(out, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('module.exports = 1;\n');
    expect(readFileSync(join(out, 'package-lock.json'), 'utf8')).toBe(
      readFileSync(join(repo, 'package-lock.json'), 'utf8'),
    );
  });

  // Moved here from the release's tests (debt-paydown R11): `npm run --silent build --dry-run` passes
  // npm_config_dry_run and npm_config_loglevel to the step's npm ci, which must not inherit them.
  it('installs the agent packages under npm run --silent --dry-run', () => {
    const repo = makeRepo();
    const result = build(repo, cache.full, LEAKED_BY_NPM_RUN);
    expect(result.status, result.stderr).toBe(0);
    expect(filesUnder(join(repo, 'dist', 'agent-packages', 'node_modules'))).toEqual([
      './dep/index.js',
      './dep/package.json',
      './sub/lib.js',
      './sub/package.json',
    ]);
  });

  it('fails the build when the npm cache lacks a locked package, naming it and npm ci as the fix', () => {
    const repo = makeRepo();
    const result = build(repo, cache.noSub);
    expect(result.status).not.toBe(0);
    expect(result.stderr.split('\n')).toContain(
      'build: the npm cache does not hold an intact copy of https://registry.invalid/sub/-/sub-2.0.0.tgz, which package-lock.json locks; run npm ci in the checkout, then retry',
    );
    expect(existsSync(join(repo, 'dist', 'agent-packages'))).toBe(false);
  });
});

describe('the formula template (tools/release/asha.rb.in)', () => {
  // brew audit --strict rejects a line over 118 characters. A 119-character comment passed every test here and
  // failed the audit of the v0.1.0 release (2026-09-27), so the limit is checked where it is cheapest.
  it('has no line longer than brew audit --strict allows (118 characters)', () => {
    const lines = readFileSync(join(REPO_ROOT, 'tools', 'release', 'asha.rb.in'), 'utf8').split('\n');
    const long = lines
      .map((line, i) => `${String(i + 1)}: ${String(line.length)}`)
      .filter((_, i) => present(lines[i], `lines[${String(i)}]`).length > 118);
    expect(long).toEqual([]);
  });
});

describe('install mode (R3, R9)', () => {
  /**
   * The one line excepted, by file and exact text (the owner's answer to decision release-guard-decider-python, (a),
   * 2026-10-11): the decider's Python named by its Homebrew path, as decider-tool R2 requires. It is a host tool's fixed
   * path, the same however asha was installed, not a switch on that. Any other match, or a change to the line, fails;
   * so does the line's removal, so the exception goes with it.
   */
  const EXCEPTED = ["src/daemon/decider/layout.ts:export const DECIDER_PYTHON = '/opt/homebrew/bin/python3.14';"];

  it('src/ has no install-mode branch and no Homebrew path but the one excepted line: grep -rnE finds nothing else', () => {
    // grep exits 1 for no match, 0 for matches, 2 for an error: 2 fails.
    const result = spawnSync('grep', ['-rnE', 'HOMEBREW|homebrew|Cellar|brew --prefix|libexec', 'src'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    expect(result.stderr).toBe('');
    expect(result.status === 0 || result.status === 1, `grep exited ${String(result.status)}`).toBe(true);
    const matches = result.stdout.split('\n').filter((line) => line !== '');
    // Compared without the line number, so the line may move within its file; reported with it.
    const textOf = (line: string): string => line.replace(/^([^:]+):\d+:/, '$1:');
    expect(matches.filter((line) => !EXCEPTED.includes(textOf(line)))).toEqual([]);
    expect(
      matches.map(textOf),
      'grep must find exactly the excepted line, once: none means remove its exception',
    ).toEqual(EXCEPTED);
  });
});
