// The release script's check of the local tap's trust (tools/release/pack.mts; debt-paydown-2 R9, A9; debt D12), run
// for real against a temporary git repository with a trust store and a fake brew of its own. In a file of its own so
// that it runs beside release.test.ts: one case waits out the release's 30 s bound on a brew that never answers.

import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { useReleaseFixture, write } from '../helpers/release-fixture.js';

const { cache, repos, makeRepo, trustStore, release } = useReleaseFixture();

describe('the release refuses a Mac whose Homebrew trusts the local tap by name (debt-paydown-2 R9, A9; D12)', () => {
  const FOLDER = '/opt/homebrew/library/taps/simplyautonomous/homebrew-tap';
  /** A folder holding one executable `brew`, put first on PATH so it shadows the real one. */
  function fakeBrew(script: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'asha-release-brew-')));
    repos.push(dir);
    writeFileSync(join(dir, 'brew'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return dir;
  }
  const refusedBeforeAnything = (repo: string, result: { status: number | null; stdout: string; stderr: string }) => {
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(existsSync(join(repo, 'build'))).toBe(false);
    expect(existsSync(join(repo, 'dist'))).toBe(false);
  };

  it('a store naming the tap refuses, naming simplyautonomous/tap and the commands that fix it, before any other check', () => {
    const repo = makeRepo();
    // Dirty too: the trust check runs first, so its refusal is the one given.
    write(repo, 'stray.txt', 'uncommitted\n');
    const result = release(repo, cache.full, {
      XDG_CONFIG_HOME: trustStore({ trustedtaps: ['simplyautonomous/tap'] }),
    });
    refusedBeforeAnything(repo, result);
    expect(result.stderr).toBe(
      'release: Homebrew trusts the local tap by name (simplyautonomous/tap): a same-name tap cloned from GitHub would be trusted too (debt D12). Trust it by its folder instead (docs/deployments/index.md#release):\n' +
        '  HOMEBREW_NO_AUTO_UPDATE=1 brew untrust --tap simplyautonomous/tap\n' +
        '  git -C "$(brew --repository simplyautonomous/tap)" remote add origin "$(brew --repository simplyautonomous/tap)"   # once, when the tap has no remote yet\n' +
        '  HOMEBREW_NO_AUTO_UPDATE=1 brew trust --tap simplyautonomous/tap\n',
    );
  });

  it('a store naming a formula of the tap refuses, naming it; both at once name both', () => {
    const repo = makeRepo();
    const formula = release(repo, cache.full, {
      XDG_CONFIG_HOME: trustStore({ trustedtaps: [FOLDER], trustedformulae: ['simplyautonomous/tap/asha'] }),
    });
    refusedBeforeAnything(repo, formula);
    expect(formula.stderr).toMatch(/^release: Homebrew trusts the local tap by name \(simplyautonomous\/tap\/asha\):/);
    expect(formula.stderr).toContain('  HOMEBREW_NO_AUTO_UPDATE=1 brew untrust --formula simplyautonomous/tap/asha\n');
    const another = release(repo, cache.full, {
      XDG_CONFIG_HOME: trustStore({ trustedtaps: [FOLDER], trustedformulae: ['simplyautonomous/tap/other'] }),
    });
    refusedBeforeAnything(repo, another);
    expect(another.stderr).toMatch(/^release: Homebrew trusts the local tap by name \(simplyautonomous\/tap\/other\):/);
    const both = release(repo, cache.full, {
      XDG_CONFIG_HOME: trustStore({
        trustedtaps: ['simplyautonomous/tap'],
        trustedformulae: ['simplyautonomous/tap/asha'],
      }),
    });
    refusedBeforeAnything(repo, both);
    expect(both.stderr).toMatch(
      /^release: Homebrew trusts the local tap by name \(simplyautonomous\/tap, simplyautonomous\/tap\/asha\):/,
    );
  });

  it('a store of folders only, or of other taps, or none, passes on to the existing checks', () => {
    const repo = makeRepo();
    write(repo, 'stray.txt', 'uncommitted\n');
    for (const store of [
      { trustedtaps: [FOLDER], trustedformulae: [`${FOLDER}/asha`] },
      { trustedtaps: ['someone/tap'], trustedformulae: ['someone/tap/asha', 'simplyautonomous/tapx/asha'] },
      undefined,
    ]) {
      const result = release(repo, cache.full, { XDG_CONFIG_HOME: trustStore(store) });
      expect(result.stderr, JSON.stringify(store)).toBe(
        'release: the working tree is not clean (git status --porcelain):\n?? stray.txt\n',
      );
    }
  });

  it(
    'brew missing from PATH, a brew exiting 1, one printing not json, one printing JSON of another shape, and one silent past 30 s each refuse, naming the cause',
    { timeout: 90_000 },
    () => {
      const repo = makeRepo();
      const empty = realpathSync(mkdtempSync(join(tmpdir(), 'asha-release-path-')));
      repos.push(empty);
      const missing = release(repo, cache.full, { PATH: empty });
      refusedBeforeAnything(repo, missing);
      expect(missing.stderr).toBe(
        "release: the local tap's trust cannot be read: brew was not found on PATH (brew trust --json=v1); the release is a Homebrew release and needs it\n",
      );
      const failing = release(repo, cache.full, {
        PATH: `${fakeBrew('echo "Error: broken" >&2; exit 1')}:${String(process.env['PATH'])}`,
      });
      refusedBeforeAnything(repo, failing);
      expect(failing.stderr).toBe(
        "release: the local tap's trust cannot be read: brew trust --json=v1 exited 1:\nError: broken\n",
      );
      const notJson = release(repo, cache.full, {
        PATH: `${fakeBrew('echo not json')}:${String(process.env['PATH'])}`,
      });
      refusedBeforeAnything(repo, notJson);
      expect(notJson.stderr).toMatch(
        /^release: the local tap's trust cannot be read: brew trust --json=v1 printed something that is not JSON \([\s\S]*\): "not json\\n"\n$/,
      );
      const shapeScript = `echo '{"taps":"simplyautonomous/tap"}'`;
      const shape = release(repo, cache.full, {
        PATH: `${fakeBrew(shapeScript)}:${String(process.env['PATH'])}`,
      });
      refusedBeforeAnything(repo, shape);
      expect(shape.stderr).toMatch(
        /^release: the local tap's trust cannot be read: brew trust --json=v1 printed JSON of another shape than/,
      );
      const silent = release(repo, cache.full, {
        PATH: `${fakeBrew('exec sleep 60')}:${String(process.env['PATH'])}`,
      });
      refusedBeforeAnything(repo, silent);
      expect(silent.stderr).toBe(
        "release: the local tap's trust cannot be read: brew trust --json=v1 did not answer within 30000 ms\n",
      );
    },
  );
});
