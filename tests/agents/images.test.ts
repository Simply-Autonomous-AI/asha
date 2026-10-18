// Image tags on the real container runtime (debt D23): ColimaRuntime.ensureImage
// on colima's `default` profile builds each source digest to its own tag,
// `<repository>:<digest hex>`, and never replaces one. Building one image name
// under two digests leaves both tags, each labelled with its own digest; the
// first is then current, with no build.
//
// No daemon and no model: the runtime is composed here as the daemon composes
// it (compose.ts), for a home id no daemon has, confined (ensureReady) and
// reclaimed at the end. The images are named for this process and removed.

import { randomBytes } from 'node:crypto';
import { execFile, type ExecFileException } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ColimaRuntime } from '../../src/daemon/container-runtime/index.js';
import { directoryDigest } from '../../src/daemon/images/index.js';
import { JsonLinesLogger } from '../../src/daemon/log.js';
import { ExecCommandRunner } from '../../src/daemon/process/index.js';
import { SpawnInteractiveLauncher, SpawnProcessLauncher } from '../../src/daemon/process/launcher.js';
import { byCodeUnit } from '../../src/shared/order.js';

/** The base every agent image is built from, pinned by digest (images/*\/Dockerfile). */
const BASE = 'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';
const REPOSITORY = `asha-image-tagtest-${String(process.pid)}`;

let dir: string;
let logFile: string;
let runtime: ColimaRuntime;
const tags: string[] = [];

/** `execFile`'s callback error as `docker()`'s exit code: 0 for none, its numeric code, or -1 when not numeric. */
function execCode(error: ExecFileException | null): number {
  if (error === null) return 0;
  return typeof error.code === 'number' ? error.code : -1;
}

function docker(args: readonly string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(
      'docker',
      [...args],
      { env: { ...process.env, DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock` }, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          code: execCode(error),
          out: `${stdout}${stderr}`,
        });
      },
    ),
  );
}

/** A build context with a RUN step (the layer whose snapshot D23 lost), differing only in `marker`. */
async function context(marker: string): Promise<{ contextDir: string; sourceDigest: string }> {
  const contextDir = await mkdtemp(join(dir, 'ctx-'));
  await writeFile(
    join(contextDir, 'Dockerfile'),
    `FROM ${BASE}\nCOPY marker /marker\nRUN cat /marker > /marker.copy\n`,
  );
  await writeFile(join(contextDir, 'marker'), marker);
  return { contextDir, sourceDigest: await directoryDigest(contextDir) };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asha-agents-images-'));
  logFile = join(dir, 'runtime.jsonl');
  runtime = new ColimaRuntime({
    runner: new ExecCommandRunner(),
    launcher: new SpawnProcessLauncher(),
    interactive: new SpawnInteractiveLauncher(),
    logger: new JsonLinesLogger({ file: logFile, echo: () => undefined, clock: () => new Date() }),
    profile: 'default',
    homeId: randomBytes(4).toString('hex'),
    clock: () => new Date(),
  });
  // Resolves the docker socket; the port is one nothing listens on, since no container is started.
  await runtime.ensureReady(9);
});

afterAll(async () => {
  const removed = await Promise.all(tags.map((tag) => docker(['image', 'rm', tag])));
  await runtime.reclaim();
  expect(removed.filter((r) => r.code !== 0).map((r) => r.out)).toEqual([]);
});

describe('image tags (D23)', () => {
  it('builds one image name under two source digests to two tags, and leaves both', async () => {
    const first = await context(`first ${randomBytes(8).toString('hex')}`);
    const second = await context(`second ${randomBytes(8).toString('hex')}`);
    expect(first.sourceDigest).not.toBe(second.sourceDigest);

    const a = await runtime.ensureImage({ repository: REPOSITORY, ...first, labels: {} });
    tags.push(a.tag);
    const b = await runtime.ensureImage({ repository: REPOSITORY, ...second, labels: {} });
    tags.push(b.tag);
    expect(a).toEqual({
      tag: `${REPOSITORY}:${first.sourceDigest.slice('sha256:'.length)}`,
      status: 'built',
      labels: expect.objectContaining({ 'asha.source': first.sourceDigest }) as { 'asha.source': string },
    });
    expect(b).toEqual({
      tag: `${REPOSITORY}:${second.sourceDigest.slice('sha256:'.length)}`,
      status: 'built',
      labels: expect.objectContaining({ 'asha.source': second.sourceDigest }) as { 'asha.source': string },
    });

    // Both tags exist after the second build, each labelled with its own digest.
    for (const [tag, digest] of [
      [a.tag, first.sourceDigest],
      [b.tag, second.sourceDigest],
    ] as const) {
      const label = await docker(['image', 'inspect', '--format', '{{ index .Config.Labels "asha.source" }}', tag]);
      expect(label, tag).toEqual({ code: 0, out: `${digest}\n` });
    }
    const listed = await docker(['image', 'ls', '--format', '{{.Tag}}', REPOSITORY]);
    expect(listed.code, listed.out).toBe(0);
    expect(listed.out.trim().split('\n').sort(byCodeUnit)).toEqual(
      [a.tag, b.tag].map((t) => t.slice(REPOSITORY.length + 1)).sort(byCodeUnit),
    );

    // The first source's image is still current: no build.
    await expect(runtime.ensureImage({ repository: REPOSITORY, ...first, labels: {} })).resolves.toEqual({
      tag: a.tag,
      status: 'current',
      labels: expect.objectContaining({ 'asha.source': first.sourceDigest }) as { 'asha.source': string },
    });
    const building = (await readFile(logFile, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r['event'] === 'image.building')
      .map((r) => r['tag']);
    expect(building).toEqual([a.tag, b.tag]);
  });
});
