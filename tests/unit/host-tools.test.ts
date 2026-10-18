// Making sure a host tool is installed (docs/plans/brew-install.md): probed, installed with Homebrew when absent,
// and every failure carrying its reason — a broken binary's own output, a Homebrew that does not run (PRINCIPLES
// §11; R1-DESIGN-014) — never a later, vaguer one.

import { describe, expect, it } from 'vitest';

import { PrerequisiteMissing, ToolInstallFailed, ensureHostTool } from '../../src/daemon/host-tools/index.js';
import { FakeRunner, RecordingLogger } from '../helpers/fakes.js';

const TOOL = { binary: 'colima', probeArgs: ['version'], formula: 'colima' } as const;
const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });

describe('ensureHostTool', () => {
  it('answers present when the probe exits 0, running nothing else', async () => {
    const runner = new FakeRunner().on('colima version', ok('colima version 0.8.1'));
    expect(await ensureHostTool(runner, new RecordingLogger(), TOOL)).toBe('present');
    expect(runner.calls.map((c) => [c.command, ...c.args].join(' '))).toEqual(['colima version']);
  });

  it('installs an absent tool and logs host_tool.installing and host_tool.installed', async () => {
    const runner = new FakeRunner()
      .on('colima version', 'not-found', ok('colima version 0.8.1'))
      .on('brew --version', ok('Homebrew 4.4.0'))
      .on('brew install colima', ok());
    const logger = new RecordingLogger();
    expect(await ensureHostTool(runner, logger, TOOL)).toBe('installed');
    expect(logger.entries.map((e) => [e.level, e.event, e.fields])).toEqual([
      ['info', 'host_tool.installing', { tool: 'colima', formula: 'colima' }],
      ['info', 'host_tool.installed', { tool: 'colima', formula: 'colima' }],
    ]);
  });

  it('a probe still failing after the install names its exit code and output, the reason the binary does not run', async () => {
    const broken = { code: 134, stdout: '', stderr: 'dyld: Library not loaded: libfoo.dylib' };
    const runner = new FakeRunner()
      .on('colima version', broken, broken)
      .on('brew --version', ok('Homebrew 4.4.0'))
      .on('brew install colima', ok('Warning: colima 0.8.1 is already installed'));
    const error = await ensureHostTool(runner, new RecordingLogger(), TOOL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolInstallFailed);
    expect((error as ToolInstallFailed).output).toBe(
      'brew install colima exited 0 but colima is still not runnable: colima version exited 134:\n\ndyld: Library not loaded: libfoo.dylib',
    );
  });

  it('a brew --version that exits non-zero fails the install with its output, installing nothing', async () => {
    const runner = new FakeRunner()
      .on('colima version', 'not-found')
      .on('brew --version', { code: 1, stdout: '', stderr: 'Error: Homebrew is broken' });
    const error = await ensureHostTool(runner, new RecordingLogger(), TOOL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ToolInstallFailed);
    expect((error as ToolInstallFailed).output).toBe('brew --version exited 1:\n\nError: Homebrew is broken');
    expect(runner.calls.map((c) => [c.command, ...c.args].join(' '))).toEqual(['colima version', 'brew --version']);
  });

  it('a missing Homebrew is PrerequisiteMissing, naming the tool it was needed for', async () => {
    const runner = new FakeRunner().on('colima version', 'not-found').on('brew --version', 'not-found');
    await expect(ensureHostTool(runner, new RecordingLogger(), TOOL)).rejects.toThrow(
      new PrerequisiteMissing('Homebrew', 'install it from https://brew.sh, then retry (needed to install colima)'),
    );
  });

  it('rethrows any other failure of the probe or of brew --version, unchanged', async () => {
    const probeFailed = new Error('spawn EACCES');
    await expect(
      ensureHostTool(new FakeRunner().on('colima version', probeFailed), new RecordingLogger(), TOOL),
    ).rejects.toBe(probeFailed);
    const brewFailed = new Error('brew --version did not finish within 30000 ms');
    await expect(
      ensureHostTool(
        new FakeRunner().on('colima version', 'not-found').on('brew --version', brewFailed),
        new RecordingLogger(),
        TOOL,
      ),
    ).rejects.toBe(brewFailed);
  });
});
