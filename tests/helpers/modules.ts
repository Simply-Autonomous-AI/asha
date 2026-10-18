// Fixture modules for the extension-modules tests (docs/plans/extension-modules.md): manifests that pass the schema,
// built so a test changes one field and sees exactly that refused, and directories on disk whose per-file sha256
// values are computed, not copied. No fixture secret begins with a real key prefix (R24: not tvly-, AKIA, ASIA).

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ContainerRuntime } from '../../src/daemon/container-runtime/index.js';
import type { FileSpaces } from '../../src/daemon/files/index.js';
import type { Logger } from '../../src/daemon/log.js';
import {
  createModuleServices,
  type InstalledModule,
  type ModuleServices,
  type SetTimer,
} from '../../src/daemon/modules/index.js';
import { FileSecretStore } from '../../src/daemon/secrets/index.js';
import { harnessPaths } from '../../src/shared/paths.js';

/** A fixture secret value: long, unique per name, and no real key's prefix. */
export function fixtureSecret(name: string): string {
  return `fixture-secret-${name.toLowerCase()}-${createHash('sha256').update(name).digest('hex').slice(0, 24)}`;
}

const LICENCE = { id: 'MIT', url: 'https://example.test/LICENSE', read: '2026-10-01' } as const;

export function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** A ToolModule's manifest with one tool, `lookup`, no host and no secret; `extra` overrides any field. */
export function toolModuleManifest(
  extra: Record<string, unknown> = {},
  files: Record<string, string> = {
    'index.mjs': 'export async function call() {}\n',
    'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}\n',
  },
): Record<string, unknown> {
  return {
    id: 'fixture_tool',
    kind: 'ToolModule',
    version: '1.0.0',
    entry: 'index.mjs',
    files: Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)])),
    licence: LICENCE,
    hosts: [],
    secrets: [],
    cost: { model: 'free' },
    tools: [
      {
        name: 'lookup',
        description: 'Look a word up.',
        classes: [],
        timeoutMs: 5_000,
        parameters: {
          type: 'object',
          properties: { word: { type: 'string', description: 'The word' } },
          required: ['word'],
        },
      },
    ],
    ...extra,
  };
}

/** A cloud ToolModule: one host, one secret, its tool classed egress and untrusted-input. */
export function cloudToolManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = toolModuleManifest();
  return {
    ...base,
    id: 'fixture_search',
    hosts: ['api.search.example'],
    secrets: ['SEARCH_KEY'],
    tools: [
      { ...(base['tools'] as Record<string, unknown>[])[0], name: 'search', classes: ['untrusted-input', 'egress'] },
    ],
    ...extra,
  };
}

export const PROVIDER_MODEL = {
  name: 'small',
  kind: 'chat',
  id: 'vendor.small-model-v1',
  card: { url: 'https://vendor.example/cards/small', read: '2026-10-01' },
  launched: '2025-12-02',
  prices: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.15, url: 'https://vendor.example/pricing', read: '2026-10-01' },
  terms: { url: 'https://vendor.example/terms', read: '2026-10-01' },
  retention: { url: 'https://vendor.example/retention', read: '2026-10-01' },
  chat: { temperature: 0 },
} as const;

export function providerManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'fixture_provider',
    kind: 'ModelProvider',
    version: '1.0.0',
    entry: 'index.mjs',
    files: {
      'index.mjs': sha256('export async function chat() {}\n'),
      'package-lock.json': sha256('{"lockfileVersion":3,"packages":{"":{}}}\n'),
    },
    licence: LICENCE,
    hosts: ['api.vendor.example'],
    secrets: ['VENDOR_KEY'],
    cost: { model: 'metered', approved: { by: 'the owner', date: '2026-09-27', capUsd: 25 } },
    models: [PROVIDER_MODEL],
    ...extra,
  };
}

export const PLUGIN_DOCKERFILE =
  'ARG ASHA_PLUGIN_BASE\nFROM ${ASHA_PLUGIN_BASE}\nARG ASHA_ARCHIVE\nCOPY ${ASHA_ARCHIVE} /opt/plugin/archive.tar\nUSER 1000:1000\n';

export function pluginManifest(
  extra: Record<string, unknown> = {},
  dockerfile = PLUGIN_DOCKERFILE,
): Record<string, unknown> {
  return {
    id: 'fixture_cli',
    kind: 'CommandTool',
    version: '1.0.0',
    entry: 'Dockerfile',
    files: { Dockerfile: sha256(dockerfile) },
    licence: { id: 'Apache-2.0', url: 'https://example.test/LICENSE', read: '2026-10-01' },
    hosts: ['api.pipeline.example'],
    secrets: ['PIPELINE_KEY'],
    cost: { model: 'external-unmetered', approved: { by: 'the owner', date: '2026-10-01', capUsd: 5 } },
    executable: {
      name: 'fixture-cli',
      version: '1.0.0',
      licence: { id: 'Apache-2.0', url: 'https://example.test/cli/LICENSE', read: '2026-10-01' },
      signature: { method: 'sha256 only (fixture)', fingerprint: 'none', verifiedBy: 'the test', date: '2026-10-01' },
      archives: {
        aarch64: { url: 'https://example.test/cli-aarch64.tar', sha256: 'a'.repeat(64), file: 'cli-aarch64.tar' },
        x86_64: { url: 'https://example.test/cli-x86_64.tar', sha256: 'b'.repeat(64), file: 'cli-x86_64.tar' },
      },
      env: { CLI_CONFIG_FILE: '/dev/null' },
    },
    commands: [
      {
        name: 'get_state',
        description: "Read a pipeline's state.",
        classes: ['egress'],
        timeoutMs: 30_000,
        prefix: ['pipeline', 'get-state'],
        fixed: ['--region', 'us-east-1'],
        arguments: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$', option: '--name', description: 'The pipeline' },
        },
      },
      {
        name: 'retry_stage',
        description: 'Retry a pipeline stage.',
        classes: ['egress', 'consequential'],
        timeoutMs: 30_000,
        prefix: ['pipeline', 'retry-stage'],
        arguments: {
          name: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,63}$', option: '--name', description: 'The pipeline' },
          stage: { type: 'enum', values: ['build', 'deploy'], option: '--stage', description: 'The stage' },
        },
      },
    ],
    ...extra,
  };
}

/** Writes a module directory: module.json (with every file's sha256 filled in) and each file. Returns its path. */
export async function writeModuleDir(
  manifest: Record<string, unknown>,
  files: Record<string, string | Buffer>,
  parent?: string,
): Promise<string> {
  const dir = join(parent ?? (await mkdtemp(join(tmpdir(), 'asha-module-'))), String(manifest['id']));
  await mkdir(dir, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  const listed = Object.fromEntries(Object.entries(files).map(([path, content]) => [path, sha256(content)]));
  await writeFile(join(dir, 'module.json'), JSON.stringify({ ...manifest, files: listed }, null, 2));
  return dir;
}

/** Timers a test fires itself (approvals' expiry, module bounds): `fire(ms)` runs every live one of that delay. */
export class TestTimers {
  readonly live: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  readonly setTimer: SetTimer = (callback, ms) => {
    const t = { callback, ms, cancelled: false };
    this.live.push(t);
    return () => {
      t.cancelled = true;
    };
  };
  fire(ms: number): number {
    const due = this.live.filter((t) => !t.cancelled && t.ms === ms);
    for (const t of due) {
      t.cancelled = true;
      t.callback();
    }
    return due.length;
  }
  pending(): number {
    return this.live.filter((t) => !t.cancelled).length;
  }
}

/**
 * The supervisor's module services for a test: `installed` modules (none by default — R38's daemon), a secret store
 * in `home`, the test's timers and clock, the real append-only audit file. Nothing of it runs until a launch grants a
 * module.
 */
export function testModules(props: {
  readonly runtime: ContainerRuntime;
  readonly files: Pick<FileSpaces, 'readForPlugin' | 'writeFromPlugin'>;
  readonly home: string;
  readonly logger: Logger;
  readonly root?: string;
  readonly installed?: ReadonlyMap<string, InstalledModule>;
  readonly timers?: TestTimers;
  readonly now?: () => number;
  readonly online?: (token: string) => boolean;
}): ModuleServices {
  const paths = harnessPaths({ ASHA_HOME: props.home });
  const timers = props.timers ?? new TestTimers();
  return createModuleServices({
    runtime: props.runtime,
    root: props.root ?? props.home,
    paths,
    logger: props.logger,
    installed: props.installed ?? new Map(),
    files: props.files,
    secrets: new FileSecretStore({
      home: paths.home,
      dir: paths.secretsDir,
      logger: props.logger,
      pid: process.pid,
      isAlive: () => false,
      insideGitTree: () => Promise.resolve(false),
    }),
    setTimer: timers.setTimer,
    now: props.now ?? (() => Date.now()),
    online: props.online ?? (() => true),
    appendOpen: (path, flags, mode) => import('node:fs/promises').then((fs) => fs.open(path, flags, mode)),
  });
}

/**
 * A module installed into `home`'s modules directory as the installer leaves it — module.json with every file's
 * sha256, and the files — and its InstalledModule, for a supervisor's `installed` map.
 */
export async function installedModule(
  home: string,
  manifest: Record<string, unknown>,
  files: Record<string, string | Buffer> = {
    'index.mjs': 'export async function call() {}\n',
    'package-lock.json': '{"lockfileVersion":3,"packages":{"":{}}}\n',
  },
): Promise<InstalledModule> {
  const { parseModuleManifest } = await import('../../src/shared/modules.js');
  const dir = await writeModuleDir(manifest, files, join(home, 'modules'));
  const { readFile } = await import('node:fs/promises');
  return {
    manifest: parseModuleManifest(
      JSON.parse(await readFile(join(dir, 'module.json'), 'utf8')),
      'module.json',
      String(manifest['id']),
    ),
    dir,
  };
}

/** Stores a module's fixture secrets in `home`'s store, as `--set-secret` would. */
export async function storeSecrets(home: string, module: string, names: readonly string[]): Promise<void> {
  const paths = harnessPaths({ ASHA_HOME: home });
  const { RecordingLogger } = await import('./fakes.js');
  const store = new FileSecretStore({
    home,
    dir: paths.secretsDir,
    logger: new RecordingLogger(),
    pid: process.pid,
    isAlive: () => false,
    insideGitTree: () => Promise.resolve(false),
  });
  for (const name of names) await store.set(module, name, fixtureSecret(name));
}
