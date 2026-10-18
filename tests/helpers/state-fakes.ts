// A fault-injecting, call-recording filesystem for the state store (docs/plans/agent-persistence.md A3, A8): the
// real filesystem underneath, every call recorded in order, and faults planted by path.

import { basename } from 'node:path';

import { nodeStateFs, type StateFile, type StateFs } from '../../src/daemon/state/index.js';

/** A planted fault: the call and the path it hits (matched by suffix), and — for writes — after how many bytes. */
export type Fault =
  | { readonly op: 'write'; readonly path: string; readonly afterBytes: number }
  | {
      readonly op: 'replace' | 'fsyncDir' | 'mkdirExclusive' | 'createFile' | 'sync' | 'remove';
      readonly path: string;
    };

export class InjectedFault extends Error {
  constructor(readonly fault: Fault) {
    super(`injected fault: ${fault.op} ${fault.path}`);
    this.name = 'InjectedFault';
  }
}

/**
 * The state store's filesystem in memory: every call resolves in a microtask, so a test under fake timers is
 * driven by the clock alone (A8a). `delay` holds a call (by its line, `<op> <path>`) for fake time — a slow copy
 * or write — and `calls` records every one, as SpyFs does.
 */
export class MemoryStateFs implements StateFs {
  readonly files = new Map<string, Buffer>();
  readonly dirs = new Set<string>(['/']);
  readonly calls: string[] = [];
  /** Returns ms of fake time to hold the call, or 0. */
  delay: (line: string) => number = () => 0;

  private async step(op: string, path: string): Promise<void> {
    const line = `${op} ${path}`;
    this.calls.push(line);
    const ms = this.delay(line);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private parent(path: string): string {
    return path.slice(0, path.lastIndexOf('/')) || '/';
  }

  private requireParent(path: string): void {
    if (!this.dirs.has(this.parent(path))) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  }

  async mkdirExclusive(path: string): Promise<void> {
    await this.step('mkdirExclusive', path);
    this.requireParent(path);
    if (this.dirs.has(path) || this.files.has(path))
      throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
    this.dirs.add(path);
  }

  async mkdirp(path: string): Promise<void> {
    await this.step('mkdirp', path);
    for (let p = path; p !== '/'; p = this.parent(p)) this.dirs.add(p);
  }

  async createFile(path: string): Promise<StateFile> {
    await this.step('create', path);
    this.requireParent(path);
    if (this.files.has(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: 'EEXIST' });
    this.files.set(path, Buffer.alloc(0));
    return {
      write: async (chunk) => {
        await this.step('write', path);
        this.files.set(path, Buffer.concat([this.files.get(path) ?? Buffer.alloc(0), Buffer.from(chunk)]));
      },
      sync: () => this.step('sync', path),
      close: () => Promise.resolve(undefined),
    };
  }

  async fsyncDir(path: string): Promise<void> {
    await this.step('fsyncDir', path);
  }

  async replaceFile(path: string, content: string): Promise<void> {
    await this.step('replace', path);
    this.requireParent(path);
    this.files.set(path, Buffer.from(content));
  }

  readFile(path: string): Promise<Buffer | undefined> {
    return Promise.resolve(this.files.get(path));
  }

  list(path: string): Promise<{ name: string; kind: 'directory' | 'file' }[] | undefined> {
    if (!this.dirs.has(path)) return Promise.resolve(undefined);
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Map<string, 'directory' | 'file'>();
    for (const d of this.dirs)
      if (d.startsWith(prefix) && d !== path && !d.slice(prefix.length).includes('/'))
        names.set(d.slice(prefix.length), 'directory');
    for (const f of this.files.keys())
      if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) names.set(f.slice(prefix.length), 'file');
    return Promise.resolve([...names].map(([name, kind]) => ({ name, kind })));
  }

  size(path: string): Promise<number> {
    const f = this.files.get(path);
    if (f === undefined) return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));
    return Promise.resolve(f.length);
  }

  async remove(path: string): Promise<void> {
    await this.step('remove', path);
    for (const f of [...this.files.keys()]) if (f === path || f.startsWith(`${path}/`)) this.files.delete(f);
    for (const d of [...this.dirs]) if (d === path || d.startsWith(`${path}/`)) this.dirs.delete(d);
  }
}

export class SpyFs implements StateFs {
  /** Every call in order, `<op> <path relative to root>`; writes as `write <path> <bytes>`. */
  readonly calls: string[] = [];
  readonly faults: Fault[] = [];
  /** Called before each call runs, with its line: lets a test act at an exact point (a crash, a kill). */
  onCall: (line: string) => void = () => undefined;

  constructor(private readonly root: string) {}

  private rel(path: string): string {
    return path.startsWith(`${this.root}/`) ? path.slice(this.root.length + 1) : path;
  }

  private record(op: string, path: string, extra = ''): void {
    const line = `${op} ${this.rel(path)}${extra}`;
    this.calls.push(line);
    this.onCall(line);
  }

  private fault(op: Fault['op'], path: string): Fault | undefined {
    return this.faults.find((f) => f.op === op && path.endsWith(f.path));
  }

  private check(op: Exclude<Fault['op'], 'write'>, path: string): void {
    const fault = this.fault(op, path);
    if (fault !== undefined) throw new InjectedFault(fault);
  }

  async mkdirExclusive(path: string): Promise<void> {
    this.record('mkdirExclusive', path);
    this.check('mkdirExclusive', path);
    await nodeStateFs.mkdirExclusive(path);
  }

  async mkdirp(path: string): Promise<void> {
    this.record('mkdirp', path);
    await nodeStateFs.mkdirp(path);
  }

  async createFile(path: string): Promise<StateFile> {
    this.record('create', path);
    this.check('createFile', path);
    const file = await nodeStateFs.createFile(path);
    const writeFault = this.faults.find(
      (f): f is Extract<Fault, { op: 'write' }> => f.op === 'write' && path.endsWith(f.path),
    );
    let written = 0;
    return {
      write: async (chunk) => {
        this.record('write', path, ` ${String(chunk.byteLength)}`);
        if (writeFault !== undefined && written + chunk.byteLength > writeFault.afterBytes) {
          // The bytes up to the fault reach the file, as a disk that fills or fails mid-write leaves them.
          await file.write(chunk.subarray(0, Math.max(0, writeFault.afterBytes - written)));
          throw new InjectedFault(writeFault);
        }
        written += chunk.byteLength;
        await file.write(chunk);
      },
      sync: async () => {
        this.record('sync', path);
        this.check('sync', path);
        await file.sync();
      },
      close: async () => {
        this.record('close', path);
        await file.close();
      },
    };
  }

  async fsyncDir(path: string): Promise<void> {
    this.record('fsyncDir', path);
    this.check('fsyncDir', path);
    await nodeStateFs.fsyncDir(path);
  }

  async replaceFile(path: string, content: string): Promise<void> {
    this.record('replace', path);
    this.check('replace', path);
    await nodeStateFs.replaceFile(path, content);
  }

  readFile(path: string): Promise<Buffer | undefined> {
    return nodeStateFs.readFile(path);
  }

  list(path: string) {
    return nodeStateFs.list(path);
  }

  size(path: string): Promise<number> {
    return nodeStateFs.size(path);
  }

  async remove(path: string): Promise<void> {
    this.record('remove', path);
    this.check('remove', path);
    await nodeStateFs.remove(path);
  }

  /** The calls whose path's last part is `name`. */
  about(name: string): string[] {
    return this.calls.filter((c) => basename(c.split(' ')[1] ?? '') === name);
  }
}
