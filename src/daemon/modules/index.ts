// Extension modules on the daemon's side (docs/plans/extension-modules.md): the public surface the composition root,
// the supervisor and the server use. Nothing here runs until a launch grants a module (R38).

import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { HarnessPaths } from '../../shared/paths.js';
import type { ContainerRuntime } from '../container-runtime/index.js';
import type { FileSpaces } from '../files/index.js';
import { streamFile } from '../images/index.js';
import type { Logger } from '../log.js';
import { writePrivateFile } from '../private-file/index.js';
import type { SecretStore } from '../secrets/index.js';
import { Approvals } from './approvals.js';
import { AuditLog, type AppendOpen } from './audit.js';
import { ModuleHost, type SetTimer } from './host.js';
import { ModuleImages, type InstalledModule } from './images.js';
import { Meter } from './meter.js';
import { PluginRunner } from './plugins.js';

export * from './approvals.js';
export * from './audit.js';
export * from './cut.js';
export * from './host.js';
export * from './images.js';
export * from './installed.js';
export * from './launch.js';
export * from './meter.js';
export * from './paths.js';
export * from './plugins.js';
export * from './redact.js';
export { buildArguments } from './arguments.js';

/** Everything the supervisor and the server use of the modules. */
export interface ModuleServices {
  readonly installed: ReadonlyMap<string, InstalledModule>;
  readonly host: ModuleHost;
  readonly plugins: PluginRunner;
  readonly approvals: Approvals;
  readonly meter: Meter;
  readonly audit: AuditLog;
}

export interface ModuleServicesProps {
  readonly runtime: ContainerRuntime;
  /** The repo or release root: harness-images/ and dist/. */
  readonly root: string;
  readonly paths: HarnessPaths;
  readonly logger: Logger;
  readonly installed: ReadonlyMap<string, InstalledModule>;
  readonly files: Pick<FileSpaces, 'readForPlugin' | 'writeFromPlugin'>;
  readonly secrets: SecretStore;
  readonly setTimer: SetTimer;
  readonly now: () => number;
  /** Whether an agent's token is still a running agent's: an approval's agent_gone (R12 (b)). */
  readonly online: (token: string) => boolean;
  /** The audit file's only opening: to append (R14). */
  readonly appendOpen: AppendOpen;
}

/** The real append-only opening of the audit file. */
export const appendOpen: AppendOpen = (path, flags, mode) => open(path, flags, mode);

/** The real timer, cancellable. */
export const realSetTimer: SetTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => {
    clearTimeout(timer);
  };
};

/** Waits for `promises` to settle, at most `ms` on `setTimer`'s clock; resolves with how many had not settled then (0: all). */
export async function settledWithin(
  promises: readonly Promise<unknown>[],
  ms: number,
  setTimer: SetTimer,
): Promise<number> {
  if (promises.length === 0) return 0;
  let settled = 0;
  for (const p of promises)
    void p.then(
      () => (settled += 1),
      () => (settled += 1),
    );
  let cancel: () => void = () => undefined;
  const late = new Promise<'late'>(
    (resolve) =>
      (cancel = setTimer(() => {
        resolve('late');
      }, ms)),
  );
  const outcome = await Promise.race([Promise.allSettled(promises).then(() => 'all' as const), late]);
  cancel();
  return outcome === 'all' ? 0 : promises.length - settled;
}

export function createModuleServices(props: ModuleServicesProps): ModuleServices {
  const newId = (): string => randomBytes(16).toString('hex');
  const images = new ModuleImages({
    runtime: props.runtime,
    root: props.root,
    stagingDir: props.paths.stagingDir,
    logger: props.logger,
    read: streamFile,
  });
  const host = new ModuleHost({
    runtime: props.runtime,
    images,
    installed: props.installed,
    secrets: props.secrets,
    logger: props.logger,
    homeId: props.paths.homeId,
    newId,
    setTimer: props.setTimer,
    now: props.now,
  });
  return {
    installed: props.installed,
    host,
    plugins: new PluginRunner({
      runtime: props.runtime,
      slot: (module, channel) => host.pluginSlot(module, channel),
      files: props.files,
      storedSecrets: () => props.secrets.allValues(),
      logger: props.logger,
      ashaHome: props.paths.home,
      stagingDir: props.paths.stagingDir,
      newId,
      now: props.now,
      setTimer: props.setTimer,
      afterChecks: () => Promise.resolve(),
    }),
    approvals: new Approvals({
      setTimer: props.setTimer,
      now: props.now,
      newId: () => randomBytes(8).toString('hex'),
      online: props.online,
    }),
    meter: new Meter({
      file: props.paths.meteringFile,
      logger: props.logger,
      now: () => new Date(props.now()),
      write: writePrivateFile,
    }),
    audit: new AuditLog({ file: join(props.paths.auditDir, 'consequential.jsonl'), open: props.appendOpen }),
  };
}
export * from './provider.js';
export * from './live.js';
