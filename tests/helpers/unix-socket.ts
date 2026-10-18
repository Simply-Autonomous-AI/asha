// A Unix socket at a path of any length. macOS holds a socket's address in 104 bytes (sun_path), and a longer path
// was bound truncated, without an error (seen 2026-10-15: the socket landed beside where the test asked, which then
// found no file) — and under a test run's own temporary folder (tests/helpers/run-temp.ts) the paths are long. So the
// socket is bound at a short path under /tmp and renamed into place: rename(2) moves a socket as any other file, and
// the server stays bound to it.

import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { join } from 'node:path';

/** Binds `server` to a Unix socket at `path`, resolving once the socket is there; a failure to bind rejects. */
export async function listenAt(server: Server, path: string): Promise<void> {
  const short = mkdtempSync('/tmp/asha-sock-');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(join(short, 's'), () => {
        server.off('error', reject);
        resolve();
      });
    });
    renameSync(join(short, 's'), path);
  } finally {
    rmSync(short, { recursive: true, force: true });
  }
}
