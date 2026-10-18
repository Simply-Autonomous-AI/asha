// The images extension modules run in (docs/plans/extension-modules.md R5, R28, R37), each built by ensureImage with
// --network=none, tagged by its source digest, and rebuilt only when that digest changes:
//
// - the harness's own images, from harness-images/<name>/ and the compiled code they run: the module base, the egress
//   proxy, and the command plugins' glibc base;
// - a ToolModule's or ModelProvider's image, FROM the module base with the installed directory copied to /module;
// - a command plugin's image, built from its installed directory itself (which holds its checked release archive),
//   with the build arguments ASHA_ARCHIVE and ASHA_PLUGIN_BASE in its source digest — after the VM's architecture is
//   compared with the one it was installed for, then the archive's sha256 with its manifest's, one read of the
//   archive serving both that check and the digest.

import { randomBytes } from 'node:crypto';
import { chmod, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { INSTALL_RECORD, MANIFEST_FILE, type Architecture, type ModuleManifest } from '../../shared/modules.js';
import { byCodeUnit } from '../../shared/order.js';
import type { ContainerRuntime, EnsuredImage } from '../container-runtime/index.js';
import { ImageSourceMissing, contextDigest, hashDirectory, streamFile, type FileReader } from '../images/index.js';
import type { Logger } from '../log.js';

/** The harness's own images (R37). */
export type HarnessImage = 'module-base' | 'egress-proxy' | 'plugin-base';

/** The compiled code each harness image runs, under dist/src/, and the shared code it imports. */
const HARNESS_CODE: Readonly<Record<HarnessImage, readonly string[]>> = {
  'module-base': ['module-runtime'],
  'egress-proxy': ['egress-proxy', 'shared'],
  'plugin-base': [],
};

/** An installed module: its manifest and its directory under ASHA_HOME/modules/. */
export interface InstalledModule {
  readonly manifest: ModuleManifest;
  readonly dir: string;
}

/** A command plugin's install record (R28): the VM's architecture it was installed for, and the archive used. */
interface InstallRecord {
  readonly architecture: Architecture;
  readonly archive: { readonly file: string; readonly sha256: string };
}

/** The VM's architecture differs from the one a command plugin was installed for (R28, E4): reinstall it. */
export class PluginArchitectureChanged extends Error {
  constructor(
    readonly module: string,
    readonly installed: string,
    readonly now: string,
    readonly url: string | undefined,
  ) {
    const urlSuffix = url === undefined ? '' : `, ${url}`;
    super(
      `command plugin ${module} was installed for ${installed}, and the colima VM is now ${now}: reinstall it with ` +
        `asha --install-module path=<dir> archive=<the archive for ${now}${urlSuffix}>`,
    );
    this.name = 'PluginArchitectureChanged';
  }
}

/** A command plugin's installed archive no longer has its manifest's sha256 (R28): never built. */
export class PluginArchiveChanged extends Error {
  constructor(
    readonly module: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `command plugin ${module}'s archive has sha256 ${actual}, not its manifest's ${expected}: it changed since its install; reinstall it`,
    );
    this.name = 'PluginArchiveChanged';
  }
}

export interface ModuleImagesProps {
  readonly runtime: Pick<ContainerRuntime, 'ensureImage' | 'vmArchitecture'>;
  /** The repo or release root: harness-images/ and dist/. */
  readonly root: string;
  readonly stagingDir: string;
  readonly logger: Logger;
  /** How files are read for their hashes (R28's one read; A35 counts them). */
  readonly read: FileReader;
}

export class ModuleImages {
  constructor(private readonly props: ModuleImagesProps) {}

  /** A harness image, staged from harness-images/<name>/ and its compiled code, and ensured. */
  async harness(name: HarnessImage): Promise<EnsuredImage> {
    const { root } = this.props;
    const copies: [string, string][] = [[join(root, 'harness-images', name), '']];
    for (const code of HARNESS_CODE[name]) copies.push([join(root, 'dist', 'src', code), join('app', 'src', code)]);
    return this.staged(`asha-harness-${name}`, `harness-${name}`, copies, {});
  }

  /** A ToolModule's or ModelProvider's image: FROM the module base, the installed directory at /module (R5). */
  async module(installed: InstalledModule): Promise<EnsuredImage> {
    const { manifest, dir } = installed;
    if (manifest.kind === 'CommandTool')
      throw new Error(`module(${manifest.id}): a command plugin is built by plugin()`);
    const base = await this.harness('module-base');
    // The second line is part of the source digest: images staged before files were made readable (0600, unreadable
    // by the image's user) carry the same files, and must not be reused (2026-10-02).
    const dockerfile = `# ${manifest.id} ${manifest.version}, built by the harness (extension-modules R5).\n# Its files staged 0644 in 0755 folders.\nFROM ${base.tag}\nCOPY module/ /module/\n`;
    const copies: [string, string][] = [
      [join(dir, MANIFEST_FILE), join('module', MANIFEST_FILE)],
      ...Object.keys(manifest.files).map((path): [string, string] => [join(dir, path), join('module', path)]),
    ];
    return this.staged(`asha-module-${manifest.id}`, `module-${manifest.id}`, copies, {}, dockerfile);
  }

  /**
   * A command plugin's image (R28): the VM's architecture compared with its install record first, then the archive
   * hashed — once, with every file of the context — and compared with its manifest's sha256; each refusal logged at
   * error and thrown before ensureImage. Built from the installed directory with ASHA_ARCHIVE and ASHA_PLUGIN_BASE.
   */
  async plugin(installed: InstalledModule): Promise<EnsuredImage> {
    const { manifest } = installed;
    if (manifest.kind !== 'CommandTool') throw new Error(`plugin(${manifest.id}): not a command plugin`);
    const record = parseInstallRecord(await readFile(join(installed.dir, INSTALL_RECORD), 'utf8'), manifest.id);
    const now = await this.props.runtime.vmArchitecture();
    if (now !== record.architecture) {
      const error = new PluginArchitectureChanged(
        manifest.id,
        record.architecture,
        now,
        manifest.executable.archives[now as Architecture]?.url,
      );
      this.props.logger.error('module.plugin_architecture_changed', {
        module: manifest.id,
        installed: record.architecture,
        now,
        error,
      });
      throw error;
    }
    const entry = manifest.executable.archives[record.architecture];
    if (entry === undefined || entry.file !== record.archive.file)
      throw new Error(`command plugin ${manifest.id}: its install record names an archive its manifest does not`);
    const files = await hashDirectory(installed.dir, this.props.read);
    const actual = files.get(entry.file) ?? 'missing';
    if (actual !== entry.sha256) {
      const error = new PluginArchiveChanged(manifest.id, entry.sha256, actual);
      this.props.logger.error('module.plugin_archive_changed', {
        module: manifest.id,
        expected: entry.sha256,
        actual,
        error,
      });
      throw error;
    }
    const base = await this.harness('plugin-base');
    const buildArgs = { ASHA_ARCHIVE: entry.file, ASHA_PLUGIN_BASE: base.tag };
    return this.props.runtime.ensureImage({
      repository: `asha-plugin-${manifest.id}`,
      contextDir: installed.dir,
      sourceDigest: contextDigest(files, buildArgs),
      labels: {},
      buildArgs,
    });
  }

  /** Copies each [from, to] into a fresh context (and a Dockerfile, when given), ensures the image, removes the context. */
  private async staged(
    repository: string,
    label: string,
    copies: readonly (readonly [string, string])[],
    buildArgs: Readonly<Record<string, string>>,
    dockerfile?: string,
  ): Promise<EnsuredImage> {
    const contextDir = join(this.props.stagingDir, `${label}-${randomBytes(6).toString('hex')}`);
    try {
      await mkdir(contextDir, { recursive: true });
      for (const [from, to] of copies) {
        try {
          await stat(from);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ImageSourceMissing(from);
          throw error;
        }
        await cp(from, join(contextDir, to), { recursive: true });
      }
      // COPY keeps each file's mode, and an installed module's files are 0600 in 0700 folders (the installer's), which
      // the image's own user could not read (EACCES on /module/module.json, the launch suite, 2026-10-02): every file
      // staged is 0644 and every folder 0755. Nothing in a context is secret; a module's secrets reach it by env (R7).
      await readableTree(contextDir);
      if (dockerfile !== undefined) await writeFile(join(contextDir, 'Dockerfile'), dockerfile);
      const files = await hashDirectory(contextDir, streamFile);
      return await this.props.runtime.ensureImage({
        repository,
        contextDir,
        sourceDigest: contextDigest(files, buildArgs),
        labels: {},
        ...(Object.keys(buildArgs).length === 0 ? {} : { buildArgs }),
      });
    } finally {
      await rm(contextDir, { recursive: true, force: true });
    }
  }
}

/** Makes every folder under `dir` 0755 and every file 0644; a link or a special file is refused (none is staged). */
async function readableTree(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await chmod(path, 0o755);
      await readableTree(path);
    } else if (entry.isFile()) await chmod(path, 0o644);
    else throw new Error(`${path}: neither a file nor a folder, in an image's context`);
  }
}

/** A command plugin's `.asha-install.json` (R28): exactly {architecture, archive: {file, sha256}}, or it throws naming the module. */
function parseInstallRecord(text: string, module: string): InstallRecord {
  const bad = (detail: string) => new Error(`command plugin ${module}: ${INSTALL_RECORD} ${detail}; reinstall it`);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw bad('is not JSON');
  }
  const r = raw as { architecture?: unknown; archive?: { file?: unknown; sha256?: unknown } } | null;
  if (r === null || typeof r !== 'object' || Object.keys(r).sort(byCodeUnit).join() !== 'architecture,archive')
    throw bad('is not {architecture, archive}');
  if (r.architecture !== 'aarch64' && r.architecture !== 'x86_64')
    throw bad('names no architecture this plugin format knows');
  if (
    typeof r.archive?.file !== 'string' ||
    typeof r.archive.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.archive.sha256)
  )
    throw bad('names no archive');
  return { architecture: r.architecture, archive: { file: r.archive.file, sha256: r.archive.sha256 } };
}
