// The public export and its pre-push hook (docs/plans/oss-release.md R1–R3, R35, R39; A1, A3, A26, A30), on a fixture
// internal repository: its refusals, each writing nothing; release 1 as a new repository of exactly the shipped
// entries, modes, blobs and symlink, one commit and an annotated tag by the publishing identity, no internal object,
// no remote; release 2 on a clone of a bare copy of release 1, one commit more, pushed without --force once the plan
// records the gates and the day's consent; the hook's every refusal; and the signers file's every refusal.

import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXPORTED_FROM, ExportRefused, PUBLISHER, exportRelease, type ExportProps } from '../../tools/oss/export.mjs';
import { ManifestInvalid } from '../../tools/oss/manifest.mjs';
import { localDate, pushAllowed } from '../../tools/oss/pre-push.mjs';

const temp = (): string => mkdtempSync(join(tmpdir(), 'asha-export-'));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=Maintainer', '-c', 'user.email=m@example.invalid', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

/** The plan's Status table with these rows, as the hook reads it. */
const plan = (rows: readonly string[]): string =>
  `# Public release\n\n## Status {#status}\n\n| Status | Date | Note |\n|---|---|---|\n${rows.join('\n')}\n\n## Context\n`;
const GATES = [
  '| gate G1 | 2026-11-01 | filed |',
  '| gate G2 | 2026-11-02 | orgs |',
  '| gate G3 | 2026-11-03 | terms |',
];

/** A fixture internal repository at one clean commit: shipped code, a script, a symlink, private files, the plan. */
function internalRepo(manifest: { ship: string[]; exclude: string[] } = MANIFEST, planRows = GATES): string {
  const repo = temp();
  git(repo, 'init', '-q', '-b', 'main');
  const files: Record<string, string> = {
    'tools/oss/manifest.json': `${JSON.stringify(manifest)}\n`,
    'package.json': '{ "name": "asha", "version": "1.2.3" }\n',
    'src/a.ts': 'export const a = 1;\n',
    run: '#!/bin/sh\necho run\n',
    'private/notes.txt': 'internal\n',
    'docs/plans/oss-release.md': plan(planRows),
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  chmodSync(join(repo, 'run'), 0o755);
  symlinkSync('src/a.ts', join(repo, 'link'));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'internal work');
  return repo;
}
const MANIFEST = { ship: ['src/', 'package.json', 'run', 'link', 'tools/'], exclude: ['private/', 'docs/'] };

const props = (repo: string, out: string, over: Partial<ExportProps> = {}): ExportProps => ({
  repo,
  commit: 'HEAD',
  out,
  env: {},
  ...over,
});
const refusal = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    expect(error instanceof ExportRefused || error instanceof ManifestInvalid, String(error)).toBe(true);
    return (error as Error).message;
  }
  throw new Error('not refused');
};
const lsTree = (cwd: string, rev = 'HEAD'): string[] => git(cwd, 'ls-tree', '-r', rev).split('\n');

describe("the export's refusals, each writing nothing (oss-release R1, A1)", () => {
  it('a dirty internal tree', () => {
    const repo = internalRepo();
    writeFileSync(join(repo, 'src', 'a.ts'), 'changed\n');
    const out = join(temp(), 'out');
    expect(refusal(() => exportRelease(props(repo, out)))).toBe(
      'the internal working tree is dirty: commit or remove every change first',
    );
    expect(existsSync(out)).toBe(false);
  });

  it('an out inside the internal repository', () => {
    const repo = internalRepo();
    expect(refusal(() => exportRelease(props(repo, join(repo, 'export'))))).toBe(
      `${join(repo, 'export')} is inside the internal repository's working tree`,
    );
  });

  it('an existing out that is no clone of the published repository', () => {
    const repo = internalRepo();
    const plain = temp();
    expect(refusal(() => exportRelease(props(repo, plain)))).toBe(
      `${plain} exists and is not a git repository: name a new folder, or a clone of the published one`,
    );
    const other = temp();
    git(other, 'init', '-q', '-b', 'main');
    writeFileSync(join(other, 'x'), 'x\n');
    git(other, 'add', 'x');
    git(other, 'commit', '-q', '-m', 'someone else');
    expect(refusal(() => exportRelease(props(repo, other)))).toBe(
      `${other} is not a clone of the published repository: its history is no export's`,
    );
  });

  it('a manifest that leaves a tracked path out, or lists one entry in both lists', () => {
    const missing = internalRepo({ ship: ['src/', 'package.json', 'link', 'tools/'], exclude: ['private/', 'docs/'] });
    const out = join(temp(), 'out');
    expect(refusal(() => exportRelease(props(missing, out)))).toBe(
      'the manifest classifies neither ship nor exclude: run',
    );
    const both = internalRepo({ ship: [...MANIFEST.ship, 'private/'], exclude: MANIFEST.exclude });
    expect(refusal(() => exportRelease(props(both, out)))).toBe('the manifest lists "private/" in both');
    expect(existsSync(out)).toBe(false);
  });
});

describe('release 1, then release 2 (oss-release R1–R3, R35; A1, A3, A26)', () => {
  it('release 1: exactly the shipped entries — modes, blobs, the symlink — one commit and tag by the publisher, no internal object, no remote', () => {
    const repo = internalRepo();
    const out = join(temp(), 'asha');
    const internal = git(repo, 'rev-parse', 'HEAD');
    const done = exportRelease(props(repo, out));
    expect([done.first, done.tag, done.files, done.internal]).toEqual([true, 'v1.2.3', 5, internal]);
    const shipped = (line: string): boolean => !/\t(?:private|docs)\//.test(line);
    expect(lsTree(out)).toEqual(lsTree(repo).filter(shipped));
    expect(lsTree(out).map((l) => l.split(' ')[0])).toEqual(['120000', '100644', '100755', '100644', '100644']);
    expect(git(out, 'remote', '-v')).toBe('');
    expect(git(out, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(out, 'log', '-1', '--format=%an <%ae>|%cn <%ce>')).toBe(
      `${PUBLISHER.name} <${PUBLISHER.email}>|${PUBLISHER.name} <${PUBLISHER.email}>`,
    );
    expect(git(out, 'log', '-1', '--format=%B')).toBe(`asha 1.2.3\n\n${EXPORTED_FROM} ${internal}.`);
    expect(git(out, 'cat-file', '-t', 'v1.2.3')).toBe('tag');
    expect(git(out, 'for-each-ref', '--format=%(taggername) %(taggeremail)', 'refs/tags/v1.2.3')).toBe(
      `${PUBLISHER.name} <${PUBLISHER.email}>`,
    );
    expect(spawnSync('git', ['cat-file', '-e', internal], { cwd: out }).status).not.toBe(0);
    expect(git(out, 'branch', '-a', '--format=%(refname:short)')).toBe('main');
  });

  it('release 2 on a clone of release 1: one commit more, its co-author named, pushed without --force once the consent is recorded', () => {
    const repo = internalRepo(MANIFEST, [...GATES, `| publish consent | ${localDate()} | v1.2.4, the owner |`]);
    const first = join(temp(), 'asha');
    exportRelease(props(repo, first));
    const bare = join(temp(), 'public.git');
    git(first, 'clone', '-q', '--bare', first, bare);
    const clone = join(temp(), 'asha');
    git(temp(), 'clone', '-q', bare, clone);
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
    writeFileSync(join(repo, 'package.json'), '{ "name": "asha", "version": "1.2.4" }\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'more internal work');
    const signers = join(temp(), 'signers.txt');
    writeFileSync(signers, 'Ada Lovelace <ada@example.invalid>\n');
    chmodSync(signers, 0o600);
    const done = exportRelease(
      props(repo, clone, { coAuthors: ['Ada Lovelace <ada@example.invalid>'], env: { ASHA_CLA_SIGNERS: signers } }),
    );
    expect([done.first, done.tag]).toEqual([false, 'v1.2.4']);
    expect(git(clone, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(git(clone, 'log', '-1', '--format=%B')).toContain('\n\nCo-authored-by: Ada Lovelace <ada@example.invalid>');
    expect(lsTree(clone).some((l) => l.endsWith('\tsrc/b.ts'))).toBe(true);
    const push = spawnSync('git', ['push', '-q', 'origin', 'main', 'v1.2.4'], { cwd: clone, encoding: 'utf8' });
    expect([push.status, push.stderr]).toEqual([0, '']);
    expect(git(bare, 'rev-parse', 'main')).toBe(done.commit);
  });

  it('the installed hook refuses a push the plan has not consented to, naming why', () => {
    const repo = internalRepo();
    const out = join(temp(), 'asha');
    exportRelease(props(repo, out));
    const bare = join(temp(), 'public.git');
    git(temp(), 'init', '-q', '--bare', bare);
    git(out, 'remote', 'add', 'origin', bare);
    const push = spawnSync('git', ['push', '-q', 'origin', 'main'], { cwd: out, encoding: 'utf8' });
    expect(push.status).not.toBe(0);
    expect(push.stderr).toContain('pre-push: refused: the plan\'s Status has no "publish consent" row');
  });
});

describe("the hook's verdicts (oss-release R35, A26)", () => {
  const today = '2026-11-05';
  const consent = (date: string, version: string): string => `| publish consent | ${date} | ${version}, the owner |`;

  it("allows a push when the three gates and the day's consent naming the version are there", () => {
    expect(pushAllowed(plan([...GATES, consent(today, 'v1.2.3')]), '1.2.3', today)).toEqual({ ok: true });
  });

  it('refuses with no consent row, one of another day or another version, and with each gate row missing', () => {
    const reason = (rows: readonly string[]): string => {
      const verdict = pushAllowed(plan(rows), '1.2.3', today);
      return verdict.ok ? 'allowed' : verdict.reason;
    };
    expect(reason(GATES)).toBe('the plan\'s Status has no "publish consent" row');
    expect(reason([...GATES, consent('2026-11-04', 'v1.2.3')])).toBe(
      'no "publish consent" row is dated today, 2026-11-05',
    );
    expect(reason([...GATES, consent(today, 'v1.2.30')])).toBe(
      'today\'s "publish consent" row does not name version 1.2.3',
    );
    for (const gate of ['G1', 'G2', 'G3'])
      expect(reason([...GATES.filter((g) => !g.includes(gate)), consent(today, 'v1.2.3')])).toBe(
        `the plan's Status has no dated row "gate ${gate}": the owner-side gate is not recorded`,
      );
    expect(reason(['| gate G1 | soon | x |', ...GATES.slice(1), consent(today, 'v1.2.3')])).toBe(
      'the plan\'s Status has no dated row "gate G1": the owner-side gate is not recorded',
    );
  });
});

describe('the signers file (oss-release R39, A30)', () => {
  const ADA = 'Ada Lovelace <ada@example.invalid>';
  const signersFile = (mode = 0o600, where = temp()): string => {
    const file = join(where, 'signers.txt');
    writeFileSync(file, `# who signed\n${ADA}\n`);
    chmodSync(file, mode);
    return file;
  };

  it('a co-author absent from it is refused, naming the identity, and nothing is written', () => {
    const repo = internalRepo();
    const out = join(temp(), 'asha');
    expect(
      refusal(() =>
        exportRelease(
          props(repo, out, { coAuthors: ['Bob <bob@example.invalid>'], env: { ASHA_CLA_SIGNERS: signersFile() } }),
        ),
      ),
    ).toBe('not in the signers file, so not released: Bob <bob@example.invalid> (R39)');
    expect(existsSync(out)).toBe(false);
  });

  it('a listed co-author proceeds; with none named, the variable may be unset', () => {
    const repo = internalRepo();
    expect(
      exportRelease(props(repo, join(temp(), 'a'), { coAuthors: [ADA], env: { ASHA_CLA_SIGNERS: signersFile() } })).tag,
    ).toBe('v1.2.3');
    expect(exportRelease(props(repo, join(temp(), 'b'))).tag).toBe('v1.2.3');
  });

  it('a co-author named with the variable unset, the file missing, its mode 0644, or the file inside a repository, is refused', () => {
    const repo = internalRepo();
    const out = join(temp(), 'asha');
    const with_ = (env: NodeJS.ProcessEnv): string =>
      refusal(() => exportRelease(props(repo, out, { coAuthors: [ADA], env })));
    expect(with_({})).toBe('the release names a co-author, and ASHA_CLA_SIGNERS is not set: it names the signers file');
    const gone = join(temp(), 'none.txt');
    expect(with_({ ASHA_CLA_SIGNERS: gone })).toBe(`the signers file ASHA_CLA_SIGNERS names does not exist: ${gone}`);
    expect(with_({ ASHA_CLA_SIGNERS: signersFile(0o644) })).toBe(
      "the signers file's mode is 644: it must grant nothing to group or others (chmod 600)",
    );
    expect(with_({ ASHA_CLA_SIGNERS: signersFile(0o600, join(repo, '.git')) })).toMatch(
      /^the signers file lies inside .+: keep it outside both repositories$/,
    );
    expect(existsSync(out)).toBe(false);
  });
});
