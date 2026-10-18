// The release tests' fixture (tests/unit/release.test.ts, tests/unit/release-tap.test.ts): a committed repository
// shaped like the harness, the release script run in it, and the npm caches its build installs from. Each test file
// calls useReleaseFixture() once, at its top level: it registers the hooks that make the caches and remove every
// folder a test made, and returns the helpers that use them.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll } from 'vitest';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'tools', 'release', 'pack.mts');
/** The build's last step (debt-paydown R10): the fixture's build runs it, as `npm run build` does. */
const AGENT_PACKAGES_STEP = join(REPO_ROOT, 'tools', 'agent-packages', 'build.mts');
export const VERSION = '1.2.3';
export const ENTRIES = [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_LICENSES.md',
  'asha',
  'catalogue',
  'decider',
  'dist',
  'harness-images',
  'images',
  'modules',
  'node_modules',
  'package-lock.json',
  'package.json',
  'portal',
  'recipes',
  'teams',
];

/** What `npm run --silent` and `npm run --dry-run` hand every npm a script starts, a build's included. */
export const LEAKED_BY_NPM_RUN = { npm_config_loglevel: 'silent', npm_config_dry_run: 'true' };

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args], {
    cwd: repo,
    encoding: 'utf8',
  }).trim();
}

export function write(repo: string, file: string, text: string): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
}

/** What useReleaseFixture returns: the npm caches, the folders to remove after each test, and the helpers. */
export interface ReleaseFixture {
  /** The private npm caches: `full` holds both packages, `noSub` only dep (filled before the file's first test). */
  readonly cache: { readonly full: string; readonly noSub: string };
  /** Folders a test made, removed after it; a test adds its own. */
  readonly repos: string[];
  /** The environment with no npm_config_* of the caller's, npm pointed at `npmCache` and empty npmrc files. */
  readonly npmEnv: (npmCache: string, extra?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  /** A committed repo shaped like the harness, tagged v1.2.3 at HEAD. Its build writes dist/. */
  readonly makeRepo: () => string;
  /** A Homebrew trust store of its own, holding these entries or none: the XDG_CONFIG_HOME to give the release. */
  readonly trustStore: (store?: {
    readonly trustedtaps?: readonly string[];
    readonly trustedformulae?: readonly string[];
  }) => string;
  /** The release script run in `repo`, bounded at 60 s: its status and output. */
  readonly release: (
    repo: string,
    npmCache?: string,
    extraEnv?: NodeJS.ProcessEnv,
  ) => { status: number | null; stdout: string; stderr: string };
}

/**
 * The build installs the agent packages with `npm ci --offline`, from the npm cache (tools/agent-packages/build.mts),
 * and the release copies them from dist/agent-packages/. The fixture's packages are
 * `npm pack`ed once into tarballs and added (`npm cache add`) to caches private to this file, so no run reaches the
 * network or the developer's own cache: FULL holds both packages, NO_SUB only dep. The lockfile names them by a
 * registry.invalid url and the tarballs' sha512 integrity, which is what npm looks the cache up by.
 */
export function useReleaseFixture(): ReleaseFixture {
  const repos: string[] = [];
  afterEach(() => {
    for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  let fixtures = '';
  const integrity: Record<string, string> = {};
  const cache = { full: '', noSub: '' };
  beforeAll(() => {
    fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'asha-release-npm-')));
    write(fixtures, 'npmrc-user', '');
    write(fixtures, 'npmrc-global', '');
    // What the registry holds: runtime files, a type declaration and a source map.
    write(fixtures, 'src/dep/package.json', '{"name":"dep","version":"1.0.0","dependencies":{"sub":"2.0.0"}}\n');
    write(fixtures, 'src/dep/index.js', 'module.exports = 1;\n');
    write(fixtures, 'src/dep/index.d.ts', 'export {};\n');
    write(fixtures, 'src/dep/index.js.map', '{}\n');
    write(fixtures, 'src/sub/package.json', '{"name":"sub","version":"2.0.0"}\n');
    write(fixtures, 'src/sub/lib.js', 'module.exports = 2;\n');
    mkdirSync(join(fixtures, 'tarballs'));
    mkdirSync(join(fixtures, 'cache-full'));
    mkdirSync(join(fixtures, 'cache-no-sub'));
    cache.full = join(fixtures, 'cache-full');
    cache.noSub = join(fixtures, 'cache-no-sub');
    const npm = (...args: string[]): void => {
      execFileSync('npm', args, { cwd: fixtures, env: npmEnv(cache.full), stdio: ['ignore', 'ignore', 'pipe'] });
    };
    npm(
      'pack',
      join(fixtures, 'src', 'dep'),
      join(fixtures, 'src', 'sub'),
      '--pack-destination',
      join(fixtures, 'tarballs'),
    );
    for (const [name, version] of [
      ['dep', '1.0.0'],
      ['sub', '2.0.0'],
    ] as const) {
      const tarball = join(fixtures, 'tarballs', `${name}-${version}.tgz`);
      integrity[name] = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`;
      npm('cache', 'add', tarball, '--cache', cache.full);
      if (name === 'dep') npm('cache', 'add', tarball, '--cache', cache.noSub);
    }
  });
  afterAll(() => {
    rmSync(fixtures, { recursive: true, force: true });
  });

  /** The environment with no npm_config_* of the caller's (npm run sets many), npm pointed at a private cache and empty npmrc files. */
  function npmEnv(npmCache: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toLowerCase().startsWith('npm_config_')),
    );
    return {
      ...env,
      ...extra,
      npm_config_cache: npmCache,
      npm_config_userconfig: join(fixtures, 'npmrc-user'),
      npm_config_globalconfig: join(fixtures, 'npmrc-global'),
    };
  }

  /** A committed repo shaped like the harness, tagged v1.2.3 at HEAD. Its build writes dist/. */
  function makeRepo(): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'asha-release-')));
    repos.push(repo);
    git(repo, 'init', '--quiet', '--initial-branch=main');
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Release Test');
    // The build also compiles every image, the test-only one included: its dist/ output must not ship either.
    const build =
      "const f=require('fs');f.mkdirSync('dist/src/cli',{recursive:true});f.writeFileSync('dist/src/cli/main.js','built\\n');f.mkdirSync('dist/images/agent/src',{recursive:true});f.writeFileSync('dist/images/agent/src/main.js','built\\n');f.mkdirSync('dist/images/suite-fixture/src',{recursive:true});f.writeFileSync('dist/images/suite-fixture/src/main.js','test only\\n');f.mkdirSync('dist/portal-build/src/portal',{recursive:true});f.writeFileSync('dist/portal-build/src/portal/app.js','built\\n')";
    const buildScript = `node -e "${build}" && node --experimental-strip-types --disable-warning=ExperimentalWarning "${AGENT_PACKAGES_STEP}"`;
    write(
      repo,
      'package.json',
      `${JSON.stringify({ name: 'x', version: VERSION, scripts: { build: buildScript }, dependencies: { dep: '1.0.0' }, devDependencies: { devdep: '1.0.0' } }, null, 2)}\n`,
    );
    // One runtime package that needs another, and one dev package: only the first two ship (debt D15).
    const lock = {
      name: 'x',
      version: VERSION,
      lockfileVersion: 3,
      packages: {
        '': { name: 'x', version: VERSION, dependencies: { dep: '1.0.0' }, devDependencies: { devdep: '1.0.0' } },
        'node_modules/dep': {
          version: '1.0.0',
          resolved: 'https://registry.invalid/dep/-/dep-1.0.0.tgz',
          integrity: integrity['dep'],
          dependencies: { sub: '2.0.0' },
        },
        'node_modules/sub': {
          version: '2.0.0',
          resolved: 'https://registry.invalid/sub/-/sub-2.0.0.tgz',
          integrity: integrity['sub'],
        },
        // Never fetched (--omit=dev), so it is in no cache.
        'node_modules/devdep': {
          version: '1.0.0',
          resolved: 'https://registry.invalid/devdep/-/devdep-1.0.0.tgz',
          integrity: 'sha512-AAAA',
          dev: true,
        },
      },
    };
    write(repo, 'package-lock.json', `${JSON.stringify(lock, null, 2)}\n`);
    write(repo, '.gitignore', 'dist/\nbuild/\n.DS_Store\nnode_modules/\n');
    write(repo, 'LICENSE', 'Apache License\n');
    // The README and the third-party licences ship with the code (docs/plans/oss-release.md R30).
    write(repo, 'README.md', '# x\n');
    write(repo, 'THIRD_PARTY_LICENSES.md', '# Third-party licences\n');
    write(repo, 'asha', '#!/usr/bin/env bash\n');
    write(repo, 'catalogue/model.json', '{}\n');
    write(repo, 'decider/launch.py', 'import sys\n');
    write(repo, 'images/agent/Dockerfile', 'FROM scratch\n');
    write(repo, 'recipes/hello.json', '{}\n');
    // The portal's page (docs/plans/portal.md R17).
    write(repo, 'portal/index.html', '<!doctype html>\n');
    write(repo, 'teams/demo/team.json', '{}\n');
    // extension-modules R37: the reference modules and the harness's own images ship; test fixtures under tests/ do not.
    write(repo, 'modules/tavily/module.json', '{}\n');
    write(repo, 'harness-images/module-base/Dockerfile', 'FROM scratch\n');
    write(repo, 'tests/fixtures/modules/fixture_tool/module.json', '{}\n');
    // The agent suite's fixture teams are committed but never shipped.
    write(repo, 'teams/suite-fixture/team.json', '{}\n');
    // And its test-only images (agent-persistence A17): committed, never shipped, source or build.
    write(repo, 'images/suite-fixture/Dockerfile', 'FROM scratch\n');
    // And the eval's test-only recipes (agent-files A9): committed, never shipped.
    write(repo, 'recipes/suite-fixture.json', '{}\n');
    // Not part of a release: proves the tarball holds only its entries.
    write(repo, 'src/index.ts', 'export {};\n');
    git(repo, 'add', '--all');
    git(repo, 'commit', '--quiet', '-m', 'initial');
    git(repo, 'tag', '-a', `v${VERSION}`, '-m', `v${VERSION}`);
    // Ignored files inside shipped directories: the tarball must not hold them.
    write(repo, 'images/.DS_Store', 'finder\n');
    write(repo, 'images/agent/node_modules/evil/x.js', 'stray\n');
    // The checkout's installed packages (ignored by git), at the locked versions but not as the registry holds them:
    // a stray Finder file, a secret, and a locally edited file. None of it ships: the build installs from the cache.
    write(repo, 'node_modules/dep/package.json', '{"name":"dep","version":"1.0.0"}\n');
    write(repo, 'node_modules/dep/index.js', 'module.exports = "edited in the checkout";\n');
    write(repo, 'node_modules/dep/.DS_Store', 'finder\n');
    write(repo, 'node_modules/dep/.env', 'SECRET=1\n');
    write(repo, 'node_modules/sub/package.json', '{"name":"sub","version":"2.0.0"}\n');
    write(repo, 'node_modules/sub/lib.js', 'module.exports = 2;\n');
    write(repo, 'node_modules/devdep/package.json', '{"name":"devdep","version":"1.0.0"}\n');
    write(repo, 'node_modules/devdep/x.js', 'dev only\n');
    return repo;
  }

  /**
   * A Homebrew trust store of its own (debt-paydown-2 R9): `$XDG_CONFIG_HOME/homebrew/trust.json` holding these entries,
   * or none; so the owner's store never decides a test. Returns the XDG_CONFIG_HOME to give the release.
   */
  function trustStore(store?: {
    readonly trustedtaps?: readonly string[];
    readonly trustedformulae?: readonly string[];
  }): string {
    const xdg = realpathSync(mkdtempSync(join(tmpdir(), 'asha-release-xdg-')));
    repos.push(xdg);
    mkdirSync(join(xdg, 'homebrew'), { mode: 0o700 });
    if (store !== undefined)
      writeFileSync(join(xdg, 'homebrew', 'trust.json'), `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    return xdg;
  }

  function release(
    repo: string,
    npmCache = cache.full,
    extraEnv: NodeJS.ProcessEnv = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', SCRIPT],
      {
        cwd: repo,
        // Every release reads the trust store it is given, an empty one unless the case names another (R9).
        env: npmEnv(npmCache, { XDG_CONFIG_HOME: trustStore(), ...extraEnv }),
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  return { cache, repos, npmEnv, makeRepo, trustStore, release };
}

export function formula(values: { url: string; sha256: string; commit: string }): string {
  return `# Generated by tools/release/pack.mts (npm run release); do not edit by hand.
# Built from harness commit ${values.commit}.
class Asha < Formula
  desc "Autonomous Simple Harness for Agents: local multi-agent harness"
  homepage "https://simplyautonomous.ai"
  url "${values.url}"
  sha256 "${values.sha256}"
  # PolyForm Noncommercial or Small Business, at the user's choice, with a condition SPDX cannot express
  # (LICENSE's second Required Notice line; docs.brew.sh, Licence Guidelines, read 2026-10-12).
  license :cannot_represent

  depends_on "colima"
  depends_on "docker"
  depends_on "llama.cpp"
  depends_on "node"

  def install
    libexec.install "asha", "catalogue", "dist", "harness-images", "images", "modules", "node_modules"
    libexec.install "package-lock.json", "package.json", "portal", "recipes", "teams"
    # Homebrew moves a LICENSE left in the build directory to the keg's root; this copy stays in libexec.
    cp "LICENSE", libexec
    # node first; then Homebrew's bin, so colima, docker and llama-server resolve
    # even when the caller's PATH lacks it.
    (bin/"asha").write_env_script libexec/"asha", PATH: "#{formula_opt_bin("node")}:#{HOMEBREW_PREFIX}/bin:$PATH"
  end

  def caveats
    <<~EOS
      Run \`asha --stop\` before \`brew upgrade asha\` or \`brew uninstall asha\`:
      a running daemon keeps using the files of the version that started it.

      asha keeps its user data in ~/.simplyautonomous/harness (ASHA_HOME),
      which \`brew uninstall asha\` keeps.
    EOS
  end

  test do
    assert_match "usage:", shell_output("#{bin}/asha --help")
  end
end
`;
}
