// Module secrets (docs/plans/extension-modules.md R7, R24, R36): one SecretStore contract — get, set, list names,
// delete by module — and its one adapter, a 0600 JSON file per module, `ASHA_HOME/secrets/<module>.json`, in a 0700
// directory, written only with writePrivateFile. Nothing is written when ASHA_HOME is inside a git tree (the one
// shared insideGitTree, agent-persistence R2). Each read-modify-write holds `secrets.lock` (acquirePidLock): a second
// writer is refused at once with LockHeld, naming the holder's pid, and writes nothing. The daemon only reads.
//
// No value ever leaves this module but to its caller: no log line, error message or listing holds one.

import { chmod, lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { present } from '../../shared/assert-present.js';
import { MODULE_ID_PATTERN, SECRET_NAME_PATTERN } from '../../shared/modules.js';
import { byCodeUnit } from '../../shared/order.js';
import type { Logger } from '../log.js';
import { acquirePidLock } from '../process/index.js';
import { writePrivateFile } from '../private-file/index.js';

export interface SecretStore {
  /** Every secret of a module, by name ({} for none). */
  get(module: string): Promise<Readonly<Record<string, string>>>;
  /** Stores one secret of a module, replacing any value it had. */
  set(module: string, name: string, value: string): Promise<void>;
  /** The names of a module's secrets, sorted: never a value. */
  names(module: string): Promise<readonly string[]>;
  /** Removes every secret of a module; nothing to remove is not a failure. */
  deleteModule(module: string): Promise<void>;
  /** Every stored value of every module (R32's content scan, R35's redaction): the harness holds them all. */
  allValues(): Promise<readonly string[]>;
}

/** ASHA_HOME is inside a git tree: no secret is written there (R7). */
export class SecretsInsideGitTree extends Error {
  constructor(readonly home: string) {
    super(
      `ASHA_HOME ${home} is inside a git working tree (it, or a directory above it, holds a .git entry): secrets are never written there, so they can never be committed; use an ASHA_HOME outside every git tree`,
    );
    this.name = 'SecretsInsideGitTree';
  }
}

/** A secrets file that is not the store's own shape: never read as "none" (PRINCIPLES §9). */
export class SecretStoreCorrupt extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file}: ${detail}; remove it and set the module's secrets again with asha --set-secret`);
    this.name = 'SecretStoreCorrupt';
  }
}

export interface FileSecretStoreProps {
  readonly home: string;
  readonly dir: string;
  readonly logger: Logger;
  readonly pid: number;
  readonly isAlive: (pid: number) => boolean;
  /** agent-persistence R2's check, injected so a test can see it ran. */
  readonly insideGitTree: (path: string) => Promise<boolean>;
}

export class FileSecretStore implements SecretStore {
  constructor(private readonly props: FileSecretStoreProps) {}

  private file(module: string): string {
    if (!MODULE_ID_PATTERN.test(module))
      throw new Error(`secrets of ${JSON.stringify(module)}: not a module id (${MODULE_ID_PATTERN.toString()})`);
    return join(this.props.dir, `${module}.json`);
  }

  async get(module: string): Promise<Readonly<Record<string, string>>> {
    const file = this.file(module);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Never the parser's message: it quotes the text, which holds secret values.
      throw new SecretStoreCorrupt(file, 'it is not JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new SecretStoreCorrupt(file, 'it is not a JSON object');
    for (const [name, value] of Object.entries(parsed)) {
      if (!SECRET_NAME_PATTERN.test(name) || typeof value !== 'string')
        throw new SecretStoreCorrupt(file, `an entry is not a secret name with a string value`);
    }
    return parsed as Record<string, string>;
  }

  async names(module: string): Promise<readonly string[]> {
    return Object.keys(await this.get(module)).sort(byCodeUnit);
  }

  async set(module: string, name: string, value: string): Promise<void> {
    if (!SECRET_NAME_PATTERN.test(name))
      throw new Error(`"${name}" is not a secret name (${SECRET_NAME_PATTERN.toString()})`);
    if (value === '') throw new Error('an empty secret is not stored');
    await this.writeLocked(async () => {
      const current = await this.get(module);
      await writePrivateFile(this.file(module), `${JSON.stringify({ ...current, [name]: value })}\n`);
    });
  }

  async deleteModule(module: string): Promise<void> {
    const file = this.file(module);
    await this.writeLocked(() => rm(file, { force: true }));
  }

  async allValues(): Promise<readonly string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.props.dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const values: string[] = [];
    for (const entry of entries) {
      const m = /^([a-z][a-z0-9_]{0,31})\.json$/.exec(entry);
      if (m === null) continue;
      values.push(...Object.values(await this.get(present(m[1], 'secrets file name capture group'))));
    }
    return values;
  }

  /** The git-tree refusal, the 0700 directory, and `secrets.lock` held for `write` (R7, R36). */
  private async writeLocked(write: () => Promise<void>): Promise<void> {
    if (await this.props.insideGitTree(this.props.home)) throw new SecretsInsideGitTree(this.props.home);
    await mkdir(this.props.dir, { recursive: true, mode: 0o700 });
    // An existing directory keeps its mode on mkdir: made 0700 here, never left wider.
    const info = await lstat(this.props.dir);
    if (!info.isDirectory()) throw new Error(`${this.props.dir} is not a directory`);
    if ((info.mode & 0o777) !== 0o700) await chmod(this.props.dir, 0o700);
    const release = await acquirePidLock({
      file: join(this.props.dir, 'secrets.lock'),
      pid: this.props.pid,
      isAlive: this.props.isAlive,
      logger: this.props.logger,
    });
    try {
      await write();
    } finally {
      await release();
    }
  }
}
