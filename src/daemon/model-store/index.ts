// The model cache. Content-addressed: a catalogue entry's files live in
// <modelsDir>/sha256-<tree digest>/, where the tree digest covers every file's
// path and sha256. Only this module writes there. Downloads land in a staging
// directory nobody else reads, every file is verified, and the directory is
// promoted by one atomic rename — so a directory that exists is complete
// (PRINCIPLES §13: write to a name nobody else holds; promote on success).

import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ReadableStream } from 'node:stream/web';

import type { CatalogueEntry, CatalogueFile } from '../definitions/index.js';
import type { Logger } from '../log.js';
import { acquirePidLock } from '../process/index.js';
import { byKey } from '../../shared/order.js';

export interface CachedModel {
  /** Directory holding every catalogue file, under its catalogue path. */
  readonly dir: string;
  /** Absolute path of the weights file. */
  readonly weightsPath: string;
  readonly status: 'cached' | 'downloaded';
}

export interface ModelStore {
  ensure(entry: CatalogueEntry): Promise<CachedModel>;
}

export type FetchFailureReason = 'http_status' | 'stalled' | 'network' | 'size_mismatch';

/** A file could not be downloaded. */
export class ModelFetchFailed extends Error {
  constructor(
    readonly url: string,
    readonly reason: FetchFailureReason,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`downloading ${url} failed (${reason}): ${detail}`, options);
    this.name = 'ModelFetchFailed';
  }
}

/** A downloaded file's sha256 is not the pinned one. Never retried. */
export class ModelDigestMismatch extends Error {
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`${path}: sha256 ${actual} does not match the pinned ${expected}`);
    this.name = 'ModelDigestMismatch';
  }
}

/** sha256 over the sorted `path\0sha256\n` lines of an entry's files. */
export function treeDigest(files: readonly CatalogueFile[]): string {
  const lines = [...files]
    .sort(byKey('path'))
    .map((f) => `${f.path}\0${f.sha256}\n`)
    .join('');
  return createHash('sha256').update(lines).digest('hex');
}

export interface HuggingFaceModelStoreProps {
  readonly modelsDir: string;
  /** e.g. https://huggingface.co — files are fetched from <base>/<repo>/resolve/<revision>/<path>. */
  readonly baseUrl: string;
  readonly fetch: typeof fetch;
  readonly logger: Logger;
  /** Abort a download that delivers no bytes for this long. Bounds inactivity, not size. */
  readonly stallTimeoutMs: number;
  /** The daemon's own pid, written into the lock file. */
  readonly pid: number;
  /** Whether a pid is a live process — injected so the stale-lock path is testable. */
  readonly isAlive: (pid: number) => boolean;
}

export class HuggingFaceModelStore implements ModelStore {
  constructor(private readonly props: HuggingFaceModelStoreProps) {}

  async ensure(entry: CatalogueEntry): Promise<CachedModel> {
    const dir = join(this.props.modelsDir, `sha256-${treeDigest(entry.files)}`);
    const weightsPath = join(dir, entry.weights);
    if (await exists(dir)) {
      this.props.logger.info('model.cache_hit', { model: entry.id, dir });
      return { dir, weightsPath, status: 'cached' };
    }

    await mkdir(this.props.modelsDir, { recursive: true });
    const release = await acquirePidLock({
      file: join(this.props.modelsDir, '.lock'),
      pid: this.props.pid,
      isAlive: this.props.isAlive,
      logger: this.props.logger,
    });
    try {
      // Another process may have completed the same download while we waited.
      if (await exists(dir)) {
        this.props.logger.info('model.cache_hit', { model: entry.id, dir });
        return { dir, weightsPath, status: 'cached' };
      }
      const staging = join(this.props.modelsDir, `.staging-${randomBytes(6).toString('hex')}`);
      try {
        for (const file of entry.files) {
          await this.download(entry, file, join(staging, file.path));
        }
        await rename(staging, dir);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      this.props.logger.info('model.downloaded', { model: entry.id, dir });
      return { dir, weightsPath, status: 'downloaded' };
    } finally {
      await release();
    }
  }

  private async download(entry: CatalogueEntry, file: CatalogueFile, target: string): Promise<void> {
    const url = `${this.props.baseUrl}/${entry.repo}/resolve/${entry.revision}/${file.path}`;
    this.props.logger.info('model.file_downloading', { model: entry.id, path: file.path, size: file.size });
    await mkdir(dirname(target), { recursive: true });

    const controller = new AbortController();
    // A plain object, not a bare `let`: TypeScript's flow analysis narrows a captured `let` to its initial literal
    // at every read in this function, never seeing the reassignment onStall makes when its timer fires — so a read
    // through a property, which TypeScript does not narrow the same way, is what keeps this check meaningful.
    const stall = { happened: false };
    let timer = setTimeout(onStall, this.props.stallTimeoutMs);
    function onStall(): void {
      stall.happened = true;
      controller.abort();
    }
    const hash = createHash('sha256');
    let received = 0;
    try {
      const response = await this.props.fetch(url, { signal: controller.signal, redirect: 'follow' });
      if (!response.ok || response.body === null) {
        throw new ModelFetchFailed(url, 'http_status', `HTTP ${String(response.status)}`);
      }
      const out = createWriteStream(target, { flags: 'wx' });
      try {
        for await (const chunk of response.body as ReadableStream<Uint8Array>) {
          clearTimeout(timer);
          timer = setTimeout(onStall, this.props.stallTimeoutMs);
          hash.update(chunk);
          received += chunk.byteLength;
          if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve));
        }
      } finally {
        await new Promise<void>((resolve, reject) =>
          out.end((error?: Error | null) => {
            if (error) reject(error);
            else resolve();
          }),
        );
      }
    } catch (error) {
      if (error instanceof ModelFetchFailed) throw error;
      if (stall.happened) {
        throw new ModelFetchFailed(
          url,
          'stalled',
          `no bytes for ${String(this.props.stallTimeoutMs)} ms after ${String(received)} bytes`,
          { cause: error },
        );
      }
      throw new ModelFetchFailed(url, 'network', (error as Error).message, { cause: error });
    } finally {
      clearTimeout(timer);
    }

    if (received !== file.size) {
      throw new ModelFetchFailed(
        url,
        'size_mismatch',
        `received ${String(received)} bytes, pinned size is ${String(file.size)}`,
      );
    }
    const actual = hash.digest('hex');
    if (actual !== file.sha256) throw new ModelDigestMismatch(file.path, file.sha256, actual);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
