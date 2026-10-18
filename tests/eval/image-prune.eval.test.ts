// The image prune at a real daemon start, on colima (docs/plans/debt-paydown-2.md R1, R2, A5; debt D27).
//
// The test builds throwaway versions of its own repositories (every name holds `prunetest-<pid>`, every image and
// container carries the label below), dated in the past with SOURCE_DATE_EPOCH, starts a daemon of a fresh home with
// `./asha --server`, and reads that start's prune record. Expected, of the test's own images: exactly the old, unused,
// not-newest, correctly labelled asha versions gone; the newest, one under 24 h, one a stopped container uses by tag,
// one by image id, one a running container uses, one whose label names another digest, a lone version, and both
// versions of a repository that is not asha's, all still present; a module image built FROM a removed base version
// still runs. The same prune also removes the owner's own old asha versions on the profile (the owner's rule, record
// `debt-image-prune` (a)); the test asserts of them only that every tag removed is an asha repository's (R2 (a)).
//
// Run on an otherwise idle machine: a prune skipped because a build held the images lock fails the test naming that
// cause (a busy machine, not a pass), and is never retried. The teardown removes every container and image carrying
// the test's label, and stops its daemon.

import { execFile, spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';
import { TEST_DAEMON_ENV } from '../helpers/test-daemon-env.js';

const REPO = resolve(import.meta.dirname, '..', '..');
const ASHA = join(REPO, 'asha');
const MODELS = process.env['ASHA_MODELS_DIR'] || join(homedir(), '.simplyautonomous', 'harness', 'models');
const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;
/** The agent images' pinned base, present on any Mac that has run an agent (images/*\/Dockerfile). */
const BASE = 'node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32';
const ID = `prunetest-${String(process.pid)}`;
const LABEL = `asha.probe=image-prune-eval-${String(process.pid)}`;
const ASHA_REPOSITORY = /^asha-(image|harness|module|plugin)-[a-z0-9][a-z0-9._-]*$/;

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<Run> {
  return new Promise((done, fail) => {
    execFile(
      command,
      [...args],
      { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1 << 26 },
      (error, stdout, stderr) => {
        if (error?.killed)
          fail(new Error(`${command} ${args.join(' ')} exceeded ${String(timeoutMs)} ms\nstderr: ${stderr}`));
        else if (error && typeof error.code !== 'number') {
          const rejection: Error = error;
          fail(rejection);
        } else done({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}
const docker = (args: readonly string[], timeoutMs = 120_000) =>
  run('docker', args, { ...process.env, DOCKER_HOST }, timeoutMs);
async function must(args: readonly string[], timeoutMs = 300_000): Promise<Run> {
  const r = await docker(args, timeoutMs);
  if (r.code !== 0) throw new Error(`docker ${args.join(' ')} exited ${String(r.code)}: ${r.stderr.trim()}`);
  return r;
}
/** Whether `ref` names an image docker still has. Named apart from the shared `present` (assert-present.js), which
 *  asserts a value is not missing rather than reporting presence. */
const imageExists = async (ref: string): Promise<boolean> => {
  const r = await docker(['image', 'inspect', '--format', '{{.Id}}', ref]);
  if (r.code === 0) return true;
  if (/No such image/i.test(r.stderr)) return false;
  throw new Error(`docker image inspect ${ref} exited ${String(r.code)}: ${r.stderr.trim()}`);
};

const hex = (n: number) => n.toString(16).padStart(64, 'c');
const IMG = `asha-image-${ID}`;
const HAR = `asha-harness-${ID}`;
const MOD = `asha-module-${ID}`;
const LONE = `asha-plugin-${ID}`;
const OTHER = `${ID}-other`;

/** Every version the test builds: its ref, its age, its label, what it is built FROM, and what the prune must do. */
const VERSIONS: readonly {
  readonly ref: string;
  readonly hoursAgo: number;
  readonly source: string;
  readonly from?: string;
  readonly expect: 'removed' | 'kept';
  readonly why: string;
}[] = [
  {
    ref: `${IMG}:${hex(1)}`,
    hoursAgo: 72,
    source: `sha256:${hex(1)}`,
    expect: 'removed',
    why: 'old, unused, not newest',
  },
  {
    ref: `${IMG}:${hex(2)}`,
    hoursAgo: 60,
    source: `sha256:${hex(2)}`,
    expect: 'kept',
    why: 'a stopped container names it by tag',
  },
  {
    ref: `${IMG}:${hex(3)}`,
    hoursAgo: 58,
    source: `sha256:${hex(3)}`,
    expect: 'kept',
    why: 'a stopped container names it by image id',
  },
  {
    ref: `${IMG}:${hex(4)}`,
    hoursAgo: 48,
    source: `sha256:${hex(99)}`,
    expect: 'kept',
    why: 'its asha.source label names another digest',
  },
  {
    ref: `${IMG}:${hex(5)}`,
    hoursAgo: 40,
    source: `sha256:${hex(5)}`,
    expect: 'kept',
    why: 'a running container uses it',
  },
  {
    ref: `${IMG}:${hex(6)}`,
    hoursAgo: 30,
    source: `sha256:${hex(6)}`,
    expect: 'removed',
    why: 'old, unused, not newest',
  },
  { ref: `${IMG}:${hex(7)}`, hoursAgo: 20, source: `sha256:${hex(7)}`, expect: 'kept', why: 'under 24 h' },
  { ref: `${IMG}:${hex(8)}`, hoursAgo: 2, source: `sha256:${hex(8)}`, expect: 'kept', why: 'the newest' },
  {
    ref: `${HAR}:${hex(11)}`,
    hoursAgo: 72,
    source: `sha256:${hex(11)}`,
    expect: 'removed',
    why: 'an old base version (a module image is built FROM it)',
  },
  { ref: `${HAR}:${hex(12)}`, hoursAgo: 1, source: `sha256:${hex(12)}`, expect: 'kept', why: 'the newest' },
  {
    ref: `${MOD}:${hex(13)}`,
    hoursAgo: 1,
    source: `sha256:${hex(13)}`,
    from: `${HAR}:${hex(11)}`,
    expect: 'kept',
    why: 'the lone module version, built FROM the removed base version',
  },
  {
    ref: `${LONE}:${hex(14)}`,
    hoursAgo: 72,
    source: `sha256:${hex(14)}`,
    expect: 'kept',
    why: 'the only version of its repository',
  },
  {
    ref: `${OTHER}:${hex(21)}`,
    hoursAgo: 72,
    source: `sha256:${hex(21)}`,
    expect: 'kept',
    why: 'not an asha repository (another project)',
  },
  {
    ref: `${OTHER}:${hex(22)}`,
    hoursAgo: 60,
    source: `sha256:${hex(22)}`,
    expect: 'kept',
    why: 'not an asha repository (another project)',
  },
];

const work = join(tmpdir(), `asha-eval-${ID}`);
let home: string | undefined;
let daemon: ReturnType<typeof spawn> | undefined;

afterAll(async () => {
  if (home !== undefined)
    await run(
      ASHA,
      ['--stop'],
      { ...process.env, ...TEST_DAEMON_ENV, ASHA_HOME: home, ASHA_MODELS_DIR: MODELS },
      120_000,
    );
  if (daemon !== undefined && daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGKILL');
  // Only what carries this test's label: its containers, then its images (by tag, then by id for any left untagged).
  const containers = (await must(['ps', '--all', '--quiet', '--filter', `label=${LABEL}`])).stdout
    .split('\n')
    .filter(Boolean);
  if (containers.length > 0) await must(['rm', '--force', ...containers]);
  const refs = (
    await must(['image', 'ls', '--filter', `label=${LABEL}`, '--format', '{{.Repository}}:{{.Tag}}'])
  ).stdout
    .split('\n')
    .filter((r) => r !== '' && !r.includes('<none>'));
  if (refs.length > 0) await must(['image', 'rm', ...refs]);
  const ids = (await must(['image', 'ls', '--all', '--quiet', '--no-trunc', '--filter', `label=${LABEL}`])).stdout
    .split('\n')
    .filter(Boolean);
  if (ids.length > 0) await must(['image', 'rm', ...new Set(ids)]);
  const left = (await must(['image', 'ls', '--all', '--quiet', '--filter', `label=${LABEL}`])).stdout.trim();
  if (left !== '') throw new Error(`images labelled ${LABEL} left after the teardown: ${left}`);
}, 300_000);

describe('the image prune at a real daemon start (debt-paydown-2 R1, R2, A5; D27)', () => {
  it("removes exactly the test's old, unused, not-newest asha versions, keeps every other one and another project's images, and a module built FROM a removed base version still runs", async () => {
    // Build every version, dated in the past (SOURCE_DATE_EPOCH sets .Created, debt-paydown P3d).
    for (const v of VERSIONS) {
      const dir = join(work, v.ref.replace(/[:/]/g, '_'));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'marker'), `${v.ref} ${randomUUID()}\n`);
      await writeFile(join(dir, 'Dockerfile'), `FROM ${v.from ?? BASE}\nCOPY marker /marker\n`);
      const epoch = Math.floor((Date.now() - v.hoursAgo * 3_600_000) / 1000);
      await must([
        'build',
        '--network=none',
        '--label',
        LABEL,
        '--label',
        `asha.source=${v.source}`,
        '--build-arg',
        `SOURCE_DATE_EPOCH=${String(epoch)}`,
        '--tag',
        v.ref,
        dir,
      ]);
    }
    // Two stopped containers (one by tag, one by image id) and one running container.
    const byId = (
      await must(['image', 'inspect', '--format', '{{.Id}}', present(VERSIONS[2], 'VERSIONS[2]').ref])
    ).stdout.trim();
    await must([
      'create',
      '--pull',
      'never',
      '--name',
      `asha-${ID}-bytag`,
      '--label',
      LABEL,
      '--network',
      'none',
      present(VERSIONS[1], 'VERSIONS[1]').ref,
      'true',
    ]);
    await must([
      'create',
      '--pull',
      'never',
      '--name',
      `asha-${ID}-byid`,
      '--label',
      LABEL,
      '--network',
      'none',
      byId,
      'true',
    ]);
    await must([
      'run',
      '--detach',
      '--pull',
      'never',
      '--name',
      `asha-${ID}-running`,
      '--label',
      LABEL,
      '--network',
      'none',
      present(VERSIONS[4], 'VERSIONS[4]').ref,
      'sleep',
      '600',
    ]);
    for (const v of VERSIONS) expect(await imageExists(v.ref), `${v.ref} built`).toBe(true);

    // A daemon of a fresh home: its start prunes, before it listens.
    home = join(await mkdtemp(join(tmpdir(), 'asha-eval-prune-')), 'home');
    const env = { ...process.env, ...TEST_DAEMON_ENV, ASHA_HOME: home, ASHA_MODELS_DIR: MODELS };
    daemon = spawn(ASHA, ['--server'], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    const log = join(home, 'logs', 'daemon.jsonl');
    const records = (): Record<string, unknown>[] =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map((l) => JSON.parse(l) as Record<string, unknown>)
        : [];
    const deadline = Date.now() + 60_000;
    while (!records().some((r) => r['event'] === 'daemon.started')) {
      if (Date.now() > deadline)
        throw new Error(
          `no daemon.started within 60,000 ms; records: ${JSON.stringify(records().map((r) => r['event']))}`,
        );
      if (daemon.exitCode !== null)
        throw new Error(
          `the daemon exited ${String(daemon.exitCode)} before daemon.started; records: ${JSON.stringify(records())}`,
        );
      await new Promise((r) => setTimeout(r, 100));
    }
    const prune = records().filter((r) => typeof r['event'] === 'string' && r['event'].startsWith('image.prune'));
    const skipped = prune.find((r) => r['event'] === 'image.prune_skipped');
    if (skipped !== undefined)
      throw new Error(
        `the prune was skipped (${String(skipped['reason'])}): a busy machine, not a pass — run on an otherwise idle machine`,
      );
    expect(
      prune.filter((r) => r['event'] === 'image.prune_failed'),
      'image.prune_failed',
    ).toEqual([]);
    const pruned = prune.filter((r) => r['event'] === 'image.pruned');
    expect(pruned, 'one image.pruned at the start').toHaveLength(1);
    const theOnlyPrune = present(pruned[0], 'pruned[0]');
    const removed = theOnlyPrune['removed'] as string[];
    // The selection itself keeps them: Docker's own refusal (image.prune_refused) is a backstop, never relied on here.
    const refused = prune.filter((r) => r['event'] === 'image.prune_refused' && String(r['tag']).includes(ID));
    expect(
      refused.map((r) => r['tag']),
      "the test's versions refused by Docker (the selection should have kept them)",
    ).toEqual([]);
    expect(
      removed.filter((tag) => !ASHA_REPOSITORY.test(present(tag.split(':')[0], `${tag}: repository part`))),
      'removed tags outside asha repositories',
    ).toEqual([]);

    for (const v of VERSIONS) {
      const there = await imageExists(v.ref);
      expect(`${v.ref} ${there ? 'present' : 'gone'}`, `${v.ref}: expected ${v.expect} — ${v.why}`).toBe(
        `${v.ref} ${v.expect === 'kept' ? 'present' : 'gone'}`,
      );
      expect(removed.includes(v.ref), `${v.ref} in image.pruned's removed`).toBe(v.expect === 'removed');
    }
    const ran = await docker([
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--label',
      LABEL,
      present(VERSIONS[10], 'VERSIONS[10]').ref,
      'cat',
      '/marker',
    ]);
    expect(ran.code, `the module image built FROM the removed base version runs: ${ran.stderr}`).toBe(0);
    expect(Number(theOnlyPrune['ms'])).toBeLessThan(10_000);
    // What the start's prune did, for the record.
    console.log(`image.pruned at the eval's daemon start: ${JSON.stringify(pruned[0])}`);
  });
});
