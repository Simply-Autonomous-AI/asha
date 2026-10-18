import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ColimaRuntime,
  ContainerIsolationFailed,
  ContainerRuntimeError,
  ContainerStoppedBeforeStart,
  AGENT_DNS_SERVER,
  egressRulesScript,
  HOST_GATEWAY,
  ImageBuildFailed,
  imageLockFile,
  imageLockScript,
  IMAGES_LOCK_FILE,
  ImageGone,
  PRUNE_LOCK_SCRIPT,
  remoteExitStatus,
  selectPrunable,
  type ImageVersion,
  imageTag,
  installScript,
  parseDockerSocket,
  parseImageInspect,
  parseImageListing,
  reclaimScript,
  removeHomeContainers,
} from '../../src/daemon/container-runtime/index.js';
import { workspaceArchive } from '../../src/daemon/container-runtime/archive.js';
import { PrerequisiteMissing, ToolInstallFailed } from '../../src/daemon/host-tools/index.js';
import { serializeError } from '../../src/daemon/log.js';
import { CommandTimedOut } from '../../src/daemon/process/index.js';
import { AGENT_STOP_GRACE_MS } from '../../src/shared/protocol.js';
import { present } from '../../src/shared/assert-present.js';
import { DOCKER_TABLE, FakeVm, warmFakeCommands } from '../helpers/fake-iptables.js';
import {
  FakeInteractive,
  FakeLauncher,
  FakeRunner,
  LockingRunner,
  RecordingLogger,
  type LogEntry,
  type RecordedCommand,
  VmLocks,
  colimaExit,
  fail,
  ok,
} from '../helpers/fakes.js';

/** `runner.calls[index]`, which must exist. */
function callAt(runner: FakeRunner, index: number): RecordedCommand {
  return present(runner.calls[index], `runner.calls[${String(index)}]`);
}

/** `launcher.launched[index]`, which must exist. */
function launchedAt<T>(launcher: { launched: readonly T[] }, index: number): T {
  return present(launcher.launched[index], `launcher.launched[${String(index)}]`);
}

/** `logger.entries[index]`, which must exist. */
function entryAt(logger: RecordingLogger, index: number): LogEntry {
  return present(logger.entries[index], `logger.entries[${String(index)}]`);
}

/** What `fn` throws, or undefined when it returns: its type and message both asserted, where `toThrow` checks the message alone. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** An abort signal already aborted with `reason`: a caller's own bound, already passed. */
function abortedWith(reason: Error): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

const SOCKET = 'unix:///Users/u/.colima/default/docker.sock';
const STATUS = JSON.stringify({ runtime: 'docker', docker_socket: SOCKET });
const HOME_ID = 'abcd1234';
const NETWORK = `asha-${HOME_ID}`;
const PORT = 51234;
/** The runtime's clock: dates the files placed in a container's /workspace. */
const NOW = new Date('2026-09-29T00:00:00.000Z');
const SUBNET = '172.18.0.0/16';
/** `docker network inspect --format '{{json .}}'` of the network as created, with fields overridden. */
const inspected = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    Name: NETWORK,
    Driver: 'bridge',
    EnableIPv6: false,
    IPAM: { Driver: 'default', Config: [{ Subnet: SUBNET, Gateway: '172.18.0.1' }] },
    Options: { 'com.docker.network.bridge.name': `asha${HOME_ID}`, 'com.docker.network.bridge.enable_icc': 'false' },
    ...over,
  });
const INSTALLED = ok('asha-isolation: ready jump_fixed=0 input_jump_fixed=0 home_rules_replaced=1\n');
const SSH = `colima ssh --profile default -- sudo sh -s`;
/** The commands the first confinement of a daemon's life runs, after colima status. */
const FIRST_CONFINE = [
  `docker ps --all --quiet --filter label=asha.home=${HOME_ID}`,
  `docker volume ls --quiet --filter label=asha.home=${HOME_ID}`,
  `docker network ls --filter name=^${NETWORK}$ --format {{.Name}}`,
  `docker network create --driver bridge --opt com.docker.network.bridge.name=asha${HOME_ID} --opt com.docker.network.bridge.enable_icc=false --ipv6=false ${NETWORK}`,
  `docker network inspect --format {{json .}} ${NETWORK}`,
  SSH,
];

/** Two source digests of one image, and the tag each is built and run as. */
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const TAG_A = `img:${'a'.repeat(64)}`;
const TAG_B = `img:${'b'.repeat(64)}`;

function setup(runner: FakeRunner) {
  const logger = new RecordingLogger();
  const launcher = new FakeLauncher();
  const interactive = new FakeInteractive();
  const runtime = new ColimaRuntime({
    runner,
    launcher,
    interactive,
    logger,
    profile: 'default',
    homeId: HOME_ID,
    clock: () => NOW,
  });
  return { runtime, logger, launcher, interactive };
}

/** Scripts the network and rule steps of a first confinement, all succeeding. */
function confines(runner: FakeRunner): FakeRunner {
  return runner
    .on('docker ps --all --quiet --filter label=', ok(''))
    .on('docker volume ls', ok(''))
    .on('docker network ls', ok(''))
    .on('docker network create', ok('e7a7b590\n'))
    .on('docker network inspect', ok(inspected()))
    .on('colima ssh', INSTALLED);
}

describe('ColimaRuntime.ensureReady', () => {
  it('only probes when colima and docker are installed and colima is running, then confines containers', async () => {
    const runner = confines(
      new FakeRunner().on('colima version', ok('0.10.1')).on('docker --version', ok()).on('colima status', ok(STATUS)),
    );
    const { runtime, logger } = setup(runner);

    await expect(runtime.ensureReady(PORT)).resolves.toBe('ready');

    expect(runner.lines()).toEqual([
      'colima version',
      'docker --version',
      'colima status --profile default --json',
      ...FIRST_CONFINE,
    ]);
    expect(logger.entries.find((e) => e.event === 'colima.ready')).toEqual({
      level: 'info',
      event: 'colima.ready',
      fields: { profile: 'default', dockerHost: SOCKET, started: false },
    });
    expect(
      present(
        logger.entries.find((e) => e.event === 'isolation.network_created'),
        "logger.entries.find('isolation.network_created')",
      ).fields,
    ).toEqual({
      network: NETWORK,
      bridge: `asha${HOME_ID}`,
      subnets: [SUBNET],
    });
    expect(logger.entries.at(-1)).toEqual({
      level: 'info',
      event: 'agent.isolation_ready',
      fields: {
        homeId: HOME_ID,
        network: NETWORK,
        hostPort: PORT,
        jumpFixed: false,
        inputJumpFixed: false,
        homeRulesReplaced: true,
        durationMs: expect.any(Number) as number,
      },
    });
  });

  it('starts colima when it is installed but stopped', async () => {
    const runner = new FakeRunner()
      .on('colima version', ok())
      .on('docker --version', ok())
      .on('colima status', fail(1, 'colima is not running'), ok(STATUS))
      .on('colima start', ok());
    const { runtime } = setup(confines(runner));

    await expect(runtime.ensureReady(PORT)).resolves.toBe('started');

    expect(runner.lines()).toEqual([
      'colima version',
      'docker --version',
      'colima status --profile default --json',
      'colima start --profile default',
      'colima status --profile default --json',
      ...FIRST_CONFINE,
    ]);
    expect(callAt(runner, 3).options.timeoutMs).toBe(600_000);
  });

  it('installs colima with Homebrew when it is missing, then starts it', async () => {
    const runner = new FakeRunner()
      .on('colima version', 'not-found', ok())
      .on('brew --version', ok('Homebrew 6'))
      .on('brew install colima', ok())
      .on('docker --version', ok())
      .on('colima status', fail(1, 'not running'), ok(STATUS))
      .on('colima start', ok());
    const { runtime, logger } = setup(confines(runner));

    await expect(runtime.ensureReady(PORT)).resolves.toBe('installed');

    expect(runner.lines()).toEqual([
      'colima version',
      'brew --version',
      'brew install colima',
      'colima version',
      'docker --version',
      'colima status --profile default --json',
      'colima start --profile default',
      'colima status --profile default --json',
      ...FIRST_CONFINE,
    ]);
    expect(logger.events()).toContain('host_tool.installed');
  });

  it('installs the docker CLI when only it is missing', async () => {
    const runner = new FakeRunner()
      .on('colima version', ok())
      .on('docker --version', 'not-found', ok())
      .on('brew --version', ok())
      .on('brew install docker', ok())
      .on('colima status', ok(STATUS));
    const { runtime } = setup(confines(runner));

    await expect(runtime.ensureReady(PORT)).resolves.toBe('installed');
    expect(runner.lines()).toContain('brew install docker');
  });

  it('fails with PrerequisiteMissing when Homebrew is absent', async () => {
    const runner = new FakeRunner().on('colima version', 'not-found').on('brew --version', 'not-found');
    const { runtime } = setup(runner);

    const error = await runtime.ensureReady(PORT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrerequisiteMissing);
    expect((error as PrerequisiteMissing).prerequisite).toBe('Homebrew');
    expect(runner.lines()).toEqual(['colima version', 'brew --version']);
  });

  it("surfaces brew's output when the install fails", async () => {
    const runner = new FakeRunner()
      .on('colima version', 'not-found')
      .on('brew --version', ok())
      .on('brew install colima', { code: 1, stdout: 'Downloading…', stderr: 'Error: no bottle available' });
    const { runtime } = setup(runner);

    const error = await runtime.ensureReady(PORT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolInstallFailed);
    expect((error as Error).message).toContain('Error: no bottle available');
  });

  it('fails when brew exits 0 but the tool still does not run', async () => {
    const runner = new FakeRunner()
      .on('colima version', 'not-found')
      .on('brew --version', ok())
      .on('brew install colima', ok());
    const { runtime } = setup(runner);
    await expect(runtime.ensureReady(PORT)).rejects.toThrow('exited 0 but colima is still not runnable');
  });

  it('fails with the command output when colima start fails', async () => {
    const runner = new FakeRunner()
      .on('colima version', ok())
      .on('docker --version', ok())
      .on('colima status', fail(1, 'not running'))
      .on('colima start', fail(1, 'FATA error starting vm: insufficient memory'));
    const { runtime } = setup(runner);

    const error = await runtime.ensureReady(PORT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerRuntimeError);
    expect((error as Error).message).toContain('insufficient memory');
  });

  it('fails naming the status when colima starts but its status still fails, and confines nothing', async () => {
    const runner = new FakeRunner()
      .on('colima version', ok())
      .on('docker --version', ok())
      .on('colima status', fail(1, 'colima is not running'), fail(1, 'FATA[0000] error retrieving current runtime'))
      .on('colima start', ok());
    const { runtime, logger } = setup(runner);

    const error = await runtime.ensureReady(PORT).catch((e: unknown) => e);

    expect([
      error instanceof ContainerRuntimeError,
      error instanceof ContainerIsolationFailed,
      (error as Error).message,
    ]).toEqual([
      true,
      false,
      'colima started but its status still fails:\nFATA[0000] error retrieving current runtime',
    ]);
    expect(runner.lines()).toEqual([
      'colima version',
      'docker --version',
      'colima status --profile default --json',
      'colima start --profile default',
      'colima status --profile default --json',
    ]);
    expect(logger.entries).toEqual([{ level: 'info', event: 'colima.starting', fields: { profile: 'default' } }]);
  });
});

describe('parseDockerSocket', () => {
  it('reads docker_socket from colima status JSON', () => {
    expect(parseDockerSocket(STATUS)).toBe(SOCKET);
  });
  it('rejects a status with no docker socket (a containerd runtime)', () => {
    expect(() => parseDockerSocket(JSON.stringify({ runtime: 'containerd' }))).toThrow('has no docker_socket');
  });
  it('rejects output that is not JSON', () => {
    expect(() => parseDockerSocket('colima is running')).toThrow('printed invalid JSON');
  });
});

describe("a plugin container's create past its bound (extension-modules R30; R1-SECURITY-002)", () => {
  it("names the container and the bound, and holds none of the call's arguments, in its message or its cause", async () => {
    const args = ['s3', 'cp', 's3://secret-bucket/reports/q3.csv', '-'];
    const runner = new FakeRunner().on(
      'docker create',
      new CommandTimedOut('docker', ['create', '--name', 'asha-plugin-1', 'p:1', ...args], 60_000),
    );
    const { runtime } = await readyRuntime(runner);
    const error = await runtime
      .pluginContainer({
        name: 'asha-plugin-1',
        image: 'p:1',
        network: 'n',
        entrypoint: 'aws',
        args,
        env: {},
        labels: {},
      })
      .create(new AbortController().signal)
      .catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'docker create asha-plugin-1 did not finish within 60000 ms',
    ]);
    expect(JSON.stringify(serializeError(error))).not.toContain('secret-bucket');
  });
});

describe('a runtime step that passes its bound fails typed, never as an untyped timeout (R1-DOCS-006)', () => {
  const base = () =>
    new FakeRunner().on('colima version', ok()).on('docker --version', ok()).on('colima status', ok(STATUS));

  it("the confinement's colima ssh: ContainerIsolationFailed naming the step and the bound", async () => {
    const runner = confines(base().on('colima ssh', new CommandTimedOut('colima', ['ssh'], 30_000)));
    const error = await setup(runner)
      .runtime.ensureReady(PORT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect([(error as Error).message, (error as Error).cause]).toEqual([
      'container isolation failed: rule install: colima ssh did not finish within 30000 ms',
      expect.any(CommandTimedOut),
    ]);
  });

  it('a docker network call of the confinement: ContainerIsolationFailed naming the network and the command, never its arguments', async () => {
    const runner = confines(
      base().on('docker network create', new CommandTimedOut('docker', ['network', 'create', '--opt', 'x'], 60_000)),
    );
    const error = await setup(runner)
      .runtime.ensureReady(PORT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect((error as Error).message).toBe(
      `container isolation failed: network ${NETWORK}: docker network create did not finish within 60000 ms`,
    );
  });

  it('colima start: ContainerRuntimeError naming it and its bound', async () => {
    const runner = new FakeRunner()
      .on('colima version', ok())
      .on('docker --version', ok())
      .on('colima status', fail(1, 'colima is not running'))
      .on('colima start', new CommandTimedOut('colima', ['start'], 600_000));
    const error = await setup(runner)
      .runtime.ensureReady(PORT)
      .catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'colima start --profile default did not finish within 600000 ms',
    ]);
  });

  it('docker build: ImageBuildFailed naming the tag and its bound', async () => {
    const runner = new LockingRunner()
      .on('docker image inspect', fail(1, 'No such image'))
      .on('docker build', new CommandTimedOut('docker', ['build'], 600_000));
    const { runtime } = await readyRuntime(runner);
    const error = await runtime
      .ensureImage({ repository: 'img', contextDir: '/ctx', sourceDigest: DIGEST_A, labels: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageBuildFailed);
    expect([(error as ImageBuildFailed).tag, (error as ImageBuildFailed).output]).toEqual([
      TAG_A,
      'docker build did not finish within 600000 ms',
    ]);
  });

  it('any other docker call: ContainerRuntimeError naming the command and its bound', async () => {
    const runner = new FakeRunner().on(
      'docker volume rm',
      new CommandTimedOut('docker', ['volume', 'rm', 'v'], 60_000),
    );
    const { runtime } = await readyRuntime(runner);
    const error = await runtime.removeVolume('v').catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'docker volume rm did not finish within 60000 ms',
    ]);
  });
});

async function readyRuntime(runner: FakeRunner) {
  runner.on('colima version', ok()).on('docker --version', ok()).on('colima status', ok(STATUS));
  const parts = setup(confines(runner));
  await parts.runtime.ensureReady(PORT);
  runner.calls.length = 0;
  return parts;
}

describe('ColimaRuntime docker operations', () => {
  it('refuses docker operations before ensureReady', async () => {
    const { runtime } = setup(new FakeRunner());
    await expect(
      runtime.ensureImage({ repository: 'img', contextDir: '/c', sourceDigest: DIGEST_A, labels: {} }),
    ).rejects.toThrow('used before ensureReady()');
  });

  it('refuses a source digest that is not sha256:<64 hex>, running nothing', async () => {
    const runner = new FakeRunner();
    const { runtime } = await readyRuntime(runner);
    await expect(
      runtime.ensureImage({ repository: 'img', contextDir: '/c', sourceDigest: 'sha256:abc', labels: {} }),
    ).rejects.toThrow('sourceDigest must be sha256:<64 hex>, not "sha256:abc"');
    expect(runner.calls).toEqual([]);
  });

  it('names each image by its source digest: imageTag is <repository>:<digest hex>', () => {
    expect(imageTag({ repository: 'asha-image-demo', sourceDigest: DIGEST_A })).toBe(
      `asha-image-demo:${'a'.repeat(64)}`,
    );
  });

  it("reuses the image when its digest tag exists, with no build, pointing docker at colima's socket (D23)", async () => {
    const runner = new FakeRunner().on('docker image inspect', ok(`${JSON.stringify({ 'asha.source': DIGEST_A })}\n`));
    const { runtime } = await readyRuntime(runner);

    await expect(
      runtime.ensureImage({ repository: 'img', contextDir: '/ctx', sourceDigest: DIGEST_A, labels: {} }),
    ).resolves.toEqual({ tag: TAG_A, status: 'current', labels: { 'asha.source': DIGEST_A } });

    expect(runner.calls).toEqual([
      {
        command: 'docker',
        args: ['image', 'inspect', '--format', '{{ json .Config.Labels }}', TAG_A],
        options: { timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } },
      },
    ]);
  });

  it('builds a missing digest tag with --tag <repository>:<digest>, labelled with the digest, and touches no other tag (D23)', async () => {
    const missing = fail(1, `Error response from daemon: No such image: ${TAG_B}`);
    const runner = new LockingRunner()
      .on('docker image inspect', missing, missing, ok(JSON.stringify({ 'asha.source': DIGEST_B })))
      .on('docker build', ok());
    const { runtime, logger } = await readyRuntime(runner);

    await expect(
      runtime.ensureImage({ repository: 'img', contextDir: '/ctx', sourceDigest: DIGEST_B, labels: {} }),
    ).resolves.toEqual({ tag: TAG_B, status: 'built', labels: { 'asha.source': DIGEST_B } });
    // Exactly the inspect of its own tag, its lock (debt-paydown R18), the inspect again under it, and the build to it:
    // no tag, rmi or inspect of another digest's tag (TAG_A stays as it was).
    expect(runner.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['docker', 'image', 'inspect', '--format', '{{ json .Config.Labels }}', TAG_B],
      ['colima', 'ssh', '--profile', 'default', '--', 'sudo', 'sh', '-c', imageLockScript('b'.repeat(64))],
      ['docker', 'image', 'inspect', '--format', '{{ json .Config.Labels }}', TAG_B],
      ['docker', 'build', '--network=none', '--label', `asha.source=${DIGEST_B}`, '--tag', TAG_B, '/ctx'],
      // The built image's labels, as it carries them.
      ['docker', 'image', 'inspect', '--format', '{{ json .Config.Labels }}', TAG_B],
    ]);
    expect(callAt(runner, 3).options).toEqual({ timeoutMs: 600_000, env: { DOCKER_HOST: SOCKET } });
    expect(runner.locks.events).toEqual([
      `share ${IMAGES_LOCK_FILE}`,
      `take ${imageLockFile('b'.repeat(64))}`,
      `release ${imageLockFile('b'.repeat(64))}`,
      `unshare ${IMAGES_LOCK_FILE}`,
    ]);
    expect(logger.entries.filter((e) => e.event === 'image.building').map((e) => e.fields)).toEqual([
      { tag: TAG_B, sourceDigest: DIGEST_B },
    ]);
  });

  it('shares one build between concurrent ensureImage calls for the same tag, so a second build never replaces the first (D23)', async () => {
    const none = fail(1, 'No such image');
    const built = ok(JSON.stringify({ 'asha.source': DIGEST_A }));
    const runner = new LockingRunner()
      .on('docker image inspect', none, none, built, none, none, built)
      .on('docker build', ok());
    const { runtime } = await readyRuntime(runner);

    const both = await Promise.all([
      runtime.ensureImage({ repository: 'img', contextDir: '/ctx1', sourceDigest: DIGEST_A, labels: {} }),
      runtime.ensureImage({ repository: 'img', contextDir: '/ctx2', sourceDigest: DIGEST_A, labels: {} }),
    ]);
    // The one that joined built nothing itself: for it the image is current.
    expect(both).toEqual([
      { tag: TAG_A, status: 'built', labels: { 'asha.source': DIGEST_A } },
      { tag: TAG_A, status: 'current', labels: { 'asha.source': DIGEST_A } },
    ]);
    expect(runner.calls.map((c) => c.args[0])).toEqual(['image', 'ssh', 'image', 'build', 'image']);

    // Once settled, the next call inspects again.
    await runtime.ensureImage({ repository: 'img', contextDir: '/ctx3', sourceDigest: DIGEST_A, labels: {} });
    expect(runner.calls.map((c) => c.args[0])).toEqual([
      'image',
      'ssh',
      'image',
      'build',
      'image',
      'image',
      'ssh',
      'image',
      'build',
      'image',
    ]);
  });

  it('refuses a digest tag whose label names another source, and never rebuilds or replaces it', async () => {
    const runner = new FakeRunner().on('docker image inspect', ok(JSON.stringify({ 'asha.source': DIGEST_B })));
    const { runtime } = await readyRuntime(runner);

    const error = await runtime
      .ensureImage({ repository: 'img', contextDir: '/ctx', sourceDigest: DIGEST_A, labels: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerRuntimeError);
    expect((error as Error).message).toBe(
      `image ${TAG_A} carries asha.source="${DIGEST_B}", not ${DIGEST_A}: asha did not build it from this source; remove it (docker image rm ${TAG_A})`,
    );
    expect(runner.calls.map((c) => c.args[0])).toEqual(['image']);
  });

  it('fails, building nothing, when docker image inspect fails for another reason than a missing image', async () => {
    const runner = new FakeRunner().on('docker image inspect', fail(1, 'Cannot connect to the Docker daemon'));
    const { runtime } = await readyRuntime(runner);

    const error = await runtime
      .ensureImage({ repository: 'img', contextDir: '/ctx', sourceDigest: DIGEST_A, labels: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerRuntimeError);
    expect((error as Error).message).toContain(`docker image inspect ${TAG_A} failed:`);
    expect((error as Error).message).toContain('Cannot connect to the Docker daemon');
    expect(runner.calls.map((c) => c.args[0])).toEqual(['image']);
  });

  it('fails with the build output when docker build fails', async () => {
    const runner = new LockingRunner()
      .on('docker image inspect', fail(1, 'No such image'))
      .on('docker build', { code: 1, stdout: 'Step 3/5', stderr: 'COPY failed: file not found' });
    const { runtime } = await readyRuntime(runner);

    const error = await runtime
      .ensureImage({ repository: 'img', contextDir: '/ctx', sourceDigest: DIGEST_A, labels: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageBuildFailed);
    expect((error as ImageBuildFailed).tag).toBe(TAG_A);
    expect((error as Error).message).toContain('COPY failed: file not found');
    // A failed build still releases its lock.
    expect(runner.locks.events).toEqual([
      `share ${IMAGES_LOCK_FILE}`,
      `take ${imageLockFile('a'.repeat(64))}`,
      `release ${imageLockFile('a'.repeat(64))}`,
      `unshare ${IMAGES_LOCK_FILE}`,
    ]);
  });

  it('a build that exits 0 after which its tag is not there fails naming the tag, its lock released', async () => {
    const missing = fail(1, `Error response from daemon: No such image: ${TAG_A}`);
    const runner = new LockingRunner().on('docker image inspect', missing).on('docker build', ok());
    const { runtime } = await readyRuntime(runner);

    const error = await runtime
      .ensureImage({ repository: 'img', contextDir: '/ctx', sourceDigest: DIGEST_A, labels: {} })
      .catch((e: unknown) => e);

    expect([
      error instanceof ContainerRuntimeError,
      error instanceof ImageBuildFailed,
      (error as Error).message,
    ]).toEqual([true, false, `docker build of ${TAG_A} exited 0, and the image is not there`]);
    // Its own inspect, the lock, the inspect under it, the build, and the inspect of what it built.
    expect(runner.calls.map((c) => c.args[0])).toEqual(['image', 'ssh', 'image', 'build', 'image']);
    expect(runner.locks.events).toEqual([
      `share ${IMAGES_LOCK_FILE}`,
      `take ${imageLockFile('a'.repeat(64))}`,
      `release ${imageLockFile('a'.repeat(64))}`,
      `unshare ${IMAGES_LOCK_FILE}`,
    ]);
  });

  it.each([
    ['not JSON', 'Template parsing error: unexpected "}"', 'not JSON', expect.any(SyntaxError) as SyntaxError],
    ['a list', '["asha.source"]', 'not an object of strings', undefined],
    ['an object holding a number', '{"asha.source":1}', 'not an object of strings', undefined],
  ])(
    "labels printed as %s fail the image's inspect, naming the tag and what was printed, and build nothing",
    async (_label, printed, what, cause) => {
      const runner = new LockingRunner().on('docker image inspect', ok(printed));
      const { runtime } = await readyRuntime(runner);

      const error = await runtime
        .ensureImage({ repository: 'img', contextDir: '/ctx', sourceDigest: DIGEST_A, labels: {} })
        .catch((e: unknown) => e);

      expect([error instanceof ContainerRuntimeError, (error as Error).message, (error as Error).cause]).toEqual([
        true,
        `docker image inspect ${TAG_A} printed labels that are ${what}: ${printed}`,
        cause,
      ]);
      expect(runner.calls.map((c) => c.args[0])).toEqual(['image']);
      expect(runner.locks.events).toEqual([]);
    },
  );

  describe("one build per tag across daemons: the tag's VM lock (debt-paydown R18, A15; D28)", () => {
    const SPEC = { repository: 'img', contextDir: '/ctx', sourceDigest: DIGEST_A, labels: {} };
    const LOCK_A = imageLockFile('a'.repeat(64));

    it("runs exactly debt-paydown-2 R3's script — the images lock shared, then the tag's — in one colima ssh session bounded at 1,410 s, and an existing tag opens none", async () => {
      expect(imageLockScript('a'.repeat(64))).toBe(
        `exec 8>/run/asha-images.lock; flock -s -w 30 8 || exit 6; exec 9>/run/asha-image-${'a'.repeat(64)}.lock; flock -w 600 9 || exit 4; echo locked; read _ || true`,
      );
      const runner = new LockingRunner()
        .on(
          'docker image inspect',
          fail(1, 'No such image'),
          fail(1, 'No such image'),
          ok(JSON.stringify({ 'asha.source': DIGEST_A })),
        )
        .on('docker build', ok());
      const { runtime } = await readyRuntime(runner);
      await runtime.ensureImage(SPEC);
      const sessions = runner.calls.filter((c) => c.command === 'colima');
      expect(sessions.map((c) => [c.args, c.options])).toEqual([
        [
          ['ssh', '--profile', 'default', '--', 'sudo', 'sh', '-c', imageLockScript('a'.repeat(64))],
          { timeoutMs: 1_410_000 },
        ],
      ]);
      // An existing tag: one inspect, no session.
      const present = new LockingRunner().on('docker image inspect', ok(JSON.stringify({ 'asha.source': DIGEST_A })));
      const ready = await readyRuntime(present);
      await ready.runtime.ensureImage(SPEC);
      expect(present.calls.map((c) => c.command)).toEqual(['docker']);
      expect(present.locks.events).toEqual([]);
    });

    it('a second daemon ensuring the same tag while the first holds its lock builds nothing: it inspects again under the lock and finds it', async () => {
      const locks = new VmLocks();
      let building!: () => void;
      const buildStarted = new Promise<void>((resolve) => (building = resolve));
      let finishBuild!: () => void;
      const buildHeld = new Promise<void>((resolve) => (finishBuild = resolve));
      const first = new LockingRunner(locks).on(
        'docker image inspect',
        fail(1, 'No such image'),
        fail(1, 'No such image'),
        ok(JSON.stringify({ 'asha.source': DIGEST_A })),
      );
      const firstBuild = first.run.bind(first);
      first.run = async (command, args, options) => {
        if (args[0] === 'build') {
          first.calls.push({ command, args, options });
          building();
          await buildHeld;
          return { code: 0, stdout: '', stderr: '' };
        }
        return firstBuild(command, args, options);
      };
      // The second daemon's runtime, on the same VM: its first inspect misses (the first is still building), its
      // inspect under the lock finds the first's image.
      const second = new LockingRunner(locks).on(
        'docker image inspect',
        fail(1, 'No such image'),
        ok(JSON.stringify({ 'asha.source': DIGEST_A })),
      );
      const one = await readyRuntime(first);
      const two = await readyRuntime(second);
      const a = one.runtime.ensureImage(SPEC);
      await buildStarted;
      const b = two.runtime.ensureImage(SPEC);
      // The second waits on the lock: its session is open, its inspect under the lock not yet made.
      await new Promise((resolve) => setImmediate(resolve));
      expect(second.calls.map((c) => c.args[0])).toEqual(['image', 'ssh']);
      finishBuild();
      expect(await a).toEqual({ tag: TAG_A, status: 'built', labels: { 'asha.source': DIGEST_A } });
      expect(await b).toEqual({ tag: TAG_A, status: 'current', labels: { 'asha.source': DIGEST_A } });
      expect(second.calls.map((c) => c.args[0])).toEqual(['image', 'ssh', 'image']);
      expect([
        first.calls.filter((c) => c.args[0] === 'build').length,
        second.calls.filter((c) => c.args[0] === 'build').length,
      ]).toEqual([1, 0]);
      // Both share the images lock at once (builds never wait for each other there); the tag's lock is taken in turn.
      expect(locks.events).toEqual([
        `share ${IMAGES_LOCK_FILE}`,
        `take ${LOCK_A}`,
        `share ${IMAGES_LOCK_FILE}`,
        `release ${LOCK_A}`,
        `unshare ${IMAGES_LOCK_FILE}`,
        `take ${LOCK_A}`,
        `release ${LOCK_A}`,
        `unshare ${IMAGES_LOCK_FILE}`,
      ]);
    });

    it('two different tags take two different locks, neither waiting for the other', async () => {
      const runner = new LockingRunner()
        .on(
          `docker image inspect --format {{ json .Config.Labels }} ${TAG_A}`,
          fail(1, 'No such image'),
          fail(1, 'No such image'),
          ok(JSON.stringify({ 'asha.source': DIGEST_A })),
        )
        .on(
          `docker image inspect --format {{ json .Config.Labels }} ${TAG_B}`,
          fail(1, 'No such image'),
          fail(1, 'No such image'),
          ok(JSON.stringify({ 'asha.source': DIGEST_B })),
        )
        .on('docker build', ok());
      const { runtime } = await readyRuntime(runner);
      await Promise.all([runtime.ensureImage(SPEC), runtime.ensureImage({ ...SPEC, sourceDigest: DIGEST_B })]);
      expect(runner.calls.filter((c) => c.command === 'colima').map((c) => c.args.at(-1))).toEqual([
        imageLockScript('a'.repeat(64)),
        imageLockScript('b'.repeat(64)),
      ]);
      // Both were taken before either was released.
      expect(runner.locks.events.slice(0, 4)).toEqual([
        `share ${IMAGES_LOCK_FILE}`,
        `take ${LOCK_A}`,
        `share ${IMAGES_LOCK_FILE}`,
        `take ${imageLockFile('b'.repeat(64))}`,
      ]);
    });

    it('the images lock not taken within 30 s (flock exits 6: an image prune held it) is ImageBuildFailed naming /run/asha-images.lock, building nothing (debt-paydown-2 R3)', async () => {
      const runner = new LockingRunner().on('docker image inspect', fail(1, 'No such image'));
      runner.lockAnswer = 6;
      const { runtime } = await readyRuntime(runner);
      const error = await runtime.ensureImage(SPEC).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImageBuildFailed);
      expect((error as Error).message).toBe(
        `docker build of ${TAG_A} failed:\nthe build lock /run/asha-images.lock was not taken: colima ssh exited 6 (an image prune held it for 30 s): ${colimaExit(6).stderr.trimEnd()}`,
      );
      expect(runner.calls.map((c) => c.args[0])).toEqual(['image', 'ssh']);
    });

    it('a lock not taken within 600 s (flock exits 4) is ImageBuildFailed naming the lock, building nothing', async () => {
      const runner = new LockingRunner().on('docker image inspect', fail(1, 'No such image'));
      runner.lockAnswer = 4;
      const { runtime } = await readyRuntime(runner);
      const error = await runtime.ensureImage(SPEC).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImageBuildFailed);
      expect((error as Error).message).toBe(
        `docker build of ${TAG_A} failed:\nthe build lock ${LOCK_A} was not taken: colima ssh exited 4 (flock waited 600 s): ${colimaExit(4).stderr.trimEnd()}`,
      );
      expect(runner.calls.map((c) => c.args[0])).toEqual(['image', 'ssh']);
    });

    it("a session that prints nothing for 660 s (the images lock 30 s, the tag's 600 s, one ssh round trip) is killed and is ImageBuildFailed naming the lock", async () => {
      const runner = new LockingRunner().on('docker image inspect', fail(1, 'No such image'));
      runner.lockAnswer = 'hang';
      const { runtime } = await readyRuntime(runner);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const failed = runtime.ensureImage(SPEC).catch((e: unknown) => e);
        await vi.advanceTimersByTimeAsync(659_999);
        expect(runner.calls.map((c) => c.args[0])).toEqual(['image', 'ssh']);
        await vi.advanceTimersByTimeAsync(1);
        const error = await failed;
        expect(error).toBeInstanceOf(ImageBuildFailed);
        expect((error as Error).message).toBe(
          `docker build of ${TAG_A} failed:\nthe build lock ${LOCK_A} was not taken: colima ssh printed no "locked" within 660000 ms`,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('a lock session that fails before "locked" (colima itself could not run) is ImageBuildFailed naming the lock and the failure, building nothing', async () => {
      const runner = new LockingRunner().on('docker image inspect', fail(1, 'No such image'));
      const stream = runner.stream.bind(runner);
      runner.stream = (command, args, options) => {
        if (!args.includes(imageLockScript('a'.repeat(64)))) return stream(command, args, options);
        runner.calls.push({ command, args, options: { timeoutMs: options.timeoutMs } });
        return Promise.reject(new Error('spawn colima EAGAIN'));
      };
      const { runtime } = await readyRuntime(runner);
      const error = await runtime.ensureImage(SPEC).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImageBuildFailed);
      expect((error as Error).message).toBe(
        `docker build of ${TAG_A} failed:\nthe build lock ${LOCK_A} was not taken: colima ssh failed: spawn colima EAGAIN`,
      );
      expect(runner.calls.map((c) => c.args[0])).toEqual(['image', 'ssh']);
    });

    /**
     * A LockingRunner for SPEC's build whose tag-lock session, once its lock is released, ends as `end` says instead of
     * exiting 0: with that result, failing with that error, or ('hang') never ending until it is killed.
     */
    function releasing(end: ReturnType<typeof colimaExit> | Error | 'hang', build = ok()): LockingRunner {
      const runner = new LockingRunner()
        .on(
          'docker image inspect',
          fail(1, 'No such image'),
          fail(1, 'No such image'),
          ok(JSON.stringify({ 'asha.source': DIGEST_A })),
        )
        .on('docker build', build);
      const stream = runner.stream.bind(runner);
      runner.stream = async (command, args, options) => {
        if (!args.includes(imageLockScript('a'.repeat(64)))) return stream(command, args, options);
        if (end !== 'hang') {
          // Taken, held until its standard input closes, and released, as the VM does; then it ends as scripted.
          await stream(command, args, options);
          if (end instanceof Error) throw end;
          return end;
        }
        runner.calls.push({ command, args, options: { timeoutMs: options.timeoutMs } });
        await options.onStdout?.(Buffer.from('locked\n'));
        const signal = present(options.signal, 'options.signal');
        return new Promise((_, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(signal.reason as Error);
            },
            { once: true },
          );
        });
      };
      return runner;
    }

    it('a lock session that exits non-zero once released fails the ensure naming the lock and the exit, though the build succeeded', async () => {
      const runner = releasing({
        code: 255,
        stderr: 'Connection to 127.0.0.1 closed by remote host.\n',
        stopped: false,
      });
      const { runtime, logger } = await readyRuntime(runner);
      const error = await runtime.ensureImage(SPEC).catch((e: unknown) => e);
      expect([
        error instanceof ContainerRuntimeError,
        error instanceof ImageBuildFailed,
        (error as Error).message,
      ]).toEqual([
        true,
        false,
        `the build lock ${LOCK_A}'s colima ssh session exited 255: Connection to 127.0.0.1 closed by remote host.`,
      ]);
      expect(runner.calls.map((c) => c.args[0])).toEqual(['image', 'ssh', 'image', 'build', 'image']);
      expect(logger.events('error')).toEqual([]);
    });

    it('a lock session that fails once released fails the ensure naming the lock, with the failure as its cause', async () => {
      const broken = new Error('signal: broken pipe');
      const runner = releasing(broken);
      const { runtime } = await readyRuntime(runner);
      const error = await runtime.ensureImage(SPEC).catch((e: unknown) => e);
      expect([error instanceof ContainerRuntimeError, (error as Error).message, (error as Error).cause]).toEqual([
        true,
        `the build lock ${LOCK_A}'s colima ssh session failed: signal: broken pipe`,
        broken,
      ]);
    });

    it("a build that fails whose lock's release fails too: the build's failure is thrown, the release's logged image.lock_release_failed, never dropped", async () => {
      const runner = releasing(
        { code: 255, stderr: 'Connection to 127.0.0.1 closed by remote host.\n', stopped: false },
        { code: 1, stdout: 'Step 3/5', stderr: 'COPY failed: file not found' },
      );
      const { runtime, logger } = await readyRuntime(runner);
      const error = await runtime.ensureImage(SPEC).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ImageBuildFailed);
      expect((error as Error).message).toBe(`docker build of ${TAG_A} failed:\nStep 3/5\nCOPY failed: file not found`);
      const released = logger.entries.filter((e) => e.event === 'image.lock_release_failed');
      expect(released).toEqual([
        {
          level: 'error',
          event: 'image.lock_release_failed',
          fields: { tag: TAG_A, lock: LOCK_A, error: expect.any(ContainerRuntimeError) as ContainerRuntimeError },
        },
      ]);
      expect((present(released[0], 'released[0]').fields['error'] as Error).message).toBe(
        `the build lock ${LOCK_A}'s colima ssh session exited 255: Connection to 127.0.0.1 closed by remote host.`,
      );
    });

    it('a lock session that has not ended 30 s after its release is killed, and the ensure fails naming the lock', async () => {
      const runner = releasing('hang');
      const { runtime } = await readyRuntime(runner);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        let settled = false;
        const failed = runtime
          .ensureImage(SPEC)
          .catch((e: unknown) => e)
          .finally(() => {
            settled = true;
          });
        await vi.advanceTimersByTimeAsync(29_999);
        expect([settled, runner.calls.map((c) => c.args[0])]).toEqual([
          false,
          ['image', 'ssh', 'image', 'build', 'image'],
        ]);
        await vi.advanceTimersByTimeAsync(1);
        const error = await failed;
        expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
          true,
          `the build lock ${LOCK_A}'s colima ssh session did not end within 30000 ms of its release; killed`,
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('start', () => {
    let logDir: string;
    beforeEach(async () => {
      logDir = await mkdtemp(join(tmpdir(), 'asha-run-'));
    });

    const CREATE = `docker create --pull never --rm --name asha-x --network ${NETWORK} --dns 192.0.2.1 --add-host host.docker.internal:192.168.5.2 --label asha.home=${HOME_ID} -v asha-vol:/channel -e ASHA_URL -e ASHA_AGENT_TOKEN img`;
    const ENV = { ASHA_URL: 'https://h:1', ASHA_AGENT_TOKEN: 'secret' };
    const FILES = [
      { path: 'guidance.md', content: Buffer.from('1. Reply.\n') },
      { path: 'flows/steps.md', content: Buffer.from('ünïcode\n') },
    ];

    it("creates the container on the home's network with nothing that widens its reach, env by name only, starts it attached, and settles with the exit code (A4)", async () => {
      const runner = new FakeRunner().on('docker create', ok('0123abcd\n'));
      const { runtime, launcher } = await readyRuntime(runner);
      launcher.onLaunch = (p) => {
        p.exit(3);
      };

      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: [],
        channelVolume: 'asha-vol',
      });

      await expect(exited).resolves.toBe(3);
      // No files: created, then started; nothing copied.
      expect(runner.lines()).toEqual([CREATE]);
      expect(callAt(runner, 0).options).toEqual({ timeoutMs: 60_000, env: { ...ENV, DOCKER_HOST: SOCKET } });
      for (const widening of ['--ip', '--cap-add', '--privileged', 'host', '--network=host'])
        expect(callAt(runner, 0).args).not.toContain(widening);
      expect(callAt(runner, 0).args.join(' ')).not.toContain('secret');
      expect(launcher.launched).toHaveLength(1);
      const launched = launchedAt(launcher, 0);
      expect([launched.command, ...launched.args]).toEqual(['docker', 'start', '--attach', 'asha-x']);
      expect(launched.options.env).toEqual({ DOCKER_HOST: SOCKET });
      expect(launched.options.logFile).toBe(join(logDir, 'agent.log'));
    });

    it('creates an agent container with --dns 192.0.2.1 and --add-host host.docker.internal:192.168.5.2, so it resolves no outside name (debt-paydown R1, A1; D18)', async () => {
      const runner = new FakeRunner().on('docker create', ok('0123abcd\n'));
      const { runtime, launcher } = await readyRuntime(runner);
      launcher.onLaunch = (p) => {
        p.exit(0);
      };
      await runtime.start({
        name: 'asha-x',
        image: 'img',
        env: {},
        logFile: join(logDir, 'agent.log'),
        files: [],
        channelVolume: 'asha-vol',
      }).exited;
      expect(AGENT_DNS_SERVER).toBe('192.0.2.1');
      expect(HOST_GATEWAY).toBe('192.168.5.2');
      expect([callAt(runner, 0).command, ...callAt(runner, 0).args], 'the agent create').toEqual([
        'docker',
        'create',
        '--pull',
        'never',
        '--rm',
        '--name',
        'asha-x',
        '--network',
        NETWORK,
        '--dns',
        '192.0.2.1',
        '--add-host',
        'host.docker.internal:192.168.5.2',
        '--label',
        `asha.home=${HOME_ID}`,
        '-v',
        'asha-vol:/channel',
        'img',
      ]);
    });

    it("places the recipe's documents in /workspace between create and start, owned by the agent's user (collaborating-agents R2)", async () => {
      const runner = new FakeRunner().on('docker create', ok('0123abcd\n')).on('docker cp', ok(''));
      const { runtime, launcher } = await readyRuntime(runner);
      launcher.onLaunch = (p) => {
        p.exit(0);
      };

      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: FILES,
        channelVolume: 'asha-vol',
      });

      await expect(exited).resolves.toBe(0);
      expect(runner.lines()).toEqual([CREATE, 'docker cp -a - asha-x:/workspace']);
      // The archive on standard input, byte for byte: uid and gid 1000 (the images' `node`), dated by the clock.
      expect(callAt(runner, 1).options).toEqual({
        timeoutMs: 60_000,
        env: { DOCKER_HOST: SOCKET },
        stdin: workspaceArchive(FILES, { uid: 1000, gid: 1000 }, NOW.getTime() / 1000),
      });
      expect([launchedAt(launcher, 0).command, ...launchedAt(launcher, 0).args]).toEqual([
        'docker',
        'start',
        '--attach',
        'asha-x',
      ]);
    });

    it('a failed copy removes the created container, starts nothing, and rejects naming the copy', async () => {
      const runner = new FakeRunner()
        .on('docker create', ok('0123abcd\n'))
        .on('docker cp', fail(1, 'Error: no space left on device'))
        .on('docker rm', ok('asha-x\n'));
      const { runtime, launcher } = await readyRuntime(runner);

      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: FILES,
        channelVolume: 'asha-vol',
      });

      await expect(exited).rejects.toThrow(
        new ContainerRuntimeError(
          'docker cp of 2 file(s) into asha-x:/workspace failed:\n\nError: no space left on device',
        ),
      );
      expect(runner.lines()).toEqual([CREATE, 'docker cp -a - asha-x:/workspace', 'docker rm --force asha-x']);
      expect(launcher.launched).toEqual([]);
    });

    it("a documents copy that throws — its bound passed — removes the created container, so it holds no channel's volume, and fails naming the copy (R1-RELIABILITY-001)", async () => {
      const timedOut = new CommandTimedOut('docker', ['cp', '-a', '-', 'asha-x:/workspace'], 60_000);
      const runner = new FakeRunner()
        .on('docker create', ok('0123abcd\n'))
        .on('docker cp', timedOut)
        .on('docker rm', new CommandTimedOut('docker', ['rm', '--force', 'asha-x'], 60_000));
      const { runtime, launcher } = await readyRuntime(runner);
      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: FILES,
        channelVolume: 'asha-vol',
      });
      const error = await exited.catch((e: unknown) => e);
      expect([error instanceof ContainerRuntimeError, (error as Error).message, (error as Error).cause]).toEqual([
        true,
        'docker cp of 2 file(s) into asha-x:/workspace failed:\ndocker cp -a - asha-x:/workspace did not finish within 60000 ms; and docker rm --force asha-x failed too: docker rm --force asha-x did not finish within 60000 ms',
        timedOut,
      ]);
      expect(runner.lines()).toEqual([CREATE, 'docker cp -a - asha-x:/workspace', 'docker rm --force asha-x']);
      expect(launcher.launched).toEqual([]);
    });

    it('a failed copy whose removal fails too names both', async () => {
      const runner = new FakeRunner()
        .on('docker create', ok(''))
        .on('docker cp', fail(1, 'cp broke'))
        .on('docker rm', fail(1, 'rm broke\n'));
      const { runtime, launcher } = await readyRuntime(runner);
      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: FILES,
        channelVolume: 'asha-vol',
      });
      await expect(exited).rejects.toThrow('; and docker rm --force asha-x failed too: rm broke');
      expect(launcher.launched).toEqual([]);
    });

    it('a failed create copies nothing, starts nothing, and rejects naming the container', async () => {
      const runner = new FakeRunner().on(
        'docker create',
        fail(125, 'Error response from daemon: Conflict. The container name "/asha-x" is already in use'),
      );
      const { runtime, launcher } = await readyRuntime(runner);
      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: FILES,
        channelVolume: 'asha-vol',
      });
      await expect(exited).rejects.toThrow('docker create asha-x failed:\n\nError response from daemon: Conflict.');
      expect(runner.lines()).toEqual([CREATE]);
      expect(launcher.launched).toEqual([]);
    });

    it('refuses to start a container before ensureReady has confined containers', () => {
      const { runtime, launcher } = setup(new FakeRunner());
      expect(() =>
        runtime.start({
          name: 'n',
          image: 'i',
          env: {},
          logFile: join(logDir, 'a.log'),
          files: [],
          channelVolume: 'asha-vol',
        }),
      ).toThrow('ColimaRuntime.start before ensureReady confined its containers');
      expect(launcher.launched).toEqual([]);
    });

    it('rejects when docker start itself is killed by a signal', async () => {
      const { runtime, launcher } = await readyRuntime(new FakeRunner().on('docker create', ok('')));
      launcher.onLaunch = (p) => {
        p.exit(null, 'SIGKILL');
      };
      const { exited } = runtime.start({
        name: 'n',
        image: 'i',
        env: {},
        logFile: join(logDir, 'a.log'),
        files: [],
        channelVolume: 'asha-vol',
      });
      await expect(exited).rejects.toThrow('docker start n was killed by SIGKILL');
    });

    it('a stop that arrives while the container is being created removes it, and it never starts (review finding 1)', async () => {
      const runner = new FakeRunner()
        .on('docker create', ok(''))
        .on('docker stop', ok(''))
        .on('docker rm', ok('asha-x\n'));
      const { runtime, launcher } = await readyRuntime(runner);
      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: FILES,
        channelVolume: 'asha-vol',
      });
      await runtime.stop('asha-x', 'kill');
      const error = await exited.catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ContainerStoppedBeforeStart);
      expect((error as Error).message).toBe('container asha-x was stopped before it started, and removed');
      expect(runner.lines()).toEqual([CREATE, 'docker stop --timeout 0 asha-x', 'docker rm --force asha-x']);
      expect(launcher.launched).toEqual([]);
    });

    it('a stop that arrives while the container is being created, whose removal then fails, rejects naming the failed docker rm, and it never starts', async () => {
      const runner = new FakeRunner()
        .on('docker create', ok(''))
        .on('docker stop', ok(''))
        .on('docker rm', fail(1, 'Error response from daemon: removal of container asha-x is already in progress\n'));
      const { runtime, launcher } = await readyRuntime(runner);
      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: FILES,
        channelVolume: 'asha-vol',
      });
      await runtime.stop('asha-x', 'kill');
      const error = await exited.catch((e: unknown) => e);
      expect([
        error instanceof ContainerRuntimeError,
        error instanceof ContainerStoppedBeforeStart,
        (error as Error).message,
      ]).toEqual([
        true,
        false,
        'asha-x was stopped before it started, and docker rm --force failed: Error response from daemon: removal of container asha-x is already in progress',
      ]);
      expect(runner.lines()).toEqual([CREATE, 'docker stop --timeout 0 asha-x', 'docker rm --force asha-x']);
      expect(callAt(runner, 2).options).toEqual({ timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } });
      expect(launcher.launched).toEqual([]);
    });

    it('a stop that arrives while its documents are being copied removes it after the copy, and it never starts', async () => {
      let copied!: () => void;
      const copying = new Promise<void>((resolve) => (copied = resolve));
      const inner = new FakeRunner()
        .on('docker create', ok(''))
        .on('docker cp', ok(''))
        .on('docker stop', ok(''))
        .on('docker rm', ok(''));
      const { runtime, launcher } = await readyRuntime(inner);
      // The copy completes only when the test says so: the stop arrives while it is in flight.
      const run = inner.run.bind(inner);
      inner.run = async (command, args, options) => {
        const result = await run(command, args, options);
        if (args[0] === 'cp') await copying;
        return result;
      };
      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: FILES,
        channelVolume: 'asha-vol',
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(inner.lines()).toEqual([CREATE, 'docker cp -a - asha-x:/workspace']);
      await runtime.stop('asha-x', 'drain', 70);
      copied();
      await expect(exited).rejects.toThrow(ContainerStoppedBeforeStart);
      expect(inner.lines()).toEqual([
        CREATE,
        'docker cp -a - asha-x:/workspace',
        'docker stop --timeout 70 asha-x',
        'docker rm --force asha-x',
      ]);
      expect(launcher.launched).toEqual([]);
    });

    it('a stop after the container started is an ordinary stop: nothing is removed by start', async () => {
      const runner = new FakeRunner().on('docker create', ok('')).on('docker stop', ok(''));
      const { runtime, launcher } = await readyRuntime(runner);
      const { exited } = runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'agent.log'),
        files: [],
        channelVolume: 'asha-vol',
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(launcher.launched).toHaveLength(1);
      await runtime.stop('asha-x', 'kill');
      launchedAt(launcher, 0).exit(137);
      await expect(exited).resolves.toBe(137);
      expect(runner.lines()).toEqual([CREATE, 'docker stop --timeout 0 asha-x']);
    });
  });

  it('stop drains with SIGTERM and a 70 s grace before SIGKILL, or kills at once, each bounded past its grace, and tolerates only an absent container', async () => {
    const runner = new FakeRunner().on('docker stop', ok(''));
    const { runtime } = await readyRuntime(runner);
    await expect(runtime.stop('asha-x', 'drain', 70)).resolves.toBeUndefined();
    await expect(runtime.stop('asha-y', 'kill')).resolves.toBeUndefined();
    expect(runner.lines()).toEqual(['docker stop --timeout 70 asha-x', 'docker stop --timeout 0 asha-y']);
    // The command's own bound outlasts the grace docker waits out.
    expect(runner.calls.map((c) => c.options.timeoutMs)).toEqual([AGENT_STOP_GRACE_MS + 60_000, 60_000]);
    expect(AGENT_STOP_GRACE_MS).toBe(70_000);

    // docker run --rm removed the container as it exited, racing this call.
    const gone = new FakeRunner().on('docker stop', fail(1, 'Error response from daemon: No such container: asha-x'));
    const { runtime: goneRuntime } = await readyRuntime(gone);
    await expect(goneRuntime.stop('asha-x', 'drain', 70)).resolves.toBeUndefined();

    const denied = new FakeRunner().on('docker stop', fail(1, 'permission denied'));
    const { runtime: deniedRuntime } = await readyRuntime(denied);
    await expect(deniedRuntime.stop('asha-x', 'drain', 70)).rejects.toThrow(
      'docker stop --timeout 70 asha-x failed: permission denied',
    );
  });
});

describe('ColimaRuntime confinement (R10, R12–R14)', () => {
  /** A runtime whose first ensureReady has run; its commands are cleared. */
  async function warm() {
    const runner = new FakeRunner();
    const parts = await readyRuntime(runner);
    return { runner, ...parts };
  }

  it('a warm launch inspects the network and makes exactly one colima ssh, bounded by 30 s, with its script on stdin (A14)', async () => {
    const { runner, runtime, logger } = await warm();
    logger.entries.length = 0;

    await expect(runtime.ensureReady(PORT)).resolves.toBe('ready');

    expect(runner.lines()).toEqual([
      'colima version',
      'docker --version',
      'colima status --profile default --json',
      `docker network inspect --format {{json .}} ${NETWORK}`,
      SSH,
    ]);
    const ssh = runner.calls.filter((c) => c.command === 'colima' && c.args[0] === 'ssh');
    expect(ssh).toHaveLength(1);
    expect(present(ssh[0], 'ssh[0]').options).toEqual({ timeoutMs: 30_000, stdin: installScript(HOME_ID, PORT) });
    expect(logger.events()).toEqual(['colima.ready', 'agent.isolation_ready']);
  });

  it.each([
    ['driver', { Driver: 'macvlan' }, 'driver "macvlan", expected "bridge"'],
    [
      'bridge name',
      { Options: { 'com.docker.network.bridge.name': 'docker0' } },
      'bridge name "docker0", expected "ashaabcd1234"',
    ],
    ['subnet', { IPAM: { Config: [{ Subnet: '10.9.0.0/16' }] } }, 'subnet ["10.9.0.0/16"], expected ["172.18.0.0/16"]'],
    ['IPv6', { EnableIPv6: true }, 'EnableIPv6 true, expected false'],
    [
      'inter-container traffic (review finding 5)',
      { Options: { 'com.docker.network.bridge.name': `asha${HOME_ID}` } },
      'com.docker.network.bridge.enable_icc undefined, expected "false"',
    ],
  ])(
    'fails with ContainerIsolationFailed naming the %s when the network no longer matches, and runs no rule change (A13)',
    async (_, over, named) => {
      const runner = new FakeRunner().on('docker network inspect', ok(inspected()), ok(inspected(over)));
      const { runtime, launcher } = await readyRuntime(runner);

      const error = await runtime.ensureReady(PORT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ContainerIsolationFailed);
      expect((error as ContainerIsolationFailed).what).toBe(`network ${NETWORK}`);
      expect((error as Error).message).toContain(named);
      expect(runner.lines()).not.toContain(SSH);
      expect(launcher.launched).toEqual([]);
    },
  );

  it('fails naming the host check when host.lima.internal is another address in the VM (A13)', async () => {
    const runner = new FakeRunner().on('colima ssh', INSTALLED, {
      code: 3,
      stdout: '',
      stderr:
        'asha-isolation: host check: host.lima.internal is "192.168.5.9" in the VM\'s /etc/hosts, not 192.168.5.2\n',
    });
    const { runtime, launcher } = await readyRuntime(runner);

    const error = await runtime.ensureReady(PORT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect((error as ContainerIsolationFailed).what).toBe('rule install');
    expect((error as Error).message).toContain('host check: host.lima.internal is "192.168.5.9"');
    expect(launcher.launched).toEqual([]);
  });

  it('fails with the command output when the rule script exits non-zero (A13)', async () => {
    const runner = new FakeRunner().on('colima ssh', INSTALLED, {
      code: 1,
      stdout: '',
      stderr: 'iptables-restore: line 3 failed\n',
    });
    const { runtime } = await readyRuntime(runner);

    const error = await runtime.ensureReady(PORT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect((error as Error).message).toBe(
      'container isolation failed: rule install: exit 1\niptables-restore: line 3 failed',
    );
  });

  it('fails when the rule script does not report its result', async () => {
    const runner = new FakeRunner().on('colima ssh', INSTALLED, ok('something else\n'));
    const { runtime } = await readyRuntime(runner);
    await expect(runtime.ensureReady(PORT)).rejects.toThrow('rule install: the script did not report its result');
  });

  it('removes a network a dead daemon of this home left, with its containers, before creating its own', async () => {
    const runner = new FakeRunner()
      .on('colima version', ok())
      .on('docker --version', ok())
      .on('colima status', ok(STATUS))
      .on('docker network ls', ok(`${NETWORK}\n`))
      .on('docker ps --all --quiet --filter label=', ok('c0\n'))
      .on('docker ps', ok('c1\nc2\n'))
      .on('docker rm', ok())
      .on('docker network rm', ok());
    const { runtime, logger } = setup(confines(runner));

    await runtime.ensureReady(PORT);

    expect(runner.lines().slice(3)).toEqual([
      // A container of this home on no network — a one-shot a killed daemon left (agent-persistence R10) — by its label.
      `docker ps --all --quiet --filter label=asha.home=${HOME_ID}`,
      'docker rm --force c0',
      `docker volume ls --quiet --filter label=asha.home=${HOME_ID}`,
      `docker network ls --filter name=^${NETWORK}$ --format {{.Name}}`,
      `docker ps --all --quiet --filter network=${NETWORK}`,
      'docker rm --force c1 c2',
      `docker network rm ${NETWORK}`,
      ...FIRST_CONFINE.slice(3),
    ]);
    expect(logger.entries.find((e) => e.event === 'isolation.stale_containers_removed')).toEqual({
      level: 'warn',
      event: 'isolation.stale_containers_removed',
      fields: { homeId: HOME_ID, containers: 1 },
    });
    expect(logger.entries.find((e) => e.event === 'isolation.stale_network_removed')).toEqual({
      level: 'warn',
      event: 'isolation.stale_network_removed',
      fields: { network: NETWORK, containers: 2 },
    });
  });

  it('fails when the network cannot be created, or is not created as asked', async () => {
    const base = () =>
      new FakeRunner()
        .on('colima version', ok())
        .on('docker --version', ok())
        .on('colima status', ok(STATUS))
        .on('docker ps', ok(''))
        .on('docker volume ls', ok(''))
        .on('docker network ls', ok(''));
    const refused = setup(
      base().on(
        'docker network create',
        fail(1, 'Error response from daemon: all predefined address pools have been fully subnetted'),
      ),
    );
    await expect(refused.runtime.ensureReady(PORT)).rejects.toThrow(
      `container isolation failed: network ${NETWORK}: docker network create failed:\n\nError response from daemon: all predefined address pools have been fully subnetted`,
    );
    const ipv6 = setup(
      base()
        .on('docker network create', ok())
        .on('docker network inspect', ok(inspected({ EnableIPv6: true }))),
    );
    await expect(ipv6.runtime.ensureReady(PORT)).rejects.toThrow(
      'not created as asked: EnableIPv6 true, expected false',
    );
    // Nothing was recorded, so nothing may start.
    expect(() =>
      ipv6.runtime.start({
        name: 'n',
        image: 'i',
        env: {},
        logFile: '/dev/null',
        files: [],
        channelVolume: 'asha-vol',
      }),
    ).toThrow('before ensureReady confined');
  });

  const LABELLED = `docker ps --all --quiet --filter label=asha.home=${HOME_ID}`;
  const VOLUMES = `docker volume ls --quiet --filter label=asha.home=${HOME_ID}`;
  const LISTED = `docker network ls --filter name=^${NETWORK}$ --format {{.Name}}`;
  const ON_NETWORK = `docker ps --all --quiet --filter network=${NETWORK}`;
  it.each([
    [
      "the listing of this home's containers",
      (r: FakeRunner) =>
        r.on('docker ps --all --quiet --filter label=', fail(1, 'Cannot connect to the Docker daemon')),
      "docker ps of this home's containers failed:\nCannot connect to the Docker daemon",
      [LABELLED],
    ],
    [
      "the removal of a dead daemon's containers found by their label",
      (r: FakeRunner) =>
        r
          .on('docker ps --all --quiet --filter label=', ok('c0\n'))
          .on('docker rm', fail(1, 'Error response from daemon: permission denied')),
      "docker rm of a dead daemon's containers failed:\nError response from daemon: permission denied",
      [LABELLED, 'docker rm --force c0'],
    ],
    [
      "the listing of a dead daemon's network",
      (r: FakeRunner) => r.on('docker network ls', fail(1, 'Cannot connect to the Docker daemon')),
      'docker network ls failed:\n\nCannot connect to the Docker daemon',
      [LABELLED, VOLUMES, LISTED],
    ],
    [
      "the listing of the containers on a dead daemon's network",
      (r: FakeRunner) =>
        r
          .on('docker network ls', ok(`${NETWORK}\n`))
          .on('docker ps --all --quiet --filter network=', fail(1, 'Cannot connect to the Docker daemon')),
      'docker ps failed:\nCannot connect to the Docker daemon',
      [LABELLED, VOLUMES, LISTED, ON_NETWORK],
    ],
    [
      "the removal of the containers on a dead daemon's network",
      (r: FakeRunner) =>
        r
          .on('docker network ls', ok(`${NETWORK}\n`))
          .on('docker ps --all --quiet --filter network=', ok('c1\nc2\n'))
          .on('docker rm', fail(1, 'Error response from daemon: removal of container c1 is already in progress')),
      "docker rm of a dead daemon's containers failed:\nError response from daemon: removal of container c1 is already in progress",
      [LABELLED, VOLUMES, LISTED, ON_NETWORK, 'docker rm --force c1 c2'],
    ],
    [
      "the removal of a dead daemon's network",
      (r: FakeRunner) =>
        r
          .on('docker network ls', ok(`${NETWORK}\n`))
          .on('docker ps --all --quiet --filter network=', ok(''))
          .on('docker network rm', fail(1, `Error response from daemon: network ${NETWORK} has active endpoints`)),
      `docker network rm of a dead daemon's network failed:\nError response from daemon: network ${NETWORK} has active endpoints`,
      [LABELLED, VOLUMES, LISTED, ON_NETWORK, `docker network rm ${NETWORK}`],
    ],
  ])(
    'a first confinement whose sweep of what a dead daemon left fails at %s fails naming the network, creating none and changing no rule (agent-persistence R10)',
    async (_step, script, detail, ran) => {
      const runner = confines(
        script(
          new FakeRunner().on('colima version', ok()).on('docker --version', ok()).on('colima status', ok(STATUS)),
        ),
      );
      const { runtime, logger } = setup(runner);

      const error = await runtime.ensureReady(PORT).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ContainerIsolationFailed);
      expect([(error as ContainerIsolationFailed).what, (error as Error).message]).toEqual([
        `network ${NETWORK}`,
        `container isolation failed: network ${NETWORK}: ${detail}`,
      ]);
      expect(runner.lines().slice(3)).toEqual(ran);
      expect(logger.events()).toEqual(['colima.ready']);
      // Nothing was recorded, so nothing may start.
      expect(() =>
        runtime.start({ name: 'n', image: 'i', env: {}, logFile: '/dev/null', files: [], channelVolume: 'asha-vol' }),
      ).toThrow('ColimaRuntime.start before ensureReady confined its containers');
    },
  );

  it('a warm launch whose network inspect fails names the network and how to recover, and changes no rule (completion review F5)', async () => {
    const runner = new FakeRunner().on(
      'docker network inspect',
      ok(inspected()),
      fail(1, `Error response from daemon: network ${NETWORK} not found`),
    );
    const { runtime } = await readyRuntime(runner);

    const error = await runtime.ensureReady(PORT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect((error as Error).message).toBe(
      `container isolation failed: network ${NETWORK}: docker network inspect failed (asha --stop, then any command, starts a daemon that recreates it):\n\nError response from daemon: network ${NETWORK} not found`,
    );
    expect(runner.lines()).toEqual([
      'colima version',
      'docker --version',
      'colima status --profile default --json',
      `docker network inspect --format {{json .}} ${NETWORK}`,
    ]);
  });

  it('a network inspect that prints no JSON fails naming the network, with the parse error as its cause, and changes no rule', async () => {
    const runner = confines(
      new FakeRunner()
        .on('colima version', ok())
        .on('docker --version', ok())
        .on('colima status', ok(STATUS))
        .on('docker network inspect', ok('Error: template parsing error')),
    );
    const error = await setup(runner)
      .runtime.ensureReady(PORT)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect([(error as Error).message, (error as Error).cause]).toEqual([
      `container isolation failed: network ${NETWORK}: docker network inspect printed invalid JSON: Error: template parsing error`,
      expect.any(SyntaxError),
    ]);
    expect(runner.lines().slice(3)).toEqual(FIRST_CONFINE.slice(0, 5));
  });

  it('runs concurrent ensureReady calls one at a time: rule changes within a daemon are serialized', async () => {
    const { runner, runtime } = await warm();

    await Promise.all([runtime.ensureReady(PORT), runtime.ensureReady(PORT)]);

    const one = [
      'colima version',
      'docker --version',
      'colima status --profile default --json',
      `docker network inspect --format {{json .}} ${NETWORK}`,
      SSH,
    ];
    expect(runner.lines()).toEqual([...one, ...one]);
  });

  it('a failed ensureReady does not stop the next one from running', async () => {
    const runner = new FakeRunner().on('colima ssh', INSTALLED, fail(1, 'boom'), INSTALLED);
    const { runtime } = await readyRuntime(runner);
    const [first, second] = await Promise.allSettled([runtime.ensureReady(PORT), runtime.ensureReady(PORT)]);
    expect(first.status).toBe('rejected');
    expect(second).toEqual({ status: 'fulfilled', value: 'ready' });
  });

  it('refuses a port that is not a TCP port, and a home id that is not 8 hex characters', () => {
    const { runtime } = setup(new FakeRunner());
    expect(() => runtime.ensureReady(0)).toThrow('hostPort must be a TCP port, not 0');
    expect(() => runtime.ensureReady(1.5)).toThrow('hostPort must be a TCP port');
    expect(
      () =>
        new ColimaRuntime({
          runner: new FakeRunner(),
          launcher: new FakeLauncher(),
          interactive: new FakeInteractive(),
          logger: new RecordingLogger(),
          profile: 'default',
          homeId: 'x; rm -rf /',
          clock: () => NOW,
        }),
    ).toThrow('homeId must be 8 hex characters');
  });
});

describe('ColimaRuntime and saved state (docs/plans/agent-persistence.md R10, R11, R16; A16)', () => {
  let logDir: string;
  beforeEach(async () => {
    logDir = await mkdtemp(join(tmpdir(), 'asha-persist-rt-'));
  });
  const ENV = { ASHA_URL: 'https://h:1', ASHA_AGENT_TOKEN: 'secret' };
  async function* archive(): AsyncIterable<Uint8Array> {
    // No real I/O to await: one resolved tick, so this is genuinely async (require-await) without changing timing —
    // an async generator's `.next()` already resolves in a microtask regardless.
    await Promise.resolve();
    yield Buffer.from('restore-');
    yield Buffer.from('tar');
  }

  it("streams a persisted agent's restore into / between create and start, owned as the archive says (-a), in place of the documents' copy", async () => {
    const runner = new FakeRunner().on('docker create', ok('')).on('docker cp', ok(''));
    const { runtime, launcher } = await readyRuntime(runner);
    launcher.onLaunch = (p) => {
      p.exit(0);
    };
    const { exited } = runtime.start({
      name: 'asha-x',
      image: 'img',
      env: ENV,
      logFile: join(logDir, 'a.log'),
      files: [],
      archive,
      channelVolume: 'asha-vol',
    });
    await expect(exited).resolves.toBe(0);
    expect(runner.lines()).toEqual([
      `docker create --pull never --rm --name asha-x --network ${NETWORK} --dns 192.0.2.1 --add-host host.docker.internal:192.168.5.2 --label asha.home=${HOME_ID} -v asha-vol:/channel -e ASHA_URL -e ASHA_AGENT_TOKEN img`,
      'docker cp -a - asha-x:/',
    ]);
    expect(present(runner.stdins.get(1), 'runner.stdins.get(1)').toString()).toBe('restore-tar');
    expect(callAt(runner, 1).options).toEqual({ timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } });
    expect([launchedAt(launcher, 0).command, ...launchedAt(launcher, 0).args]).toEqual([
      'docker',
      'start',
      '--attach',
      'asha-x',
    ]);
  });

  it('a failed restore removes the created container and starts nothing', async () => {
    const runner = new FakeRunner()
      .on('docker create', ok(''))
      .on('docker cp', fail(1, 'no space left'))
      .on('docker rm', ok(''));
    const { runtime, launcher } = await readyRuntime(runner);
    const { exited } = runtime.start({
      name: 'asha-x',
      image: 'img',
      env: ENV,
      logFile: join(logDir, 'a.log'),
      files: [],
      archive,
      channelVolume: 'asha-vol',
    });
    await expect(exited).rejects.toThrow(
      new ContainerRuntimeError('docker cp of the saved state into asha-x:/ failed:\nno space left'),
    );
    expect(runner.lines().slice(1)).toEqual(['docker cp -a - asha-x:/', 'docker rm --force asha-x']);
    expect(launcher.launched).toEqual([]);
  });

  it('a restore whose stored archive cannot be read (the copy throws) removes the created container and fails naming the copy (R1-RELIABILITY-001)', async () => {
    const runner = new FakeRunner().on('docker create', ok('')).on('docker cp', ok('')).on('docker rm', ok(''));
    const { runtime, launcher } = await readyRuntime(runner);
    const unreadable = new Error("EACCES: permission denied, open '/s/gen-1/memory.tar'");
    const { exited } = runtime.start({
      name: 'asha-x',
      image: 'img',
      env: ENV,
      logFile: join(logDir, 'a.log'),
      files: [],
      // The stored file fails to read at the first chunk.
      archive: () => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(unreadable) }) }),
      channelVolume: 'asha-vol',
    });
    const error = await exited.catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message, (error as Error).cause]).toEqual([
      true,
      `docker cp of the saved state into asha-x:/ failed:\n${unreadable.message}`,
      unreadable,
    ]);
    expect(runner.lines().slice(1)).toEqual(['docker cp -a - asha-x:/', 'docker rm --force asha-x']);
    expect(launcher.launched).toEqual([]);
  });

  it('refuses a restore archive beside files: the archive carries the documents', async () => {
    const { runtime } = await readyRuntime(new FakeRunner());
    expect(() =>
      runtime.start({
        name: 'asha-x',
        image: 'img',
        env: ENV,
        logFile: join(logDir, 'a.log'),
        files: [{ path: 'a.md', content: Buffer.from('a') }],
        archive,
        channelVolume: 'asha-vol',
      }),
    ).toThrow('files must be []');
  });

  it('drains with the grace it is given, bounded at that grace plus 60 s; a drain without one is a defect', async () => {
    const runner = new FakeRunner().on('docker stop', ok(''));
    const { runtime } = await readyRuntime(runner);
    await runtime.stop('asha-x', 'drain', 15);
    await runtime.stop('asha-y', 'drain', 3);
    expect(runner.lines()).toEqual(['docker stop --timeout 15 asha-x', 'docker stop --timeout 3 asha-y']);
    expect(runner.calls.map((c) => c.options.timeoutMs)).toEqual([75_000, 63_000]);
    await expect((runtime.stop as (n: string, m: string) => Promise<void>)('asha-z', 'drain')).rejects.toThrow(
      'stop asha-z drain needs its grace in whole seconds, not undefined',
    );
  });

  it('copies a directory out as a tar stream, chunk by chunk; a failed or timed-out copy is data, and a reader that stops ends it', async () => {
    const runner = new FakeRunner().on(
      'docker cp',
      { code: 0, stdout: Buffer.from('0123456789'), stderr: '' },
      fail(1, 'Error: No such container: asha-x'),
      new CommandTimedOut('docker', ['cp'], 60_000),
    );
    runner.streamChunk = 4;
    const { runtime } = await readyRuntime(runner);
    const seen: string[] = [];
    expect(
      await runtime.copyOut('asha-x', '/memory', (c) => {
        seen.push(c.toString());
        return Promise.resolve('more');
      }),
    ).toEqual({
      ok: true,
    });
    expect(seen).toEqual(['0123', '4567', '89']);
    expect(runner.lines()[0]).toBe('docker cp asha-x:/memory -');
    expect(callAt(runner, 0).options).toEqual({ timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } });
    expect(await runtime.copyOut('asha-x', '/memory', () => Promise.resolve('more'))).toEqual({
      ok: false,
      detail: 'docker cp asha-x:/memory - exited 1: Error: No such container: asha-x',
    });
    expect(await runtime.copyOut('asha-x', '/memory', () => Promise.resolve('more'))).toEqual({
      ok: false,
      detail: 'docker cp did not finish within 60000 ms',
    });
  });

  it('runs a one-shot: created with no network, the home label, no --rm and no environment, exactly its arguments; restored; attached with its stderr only in its log; removed', async () => {
    const runner = new FakeRunner()
      .on('docker create', ok(''))
      .on('docker cp -a', ok(''))
      .on('docker start', {
        code: 0,
        stdout: Buffer.from('{"erased":{"files":2,"bytes":40}}\n'),
        stderr: 'zora was here\n',
      })
      .on('docker cp asha-erase', { code: 0, stdout: Buffer.from('TAR'), stderr: '' })
      .on('docker rm', ok(''));
    const { runtime } = await readyRuntime(runner);
    const logFile = join(logDir, 'one-shot.log');
    const oneShot = runtime.oneShot({
      name: 'asha-erase-1',
      image: 'asha-image-memory:abc',
      args: ['erase-user', '--channel', 'lab', '--user', 'ivy'],
      logFile,
      archive,
      timeoutMs: 60_000,
      maxStdoutBytes: 4096,
    });
    expect(await oneShot.run()).toEqual({
      kind: 'exited',
      code: 0,
      stdout: '{"erased":{"files":2,"bytes":40}}\n',
      overflow: false,
    });
    const copied: Buffer[] = [];
    expect(
      await oneShot.copyOut('/memory', (c) => {
        copied.push(c);
        return Promise.resolve('more');
      }),
    ).toEqual({ ok: true });
    await oneShot.remove();
    expect(runner.lines()).toEqual([
      `docker create --pull never --name asha-erase-1 --network none --label asha.home=${HOME_ID} asha-image-memory:abc erase-user --channel lab --user ivy`,
      'docker cp -a - asha-erase-1:/',
      'docker start --attach asha-erase-1',
      'docker cp asha-erase-1:/memory -',
      'docker rm --force asha-erase-1',
    ]);
    expect(callAt(runner, 0).args).not.toContain('--rm');
    expect(callAt(runner, 0).args.filter((a) => a === '-e')).toEqual([]);
    expect(callAt(runner, 2).options).toEqual({ timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } });
    expect(present(runner.streamOptions.get(2), 'runner.streamOptions.get(2)').stderrFile).toBe(logFile);
    expect(await readFile(logFile, 'utf8')).toBe('zora was here\n');
    expect(Buffer.concat(copied).toString()).toBe('TAR');
  });

  it('a one-shot whose docker create times out fails naming the container, never its arguments, which can name a user (R15)', async () => {
    const runner = new FakeRunner().on(
      'docker create',
      new CommandTimedOut('docker', ['create', '--name', 'asha-erase-1', 'img', 'erase-user', '--user', 'ivy'], 60_000),
    );
    const { runtime } = await readyRuntime(runner);
    const oneShot = runtime.oneShot({
      name: 'asha-erase-1',
      image: 'img',
      args: ['erase-user', '--channel', 'lab', '--user', 'ivy'],
      logFile: join(logDir, 'x.log'),
      archive,
      timeoutMs: 60_000,
      maxStdoutBytes: 4096,
    });
    const error = await oneShot.run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerRuntimeError);
    expect((error as Error).message).toBe('docker create asha-erase-1 did not finish within 60000 ms');
    expect(JSON.stringify(serializeError(error))).not.toContain('ivy');
  });

  it("keeps at most maxStdoutBytes of a one-shot's output, saying it overflowed; kills it at its bound", async () => {
    const big = new FakeRunner()
      .on('docker create', ok(''))
      .on('docker cp', ok(''))
      .on('docker start', { code: 0, stdout: Buffer.alloc(4097, 'x'), stderr: '' });
    const { runtime } = await readyRuntime(big);
    const spec = {
      name: 'o',
      image: 'i',
      args: [],
      logFile: join(logDir, 'o.log'),
      archive,
      timeoutMs: 60_000,
      maxStdoutBytes: 4096,
    };
    expect(await runtime.oneShot(spec).run()).toEqual({
      kind: 'exited',
      code: 0,
      stdout: 'x'.repeat(4096),
      overflow: true,
    });
    const slow = new FakeRunner()
      .on('docker create', ok(''))
      .on('docker cp', ok(''))
      .on('docker start', new CommandTimedOut('docker', ['start'], 60_000))
      .on('docker stop', ok(''));
    const { runtime: slowRuntime } = await readyRuntime(slow);
    expect(await slowRuntime.oneShot(spec).run()).toEqual({ kind: 'timeout' });
    expect(slow.lines().slice(-1)).toEqual(['docker stop --timeout 0 o']);
  });

  it("a copy out aborted by its caller's signal rejects with the signal's reason, reading nothing: the caller's own bound, never data", async () => {
    const runner = new FakeRunner().on('docker cp', { code: 0, stdout: Buffer.from('TAR'), stderr: '' });
    const { runtime } = await readyRuntime(runner);
    const reason = new Error('the checkpoint passed its bound');
    const signal = abortedWith(reason);
    const seen: Buffer[] = [];
    const error = await runtime
      .copyOut(
        'asha-x',
        '/memory',
        (chunk) => {
          seen.push(chunk);
          return Promise.resolve('more');
        },
        signal,
      )
      .catch((e: unknown) => e);
    expect(error).toBe(reason);
    expect(seen).toEqual([]);
    expect(runner.lines()).toEqual(['docker cp asha-x:/memory -']);
    expect(present(runner.streamOptions.get(0), 'runner.streamOptions.get(0)').signal).toBe(signal);
  });

  const ONE_SHOT = { name: 'o', image: 'i', args: [], archive, timeoutMs: 1_000, maxStdoutBytes: 64 };

  it('a one-shot whose restore fails throws naming the copy, and starts nothing', async () => {
    const runner = new FakeRunner()
      .on('docker create', ok(''))
      .on('docker cp -a', fail(1, 'Error: no space left on device\n'));
    const { runtime } = await readyRuntime(runner);
    const error = await runtime
      .oneShot({ ...ONE_SHOT, logFile: join(logDir, 'o.log') })
      .run()
      .catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'docker cp of the saved state into o:/ failed:\nError: no space left on device',
    ]);
    expect(runner.lines()).toEqual([
      `docker create --pull never --name o --network none --label asha.home=${HOME_ID} i`,
      'docker cp -a - o:/',
    ]);
  });

  it('a one-shot killed at its bound whose docker stop fails throws naming the stop; one already gone is the timeout', async () => {
    const runner = new FakeRunner()
      .on('docker create', ok(''))
      .on('docker cp', ok(''))
      .on('docker start', new CommandTimedOut('docker', ['start', '--attach', 'o'], 1_000))
      .on(
        'docker stop',
        fail(1, 'Error response from daemon: permission denied\n'),
        fail(1, 'Error response from daemon: No such container: o\n'),
      );
    const { runtime } = await readyRuntime(runner);
    const spec = { ...ONE_SHOT, logFile: join(logDir, 'o.log') };
    const error = await runtime
      .oneShot(spec)
      .run()
      .catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'docker stop --timeout 0 o failed: Error response from daemon: permission denied',
    ]);
    expect(await runtime.oneShot(spec).run()).toEqual({ kind: 'timeout' });
    expect(runner.lines().filter((line) => line.startsWith('docker st'))).toEqual([
      'docker start --attach o',
      'docker stop --timeout 0 o',
      'docker start --attach o',
      'docker stop --timeout 0 o',
    ]);
    // Attached for its own bound; killed within the usual command bound.
    expect(
      runner.calls.filter((c) => c.args[0] === 'start' || c.args[0] === 'stop').map((c) => c.options.timeoutMs),
    ).toEqual([1_000, 60_000, 1_000, 60_000]);
  });

  it("a one-shot's removal tolerates only a container already gone", async () => {
    const runner = new FakeRunner().on(
      'docker rm',
      fail(1, 'Error response from daemon: No such container: o\n'),
      fail(1, 'Error response from daemon: permission denied\n'),
    );
    const { runtime } = await readyRuntime(runner);
    const oneShot = runtime.oneShot({ ...ONE_SHOT, logFile: join(logDir, 'o.log') });
    await expect(oneShot.remove()).resolves.toBeUndefined();
    const error = await oneShot.remove().catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'docker rm --force o failed: Error response from daemon: permission denied',
    ]);
    expect(runner.lines()).toEqual(['docker rm --force o', 'docker rm --force o']);
  });

  it('the reclaim script removes containers carrying the home label as well as those on its network', () => {
    expect(reclaimScript(HOME_ID)).toContain(
      `  by_net=$(docker ps --all --quiet --filter network=asha-${HOME_ID}) || return 1\n  by_label=$(docker ps --all --quiet --filter label=asha.home=${HOME_ID}) || return 1\n  printf '%s\\n' $by_net $by_label | sort -u\n}\ncontainers=$(home_containers)\n`,
    );
  });
});

describe('ColimaRuntime.reclaim', () => {
  it('does nothing when colima is not installed, or its profile is not running', async () => {
    const missing = new FakeRunner().on('colima status', 'not-found');
    const a = setup(missing);
    await expect(a.runtime.reclaim()).resolves.toEqual({ volumes: 0 });
    expect(missing.lines()).toEqual(['colima status --profile default --json']);
    expect(a.logger.entries).toEqual([
      {
        level: 'info',
        event: 'isolation.reclaim_skipped',
        fields: { homeId: HOME_ID, reason: 'colima is not installed' },
      },
    ]);

    const stopped = new FakeRunner().on('colima status', fail(1, 'colima is not running'));
    const b = setup(stopped);
    await b.runtime.reclaim();
    expect(stopped.lines()).toEqual(['colima status --profile default --json']);
    expect(entryAt(b.logger, 0).fields).toEqual({ homeId: HOME_ID, reason: 'colima profile default is not running' });
  });

  it("removes the home's rules, containers and network in one colima ssh, and the next launch recreates the network", async () => {
    const runner = new FakeRunner().on(
      'colima ssh',
      INSTALLED,
      ok('asha-isolation: reclaimed rules=2 containers=1 network=1 volumes=0 networks=0\n'),
      INSTALLED,
    );
    const { runtime, logger } = await readyRuntime(runner);

    expect(await runtime.reclaim()).toEqual({ volumes: 0 });

    expect(runner.lines()).toEqual(['colima status --profile default --json', SSH]);
    expect(callAt(runner, 1).options).toEqual({ timeoutMs: 30_000, stdin: reclaimScript(HOME_ID) });
    expect(logger.entries.at(-1)).toEqual({
      level: 'info',
      event: 'isolation.reclaimed',
      fields: { homeId: HOME_ID, rules: 2, containers: 1, network: true, volumes: 0, networks: 0 },
    });
    runner.calls.length = 0;
    await runtime.ensureReady(PORT);
    expect(runner.lines().slice(3)).toEqual(FIRST_CONFINE);
  });

  it('fails with ContainerIsolationFailed when the reclaim script fails', async () => {
    const runner = new FakeRunner()
      .on('colima status', ok(STATUS))
      .on('colima ssh', fail(4, 'asha-isolation: lock: /run/asha-iptables.lock not free within 20 s\n'));
    const { runtime } = setup(runner);
    const error = await runtime.reclaim().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect((error as Error).message).toContain('reclaim: lock: /run/asha-iptables.lock not free within 20 s');
  });

  it('fails with ContainerIsolationFailed when the reclaim script exits 0 without reporting its result, logging no reclaim', async () => {
    const runner = new FakeRunner().on('colima status', ok(STATUS)).on('colima ssh', ok('something else\n'));
    const { runtime, logger } = setup(runner);
    const error = await runtime.reclaim().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect([(error as ContainerIsolationFailed).what, (error as Error).message]).toEqual([
      'reclaim',
      'container isolation failed: reclaim: the script did not report its result:\nsomething else',
    ]);
    expect(runner.lines()).toEqual(['colima status --profile default --json', SSH]);
    expect(logger.entries).toEqual([]);
  });
});

describe("the reclaim's removal of a dead daemon's containers, run in bash against a scripted docker", () => {
  /**
   * A fake `docker` on PATH: `ps` lists the ids in present (each call counted; after vanishAfter calls the list
   * empties, as a removal Docker had in progress finishes), and `rm --force` answers as rmMode says.
   */
  async function run(props: {
    present: string[];
    rmMode: 'ok' | 'progress' | 'gone' | 'other' | 'mixed' | 'mixedbad';
    vanishAfter: number;
    waitS?: number;
    /** From this network-filter `ps` call on (1 = the first), every `ps` exits 1: Docker no longer answers. */
    psFailsFrom?: number;
  }) {
    const dir = await mkdtemp(join(tmpdir(), 'asha-fake-docker-'));
    const { writeFile: write, chmod } = await import('node:fs/promises');
    await write(join(dir, 'present'), props.present.join('\n'));
    await write(join(dir, 'polls'), '0');
    const docker = `#!/bin/bash
S=${dir}
if [ "$1" = ps ]; then
  case "$*" in *network=*) n=$(( $(cat $S/polls) + 1 )); echo $n > $S/polls ;; esac
  if [ "$(cat $S/polls)" -ge ${String(props.psFailsFrom ?? 0)} ] && [ ${String(props.psFailsFrom ?? 0)} -gt 0 ]; then
    echo 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' >&2; exit 1
  fi
  case "$*" in *network=*)
    if [ $n -gt ${String(props.vanishAfter)} ]; then : > $S/present; fi
    cat $S/present; echo ;; esac
  exit 0
fi
if [ "$1" = rm ]; then
  echo "$*" >> $S/rm.log
  shift 2
  code=0
  for c in "$@"; do
    mode="${props.rmMode}"
    if [ "$mode" = mixed ]; then if [ "$c" = aaa ]; then mode=ok; else mode=progress; fi; fi
    if [ "$mode" = mixedbad ]; then if [ "$c" = aaa ]; then mode=other; else mode=progress; fi; fi
    case "$mode" in
      ok) grep -v "^$c$" $S/present > $S/p2 || true; mv $S/p2 $S/present; echo "$c" ;;
      progress) echo "Error response from daemon: removal of container $c is already in progress" >&2; code=1 ;;
      gone) echo "Error response from daemon: No such container: $c" >&2; code=1 ;;
      other) echo "Error response from daemon: permission denied for $c" >&2; code=1 ;;
    esac
  done
  exit $code
fi
exit 2
`;
    await write(join(dir, 'docker'), docker);
    await chmod(join(dir, 'docker'), 0o755);
    const { spawnSync } = await import('node:child_process');
    const script = `set -eu\n${removeHomeContainers(HOME_ID, props.waitS ?? 3)}echo "containers=$containers"\n`;
    const r = spawnSync('bash', ['-c', script], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      encoding: 'utf8',
      timeout: 20_000,
    });
    const { readFile: read } = await import('node:fs/promises');
    const rm = await read(join(dir, 'rm.log'), 'utf8').then(
      (t) => t.trim().split('\n'),
      () => [],
    );
    return { code: r.status, stdout: r.stdout, stderr: r.stderr, rm };
  }

  it('removes every listed container in one docker rm naming them all (extension-modules P7: one call per container cost 16 × ~40 ms)', async () => {
    expect(await run({ present: ['aaa', 'bbb'], rmMode: 'ok', vanishAfter: 99 })).toEqual({
      code: 0,
      stdout: 'containers=aaa\nbbb\n',
      stderr: '',
      rm: ['rm --force aaa bbb'],
    });
  });

  it('tolerates one container already being removed beside one removed now, and fails on any other answer among them', async () => {
    const r = await run({ present: ['aaa', 'bbb'], rmMode: 'mixed', vanishAfter: 2 });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, 'containers=aaa\nbbb\n', '']);
    // A failure beside a tolerated answer still fails the reclaim, naming only the failure.
    const bad = await run({ present: ['aaa', 'bbb'], rmMode: 'mixedbad', vanishAfter: 99 });
    expect([bad.code, bad.stderr.trim()]).toEqual([1, 'Error response from daemon: permission denied for aaa']);
  });

  it('tolerates a removal already in progress, and waits until it is done', async () => {
    const r = await run({ present: ['aaa'], rmMode: 'progress', vanishAfter: 2 });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, 'containers=aaa\n', '']);
  });

  it('tolerates a container already gone', async () => {
    expect((await run({ present: ['aaa'], rmMode: 'gone', vanishAfter: 1 })).code).toBe(0);
  });

  it('fails on any other docker rm failure, naming it', async () => {
    const r = await run({ present: ['aaa'], rmMode: 'other', vanishAfter: 99 });
    expect([r.code, r.stderr.trim()]).toEqual([1, 'Error response from daemon: permission denied for aaa']);
  });

  it('fails when a removal in progress does not finish within its bound', async () => {
    const r = await run({ present: ['aaa'], rmMode: 'progress', vanishAfter: 99, waitS: 2 });
    expect([r.code, r.stderr.trim()]).toEqual([
      1,
      "reclaim: this home's containers still present 2 s after their removal",
    ]);
  });

  it('a container listing that fails fails the removal, never read as none: removing nothing (PRINCIPLES §11; R1-DESIGN-002)', async () => {
    const r = await run({ present: ['aaa'], rmMode: 'ok', vanishAfter: 99, psFailsFrom: 1 });
    expect([r.code === 0, r.stdout, r.stderr.trim(), r.rm]).toEqual([
      false,
      '',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
      [],
    ]);
  });

  it('a listing that fails while waiting for the containers to go fails the removal, not read as gone (R1-DESIGN-002)', async () => {
    const r = await run({ present: ['aaa'], rmMode: 'progress', vanishAfter: 99, psFailsFrom: 2 });
    expect([r.code === 0, r.stdout, r.stderr.trim()]).toEqual([
      false,
      '',
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    ]);
  });

  it('the reclaim script runs exactly this removal', () => {
    expect(reclaimScript(HOME_ID)).toContain(removeHomeContainers(HOME_ID));
  });
});

describe('the rule scripts', () => {
  const install = installScript(HOME_ID, PORT);
  const reclaim = reclaimScript(HOME_ID);
  /** Every interface an iptables rule in the script matches. */
  const interfaces = (script: string) => [...script.matchAll(/-i (\S+)/g)].map((m) => m[1]);

  it("installs exactly this home's allow, tagged, above the shared rejects, in one iptables-restore under the lock", () => {
    expect(install).toContain('exec 9>/run/asha-iptables.lock\nflock -w 20 9');
    expect(install).toContain(
      `echo '-I ASHA-AGENTS 1 -i asha${HOME_ID} -d 192.168.5.2/32 -p tcp --dport ${String(PORT)} -m comment --comment asha:${HOME_ID} -j RETURN'`,
    );
    expect(install).toContain(
      'iptables -w -A ASHA-AGENTS -i asha+ -d 192.168.5.2/32 -p tcp -j REJECT --reject-with tcp-reset',
    );
    expect(install).toContain('iptables -w -A ASHA-AGENTS -i asha+ -d 192.168.5.2/32 -j REJECT');
    expect(install).toContain("echo '-I DOCKER-USER 1 -i asha+ -j ASHA-AGENTS'");
    expect(install).toContain("echo '-I INPUT 1 -i asha+ -j ASHA-AGENTS'");
    expect(install).toContain(
      `echo '-I ASHA-AGENTS 1 -i asha${HOME_ID} -m comment --comment asha:${HOME_ID} -j REJECT'`,
    );
    expect(install.match(/iptables-restore/g)).toEqual(['iptables-restore']);
    expect(install).toContain('iptables-restore --noflush');
    expect(install).toContain('if [ "$hosts_addr" != "192.168.5.2" ]');
  });

  it('matches no interface outside asha+, and never flushes, deletes or re-polices a chain', () => {
    for (const script of [install, reclaim]) {
      expect(new Set(interfaces(script))).toEqual(new Set(script === install ? ['asha+', `asha${HOME_ID}`] : []));
      expect(script).not.toMatch(/ -[FXPZ] /);
      expect(script).not.toMatch(/iptables(-restore)? [^|\n]*--flush/);
    }
  });

  it("deletes only rules tagged with this home's id", () => {
    for (const script of [install, reclaim]) {
      // The install touches only the agent rules (on asha<homeId>); the reclaim removes every rule of the home, the
      // egress bridge's (ashae<homeId>, extension-modules R6 (d)) among them.
      expect(script).toContain(
        script === install
          ? `awk -v t='--comment "asha:${HOME_ID}"' 'index($0, "-A ASHA-AGENTS ") == 1 && index($0, t) > 0 && index($0, " -i asha${HOME_ID} ") > 0'`
          : `awk -v t='--comment "asha:${HOME_ID}"' 'index($0, "-A ASHA-AGENTS ") == 1 && index($0, t) > 0'`,
      );
      // The only deletions: this home's tagged lines, and (install only) extra copies of the jumps.
      const deletions = script.split('\n').filter((line) => line.includes('-D '));
      expect(
        deletions.every(
          (line) =>
            line.includes(`sed 's/^-A /-D /'`) ||
            line.includes("echo '-D DOCKER-USER -i asha+ -j ASHA-AGENTS'") ||
            line.includes("echo '-D INPUT -i asha+ -j ASHA-AGENTS'"),
        ),
      ).toBe(true);
    }
    expect(reclaim).not.toContain('DOCKER-USER');
    expect(reclaim).not.toMatch(/-N |-I |-A ASHA-AGENTS -i/);
    expect(reclaim).toContain(`docker network rm asha-${HOME_ID}`);
    expect(reclaim).toContain(`docker ps --all --quiet --filter network=asha-${HOME_ID}`);
  });
});

describe('installScript, run against a fake iptables (agent-tools R14, A11)', () => {
  // The fakes' first runs, macOS's assessment of each new executable, here rather than in a test's 5 s.
  beforeAll(warmFakeCommands, 60_000);

  const ALLOW = `-i asha${HOME_ID} -d 192.168.5.2/32 -p tcp --dport ${String(PORT)} -m comment --comment asha:${HOME_ID} -j RETURN`;
  const REJECT = `-i asha${HOME_ID} -m comment --comment asha:${HOME_ID} -j REJECT`;
  const SHARED = [
    '-i asha+ -d 192.168.5.2/32 -p tcp -j REJECT --reject-with tcp-reset',
    '-i asha+ -d 192.168.5.2/32 -j REJECT',
  ];
  const OTHER = '-i asha99999999 -d 192.168.5.2/32 -p tcp --dport 40000 -m comment --comment asha:99999999 -j RETURN';

  it('on a fresh VM installs the jumps as rule 1 of DOCKER-USER and INPUT, and the allow then the reject of everything else from the bridge', async () => {
    const vm = await FakeVm.create(DOCKER_TABLE);

    const first = await vm.run(installScript(HOME_ID, PORT));

    expect([first.code, first.stdout]).toEqual([
      0,
      'asha-isolation: ready jump_fixed=1 input_jump_fixed=1 home_rules_replaced=1\n',
    ]);
    // Its stderr holds only the answers of `iptables -C` for rules not yet there, as the real iptables prints them.
    expect(first.stderr.split('\n').filter((l) => l !== '' && !l.startsWith('iptables: Bad rule'))).toEqual([]);
    expect(await vm.chain('ASHA-AGENTS')).toEqual([ALLOW, REJECT, ...SHARED]);
    expect(await vm.chain('DOCKER-USER')).toEqual(['-i asha+ -j ASHA-AGENTS']);
    expect(await vm.chain('INPUT')).toEqual(['-i asha+ -j ASHA-AGENTS']);

    // A second launch finds everything in place and changes nothing.
    const table = await vm.table();
    const second = await vm.run(installScript(HOME_ID, PORT));
    expect(second).toEqual({
      code: 0,
      stdout: 'asha-isolation: ready jump_fixed=0 input_jump_fixed=0 home_rules_replaced=0\n',
      stderr: '',
    });
    expect(await vm.table()).toEqual(table);
  });

  it("replaces a home's rules from before R14 (the allow alone) or out of order, and leaves another home's allow alone", async () => {
    for (const before of [[ALLOW], [REJECT, ALLOW]]) {
      const vm = await FakeVm.create({
        chains: [...DOCKER_TABLE.chains, 'ASHA-AGENTS'],
        rules: [
          { chain: 'INPUT', spec: '-i asha+ -j ASHA-AGENTS' },
          ...DOCKER_TABLE.rules,
          { chain: 'DOCKER-USER', spec: '-i asha+ -j ASHA-AGENTS' },
          { chain: 'ASHA-AGENTS', spec: OTHER },
          ...before.map((spec) => ({ chain: 'ASHA-AGENTS', spec })),
          ...SHARED.map((spec) => ({ chain: 'ASHA-AGENTS', spec })),
        ],
      });

      const run = await vm.run(installScript(HOME_ID, PORT));

      expect(run.stdout).toBe('asha-isolation: ready jump_fixed=0 input_jump_fixed=0 home_rules_replaced=1\n');
      expect(await vm.chain('ASHA-AGENTS')).toEqual([ALLOW, REJECT, OTHER, ...SHARED]);
    }
  });

  it('moves an INPUT jump that is not rule 1 back to rule 1', async () => {
    const vm = await FakeVm.create({
      ...DOCKER_TABLE,
      rules: [{ chain: 'INPUT', spec: '-i eth0 -j ACCEPT' }, ...DOCKER_TABLE.rules],
    });
    await vm.run(installScript(HOME_ID, PORT));
    expect(await vm.chain('INPUT')).toEqual(['-i asha+ -j ASHA-AGENTS', '-i eth0 -j ACCEPT']);
  });

  it.each([
    [`-I ASHA-AGENTS 1 ${REJECT}`, `verify: the reject of everything else from asha${HOME_ID} is missing`],
    ['-I INPUT 1', 'verify: the jump is not rule 1 of INPUT (rule 1 is: )'],
    [`-I ASHA-AGENTS 1 ${ALLOW}`, `verify: the allow for port ${String(PORT)} is missing`],
  ])('fails its verify step, exit 5, naming the rule, when the change %s does not land', async (drop, named) => {
    const vm = await FakeVm.create(DOCKER_TABLE);

    const run = await vm.run(installScript(HOME_ID, PORT), { drop });

    expect(run.code).toBe(5);
    expect(run.stderr.trim().split('\n').at(-1)).toBe(`asha-isolation: ${named}`);
    expect(run.stdout).toBe('');
  });
});

describe('ColimaRuntime and the channel file spaces (docs/plans/agent-files.md R3a, R10, R10a, R12; A4, A11)', () => {
  const VOLUME = `asha-${HOME_ID}-0123abcd-lab`;
  const HOLDER = `${VOLUME}-files`;
  const IMAGE = TAG_A;
  const LABELS = { 'asha.home': HOME_ID, 'asha.space': 'f'.repeat(32) };

  it('creates the volume with its labels, reads one label back exactly as R10 names it, and creates the holder never started, with no network, no pull and the volume at /channel', async () => {
    const runner = new FakeRunner()
      .on('docker volume create', ok(`${VOLUME}\n`))
      .on('docker volume inspect', ok(`${'f'.repeat(32)}\n`))
      .on('docker create', ok('h0\n'));
    const { runtime } = await readyRuntime(runner);
    await runtime.createVolume(VOLUME, LABELS);
    expect(await runtime.volumeLabel(VOLUME, 'asha.space')).toBe('f'.repeat(32));
    await runtime.createHolder({ name: HOLDER, image: IMAGE, volume: VOLUME, labels: LABELS });
    expect(runner.calls.map((c) => [c.command, ...c.args])).toEqual([
      [
        'docker',
        'volume',
        'create',
        '--label',
        `asha.home=${HOME_ID}`,
        '--label',
        `asha.space=${'f'.repeat(32)}`,
        VOLUME,
      ],
      ['docker', 'volume', 'inspect', '--format', '{{index .Labels "asha.space"}}', VOLUME],
      [
        'docker',
        'create',
        '--pull',
        'never',
        '--name',
        HOLDER,
        '--network',
        'none',
        '--entrypoint',
        'true',
        '--label',
        `asha.home=${HOME_ID}`,
        '--label',
        `asha.space=${'f'.repeat(32)}`,
        '-v',
        `${VOLUME}:/channel`,
        IMAGE,
      ],
    ]);
    for (const call of runner.calls) expect(call.options).toEqual({ timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } });
  });

  it('a failed volume create, label read-back, holder create or removal throws naming the command and its output; a removal of what is already gone is not a failure', async () => {
    const runner = new FakeRunner()
      .on('docker volume create', fail(1, 'Error: disk full'))
      .on('docker volume inspect', fail(1, 'Error response from daemon: get x: no such volume'))
      .on('docker create', fail(125, 'Unable to find image'))
      .on('docker rm --force gone', fail(1, 'Error response from daemon: No such container: gone'))
      .on('docker rm --force stuck', fail(1, 'Error response from daemon: permission denied'))
      .on('docker volume rm gone', fail(1, 'Error response from daemon: get gone: no such volume'))
      .on('docker volume rm busy', fail(1, 'Error response from daemon: remove busy: volume is in use - [c1]'));
    const { runtime } = await readyRuntime(runner);
    await expect(runtime.createVolume(VOLUME, LABELS)).rejects.toThrow(
      `docker volume create ${VOLUME} failed:\nError: disk full`,
    );
    await expect(runtime.volumeLabel(VOLUME, 'asha.space')).rejects.toThrow(
      `docker volume inspect ${VOLUME} failed:\nError response from daemon: get x: no such volume`,
    );
    await expect(runtime.createHolder({ name: HOLDER, image: IMAGE, volume: VOLUME, labels: LABELS })).rejects.toThrow(
      `docker create ${HOLDER} failed:\nUnable to find image`,
    );
    await expect(runtime.removeContainer('gone')).resolves.toBeUndefined();
    await expect(runtime.removeContainer('stuck')).rejects.toThrow(
      'docker rm --force stuck failed: Error response from daemon: permission denied',
    );
    await expect(runtime.removeVolume('gone')).resolves.toBeUndefined();
    await expect(runtime.removeVolume('busy')).rejects.toThrow(
      'docker volume rm busy failed: Error response from daemon: remove busy: volume is in use - [c1]',
    );
  });

  it("copies a tar into the holder at / (docker cp - <holder>:/), bounded by 60 s: its exit status is data, its bound a timeout, its abort the caller's", async () => {
    const runner = new FakeRunner().on(
      'docker cp -',
      ok(''),
      fail(1, 'Error: cannot overwrite non-directory'),
      new CommandTimedOut('docker', ['cp'], 60_000),
      ok(''),
    );
    const { runtime } = await readyRuntime(runner);
    async function* archive() {
      await Promise.resolve();
      yield Buffer.from('ab');
      yield Buffer.from('cd');
    }
    expect(await runtime.copyIn(HOLDER, archive())).toEqual({ kind: 'exited', code: 0, stderr: '' });
    expect(runner.lines()[0]).toBe(`docker cp - ${HOLDER}:/`);
    expect(callAt(runner, 0).options).toEqual({ timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } });
    expect(present(runner.stdins.get(0), 'runner.stdins.get(0)').toString()).toBe('abcd');
    expect(await runtime.copyIn(HOLDER, archive())).toEqual({
      kind: 'exited',
      code: 1,
      stderr: 'Error: cannot overwrite non-directory',
    });
    expect(await runtime.copyIn(HOLDER, archive())).toEqual({ kind: 'timeout' });
    const stop = new AbortController();
    stop.abort(new Error('the daemon is stopping'));
    await expect(runtime.copyIn(HOLDER, archive(), stop.signal)).rejects.toThrow('the daemon is stopping');
  });

  it("rolls an upload back by exactly R3a's one-shot: --rm --pull never --network none --user 0:0, the home label, the volume, rm -rf -- /channel/<folder> (A4)", async () => {
    const runner = new FakeRunner().on(
      'docker run',
      ok(''),
      fail(1, "rm: can't remove"),
      new CommandTimedOut('docker', ['run'], 60_000),
    );
    const { runtime } = await readyRuntime(runner);
    const folder = 'upload-0123456789abcdef';
    expect(await runtime.rollback({ volume: VOLUME, image: IMAGE, folder })).toEqual({
      kind: 'exited',
      code: 0,
      stderr: '',
    });
    expect([callAt(runner, 0).command, ...callAt(runner, 0).args]).toEqual([
      'docker',
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--user',
      '0:0',
      '--label',
      `asha.home=${HOME_ID}`,
      '-v',
      `${VOLUME}:/channel`,
      '--entrypoint',
      'rm',
      IMAGE,
      '-rf',
      '--',
      `/channel/${folder}`,
    ]);
    expect(callAt(runner, 0).options).toEqual({ timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } });
    expect(await runtime.rollback({ volume: VOLUME, image: IMAGE, folder })).toEqual({
      kind: 'exited',
      code: 1,
      stderr: "rm: can't remove",
    });
    expect(await runtime.rollback({ volume: VOLUME, image: IMAGE, folder })).toEqual({ kind: 'timeout' });
    // A folder that is not an upload's is never passed to rm: a defect, refused before anything runs.
    await expect(runtime.rollback({ volume: VOLUME, image: IMAGE, folder: '../etc' })).rejects.toThrow(
      'rollback of "../etc"',
    );
    expect(runner.calls).toHaveLength(3);
  });

  it('empties a space by a fixed root one-shot: --rm --pull never --network none --user 0:0, the home label, the volume, sh -c removing every entry under /channel (agent-files R15; R1-DESIGN-005)', async () => {
    const runner = new FakeRunner().on(
      'docker run',
      ok(''),
      fail(1, "rm: can't remove"),
      new CommandTimedOut('docker', ['run'], 60_000),
    );
    const { runtime } = await readyRuntime(runner);
    expect(await runtime.emptySpace({ volume: VOLUME, image: IMAGE })).toEqual({ kind: 'exited', code: 0, stderr: '' });
    expect([callAt(runner, 0).command, ...callAt(runner, 0).args]).toEqual([
      'docker',
      'run',
      '--rm',
      '--pull',
      'never',
      '--network',
      'none',
      '--user',
      '0:0',
      '--label',
      `asha.home=${HOME_ID}`,
      '-v',
      `${VOLUME}:/channel`,
      '--entrypoint',
      'sh',
      IMAGE,
      '-c',
      'rm -rf -- /channel/* /channel/.[!.]* /channel/..?*',
    ]);
    expect(callAt(runner, 0).options).toEqual({ timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } });
    expect(await runtime.emptySpace({ volume: VOLUME, image: IMAGE })).toEqual({
      kind: 'exited',
      code: 1,
      stderr: "rm: can't remove",
    });
    expect(await runtime.emptySpace({ volume: VOLUME, image: IMAGE })).toEqual({ kind: 'timeout' });
  });

  it("a rollback or an emptying aborted by its caller's signal rejects with the signal's reason: the stop's to handle, never an outcome", async () => {
    const runner = new FakeRunner().on('docker run', ok(''));
    const { runtime } = await readyRuntime(runner);
    const reason = new Error('the daemon is stopping');
    const rolledBack = await runtime
      .rollback({ volume: VOLUME, image: IMAGE, folder: 'upload-0123456789abcdef' }, abortedWith(reason))
      .catch((e: unknown) => e);
    const emptied = await runtime
      .emptySpace({ volume: VOLUME, image: IMAGE }, abortedWith(reason))
      .catch((e: unknown) => e);
    expect(rolledBack).toBe(reason);
    expect(emptied).toBe(reason);
    expect(runner.calls.map((c) => c.args.at(-1))).toEqual([
      '/channel/upload-0123456789abcdef',
      'rm -rf -- /channel/* /channel/.[!.]* /channel/..?*',
    ]);
  });

  it("mounts the channel's volume at /channel on every agent container: the only mount it adds (R10)", async () => {
    const runner = new FakeRunner().on('docker create', ok('0123abcd\n'));
    const { runtime, launcher } = await readyRuntime(runner);
    launcher.onLaunch = (p) => {
      p.exit(0);
    };
    const logDir = await mkdtemp(join(tmpdir(), 'asha-run-'));
    await runtime.start({
      name: 'asha-x',
      image: 'img',
      env: {},
      logFile: join(logDir, 'a.log'),
      files: [],
      channelVolume: VOLUME,
    }).exited;
    expect(runner.lines()[0]).toBe(
      `docker create --pull never --rm --name asha-x --network ${NETWORK} --dns 192.0.2.1 --add-host host.docker.internal:192.168.5.2 --label asha.home=${HOME_ID} -v ${VOLUME}:/channel img`,
    );
    expect(callAt(runner, 0).args.filter((a) => a === '-v' || a.startsWith('--mount'))).toEqual(['-v']);
  });
});

describe("the sweeps of a home's volumes (agent-files R10a, A11)", () => {
  it("the reclaim script removes the home's containers, then every volume labelled with its home, and reports their count", () => {
    const script = reclaimScript(HOME_ID);
    const containers = script.indexOf(removeHomeContainers(HOME_ID));
    const volumes = script.indexOf(`volumes=$(docker volume ls --quiet --filter label=asha.home=${HOME_ID})`);
    expect(containers).toBeGreaterThan(0);
    expect(volumes).toBeGreaterThan(containers);
    expect(script).toContain('network=$network volumes=$removed_volumes networks=$removed_networks"');
  });

  /** Runs the reclaim's volume part in bash against a scripted docker: `volume ls` lists `present`, `volume rm` answers as rmMode says. */
  async function sweep(props: { present: string[]; rmMode: 'ok' | 'busy'; lsFails?: boolean }) {
    const dir = await mkdtemp(join(tmpdir(), 'asha-fake-docker-'));
    const { writeFile: write, chmod } = await import('node:fs/promises');
    await write(join(dir, 'present'), props.present.join('\n'));
    await write(join(dir, 'log'), '');
    await write(
      join(dir, 'docker'),
      `#!/bin/bash
S=${dir}
echo "$*" >> $S/log
if [ "$1 $2" = "volume ls" ]; then ${props.lsFails ? 'echo "Cannot connect to the Docker daemon" >&2; exit 1' : 'cat $S/present; echo; exit 0'}; fi
if [ "$1 $2" = "volume rm" ]; then
  case "${props.rmMode}" in
    ok) echo "$3"; exit 0 ;;
    busy) echo "Error response from daemon: remove $3: volume is in use - [c1]" >&2; exit 1 ;;
  esac
fi
exit 2
`,
    );
    await chmod(join(dir, 'docker'), 0o755);
    const { spawnSync } = await import('node:child_process');
    const { removeHomeVolumes } = await import('../../src/daemon/container-runtime/index.js');
    const r = spawnSync('bash', ['-c', `set -eu\n${removeHomeVolumes(HOME_ID)}echo "volumes=$removed_volumes"\n`], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      encoding: 'utf8',
      timeout: 20_000,
    });
    const { readFile: read } = await import('node:fs/promises');
    return {
      code: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      docker: (await read(join(dir, 'log'), 'utf8')).trim().split('\n'),
    };
  }

  it('removes each labelled volume and reports volumes=2', async () => {
    const r = await sweep({ present: ['asha-v1', 'asha-v2'], rmMode: 'ok' });
    expect([r.code, r.stdout, r.stderr]).toEqual([0, 'volumes=2\n', '']);
    expect(r.docker).toEqual([
      `volume ls --quiet --filter label=asha.home=${HOME_ID}`,
      'volume rm asha-v1',
      'volume rm asha-v2',
    ]);
  });

  it('reports volumes=0 when there is none', async () => {
    const r = await sweep({ present: [], rmMode: 'ok' });
    expect([r.code, r.stdout]).toEqual([0, 'volumes=0\n']);
  });

  it('a volume that cannot be removed fails the sweep, naming it', async () => {
    const r = await sweep({ present: ['asha-v1'], rmMode: 'busy' });
    expect([r.code, r.stderr.trim()]).toEqual([
      6,
      'asha-isolation: reclaim: volume asha-v1 could not be removed: Error response from daemon: remove asha-v1: volume is in use - [c1]',
    ]);
  });

  it('a listing that fails fails the sweep: never read as "no volumes"', async () => {
    const r = await sweep({ present: ['asha-v1'], rmMode: 'ok', lsFails: true });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toBe('');
  });

  it('the reclaim reports the volumes it removed (and isolation.reclaimed carries them)', async () => {
    const runner = new FakeRunner().on(
      'colima ssh',
      INSTALLED,
      ok('asha-isolation: reclaimed rules=2 containers=1 network=1 volumes=2 networks=0\n'),
    );
    const { runtime, logger } = await readyRuntime(runner);
    expect(await runtime.reclaim()).toEqual({ volumes: 2 });
    expect(logger.entries.at(-1)).toEqual({
      level: 'info',
      event: 'isolation.reclaimed',
      fields: { homeId: HOME_ID, rules: 2, containers: 1, network: true, volumes: 2, networks: 0 },
    });
  });

  it('a reclaim whose volume removal failed throws naming the volume (the script exits 6)', async () => {
    const runner = new FakeRunner().on(
      'colima ssh',
      INSTALLED,
      fail(
        6,
        'asha-isolation: reclaim: volume asha-abcd1234-0123abcd-lab could not be removed: Error response from daemon: remove asha-abcd1234-0123abcd-lab: volume is in use - [c1]',
      ),
    );
    const { runtime } = await readyRuntime(runner);
    await expect(runtime.reclaim()).rejects.toThrow('reclaim: volume asha-abcd1234-0123abcd-lab could not be removed');
  });

  it("createNetwork's sweep removes the home's labelled volumes after its containers, logging files.stale_space_removed; with none it logs nothing more", async () => {
    const runner = new FakeRunner()
      .on('colima version', ok())
      .on('docker --version', ok())
      .on('colima status', ok(STATUS))
      .on('docker ps --all --quiet --filter label=', ok('c0\n'))
      .on('docker rm', ok())
      .on('docker volume ls', ok('asha-v1\nasha-v2\n'))
      .on('docker volume rm', ok());
    const { runtime, logger } = setup(confines(runner));
    await runtime.ensureReady(PORT);
    expect(runner.lines().slice(3, 7)).toEqual([
      `docker ps --all --quiet --filter label=asha.home=${HOME_ID}`,
      'docker rm --force c0',
      `docker volume ls --quiet --filter label=asha.home=${HOME_ID}`,
      'docker volume rm asha-v1 asha-v2',
    ]);
    expect(logger.entries.filter((e) => e.event.startsWith('files.'))).toEqual([
      { level: 'warn', event: 'files.stale_space_removed', fields: { volumes: 2 } },
    ]);

    const none = new FakeRunner()
      .on('colima version', ok())
      .on('docker --version', ok())
      .on('colima status', ok(STATUS))
      .on('docker volume ls', ok(''));
    const quiet = setup(confines(none));
    await quiet.runtime.ensureReady(PORT);
    expect(none.lines().slice(3, 5)).toEqual([
      `docker ps --all --quiet --filter label=asha.home=${HOME_ID}`,
      `docker volume ls --quiet --filter label=asha.home=${HOME_ID}`,
    ]);
    expect(quiet.logger.entries.filter((e) => e.event.startsWith('files.'))).toEqual([]);
  });

  it("createNetwork's sweep fails the start when a volume cannot be removed, or cannot be listed", async () => {
    const base = () =>
      new FakeRunner()
        .on('colima version', ok())
        .on('docker --version', ok())
        .on('colima status', ok(STATUS))
        .on('docker ps --all --quiet --filter label=', ok(''));
    const busy = setup(
      confines(
        base()
          .on('docker volume ls', ok('asha-v1\n'))
          .on('docker volume rm', fail(1, 'Error response from daemon: remove asha-v1: volume is in use')),
      ),
    );
    await expect(busy.runtime.ensureReady(PORT)).rejects.toThrow(
      "docker volume rm of a dead daemon's volumes failed:\nError response from daemon: remove asha-v1: volume is in use",
    );
    const unlisted = setup(confines(base().on('docker volume ls', fail(1, 'Cannot connect to the Docker daemon'))));
    await expect(unlisted.runtime.ensureReady(PORT)).rejects.toThrow(
      "docker volume ls of this home's volumes failed:\nCannot connect to the Docker daemon",
    );
  });
});

describe('only agent containers carry the DNS flags (debt-paydown R1, A1; D18)', () => {
  it('the module, egress-proxy, plugin, one-shot, holder and rollback creates carry neither --dns nor --add-host', async () => {
    const runner = new FakeRunner()
      .on('docker create', ok(''))
      .on('docker run', ok(''))
      .on('docker cp', ok(''))
      .on('docker start', ok(''))
      .on('docker rm', ok(''));
    const { runtime, interactive } = await readyRuntime(runner);
    const created: Record<string, readonly string[]> = {};
    const mark = () => runner.calls.length;
    let at = mark();
    runtime.runAttached({
      name: 'asha-mod-x',
      image: 'm:1',
      network: 'asha-m-1',
      env: {},
      labels: { 'asha.module': 'x' },
      onStdout: () => undefined,
      onStderrLine: () => undefined,
    });
    created.module = launchedAt(interactive, 0).args;
    runtime.runAttached({
      name: `asha-egress-${HOME_ID}`,
      image: 'e:1',
      network: `asha-egress-${HOME_ID}`,
      env: {},
      labels: {},
      onStdout: () => undefined,
      onStderrLine: () => undefined,
    });
    created['egress proxy'] = launchedAt(interactive, 1).args;
    await runtime
      .pluginContainer({
        name: 'asha-plugin-1',
        image: 'p:1',
        network: 'asha-m-2',
        entrypoint: 'cli',
        args: [],
        env: {},
        labels: {},
      })
      .create(new AbortController().signal);
    created.plugin = callAt(runner, at).args;
    at = mark();
    const logDir = await mkdtemp(join(tmpdir(), 'asha-run-'));
    await runtime
      .oneShot({
        name: 'asha-erase-1',
        image: 'i:1',
        args: ['erase-user'],
        logFile: join(logDir, 'o.log'),
        archive: async function* () {
          await Promise.resolve();
          yield Buffer.from('t');
        },
        timeoutMs: 60_000,
        maxStdoutBytes: 64,
      })
      .run();
    created['one-shot'] = callAt(runner, at).args;
    at = mark();
    await runtime.createHolder({ name: 'asha-h', image: 'i:1', volume: 'v', labels: {} });
    created.holder = callAt(runner, at).args;
    at = mark();
    await runtime.rollback({ volume: 'v', image: 'i:1', folder: 'upload-0123456789abcdef' });
    created.rollback = callAt(runner, at).args;
    expect(Object.keys(created)).toEqual(['module', 'egress proxy', 'plugin', 'one-shot', 'holder', 'rollback']);
    for (const [kind, args] of Object.entries(created)) {
      expect(args.includes('create') || args.includes('run'), `${kind}: ${args.join(' ')}`).toBe(true);
      expect(
        args.filter(
          (a) => a === '--dns' || a === '--add-host' || a.startsWith('--dns=') || a.startsWith('--add-host='),
        ),
        `the ${kind} create`,
      ).toEqual([]);
    }
  });
});

describe("the module operations' answers, refusals and failures (docs/plans/extension-modules.md R5, R6, R30, R34)", () => {
  const BRIDGE = `ashae${HOME_ID}`;
  const PLUGIN = {
    name: 'asha-plugin-1',
    image: 'p:1',
    network: 'asha-m-2',
    entrypoint: 'cli',
    args: [],
    env: {},
    labels: {},
  };
  const DOCKER_OPTIONS = { timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } };
  const more = () => Promise.resolve('more' as const);
  /** The call's files, as one tar streamed in two chunks. */
  async function* tar(): AsyncIterable<Uint8Array> {
    await Promise.resolve();
    yield Buffer.from('plugin-');
    yield Buffer.from('tar');
  }

  it('a network create that fails names the network and its output; a removal tolerates only a network already gone', async () => {
    const runner = new FakeRunner()
      .on(
        'docker network create --driver bridge --internal',
        fail(1, 'Error response from daemon: network with name asha-m-1 already exists'),
      )
      .on('docker network rm gone', fail(1, 'Error response from daemon: network gone not found'))
      .on('docker network rm missing', fail(1, 'Error: No such network: missing'))
      .on(
        'docker network rm busy',
        fail(1, 'Error response from daemon: error while removing network: network busy has active endpoints\n'),
      );
    const { runtime } = await readyRuntime(runner);
    const created = await runtime
      .createNetwork({ name: 'asha-m-1', internal: true, labels: {} })
      .catch((e: unknown) => e);
    expect([created instanceof ContainerRuntimeError, (created as Error).message]).toEqual([
      true,
      'docker network create asha-m-1 failed:\n\nError response from daemon: network with name asha-m-1 already exists',
    ]);
    await expect(runtime.removeNetwork('gone')).resolves.toBeUndefined();
    await expect(runtime.removeNetwork('missing')).resolves.toBeUndefined();
    const busy = await runtime.removeNetwork('busy').catch((e: unknown) => e);
    expect([busy instanceof ContainerRuntimeError, (busy as Error).message]).toEqual([
      true,
      'docker network rm busy failed: Error response from daemon: error while removing network: network busy has active endpoints',
    ]);
    expect(runner.lines()).toEqual([
      `docker network create --driver bridge --internal --ipv6=false --label asha.home=${HOME_ID} asha-m-1`,
      'docker network rm gone',
      'docker network rm missing',
      'docker network rm busy',
    ]);
    for (const call of runner.calls) expect(call.options).toEqual(DOCKER_OPTIONS);
  });

  it("installs the egress bridge's rejects in one colima ssh bounded by 30 s, its script on stdin, logging egress.rules_ready with the count inserted; a script that reports no result fails naming the step (R6 (d))", async () => {
    const runner = new FakeRunner().on('colima ssh', ok('asha-egress: ready inserted=4\n'), ok('iptables: done\n'));
    const { runtime, logger } = setup(runner);
    await expect(runtime.installEgressRules(BRIDGE)).resolves.toBeUndefined();
    expect(runner.calls).toEqual([
      {
        command: 'colima',
        args: ['ssh', '--profile', 'default', '--', 'sudo', 'sh', '-s'],
        options: { timeoutMs: 30_000, stdin: egressRulesScript(HOME_ID, BRIDGE, 'install') },
      },
    ]);
    expect(logger.entries).toEqual([
      { level: 'info', event: 'egress.rules_ready', fields: { homeId: HOME_ID, bridge: BRIDGE, inserted: 4 } },
    ]);
    const error = await runtime.installEgressRules(BRIDGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect([(error as ContainerIsolationFailed).what, (error as Error).message]).toEqual([
      'egress rule install',
      'container isolation failed: egress rule install: the script did not report its result:\niptables: done',
    ]);
    expect(logger.entries).toHaveLength(1);
  });

  it('verifies the egress rejects with the verify script; a script that does not report them verified fails naming the step (R6 (d))', async () => {
    const runner = new FakeRunner().on(
      'colima ssh',
      ok('asha-egress: verified\n'),
      ok('asha-egress: ready inserted=0\n'),
    );
    const { runtime, logger } = setup(runner);
    await expect(runtime.verifyEgressRules(BRIDGE)).resolves.toBeUndefined();
    const error = await runtime.verifyEgressRules(BRIDGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerIsolationFailed);
    expect([(error as ContainerIsolationFailed).what, (error as Error).message]).toEqual([
      'egress rule verify',
      'container isolation failed: egress rule verify: the script did not report its result:\nasha-egress: ready inserted=0',
    ]);
    expect(runner.calls.map((c) => c.options)).toEqual([
      { timeoutMs: 30_000, stdin: egressRulesScript(HOME_ID, BRIDGE, 'verify') },
      { timeoutMs: 30_000, stdin: egressRulesScript(HOME_ID, BRIDGE, 'verify') },
    ]);
    expect(logger.entries).toEqual([]);
  });

  it("an attached container settles with its exit code, writes a line to its stdin, and is removed by docker rm --force then its stdin's end; a container already gone is no failure, any other is, its stdin left open (R5, R34)", async () => {
    const runner = new FakeRunner()
      .on('docker rm --force asha-mod-x', ok('asha-mod-x\n'))
      .on('docker rm --force asha-mod-y', fail(1, 'Error response from daemon: No such container: asha-mod-y\n'))
      .on('docker rm --force asha-mod-z', fail(1, 'Error response from daemon: permission denied\n'));
    const { runtime, interactive } = await readyRuntime(runner);
    const attach = (name: string) =>
      runtime.runAttached({
        name,
        image: 'm:1',
        network: 'asha-m-1',
        env: {},
        labels: {},
        onStdout: () => undefined,
        onStderrLine: () => undefined,
      });
    const x = attach('asha-mod-x');
    const child = launchedAt(interactive, 0);
    expect(x.write('{"id":1}\n')).toBe(true);
    expect(child.written).toEqual(['{"id":1}\n']);
    await x.remove();
    expect(child.ended).toBe(true);
    expect(x.write('{"id":2}\n')).toBe(false);
    child.exit(3);
    await expect(x.exited).resolves.toBe(3);

    const y = attach('asha-mod-y');
    await expect(y.remove()).resolves.toBeUndefined();
    expect(launchedAt(interactive, 1).ended).toBe(true);

    const z = attach('asha-mod-z');
    const error = await z.remove().catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'docker rm --force asha-mod-z failed: Error response from daemon: permission denied',
    ]);
    expect(launchedAt(interactive, 2).ended).toBe(false);
    expect(runner.lines()).toEqual([
      'docker rm --force asha-mod-x',
      'docker rm --force asha-mod-y',
      'docker rm --force asha-mod-z',
    ]);
    for (const call of runner.calls) expect(call.options).toEqual(DOCKER_OPTIONS);
  });

  it('a network connect, or the inspect after it, that fails, prints no JSON or shows no IPv4 address on the network throws naming the container and the network', async () => {
    const inspect = 'docker inspect --format {{json .NetworkSettings.Networks}}';
    const runner = new FakeRunner()
      .on(
        'docker network connect --alias a n refused',
        fail(1, 'Error response from daemon: container refused is not running\n'),
      )
      .on('docker network connect', ok())
      .on(`${inspect} uninspected`, fail(1, 'Error: No such object: uninspected\n'))
      .on(`${inspect} garbled`, ok('<no value>'))
      .on(`${inspect} elsewhere`, ok(JSON.stringify({ other: { IPAddress: '192.0.2.10' } })))
      .on(`${inspect} unaddressed`, ok(JSON.stringify({ n: { IPAddress: '' } })))
      .on(`${inspect} unlisted`, ok('null'));
    const { runtime } = await readyRuntime(runner);
    const failures: [string, string, unknown][] = [];
    for (const container of ['refused', 'uninspected', 'garbled', 'elsewhere', 'unaddressed', 'unlisted']) {
      const error = await runtime.connectNetwork('n', container, 'a').catch((e: unknown) => e);
      expect(error, container).toBeInstanceOf(ContainerRuntimeError);
      failures.push([container, (error as Error).message, (error as Error).cause]);
    }
    expect(failures).toEqual([
      [
        'refused',
        'docker network connect n refused failed:\nError response from daemon: container refused is not running',
        undefined,
      ],
      ['uninspected', 'docker inspect uninspected failed:\nError: No such object: uninspected', undefined],
      ['garbled', 'docker inspect garbled printed networks that are not JSON: <no value>', expect.any(SyntaxError)],
      ['elsewhere', 'elsewhere has no IPv4 address on n after connecting it', undefined],
      ['unaddressed', 'unaddressed has no IPv4 address on n after connecting it', undefined],
      ['unlisted', 'unlisted has no IPv4 address on n after connecting it', undefined],
    ]);
    // The refused connect inspects nothing.
    expect(runner.lines().filter((line) => line.endsWith(' refused'))).toEqual([
      'docker network connect --alias a n refused',
    ]);
  });

  it('a network disconnect is docker network disconnect --force; a container or network already gone, or one not connected, is no failure, any other is', async () => {
    const runner = new FakeRunner()
      .on('docker network disconnect --force n a', ok())
      .on('docker network disconnect --force n b', fail(1, 'Error response from daemon: No such container: b'))
      .on(
        'docker network disconnect --force n c',
        fail(1, 'Error response from daemon: container c is not connected to network n'),
      )
      .on('docker network disconnect --force gone d', fail(1, 'Error response from daemon: network gone not found'))
      .on('docker network disconnect --force n e', fail(1, 'Error response from daemon: permission denied\n'));
    const { runtime } = await readyRuntime(runner);
    for (const [network, container] of [
      ['n', 'a'],
      ['n', 'b'],
      ['n', 'c'],
      ['gone', 'd'],
    ] as const)
      await expect(runtime.disconnectNetwork(network, container), container).resolves.toBeUndefined();
    const error = await runtime.disconnectNetwork('n', 'e').catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'docker network disconnect n e failed: Error response from daemon: permission denied',
    ]);
    expect(runner.lines()).toEqual([
      'docker network disconnect --force n a',
      'docker network disconnect --force n b',
      'docker network disconnect --force n c',
      'docker network disconnect --force gone d',
      'docker network disconnect --force n e',
    ]);
    for (const call of runner.calls) expect(call.options).toEqual(DOCKER_OPTIONS);
  });

  it("a plugin container's copy in is one tar into / (-a), bounded by the smaller of its bound and 60 s: its exit status is data, its bound a timeout, its abort the caller's (R30)", async () => {
    const runner = new FakeRunner().on(
      'docker cp -a - asha-plugin-1:/',
      ok(''),
      fail(1, 'Error: no space left on device\n'),
      new CommandTimedOut('docker', ['cp', '-a', '-', 'asha-plugin-1:/'], 1),
      ok(''),
    );
    const { runtime } = await readyRuntime(runner);
    const plugin = runtime.pluginContainer(PLUGIN);
    const live = new AbortController().signal;
    expect(await plugin.copyIn(tar(), 5_000, live)).toEqual({ kind: 'exited', code: 0, stderr: '' });
    expect(present(runner.stdins.get(0), 'runner.stdins.get(0)').toString()).toBe('plugin-tar');
    expect(await plugin.copyIn(tar(), 90_000, live)).toEqual({
      kind: 'exited',
      code: 1,
      stderr: 'Error: no space left on device',
    });
    expect(await plugin.copyIn(tar(), 0, live)).toEqual({ kind: 'timeout' });
    const reason = new Error('the call passed its bound');
    expect(await plugin.copyIn(tar(), 5_000, abortedWith(reason)).catch((e: unknown) => e)).toBe(reason);
    expect(runner.lines()).toEqual(Array.from({ length: 4 }, () => 'docker cp -a - asha-plugin-1:/'));
    expect(runner.calls.map((c) => c.options)).toEqual([
      { timeoutMs: 5_000, env: { DOCKER_HOST: SOCKET } },
      { timeoutMs: 60_000, env: { DOCKER_HOST: SOCKET } },
      { timeoutMs: 1, env: { DOCKER_HOST: SOCKET } },
      { timeoutMs: 5_000, env: { DOCKER_HOST: SOCKET } },
    ]);
  });

  it("a plugin container's run past its bound is a timeout; its abort is the caller's (R30, R34)", async () => {
    const runner = new FakeRunner().on(
      'docker start --attach asha-plugin-1',
      new CommandTimedOut('docker', ['start', '--attach', 'asha-plugin-1'], 5_000),
      ok(''),
    );
    const { runtime } = await readyRuntime(runner);
    const plugin = runtime.pluginContainer(PLUGIN);
    expect(await plugin.run(5_000, 1024, new AbortController().signal)).toEqual({ kind: 'timeout' });
    const reason = new Error('the call passed its bound');
    expect(await plugin.run(0, 1024, abortedWith(reason)).catch((e: unknown) => e)).toBe(reason);
    expect(runner.calls.map((c) => [[c.command, ...c.args].join(' '), c.options.timeoutMs])).toEqual([
      ['docker start --attach asha-plugin-1', 5_000],
      ['docker start --attach asha-plugin-1', 1],
    ]);
  });

  it("a plugin container's copy out hands over each chunk, bounded by the smaller of its bound and 60 s; a reader's stop ends it well; a failed or timed-out copy is data; its abort is the caller's (R30)", async () => {
    const tarBytes = { code: 0, stdout: Buffer.from('0123456789'), stderr: '' };
    const runner = new FakeRunner().on(
      'docker cp asha-plugin-1:/out -',
      tarBytes,
      tarBytes,
      fail(1, 'Error response from daemon: Could not find the file /out in container asha-plugin-1\n'),
      new CommandTimedOut('docker', ['cp', 'asha-plugin-1:/out', '-'], 5_000),
      ok(''),
    );
    runner.streamChunk = 4;
    const { runtime } = await readyRuntime(runner);
    const plugin = runtime.pluginContainer(PLUGIN);
    const live = new AbortController().signal;
    const seen: string[] = [];
    expect(
      await plugin.copyOut(
        '/out',
        (chunk) => {
          seen.push(chunk.toString());
          return Promise.resolve('more');
        },
        90_000,
        live,
      ),
    ).toEqual({ ok: true });
    expect(seen).toEqual(['0123', '4567', '89']);
    const first: string[] = [];
    expect(
      await plugin.copyOut(
        '/out',
        (chunk) => {
          first.push(chunk.toString());
          return Promise.resolve('stop');
        },
        5_000,
        live,
      ),
    ).toEqual({ ok: true });
    expect(first).toEqual(['0123']);
    expect(await plugin.copyOut('/out', more, 5_000, live)).toEqual({
      ok: false,
      detail:
        'docker cp asha-plugin-1:/out - exited 1: Error response from daemon: Could not find the file /out in container asha-plugin-1',
    });
    expect(await plugin.copyOut('/out', more, 5_000, live)).toEqual({
      ok: false,
      detail: 'docker cp asha-plugin-1:/out - did not finish within 5000 ms',
    });
    const reason = new Error('the call passed its bound');
    expect(await plugin.copyOut('/out', more, 5_000, abortedWith(reason)).catch((e: unknown) => e)).toBe(reason);
    expect(runner.calls.map((c) => c.options.timeoutMs)).toEqual([60_000, 5_000, 5_000, 5_000, 5_000]);
  });

  it("a plugin container's removal is docker rm --force; a container already gone is no failure, any other is (R30)", async () => {
    const runner = new FakeRunner().on(
      'docker rm --force asha-plugin-1',
      ok('asha-plugin-1\n'),
      fail(1, 'Error response from daemon: No such container: asha-plugin-1\n'),
      fail(1, 'Error response from daemon: permission denied\n'),
    );
    const { runtime } = await readyRuntime(runner);
    const plugin = runtime.pluginContainer(PLUGIN);
    await expect(plugin.remove()).resolves.toBeUndefined();
    await expect(plugin.remove()).resolves.toBeUndefined();
    const error = await plugin.remove().catch((e: unknown) => e);
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'docker rm --force asha-plugin-1 failed: Error response from daemon: permission denied',
    ]);
    expect(runner.lines()).toEqual(Array.from({ length: 3 }, () => 'docker rm --force asha-plugin-1'));
    for (const call of runner.calls) expect(call.options).toEqual(DOCKER_OPTIONS);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The image prune (docs/plans/debt-paydown-2.md R1–R5, A1–A4; debt D27).

const HOUR = 3_600_000;
/** 64 hex naming version n of a fixture: `ddd…d<n in hex>`. */
const vhex = (n: number) => n.toString(16).padStart(64, 'd');
/** A version `hoursAgo` before NOW, labelled as asha labels it unless `source` says otherwise. */
const version = (repository: string, n: number, hoursAgo: number, over: Partial<ImageVersion> = {}): ImageVersion => ({
  repository,
  tag: vhex(n),
  id: `sha256:${n.toString(16).padStart(64, 'e')}`,
  created: NOW.getTime() - hoursAgo * HOUR,
  source: `sha256:${vhex(n)}`,
  ...over,
});
const ref = (v: ImageVersion) => `${v.repository}:${v.tag}`;

describe('selectPrunable: the versions an image prune removes (debt-paydown-2 R2, A1)', () => {
  const A = 'asha-image-probedp2a';
  const B = 'asha-image-probedp2b';
  const BASE = 'asha-harness-probedp2-base';
  const MOD = 'asha-module-probedp2';
  const OTHER = 'probedp2-other';
  // Probe Q1 (b)'s fourteen versions, as data.
  const Q1B = [
    version(A, 1, 72), // removed: old, unused, not newest
    version(A, 2, 60), // kept: a stopped container names it by tag (its image id is in use)
    version(A, 3, 58), // kept: a stopped container names it by image id
    version(A, 4, 48, { source: `sha256:${vhex(99)}` }), // kept: its asha.source label does not match its tag
    version(A, 5, 30), // removed
    version(A, 6, 20), // kept: under 24 h
    version(A, 7, 2), // kept: the newest
    version(B, 8, 72), // kept: the only (newest) version of its repository
    version(OTHER, 9, 72), // kept: not an asha repository
    version(OTHER, 10, 1), // kept: not an asha repository
    version(BASE, 11, 71), // removed: an old base version
    version(BASE, 12, 1), // kept: the newest
    version(MOD, 13, 70), // removed: an old module version
    version(MOD, 14, 1), // kept: the newest
  ];
  const Q1B_USED = new Set([version(A, 2, 60).id, version(A, 3, 58).id]);

  /** Fails naming each version wrongly selected (by its fixture's note), then checks the exact selection and order. */
  const expectSelected = (
    images: readonly ImageVersion[],
    notes: ReadonlyMap<ImageVersion, string>,
    used: ReadonlySet<string>,
    expected: readonly ImageVersion[],
  ) => {
    const selected = selectPrunable(images, used, NOW.getTime());
    const wrong = selected.filter((v) => !expected.includes(v)).map((v) => `${notes.get(v) ?? '?'}: ${ref(v)}`);
    const missed = expected.filter((v) => !selected.includes(v)).map((v) => `${notes.get(v) ?? '?'}: ${ref(v)}`);
    expect(wrong.join('; '), 'versions wrongly selected').toBe('');
    expect(missed.join('; '), 'versions wrongly kept').toBe('');
    expect(selected.map(ref)).toEqual(expected.map(ref));
  };
  const Q1B_LABELS = [
    'removed',
    'used by tag (f)',
    'used by id (f)',
    'label of another digest (c)',
    'removed',
    'under 24 h (e)',
    'newest (d)',
    'lone version (d)',
    'non-asha (a)',
    'non-asha (a)',
    'removed',
    'newest (d)',
    'removed',
    'newest (d)',
  ];
  const Q1B_NOTES = new Map(Q1B.map((v, i) => [v, present(Q1B_LABELS[i], `Q1B_LABELS[${String(i)}]`)]));

  it("selects exactly Q1 (b)'s four removals, the oldest first", () => {
    expectSelected(Q1B, Q1B_NOTES, Q1B_USED, [
      present(Q1B[0], 'Q1B[0]'),
      present(Q1B[10], 'Q1B[10]'),
      present(Q1B[12], 'Q1B[12]'),
      present(Q1B[4], 'Q1B[4]'),
    ]);
  });

  it('keeps, each by exactly one clause: a non-asha repository (a), a :latest or upper-case tag (b), a label of another digest (c), the newest and every version tied with it, and a lone version (d), a version exactly 24 h old (e), one a container uses by id (f); removes one 24 h and 1 ms old', () => {
    const C = 'asha-plugin-ties';
    const D = 'asha-image-edge';
    const images = [
      version(OTHER, 21, 72), // (a) only
      version(OTHER, 22, 1),
      version(A, 23, 72, { tag: 'latest', source: 'sha256:latest' }), // (b) only
      version(A, 24, 72, { tag: 'A'.repeat(64), source: `sha256:${'A'.repeat(64)}` }), // (b) only
      version(A, 25, 72, { source: `sha256:${vhex(26)}` }), // (c) only
      version(A, 27, 1), // A's newest
      version(C, 28, 30), // (d) only: tied newest
      version(C, 29, 30), // (d) only: tied newest
      version(B, 30, 72), // (d) only: a lone version
      { ...version(D, 31, 0), created: NOW.getTime() - 86_400_000 }, // (e) only: exactly 24 h
      { ...version(D, 32, 0), created: NOW.getTime() - 86_400_001 }, // removed: 24 h and 1 ms
      version(D, 33, 72), // (f) only: a container uses it by id
      version(D, 34, 1), // D's newest
    ];
    const used = new Set([version(D, 33, 72).id]);
    const labels = [
      'non-asha repository (a)',
      'non-asha newest',
      ':latest tag (b)',
      'upper-case tag (b)',
      'label of another digest (c)',
      'A newest',
      'tied newest (d)',
      'tied newest (d)',
      'lone version (d)',
      'exactly 24 h old (e)',
      '24 h and 1 ms old',
      'used by a container by id (f)',
      'D newest',
    ];
    const notes = new Map(images.map((v, i) => [v, present(labels[i], `labels[${String(i)}]`)]));
    expectSelected(images, notes, used, [present(images[10], 'images[10]')]);
  });

  it('selects nothing from no versions, and is a pure function of its arguments (the input is not reordered)', () => {
    expect(selectPrunable([], new Set(), NOW.getTime())).toEqual([]);
    const copy = [...Q1B];
    selectPrunable(copy, Q1B_USED, NOW.getTime());
    expect(copy).toEqual(Q1B);
  });
});

/** `docker image ls --format '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}'` of these versions, as UTC. */
const listing = (versions: readonly ImageVersion[]) =>
  versions
    .map((v) => {
      const iso = new Date(v.created).toISOString();
      return `${v.repository}\t${v.tag}\t${v.id}\t${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000 UTC`;
    })
    .join('\n') + '\n';
/** `docker image inspect --format '{{.Id}}\t{{.Created}}\t{{json .Config.Labels}}'` of these versions. */
const inspection = (versions: readonly ImageVersion[]) =>
  versions
    .map((v) => `${v.id}\t${new Date(v.created).toISOString()}\t${JSON.stringify({ 'asha.source': v.source })}`)
    .join('\n') + '\n';
const LIST_CMD = [
  'docker',
  'image',
  'ls',
  '--no-trunc',
  '--filter',
  'reference=asha-*',
  '--format',
  '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}',
];
const INSPECT_CMD = ['docker', 'image', 'inspect', '--format', '{{.Id}}\t{{.Created}}\t{{json .Config.Labels}}'];
const PRUNE_SSH = ['colima', 'ssh', '--profile', 'default', '--', 'sudo', 'sh', '-c', PRUNE_LOCK_SCRIPT];
/** Docker's own words for each tag it removes. */
const untagged = (tags: readonly string[]) =>
  tags.map((t) => `Untagged: ${t}\nDeleted: sha256:${'f'.repeat(64)}`).join('\n') + '\n';

describe('ColimaRuntime.pruneImages (debt-paydown-2 R1–R4, A2)', () => {
  const R = 'asha-image-hello-world';
  const old1 = version(R, 1, 72);
  const old2 = version(R, 2, 48);
  const used = version(R, 3, 40);
  const young = version(R, 4, 10);
  const newest = version(R, 5, 1);
  const other = version('asha-harness-module-base', 6, 1);

  /** A runner that answers a whole prune: status, the session, the listing, two containers, the inspect and the rm. */
  function pruneRunner(rmAnswers: ReturnType<typeof ok>[] = [ok(untagged([ref(old1), ref(old2)]))]) {
    return new LockingRunner()
      .on('colima status', ok(STATUS))
      .on('docker image ls', ok(listing([old1, old2, used, young, newest, other])))
      .on('docker ps', ok('c1\nc2\n'))
      .on('docker container inspect', ok(`${used.id}\nsha256:${'0'.repeat(64)}\n`))
      .on('docker image inspect', ok(inspection([newest, old1, old2, used])))
      .on('docker image rm', ...rmAnswers);
  }

  it("runs exactly: colima status, R3's prune script in one session, the filtered listing, docker ps, docker container inspect, docker image inspect of the candidates only, docker image rm; then closes the session and logs image.pruned with exactly removed, kept and ms", async () => {
    const runner = pruneRunner();
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(PRUNE_LOCK_SCRIPT).toBe(
      'exec 8>/run/asha-images.lock; flock -x -n 8 || { echo busy; exit 5; }; echo locked; read _ || true',
    );
    expect(runner.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['colima', 'status', '--profile', 'default', '--json'],
      PRUNE_SSH,
      LIST_CMD,
      ['docker', 'ps', '--all', '--quiet', '--no-trunc'],
      ['docker', 'container', 'inspect', '--format', '{{.Image}}', 'c1', 'c2'],
      // The newest of the repository with old versions, and its versions listed more than 24 h and 1 s old: not the
      // young one, nor the other repository's lone newest.
      [...INSPECT_CMD, ref(newest), ref(old1), ref(old2), ref(used)],
      ['docker', 'image', 'rm', ref(old1), ref(old2)],
    ]);
    // Every command bounded by the time left of the prune's 10 s, docker pointed at colima's socket.
    for (const call of runner.calls) expect(call.options.timeoutMs, call.args.join(' ')).toBeLessThanOrEqual(10_000);
    for (const call of runner.calls.filter((c) => c.command === 'docker'))
      expect(call.options.env).toEqual({ DOCKER_HOST: SOCKET });
    expect(runner.locks.events).toEqual([`take ${IMAGES_LOCK_FILE}`, `release ${IMAGES_LOCK_FILE}`]);
    expect(logger.entries).toEqual([
      {
        level: 'info',
        event: 'image.pruned',
        fields: { removed: [ref(old1), ref(old2)], kept: 4, ms: expect.any(Number) as number },
      },
    ]);
    expect(Object.keys(entryAt(logger, 0).fields)).toEqual(['removed', 'kept', 'ms']);
  });

  it('a build holding the images lock: busy, no other command, image.prune_skipped "a build holds the image lock"', async () => {
    const runner = pruneRunner();
    runner.locks.shared = 1;
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(runner.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['colima', 'status', '--profile', 'default', '--json'],
      PRUNE_SSH,
    ]);
    expect(runner.locks.events).toEqual([`busy ${IMAGES_LOCK_FILE}`]);
    expect(logger.entries).toEqual([
      { level: 'info', event: 'image.prune_skipped', fields: { reason: 'a build holds the image lock' } },
    ]);
  });

  it('colima not running, or not installed: no ssh, image.prune_skipped naming why', async () => {
    const stopped = new LockingRunner().on('colima status', fail(1, 'colima is not running'));
    const a = setup(stopped);
    await a.runtime.pruneImages();
    expect(stopped.lines()).toEqual(['colima status --profile default --json']);
    expect(a.logger.entries).toEqual([
      { level: 'info', event: 'image.prune_skipped', fields: { reason: 'colima profile default is not running' } },
    ]);
    const absent = new LockingRunner().on('colima status', 'not-found');
    const b = setup(absent);
    await b.runtime.pruneImages();
    expect(absent.lines()).toEqual(['colima status --profile default --json']);
    expect(b.logger.entries).toEqual([
      { level: 'info', event: 'image.prune_skipped', fields: { reason: 'colima is not installed' } },
    ]);
  });

  it('nothing old: the listing only, nothing inspected or removed, image.pruned with removed [] and every version kept', async () => {
    const runner = new LockingRunner()
      .on('colima status', ok(STATUS))
      .on('docker image ls', ok(listing([young, newest, other])));
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(runner.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['colima', 'status', '--profile', 'default', '--json'],
      PRUNE_SSH,
      LIST_CMD,
    ]);
    expect(logger.entries).toEqual([
      { level: 'info', event: 'image.pruned', fields: { removed: [], kept: 3, ms: expect.any(Number) as number } },
    ]);
  });

  it("one tag refused by Docker (a container created since the listing): image.prune_refused naming it with Docker's message, the rest removed", async () => {
    const conflict = `Error response from daemon: conflict: unable to delete ${ref(old2)} (must be forced) - container 4ee4dc956f92 is using its referenced image 8a67c8c79805`;
    const runner = pruneRunner([{ code: 1, stdout: untagged([ref(old1)]), stderr: `${conflict}\n` }]);
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(logger.entries).toEqual([
      { level: 'warn', event: 'image.prune_refused', fields: { tag: ref(old2), message: conflict } },
      {
        level: 'info',
        event: 'image.pruned',
        fields: { removed: [ref(old1)], kept: 5, ms: expect.any(Number) as number },
      },
    ]);
  });

  it('a docker image rm failing otherwise: image.prune_failed with the error and the tags removed before it; the session closed', async () => {
    const runner = pruneRunner([
      { code: 1, stdout: untagged([ref(old1)]), stderr: 'Error response from daemon: some other failure\n' },
    ]);
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(logger.entries.map((e) => [e.level, e.event, e.fields['removed']])).toEqual([
      ['error', 'image.prune_failed', [ref(old1)]],
    ]);
    expect((entryAt(logger, 0).fields['error'] as Error).message).toContain('some other failure');
    expect(runner.locks.events).toEqual([`take ${IMAGES_LOCK_FILE}`, `release ${IMAGES_LOCK_FILE}`]);
  });

  it('a container removed since docker ps (Docker: "No such container: <listed id>") uses no image, and the prune goes on; any other inspect failure fails it', async () => {
    const gone = new LockingRunner()
      .on('colima status', ok(STATUS))
      .on('docker image ls', ok(listing([old1, old2, used, young, newest, other])))
      .on('docker ps', ok('c1\nc2\n'))
      .on('docker container inspect', {
        code: 1,
        stdout: `${used.id}\n`,
        stderr: 'Error response from daemon: No such container: c2\n',
      })
      .on('docker image inspect', ok(inspection([newest, old1, old2, used])))
      .on('docker image rm', ok(untagged([ref(old1), ref(old2)])));
    const a = setup(gone);
    await a.runtime.pruneImages();
    expect(a.logger.entries).toEqual([
      {
        level: 'info',
        event: 'image.pruned',
        fields: { removed: [ref(old1), ref(old2)], kept: 4, ms: expect.any(Number) as number },
      },
    ]);
    for (const stderr of [
      'Error response from daemon: No such container: c9\n',
      'Error response from daemon: Cannot connect\n',
      '',
    ]) {
      const broken = new LockingRunner()
        .on('colima status', ok(STATUS))
        .on('docker image ls', ok(listing([old1, newest])))
        .on('docker ps', ok('c1\nc2\n'))
        .on('docker container inspect', { code: 1, stdout: '', stderr });
      const b = setup(broken);
      await b.runtime.pruneImages();
      expect(
        b.logger.entries.map((e) => [e.level, e.event]),
        JSON.stringify(stderr),
      ).toEqual([['error', 'image.prune_failed']]);
      expect((entryAt(b.logger, 0).fields['error'] as Error).message).toContain(
        'docker container inspect of 2 container(s) failed',
      );
    }
  });

  it('the session ending non-zero after the removal, a "busy" that does not exit 5, and an rm that exits 0 without untagging a tag each fail the prune (review finding 1)', async () => {
    // The session fails after the work: the removal stands, the prune is a failure naming the session.
    const late = pruneRunner();
    const stream = late.stream.bind(late);
    late.stream = async (command, args, options) => {
      const result = await stream(command, args, options);
      return args.includes(PRUNE_LOCK_SCRIPT) ? colimaExit(255) : result;
    };
    const a = setup(late);
    await a.runtime.pruneImages();
    expect(a.logger.entries.map((e) => [e.level, e.event, e.fields['removed']])).toEqual([
      ['error', 'image.prune_failed', [ref(old1), ref(old2)]],
    ]);
    expect((entryAt(a.logger, 0).fields['error'] as Error).message).toContain(
      "the image prune's lock session exited 255",
    );
    // "busy" printed, but the session ended otherwise than flock's exit 5: a failure, not a skip.
    const odd = pruneRunner();
    odd.locks.shared = 1;
    const oddStream = odd.stream.bind(odd);
    odd.stream = async (command, args, options) => {
      const result = await oddStream(command, args, options);
      return args.includes(PRUNE_LOCK_SCRIPT) ? colimaExit(3) : result;
    };
    const b = setup(odd);
    await b.runtime.pruneImages();
    expect(b.logger.entries.map((e) => [e.level, e.event])).toEqual([['error', 'image.prune_failed']]);
    // docker image rm exits 0 but untags only one of two.
    const quiet = pruneRunner([ok(untagged([ref(old1)]))]);
    const c = setup(quiet);
    await c.runtime.pruneImages();
    expect(c.logger.entries.map((e) => [e.level, e.event, e.fields['removed']])).toEqual([
      ['error', 'image.prune_failed', [ref(old1)]],
    ]);
    expect((entryAt(c.logger, 0).fields['error'] as Error).message).toBe(
      `docker image rm exited 0 and did not report removing ${ref(old2)}`,
    );
  });

  it("a refusal naming a tag outside the call is not a refusal of it; a command killed at the time left is logged reason 'timeout' (review findings 15, 10)", async () => {
    const stray = pruneRunner([
      {
        code: 1,
        stdout: untagged([ref(old1), ref(old2)]),
        stderr:
          'Error response from daemon: conflict: unable to delete asha-image-other:x (must be forced) - container 1 is using its referenced image 2\n',
      },
    ]);
    const a = setup(stray);
    await a.runtime.pruneImages();
    expect(a.logger.entries.map((e) => [e.level, e.event])).toEqual([['error', 'image.prune_failed']]);
    const slow = new LockingRunner()
      .on('colima status', ok(STATUS))
      .on('docker image ls', new CommandTimedOut('docker', ['image', 'ls'], 9_000));
    const b = setup(slow);
    await b.runtime.pruneImages();
    expect(b.logger.entries.map((e) => [e.level, e.event, e.fields['reason']])).toEqual([
      ['error', 'image.prune_failed', 'timeout'],
    ]);
  });

  it("inspects no version listed 24 h and 1 s old or less (the listing's one-second margin, R2), and pruneRepository narrows what is considered (A6's test-only property)", async () => {
    const edge = { ...version(R, 7, 0), created: NOW.getTime() - 86_401_000 };
    const runner = new LockingRunner()
      .on('colima status', ok(STATUS))
      .on('docker image ls', ok(listing([edge, newest])));
    const a = setup(runner);
    await a.runtime.pruneImages();
    expect(runner.calls.map((c) => c.args[0])).toEqual(['status', 'ssh', 'image']);
    expect(present(a.logger.entries.at(-1), 'a.logger.entries.at(-1)').fields['removed']).toEqual([]);
    // Only the scoped repository is considered: the other's old version is neither inspected nor removed.
    const scoped = pruneRunner([ok(untagged([ref(old1), ref(old2)]))]);
    const logger = new RecordingLogger();
    const otherOld = version('asha-image-other', 8, 72);
    scoped.on(
      'docker image ls',
      ok(listing([old1, old2, used, young, newest, otherOld, version('asha-image-other', 9, 1)])),
    );
    const runtime = new ColimaRuntime({
      runner: scoped,
      launcher: new FakeLauncher(),
      interactive: new FakeInteractive(),
      logger,
      profile: 'default',
      homeId: HOME_ID,
      clock: () => NOW,
      pruneRepository: new RegExp(`^${R}$`),
    });
    await runtime.pruneImages();
    const inspected = present(
      scoped.calls.find((c) => c.args[0] === 'image' && c.args[1] === 'inspect'),
      "scoped.calls.find('image inspect')",
    ).args;
    expect(inspected.some((a) => a.startsWith('asha-image-other:'))).toBe(false);
    expect(logger.entries.at(-1)).toEqual({
      level: 'info',
      event: 'image.pruned',
      fields: { removed: [ref(old1), ref(old2)], kept: 3, ms: expect.any(Number) as number },
    });
  });

  it('a listing exiting 1: image.prune_failed naming it, nothing removed, the session closed', async () => {
    const runner = new LockingRunner()
      .on('colima status', ok(STATUS))
      .on('docker image ls', fail(1, 'Cannot connect to the Docker daemon'));
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(runner.calls.map((c) => c.args[0])).toEqual(['status', 'ssh', 'image']);
    expect(logger.entries.map((e) => [e.level, e.event, e.fields['removed']])).toEqual([
      ['error', 'image.prune_failed', []],
    ]);
    expect((entryAt(logger, 0).fields['error'] as Error).message).toContain('docker image ls failed:');
    expect(runner.locks.events).toEqual([`take ${IMAGES_LOCK_FILE}`, `release ${IMAGES_LOCK_FILE}`]);
  });

  it('a listing line it cannot read fails the prune, never read as no versions', async () => {
    const runner = new LockingRunner().on('colima status', ok(STATUS)).on('docker image ls', ok('asha-image-x\tabc\n'));
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(logger.entries.map((e) => e.event)).toEqual(['image.prune_failed']);
    expect((entryAt(logger, 0).fields['error'] as Error).message).toContain(
      'docker image ls printed a line the prune cannot read',
    );
  });

  it('a session that ends before "locked" (not "busy"): image.prune_failed, nothing listed', async () => {
    const runner = pruneRunner();
    runner.pruneAnswer = 255;
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(runner.calls.map((c) => c.args[0])).toEqual(['status', 'ssh']);
    expect(logger.entries.map((e) => e.event)).toEqual(['image.prune_failed']);
    expect((entryAt(logger, 0).fields['error'] as Error).message).toBe(
      `the image prune's lock session ended before "locked": colima ssh exited 255: ${colimaExit(255).stderr.trimEnd()}`,
    );
  });

  it('a session that fails before "locked" (colima itself could not run): image.prune_failed naming it, the failure its cause, nothing listed', async () => {
    const runner = pruneRunner();
    const spawn = new Error('spawn colima EAGAIN');
    const stream = runner.stream.bind(runner);
    runner.stream = (command, args, options) => {
      if (!args.includes(PRUNE_LOCK_SCRIPT)) return stream(command, args, options);
      runner.calls.push({ command, args, options: { timeoutMs: options.timeoutMs } });
      return Promise.reject(spawn);
    };
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(runner.calls.map((c) => [c.command, ...c.args])).toEqual([
      ['colima', 'status', '--profile', 'default', '--json'],
      PRUNE_SSH,
    ]);
    expect(logger.entries.map((e) => [e.level, e.event, Object.keys(e.fields), e.fields['removed']])).toEqual([
      ['error', 'image.prune_failed', ['removed', 'error'], []],
    ]);
    const error = entryAt(logger, 0).fields['error'] as Error;
    expect([error instanceof ContainerRuntimeError, error.message, error.cause]).toEqual([
      true,
      `the image prune's lock session ended before "locked": colima ssh failed: spawn colima EAGAIN`,
      spawn,
    ]);
  });

  it('a docker image inspect of the candidates that fails: image.prune_failed naming it and how many it inspected, nothing removed, the session closed', async () => {
    const runner = new LockingRunner()
      .on('colima status', ok(STATUS))
      .on('docker image ls', ok(listing([old1, old2, used, young, newest, other])))
      .on('docker ps', ok(''))
      .on('docker image inspect', fail(1, `Error response from daemon: No such image: ${ref(old2)}\n`));
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(runner.calls.map((c) => [c.command, ...c.args]).slice(2)).toEqual([
      LIST_CMD,
      ['docker', 'ps', '--all', '--quiet', '--no-trunc'],
      [...INSPECT_CMD, ref(newest), ref(old1), ref(old2), ref(used)],
    ]);
    expect(logger.entries.map((e) => [e.level, e.event, e.fields['removed']])).toEqual([
      ['error', 'image.prune_failed', []],
    ]);
    expect((entryAt(logger, 0).fields['error'] as Error).message).toBe(
      `docker image inspect of 4 version(s) failed:\nError response from daemon: No such image: ${ref(old2)}`,
    );
    expect(runner.locks.events).toEqual([`take ${IMAGES_LOCK_FILE}`, `release ${IMAGES_LOCK_FILE}`]);
  });

  it("the work failing and then the session failing as it closes: image.prune_failed naming both, the work's failure its cause", async () => {
    const runner = new LockingRunner()
      .on('colima status', ok(STATUS))
      .on('docker image ls', fail(1, 'Cannot connect to the Docker daemon'));
    const stream = runner.stream.bind(runner);
    runner.stream = async (command, args, options) => {
      const result = await stream(command, args, options);
      return args.includes(PRUNE_LOCK_SCRIPT) ? colimaExit(255) : result;
    };
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(logger.entries.map((e) => [e.level, e.event, e.fields['removed']])).toEqual([
      ['error', 'image.prune_failed', []],
    ]);
    const error = entryAt(logger, 0).fields['error'] as Error;
    expect([error instanceof ContainerRuntimeError, error.message, (error.cause as Error).message]).toEqual([
      true,
      `docker image ls failed:\n\nCannot connect to the Docker daemon; and the image prune's lock session exited 255: ${colimaExit(255).stderr.trimEnd()}`,
      'docker image ls failed:\n\nCannot connect to the Docker daemon',
    ]);
    expect(runner.locks.events).toEqual([`take ${IMAGES_LOCK_FILE}`, `release ${IMAGES_LOCK_FILE}`]);
  });

  it('a runner that never answers: at 10,000 ms the session is killed (the lock released), image.prune_failed reason timeout with the tags removed so far', async () => {
    const runner = pruneRunner();
    const run = runner.run.bind(runner);
    // The listing never answers.
    runner.run = (command, args, options) =>
      args[1] === 'ls' ? new Promise(() => undefined) : run(command, args, options);
    const { runtime, logger } = setup(runner);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const pruned = runtime.pruneImages();
      await vi.advanceTimersByTimeAsync(9_999);
      expect(logger.entries).toEqual([]);
      expect(runner.locks.events).toEqual([`take ${IMAGES_LOCK_FILE}`]);
      await vi.advanceTimersByTimeAsync(1);
      await pruned;
      expect(logger.entries.map((e) => [e.level, e.event, e.fields['reason'], e.fields['removed']])).toEqual([
        ['error', 'image.prune_failed', 'timeout', []],
      ]);
      expect(runner.locks.events).toEqual([`take ${IMAGES_LOCK_FILE}`, `release ${IMAGES_LOCK_FILE}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes at most 50 per start, the oldest first, in calls of at most 20 tags', async () => {
    const many = Array.from({ length: 55 }, (_, n) => version(R, 100 + n, 100 - n));
    const newest55 = version(R, 99, 1);
    const all = [...many, newest55];
    const runner = new LockingRunner()
      .on('colima status', ok(STATUS))
      .on('docker image ls', ok(listing(all)))
      .on('docker ps', ok(''))
      .on('docker image inspect', ok(inspection([newest55, ...many])));
    const rmBatches: string[][] = [];
    const run = runner.run.bind(runner);
    runner.run = async (command, args, options) => {
      if (args[1] !== 'rm') return run(command, args, options);
      runner.calls.push({ command, args, options });
      rmBatches.push(args.slice(2));
      return ok(untagged(args.slice(2)));
    };
    const { runtime, logger } = setup(runner);
    await runtime.pruneImages();
    expect(rmBatches.map((b) => b.length)).toEqual([20, 20, 10]);
    expect(rmBatches.flat()).toEqual(many.slice(0, 50).map(ref));
    // No containers: no container inspect.
    expect(runner.calls.some((c) => c.args[0] === 'container')).toBe(false);
    const last = present(logger.entries.at(-1), 'logger.entries.at(-1)');
    expect(last.fields['removed']).toEqual(many.slice(0, 50).map(ref));
    expect(last.fields['kept']).toBe(6);
  });

  it("never beside a build: a prune finds a build's shared lock busy; a build waits for a prune's exclusive lock, then builds (R3)", async () => {
    const locks = new VmLocks();
    // A prune holding the lock: its listing held until the build has asked for its lock.
    let listed!: () => void;
    const listingHeld = new Promise<void>((resolve) => (listed = resolve));
    const pruner = new LockingRunner(locks).on('colima status', ok(STATUS)).on('docker image ls', ok(''));
    const pruneRun = pruner.run.bind(pruner);
    pruner.run = async (command, args, options) => {
      if (args[1] === 'ls') await listingHeld;
      return pruneRun(command, args, options);
    };
    const builder = new LockingRunner(locks)
      .on(
        'docker image inspect',
        fail(1, 'No such image'),
        fail(1, 'No such image'),
        ok(JSON.stringify({ 'asha.source': DIGEST_A })),
      )
      .on('docker build', ok());
    const prune = setup(pruner);
    const build = await readyRuntime(builder);
    const pruned = prune.runtime.pruneImages();
    await vi.waitFor(() => {
      expect(locks.events).toEqual([`take ${IMAGES_LOCK_FILE}`]);
    });
    const built = build.runtime.ensureImage({
      repository: 'img',
      contextDir: '/ctx',
      sourceDigest: DIGEST_A,
      labels: {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    // The build's session is open and waiting: it has not shared the lock, nor built.
    expect(builder.calls.map((c) => c.args[0])).toEqual(['image', 'ssh']);
    listed();
    await pruned;
    await built;
    expect(locks.events).toEqual([
      `take ${IMAGES_LOCK_FILE}`,
      `release ${IMAGES_LOCK_FILE}`,
      `share ${IMAGES_LOCK_FILE}`,
      `take ${imageLockFile('a'.repeat(64))}`,
      `release ${imageLockFile('a'.repeat(64))}`,
      `unshare ${IMAGES_LOCK_FILE}`,
    ]);
    // And a prune while a build holds it shared: busy.
    let finish!: () => void;
    const holding = new Promise<void>((resolve) => (finish = resolve));
    const builder2 = new LockingRunner(locks).on(
      'docker image inspect',
      fail(1, 'No such image'),
      fail(1, 'No such image'),
      ok(JSON.stringify({ 'asha.source': DIGEST_B })),
    );
    const run2 = builder2.run.bind(builder2);
    builder2.run = async (command, args, options) => {
      if (args[0] === 'build') {
        await holding;
        return ok();
      }
      return run2(command, args, options);
    };
    const build2 = await readyRuntime(builder2);
    const second = build2.runtime.ensureImage({
      repository: 'img',
      contextDir: '/ctx',
      sourceDigest: DIGEST_B,
      labels: {},
    });
    await vi.waitFor(() => {
      expect(locks.shared).toBe(1);
    });
    const pruner2 = new LockingRunner(locks).on('colima status', ok(STATUS));
    const p2 = setup(pruner2);
    await p2.runtime.pruneImages();
    expect(p2.logger.entries).toEqual([
      { level: 'info', event: 'image.prune_skipped', fields: { reason: 'a build holds the image lock' } },
    ]);
    finish();
    await second;
  });
});

describe("the prune's parsers throw on what they cannot read, never reading it as no versions (debt-paydown-2 R2)", () => {
  const ID = `sha256:${'1'.repeat(64)}`;
  const refs = [
    { repository: 'asha-image-x', tag: vhex(1) },
    { repository: 'asha-image-x', tag: vhex(2) },
  ];

  it('parseImageListing: a row whose time has the shape but is no date', () => {
    const line = `asha-image-x\t${vhex(1)}\t${ID}\t2026-13-45 25:61:61 +0000 UTC`;
    const error = thrownBy(() => parseImageListing(`${line}\n`));
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      `docker image ls printed a time the prune cannot read: ${JSON.stringify(line)}`,
    ]);
  });

  it('parseImageInspect: another count of lines than versions asked for', () => {
    const error = thrownBy(() => parseImageInspect(`${ID}\t2026-10-01T00:00:00Z\tnull\n`, refs));
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      'docker image inspect of 2 version(s) printed 1 line(s)',
    ]);
  });

  it('parseImageInspect: labels that are not JSON, with the parse error as the cause', () => {
    const bad = `${ID}\t2026-10-01T00:00:00Z\t{"asha.source":`;
    const error = thrownBy(() => parseImageInspect(`${ID}\t2026-10-01T00:00:00Z\tnull\n${bad}\n`, refs));
    expect([error instanceof ContainerRuntimeError, (error as Error).message, (error as Error).cause]).toEqual([
      true,
      `docker image inspect printed labels that are not JSON: ${JSON.stringify(bad)}`,
      expect.any(SyntaxError),
    ]);
  });

  it.each([
    ['a line of another shape', 'not an inspect line'],
    ['a created time that is no date', `${ID}\tyesterday\t{}`],
    ['labels that are a list', `${ID}\t2026-10-01T00:00:00Z\t["asha.source"]`],
    ['labels that are a string', `${ID}\t2026-10-01T00:00:00Z\t"asha.source"`],
  ])('parseImageInspect: %s', (_label, bad) => {
    const error = thrownBy(() => parseImageInspect(`${bad}\n${ID}\t2026-10-01T00:00:00Z\tnull\n`, refs));
    expect([error instanceof ContainerRuntimeError, (error as Error).message]).toEqual([
      true,
      `docker image inspect printed a line the prune cannot read: ${JSON.stringify(bad)}`,
    ]);
  });
});

describe("remoteExitStatus: the VM command's status as colima ssh reports it (probe Q4)", () => {
  it('reads the status colima names on stderr when it exits 1; any other exit is itself; exit 1 without the line is 1', () => {
    for (const status of [0, 1, 4, 5, 6, 255])
      expect(remoteExitStatus(colimaExit(status)), `status ${String(status)}`).toBe(status);
    expect(remoteExitStatus({ code: 1, stderr: 'ssh: connect to host 127.0.0.1 port 50123: Connection refused' })).toBe(
      1,
    );
    expect(remoteExitStatus({ code: 255, stderr: 'level=fatal msg="exit status 5"' })).toBe(255);
  });
});

describe('a removed tag stays local: --pull never and ImageGone (debt-paydown-2 R5, A4)', () => {
  const GONE = `Error response from daemon: No such image: img`;

  it('every create or run of an ensured tag carries --pull never: start, one-shot, runAttached (module, egress proxy), pluginContainer, holder, rollback', async () => {
    const runner = new FakeRunner()
      .on('docker create', ok(''))
      .on('docker run', ok(''))
      .on('docker cp', ok(''))
      .on('docker start', ok(''))
      .on('docker rm', ok(''));
    const { runtime, interactive } = await readyRuntime(runner);
    const sites: Record<string, readonly string[]> = {};
    runtime.start({
      name: 'asha-x',
      image: 'i:1',
      env: {},
      logFile: join(await mkdtemp(join(tmpdir(), 'asha-pull-')), 'a.log'),
      files: [],
      channelVolume: 'v',
    });
    await vi.waitFor(() => {
      expect(runner.calls.length).toBeGreaterThan(0);
    });
    sites.start = callAt(runner, 0).args;
    let at = runner.calls.length;
    runtime.runAttached({
      name: 'asha-mod-x',
      image: 'm:1',
      network: 'asha-m-1',
      env: {},
      labels: {},
      onStdout: () => undefined,
      onStderrLine: () => undefined,
    });
    sites.runAttached = launchedAt(interactive, 0).args;
    await runtime
      .pluginContainer({
        name: 'asha-plugin-1',
        image: 'p:1',
        network: 'asha-m-2',
        entrypoint: 'cli',
        args: [],
        env: {},
        labels: {},
      })
      .create(new AbortController().signal);
    sites.pluginContainer = callAt(runner, at).args;
    at = runner.calls.length;
    const logDir = await mkdtemp(join(tmpdir(), 'asha-pull-'));
    await runtime
      .oneShot({
        name: 'asha-erase-1',
        image: 'i:1',
        args: [],
        logFile: join(logDir, 'o.log'),
        archive: async function* () {
          await Promise.resolve();
          yield Buffer.from('t');
        },
        timeoutMs: 60_000,
        maxStdoutBytes: 64,
      })
      .run();
    sites.oneShot = callAt(runner, at).args;
    at = runner.calls.length;
    await runtime.createHolder({ name: 'asha-h', image: 'i:1', volume: 'v', labels: {} });
    sites.holder = callAt(runner, at).args;
    at = runner.calls.length;
    await runtime.rollback({ volume: 'v', image: 'i:1', folder: 'upload-0123456789abcdef' });
    sites.rollback = callAt(runner, at).args;
    for (const [site, args] of Object.entries(sites)) {
      expect(['create', 'run'], site).toContain(args[0]);
      const pull = args.indexOf('--pull');
      expect(pull > 0 && args[pull + 1] === 'never', `${site}: ${args.join(' ')}`).toBe(true);
    }
  });

  it("every docker create and docker run argument list in the runtime's source carries --pull never (a new call site without it fails here)", async () => {
    const source = await readFile(
      join(import.meta.dirname, '..', '..', 'src', 'daemon', 'container-runtime', 'index.ts'),
      'utf8',
    );
    const lists: { readonly line: number; readonly text: string }[] = [];
    for (const m of source.matchAll(/'(create|run)'/g)) {
      const start = source.lastIndexOf('[', m.index);
      // The array the word opens: from its '[' to the matching ']'.
      let depth = 0;
      let end = start;
      for (; end < source.length; end++) {
        if (source[end] === '[') depth++;
        else if (source[end] === ']' && --depth === 0) break;
      }
      const text = source.slice(start, end + 1).replace(/\s+/g, ' ');
      // The word must be the array's first element (docker's subcommand), or follow 'network'/'volume' (not an image).
      if (/^\[ ?'(network|volume)', /.test(text)) continue;
      // docker's subcommand: the array's first element, or its second after 'container' (review finding 14).
      if (!new RegExp(`^\\[ ?('container', )?'${present(m[1], 'm[1]')}'`).test(text)) continue;
      lists.push({ line: source.slice(0, m.index).split('\n').length, text });
    }
    // start, the one-shot, the holder, the rollback, runAttached and pluginContainer.
    expect(lists).toHaveLength(6);
    for (const list of lists)
      expect(list.text, `container-runtime/index.ts line ${String(list.line)}`).toContain("'--pull', 'never'");
  });

  it("a create answering No such image for its tag throws ImageGone with R5's message, logs image.gone, and classify gives container_runtime", async () => {
    const runner = new FakeRunner().on('docker create', fail(1, `${GONE.replace('img', 'asha-image-x:abc')}\n`));
    const { runtime, logger } = await readyRuntime(runner);
    const error = await runtime
      .start({
        name: 'asha-x',
        image: 'asha-image-x:abc',
        env: {},
        logFile: join(await mkdtemp(join(tmpdir(), 'asha-gone-')), 'a.log'),
        files: [],
        channelVolume: 'v',
      })
      .exited.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImageGone);
    expect(error).toBeInstanceOf(ContainerRuntimeError);
    expect((error as Error).message).toBe(
      'image asha-image-x:abc was removed while this launch was starting (an image prune of another asha server); launch again to rebuild it',
    );
    expect(logger.entries.filter((e) => e.event === 'image.gone')).toEqual([
      { level: 'warn', event: 'image.gone', fields: { tag: 'asha-image-x:abc' } },
    ]);
    const { classify } = await import('../../src/daemon/agents/index.js');
    expect(classify(error)).toBe('container_runtime');
  });

  it('ImageGone from the one-shot, the plugin create, the holder and an attached run; any other failure stays ContainerRuntimeError', async () => {
    const gone = (tag: string) => fail(1, `Error response from daemon: No such image: ${tag}\n`);
    const runner = new FakeRunner().on(
      'docker create',
      gone('o:1'),
      gone('p:1'),
      gone('h:1'),
      fail(1, 'Error response from daemon: Conflict'),
    );
    const { runtime, interactive, logger } = await readyRuntime(runner);
    const logDir = await mkdtemp(join(tmpdir(), 'asha-gone-'));
    await expect(
      runtime
        .oneShot({
          name: 'o',
          image: 'o:1',
          args: [],
          logFile: join(logDir, 'o.log'),
          archive: async function* () {
            await Promise.resolve();
            yield Buffer.from('t');
          },
          timeoutMs: 1_000,
          maxStdoutBytes: 64,
        })
        .run(),
    ).rejects.toBeInstanceOf(ImageGone);
    await expect(
      runtime
        .pluginContainer({ name: 'p', image: 'p:1', network: 'n', entrypoint: 'e', args: [], env: {}, labels: {} })
        .create(new AbortController().signal),
    ).rejects.toBeInstanceOf(ImageGone);
    await expect(runtime.createHolder({ name: 'h', image: 'h:1', volume: 'v', labels: {} })).rejects.toBeInstanceOf(
      ImageGone,
    );
    const other = await runtime
      .createHolder({ name: 'h2', image: 'h:1', volume: 'v', labels: {} })
      .catch((e: unknown) => e);
    // Docker's "No such image" for another tag than the one created is not ImageGone (review finding 15).
    const elsewhere = new FakeRunner().on('docker create', fail(1, 'Error response from daemon: No such image: h:2\n'));
    const ready = await readyRuntime(elsewhere);
    const notGone = await ready.runtime
      .createHolder({ name: 'h3', image: 'h:1', volume: 'v', labels: {} })
      .catch((e: unknown) => e);
    expect(notGone).toBeInstanceOf(ContainerRuntimeError);
    expect(notGone).not.toBeInstanceOf(ImageGone);
    expect(other).toBeInstanceOf(ContainerRuntimeError);
    expect(other).not.toBeInstanceOf(ImageGone);
    const attached = runtime.runAttached({
      name: 'm',
      image: 'm:1',
      network: 'n',
      env: {},
      labels: {},
      onStdout: () => undefined,
      onStderrLine: () => undefined,
    });
    const child = launchedAt(interactive, 0);
    child.options.onStderrLine('docker: Error response from daemon: No such image: m:1');
    child.exit(125);
    await expect(attached.exited).rejects.toBeInstanceOf(ImageGone);
    expect(logger.entries.filter((e) => e.event === 'image.gone').map((e) => e.fields['tag'])).toEqual([
      'o:1',
      'p:1',
      'h:1',
      'm:1',
    ]);
  });
});
