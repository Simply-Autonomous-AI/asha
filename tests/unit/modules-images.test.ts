// A command plugin's image at each launch (docs/plans/extension-modules.md R28; A35): src/daemon/modules/images.ts with
// a fake runtime whose ensureImage records its calls, a fake VM architecture, and a reader that counts what it reads.

import { createHash } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { contextDigest, streamFile, type FileReader } from '../../src/daemon/images/index.js';
import {
  ModuleImages,
  PluginArchiveChanged,
  PluginArchitectureChanged,
  type InstalledModule,
} from '../../src/daemon/modules/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { parseModuleManifest } from '../../src/shared/modules.js';
import { FakeRuntime } from '../helpers/daemon-fakes.js';
import { RecordingLogger } from '../helpers/fakes.js';
import { PLUGIN_DOCKERFILE, pluginManifest, toolModuleManifest, writeModuleDir } from '../helpers/modules.js';

const ARCHIVE = Buffer.from('fixture plugin archive\n');
const SHA = createHash('sha256').update(ARCHIVE).digest('hex');

async function plugin() {
  const raw = pluginManifest({
    executable: {
      ...(pluginManifest()['executable'] as Record<string, unknown>),
      archives: {
        aarch64: { url: 'https://example.test/a.tar', sha256: SHA, file: 'cli-aarch64.tar' },
        x86_64: { url: 'https://example.test/x.tar', sha256: 'b'.repeat(64), file: 'cli-x86_64.tar' },
      },
    },
  });
  const dir = await writeModuleDir(raw, { Dockerfile: PLUGIN_DOCKERFILE });
  await writeFile(join(dir, 'cli-aarch64.tar'), ARCHIVE);
  await writeFile(
    join(dir, '.asha-install.json'),
    JSON.stringify({ architecture: 'aarch64', archive: { file: 'cli-aarch64.tar', sha256: SHA } }),
  );
  const root = await mkdtemp(join(tmpdir(), 'asha-root-'));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'harness-images', 'plugin-base'), { recursive: true });
  await writeFile(join(root, 'harness-images', 'plugin-base', 'Dockerfile'), 'FROM scratch\n');
  const installed: InstalledModule = { manifest: parseModuleManifest(raw, 'module.json', 'fixture_cli'), dir };
  const runtime = new FakeRuntime('127.0.0.1');
  const logger = new RecordingLogger();
  const reads: string[] = [];
  const read: FileReader = (path) => (reads.push(path), streamFile(path));
  const images = new ModuleImages({
    runtime,
    root,
    stagingDir: await mkdtemp(join(tmpdir(), 'asha-staging-')),
    logger,
    read,
  });
  return { installed, dir, runtime, logger, reads, images };
}

describe("a module's image (R5): readable by the module base's user", () => {
  it("stages the installed files, which the installer writes 0600 in 0700 folders, as 0644 files in 0755 folders, so the image's node user can read /module (the launch suite, 2026-10-02: EACCES on /module/module.json)", async () => {
    const files = {
      'index.mjs': 'export async function call() {}\n',
      'lib/util.mjs': 'export const x = 1;\n',
      'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}\n',
    };
    const raw = toolModuleManifest({}, files);
    const dir = await writeModuleDir(raw, files);
    const { chmod, mkdir, readdir, stat } = await import('node:fs/promises');
    for (const path of ['module.json', ...Object.keys(files)]) await chmod(join(dir, path), 0o600);
    await chmod(join(dir, 'lib'), 0o700);
    const root = await mkdtemp(join(tmpdir(), 'asha-root-'));
    await mkdir(join(root, 'harness-images', 'module-base'), { recursive: true });
    await writeFile(join(root, 'harness-images', 'module-base', 'Dockerfile'), 'FROM scratch\n');
    await mkdir(join(root, 'dist', 'src', 'module-runtime'), { recursive: true });
    await writeFile(join(root, 'dist', 'src', 'module-runtime', 'main.js'), '// runtime\n');
    const runtime = new FakeRuntime('127.0.0.1');
    const modes: [string, string][] = [];
    const ensure = runtime.ensureImage.bind(runtime);
    runtime.ensureImage = async (spec) => {
      if (spec.repository === 'asha-module-fixture_tool') {
        const walk = async (at: string, rel: string): Promise<void> => {
          for (const entry of await readdir(at, { withFileTypes: true })) {
            const path = join(at, entry.name);
            modes.push([join(rel, entry.name), ((await stat(path)).mode & 0o777).toString(8)]);
            if (entry.isDirectory()) await walk(path, join(rel, entry.name));
          }
        };
        await walk(join(spec.contextDir, 'module'), 'module');
      }
      return ensure(spec);
    };
    const images = new ModuleImages({
      runtime,
      root,
      stagingDir: await mkdtemp(join(tmpdir(), 'asha-staging-')),
      logger: new RecordingLogger(),
      read: streamFile,
    });
    await images.module({ manifest: parseModuleManifest(raw, 'module.json', 'fixture_tool'), dir });
    expect(modes.toSorted((a, b) => byCodeUnit(a.join(','), b.join(',')))).toEqual([
      ['module/index.mjs', '644'],
      ['module/lib', '755'],
      ['module/lib/util.mjs', '644'],
      ['module/module.json', '644'],
      ['module/package-lock.json', '644'],
    ]);
  });
});

describe("a command plugin's image (R28, A35)", () => {
  it('ensures the image once, reading the archive once for both its check and the source digest, with ASHA_ARCHIVE and ASHA_PLUGIN_BASE', async () => {
    const p = await plugin();
    await p.images.plugin(p.installed);
    const pluginImages = p.runtime.images.filter((i) => i.repository === 'asha-plugin-fixture_cli');
    expect(pluginImages).toHaveLength(1);
    expect(present(pluginImages[0], 'pluginImages[0]').buildArgs).toEqual({
      ASHA_ARCHIVE: 'cli-aarch64.tar',
      ASHA_PLUGIN_BASE: expect.stringMatching(/^asha-harness-plugin-base:/) as string,
    });
    expect(p.reads.filter((r) => r.endsWith('cli-aarch64.tar'))).toHaveLength(1);
  });

  it('refuses an archive changed by one byte before ensureImage, naming the module and both sha256 values, logged at error', async () => {
    const p = await plugin();
    const changed = Buffer.from(ARCHIVE);
    changed[0] = present(changed[0], 'changed[0]') ^ 1;
    await writeFile(join(p.dir, 'cli-aarch64.tar'), changed);
    const actual = createHash('sha256').update(changed).digest('hex');
    const error = await p.images.plugin(p.installed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginArchiveChanged);
    expect((error as Error).message).toBe(
      `command plugin fixture_cli's archive has sha256 ${actual}, not its manifest's ${SHA}: it changed since its install; reinstall it`,
    );
    expect(p.runtime.images.filter((i) => i.repository === 'asha-plugin-fixture_cli')).toEqual([]);
    expect(
      p.logger.entries
        .filter((e) => e.level === 'error')
        .map((e) => [e.event, e.fields['expected'], e.fields['actual']]),
    ).toEqual([['module.plugin_archive_changed', SHA, actual]]);
  });

  it('refuses a VM whose architecture changed before reading the archive, naming both and the reinstall', async () => {
    const p = await plugin();
    p.runtime.arch = 'x86_64';
    const error = await p.images.plugin(p.installed).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PluginArchitectureChanged);
    expect((error as Error).message).toBe(
      'command plugin fixture_cli was installed for aarch64, and the colima VM is now x86_64: reinstall it with asha --install-module path=<dir> archive=<the archive for x86_64, https://example.test/x.tar>',
    );
    expect(p.reads).toEqual([]);
    expect(p.runtime.images).toEqual([]);
  });

  it('gives two ASHA_ARCHIVE values of one context two source digests', () => {
    const files = new Map([['Dockerfile', 'a'.repeat(64)]]);
    expect(contextDigest(files, { ASHA_ARCHIVE: 'one.tar' })).not.toBe(
      contextDigest(files, { ASHA_ARCHIVE: 'two.tar' }),
    );
    expect(contextDigest(files)).toBe(contextDigest(files, {}));
  });
});
