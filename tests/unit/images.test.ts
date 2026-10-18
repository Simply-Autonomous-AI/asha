import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import type { ImageDefinition } from '../../src/daemon/definitions/index.js';
import {
  AgentPackagesInvalid,
  ImageSourceMissing,
  agentPackagePaths,
  directoryDigest,
  imageLabels,
  stageAgentImage,
} from '../../src/daemon/images/index.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { parseImageManifest } from '../../src/shared/tools.js';

/** Every file the staged context is made of, each of which the digest must see. */
const INPUTS: Readonly<Record<string, string>> = {
  'dist/src/shared/a.js': 'export const a = 1;\n',
  'dist/src/agent-sdk/b.js': 'export const b = 2;\n',
  'dist/images/demo/src/main.js': 'console.log("demo");\n',
  'images/demo/Dockerfile': 'FROM node:22-alpine\nCOPY app /app\n',
  'images/demo/image.json': '{"tools": []}\n',
  'node_modules/dep-a/build/src/index.js': 'module.exports = require("dep-b");\n',
  'node_modules/dep-a/package.json': '{"name":"dep-a","version":"1.0.0","main":"build/src/index.js"}\n',
  'node_modules/dep-b/index.js': 'module.exports = 2;\n',
  'node_modules/dep-b/package.json': '{"name":"dep-b","version":"2.0.0"}\n',
  'node_modules/@scope/peer/index.js': 'module.exports = 3;\n',
  'node_modules/@scope/peer/package.json': '{"name":"@scope/peer","version":"3.0.0"}\n',
};

/**
 * The package files: dep-a depends on dep-b and needs @scope/peer as a peer
 * (optional-peer is optional and absent); tool is a dev dependency. Beside the
 * runtime files, the packages hold what is never staged.
 */
const PACKAGES: Readonly<Record<string, string>> = {
  'package.json': JSON.stringify({
    name: 'demo',
    dependencies: { 'dep-a': '1.0.0' },
    devDependencies: { tool: '1.0.0' },
  }),
  'package-lock.json': JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'demo' },
      'node_modules/dep-a': {
        version: '1.0.0',
        dependencies: { 'dep-b': '^2.0.0' },
        peerDependencies: { '@scope/peer': '^3.0.0', 'optional-peer': '^1.0.0' },
        peerDependenciesMeta: { 'optional-peer': { optional: true } },
      },
      'node_modules/dep-b': { version: '2.0.0' },
      'node_modules/@scope/peer': { version: '3.0.0' },
      'node_modules/tool': { version: '1.0.0', dev: true },
    },
  }),
  'node_modules/dep-a/build/src/index.js.map': '{}',
  'node_modules/dep-a/build/src/index.d.ts': 'export {};\n',
  'node_modules/dep-a/build/esm/index.js': 'export default 1;\n',
  'node_modules/dep-a/build/esnext/index.js': 'export default 1;\n',
  'node_modules/dep-a/node_modules/stray/index.js': 'not in the lockfile\n',
  'node_modules/tool/index.js': 'a dev tool\n',
};
/** PACKAGES's lockfile text, present because the literal above always holds it. */
const PACKAGE_LOCK_JSON = present(PACKAGES['package-lock.json'], "PACKAGES['package-lock.json']");

/** Where staging copies the agent packages from (debt-paydown R11): the build's clean install, never root's node_modules. */
const AP = 'dist/agent-packages';
/** A fixture path as placed in the root: the packages and their lockfile under dist/agent-packages, the rest as named. */
const placed = (path: string): string =>
  path.startsWith('node_modules/') || path === 'package.json' || path === 'package-lock.json' ? `${AP}/${path}` : path;

async function write(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join('/'))
    .sort(byCodeUnit);
}

async function absent(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

describe('stageAgentImage', () => {
  let root: string;
  let stagingParent: string;
  let image: ImageDefinition;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'asha-root-'));
    stagingParent = await mkdtemp(join(tmpdir(), 'asha-staging-'));
    for (const [path, content] of Object.entries({ ...INPUTS, ...PACKAGES })) await write(root, placed(path), content);
    image = {
      name: 'demo',
      dir: join(root, 'images', 'demo'),
      repository: 'asha-image-demo',
      manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
    };
  });

  const stage = () => stageAgentImage({ root, image, stagingParent });

  it('stages exactly the Dockerfile at the root, and under app/ the compiled JS and the runtime files of the production dependencies', async () => {
    const staged = await stage();
    const { contextDir } = staged.spec;

    expect(dirname(contextDir)).toBe(stagingParent);
    expect(contextDir.startsWith(join(stagingParent, 'demo-'))).toBe(true);
    expect(await listFiles(contextDir)).toEqual([
      'Dockerfile',
      'app/images/demo/image.json',
      'app/images/demo/src/main.js',
      'app/node_modules/@scope/peer/index.js',
      'app/node_modules/@scope/peer/package.json',
      'app/node_modules/dep-a/build/src/index.js',
      'app/node_modules/dep-a/package.json',
      'app/node_modules/dep-b/index.js',
      'app/node_modules/dep-b/package.json',
      'app/src/agent-sdk/b.js',
      'app/src/shared/a.js',
    ]);
    expect(await readFile(join(contextDir, 'Dockerfile'), 'utf8')).toBe(INPUTS['images/demo/Dockerfile']);
    expect(await readFile(join(contextDir, 'app/src/shared/a.js'), 'utf8')).toBe(INPUTS['dist/src/shared/a.js']);
    expect(await readFile(join(contextDir, 'app/src/agent-sdk/b.js'), 'utf8')).toBe(INPUTS['dist/src/agent-sdk/b.js']);
    expect(await readFile(join(contextDir, 'app/images/demo/src/main.js'), 'utf8')).toBe(
      INPUTS['dist/images/demo/src/main.js'],
    );
    // The manifest, beside the compiled code, where the agent reads it at start (agent-tools R1).
    expect(await readFile(join(contextDir, 'app/images/demo/image.json'), 'utf8')).toBe(
      INPUTS['images/demo/image.json'],
    );
  });

  it("uses the image's repository and a sha256 digest of the staged context", async () => {
    const staged = await stage();

    expect(staged.spec.repository).toBe('asha-image-demo');
    expect(staged.spec.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(staged.spec.sourceDigest).toBe(await directoryDigest(staged.spec.contextDir));
    // An image.json declaring neither the erase mode nor a state schema adds no label (agent-persistence R1, R12).
    expect(staged.spec.labels).toEqual({});
  });

  it('labels the build asha.erase-user=true exactly when image.json declares eraseUser, and asha.state-schema=<n> for its stateSchema (agent-persistence A10, A16)', () => {
    const manifest = { tools: [], answerTools: [], keepsMemory: true, eraseUser: true, stateSchema: 1 };
    expect(imageLabels({ manifest })).toEqual({ 'asha.erase-user': 'true', 'asha.state-schema': '1' });
    expect(imageLabels({ manifest: { ...manifest, eraseUser: false } })).toEqual({ 'asha.state-schema': '1' });
    expect(imageLabels({ manifest: { ...manifest, stateSchema: null } })).toEqual({ 'asha.erase-user': 'true' });
    // The checked-in memory image: both.
    const memory = parseImageManifest(
      JSON.parse(readFileSync(resolve(import.meta.dirname, '..', '..', 'images', 'memory', 'image.json'), 'utf8')),
      'memory',
    );
    expect(imageLabels({ manifest: memory })).toEqual({ 'asha.erase-user': 'true', 'asha.state-schema': '1' });
  });

  it('produces the same digest for two stagings of the same inputs, in different directories', async () => {
    const first = await stage();
    const second = await stage();

    expect(second.spec.contextDir).not.toBe(first.spec.contextDir);
    expect(second.spec.sourceDigest).toBe(first.spec.sourceDigest);
  });

  it('changes the digest when any one byte of any input changes', async () => {
    const baseline = (await stage()).spec.sourceDigest;
    const seen = new Set([baseline]);

    for (const [path, content] of Object.entries(INPUTS)) {
      // Flip the last character, then restore it before the next input. A package's manifest must stay JSON with
      // its locked version (copyAgentPackages checks it), so its name changes instead.
      const flip = content.at(-1) === 'X' ? 'Y' : 'X';
      const flipped = path.endsWith('/package.json')
        ? content.replace('"name":"', '"name":"X')
        : content.slice(0, -1) + flip;
      await write(root, placed(path), flipped);
      const digest = (await stage()).spec.sourceDigest;
      expect(digest, `digest did not change when ${path} changed`).not.toBe(baseline);
      seen.add(digest);
      await write(root, placed(path), content);
    }

    expect(seen.size).toBe(1 + Object.keys(INPUTS).length);
    expect((await stage()).spec.sourceDigest).toBe(baseline);
  });

  // debt-paydown R11, A9 (D22): what the checkout's node_modules holds never reaches an image.
  it("copies the agent packages only from dist/agent-packages: the checkout's stray .DS_Store, .env and edited file are not staged", async () => {
    await write(root, 'package.json', present(PACKAGES['package.json'], "PACKAGES['package.json']"));
    await write(root, 'package-lock.json', PACKAGE_LOCK_JSON);
    for (const [path, content] of Object.entries(INPUTS))
      if (path.startsWith('node_modules/')) await write(root, path, content);
    await write(root, 'node_modules/dep-b/.DS_Store', 'finder\n');
    await write(root, 'node_modules/dep-b/.env', 'SECRET=1\n');
    await write(root, 'node_modules/dep-b/index.js', 'module.exports = "edited in the checkout";\n');
    const staged = await stage();
    const files = await listFiles(staged.spec.contextDir);
    // One comparison, so a failure shows each of the three clauses at once.
    expect({
      dsStore: files.filter((f) => f.endsWith('/.DS_Store')),
      env: files.filter((f) => f.endsWith('/.env')),
      editedFile: await readFile(join(staged.spec.contextDir, 'app/node_modules/dep-b/index.js'), 'utf8'),
    }).toEqual({ dsStore: [], env: [], editedFile: INPUTS['node_modules/dep-b/index.js'] });
  });

  it('fails with ImageSourceMissing naming dist/agent-packages when the build did not make it', async () => {
    await rm(join(root, AP), { recursive: true });
    const error = await stage().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageSourceMissing);
    expect((error as ImageSourceMissing).path).toBe(join(root, AP));
    expect(await readdir(stagingParent)).toEqual([]);
  });

  it('cleanup removes the staged context', async () => {
    const staged = await stage();
    await staged.cleanup();

    expect(await absent(staged.spec.contextDir)).toBe(true);
    expect(await readdir(stagingParent)).toEqual([]);
  });

  it('fails with ImageSourceMissing naming a missing package directory or lockfile, leaving no staging directory', async () => {
    await rm(join(root, AP, 'node_modules', 'dep-b'), { recursive: true });
    const error = await stage().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageSourceMissing);
    expect((error as ImageSourceMissing).path).toBe(join(root, AP, 'node_modules', 'dep-b'));
    expect(await readdir(stagingParent)).toEqual([]);

    await rm(join(root, AP, 'package-lock.json'));
    const noLock = await stage().catch((e: unknown) => e);
    expect((noLock as ImageSourceMissing).path).toBe(join(root, AP, 'package-lock.json'));
    expect(await readdir(stagingParent)).toEqual([]);
  });

  it('fails with AgentPackagesInvalid for a dependency the lockfile lacks or marks dev', async () => {
    const lock = JSON.parse(PACKAGE_LOCK_JSON) as { packages: Record<string, Record<string, unknown>> };
    delete lock.packages['node_modules/dep-b'];
    await write(root, placed('package-lock.json'), JSON.stringify(lock));
    await expect(stage()).rejects.toThrow(
      new AgentPackagesInvalid('dep-b, needed by node_modules/dep-a, is not in it'),
    );

    const dev = JSON.parse(PACKAGE_LOCK_JSON) as { packages: Record<string, Record<string, unknown>> };
    present(dev.packages['node_modules/dep-b'], "dev.packages['node_modules/dep-b']").dev = true;
    await write(root, placed('package-lock.json'), JSON.stringify(dev));
    await expect(stage()).rejects.toThrow('node_modules/dep-b is marked dev, but an agent image needs it at run time');
    expect(await readdir(stagingParent)).toEqual([]);
  });

  // Debt D15: a node_modules that is not what the lockfile says never reaches an image (or a release).
  it('fails with AgentPackagesInvalid when an installed package is not the locked version, leaving no staging directory', async () => {
    await write(root, placed('node_modules/dep-b/package.json'), '{"name":"dep-b","version":"2.0.1"}\n');
    await expect(stage()).rejects.toThrow(
      new AgentPackagesInvalid('node_modules/dep-b is installed at 2.0.1 but locked at 2.0.0; run npm ci'),
    );
    expect(await readdir(stagingParent)).toEqual([]);
  });

  it('resolves a nested dependency before the top-level one, as Node does', async () => {
    const lock = JSON.parse(PACKAGE_LOCK_JSON) as { packages: Record<string, Record<string, unknown>> };
    lock.packages['node_modules/dep-a/node_modules/dep-b'] = { version: '2.1.0' };
    await write(root, placed('package-lock.json'), JSON.stringify(lock));
    expect(await agentPackagePaths(join(root, AP))).toEqual([
      'node_modules/@scope/peer',
      'node_modules/dep-a',
      'node_modules/dep-a/node_modules/dep-b',
    ]);
  });

  it('fails with ImageSourceMissing naming the missing path, leaving no staging directory', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'asha-nodist-'));
    await write(
      empty,
      'images/demo/Dockerfile',
      present(INPUTS['images/demo/Dockerfile'], "INPUTS['images/demo/Dockerfile']"),
    );

    const error = await stageAgentImage({
      root: empty,
      image: {
        name: 'demo',
        dir: join(empty, 'images', 'demo'),
        repository: 'asha-image-demo',
        manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
      },
      stagingParent,
    }).catch((e: unknown) => e);

    const missing = join(empty, 'dist', 'src', 'shared');
    expect(error).toBeInstanceOf(ImageSourceMissing);
    expect((error as ImageSourceMissing).path).toBe(missing);
    expect((error as Error).message).toBe(
      `${missing} does not exist: this asha installation is incomplete; reinstall it (brew reinstall asha) or, in a checkout, run \`npm run build\`; if this daemon was started by an earlier asha (after brew upgrade asha), run asha --stop and retry`,
    );
    expect(await readdir(stagingParent)).toEqual([]);
  });
});

describe("stageAgentImage with this repo's package-lock.json and node_modules (docs/plans/otel-traces.md A9)", () => {
  const REPO = resolve(import.meta.dirname, '..', '..');
  /** The Justification table's eleven installed packages. */
  const ELEVEN = [
    'api',
    'api-logs',
    'core',
    'exporter-trace-otlp-http',
    'otlp-exporter-base',
    'otlp-transformer',
    'resources',
    'sdk-logs',
    'sdk-metrics',
    'sdk-trace',
    'semantic-conventions',
  ].map((name) => `@opentelemetry/${name}`);

  it('stages exactly the eleven packages, only their runtime files, and they load under ESM from the staged app', async () => {
    // The real lockfile and node_modules; a stand-in for dist/, which npm test does not build.
    const root = await mkdtemp(join(tmpdir(), 'asha-root-'));
    for (const [path, content] of Object.entries(INPUTS))
      if (!path.startsWith('node_modules/')) await write(root, path, content);
    // dist/agent-packages as the build makes it, with the real lockfile; its packages the checkout's (the closure is the point here).
    await mkdir(join(root, AP), { recursive: true });
    for (const file of ['package.json', 'package-lock.json'])
      await writeFile(join(root, AP, file), await readFile(join(REPO, file)));
    await symlink(join(REPO, 'node_modules'), join(root, AP, 'node_modules'));
    const staged = await stageAgentImage({
      root,
      image: {
        name: 'demo',
        dir: join(root, 'images', 'demo'),
        repository: 'asha-image-demo',
        manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
      },
      stagingParent: await mkdtemp(join(tmpdir(), 'asha-staging-')),
    });
    const app = join(staged.spec.contextDir, 'app');
    const files = (await listFiles(join(app, 'node_modules'))).map((f) => `node_modules/${f}`);

    const packages = [...new Set(files.map((f) => f.split('/').slice(1, 3).join('/')))].sort(byCodeUnit);
    expect(packages).toEqual(ELEVEN);
    const lock = JSON.parse(await readFile(join(REPO, 'package-lock.json'), 'utf8')) as {
      packages: Record<string, { dev?: boolean }>;
    };
    const dev = Object.keys(lock.packages)
      .filter((p) => present(lock.packages[p], `lock.packages[${JSON.stringify(p)}]`).dev === true)
      .map((p) => p.replace(/^.*node_modules\//, ''));
    expect(dev).toEqual(expect.arrayContaining(['typescript', 'vitest', 'marked', '@types/node']));
    expect(packages.filter((p) => dev.includes(p))).toEqual([]);
    expect(
      files.filter((f) => f.endsWith('.map') || f.endsWith('.d.ts') || f.includes('/esm/') || f.includes('/esnext/')),
    ).toEqual([]);
    expect(files.filter((f) => f.split('/').indexOf('node_modules', 1) > 0)).toEqual([]);

    await writeFile(join(app, 'package.json'), '{"type":"module"}\n');
    await writeFile(
      join(app, 'probe.mjs'),
      "import { TracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace';\n" +
        "import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';\n" +
        "import { trace } from '@opentelemetry/api';\n" +
        "import { setGlobalErrorHandler } from '@opentelemetry/core';\n" +
        'console.log([TracerProvider, BatchSpanProcessor, OTLPTraceExporter, trace.setSpanContext, setGlobalErrorHandler].map((x) => typeof x).join(","));\n',
    );
    const loaded = execFileSync(process.execPath, [join(app, 'probe.mjs')], {
      cwd: app,
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(loaded).toBe('function,function,function,function,function\n');
    await staged.cleanup();
    // Its own bound: it copies the real packages and imports them, about 2.3 s in a full unit run, and passed vitest's
    // default 5 s once (2026-10-01, at 5,003 ms) while Spotlight indexed a fresh worktree's node_modules beside it.
  }, 20_000);
});
