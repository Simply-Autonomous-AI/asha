// The audit of consequential calls (docs/plans/extension-modules.md R14): `ASHA_HOME/audit/consequential.jsonl`, one
// JSON line before each call is sent and one with its outcome, append-only — the file is only ever opened to append,
// by the daemon alone, and no code path truncates or rewrites it. Each line's fields are exactly R14's; the arguments
// appear only as their sha256, never a secret or a value.

import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** One audit line's fields, exactly (R14). `outcome`: `sending` before the call; then `ok` or its failure reason. */
export interface AuditLine {
  readonly time: string;
  readonly agent: string;
  readonly conversation: string;
  readonly module: string;
  readonly tool: string;
  readonly argumentsSha256: string;
  readonly approval: string;
  readonly idempotencyKey: string;
  readonly outcome: string;
}

export const AUDIT_FIELDS = [
  'time',
  'agent',
  'conversation',
  'module',
  'tool',
  'argumentsSha256',
  'approval',
  'idempotencyKey',
  'outcome',
] as const;

/** Opens a file to append to it: the only way the audit file is ever opened. */
export type AppendOpen = (
  path: string,
  flags: 'a',
  mode: number,
) => Promise<{ write(data: string): Promise<unknown>; sync(): Promise<void>; close(): Promise<void> }>;

export class AuditLog {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly props: { readonly file: string; readonly open: AppendOpen }) {}

  /** Appends one line, synced, one write at a time; a failure is the caller's to handle (the call is not made). */
  append(line: AuditLine): Promise<void> {
    const ordered = Object.fromEntries(AUDIT_FIELDS.map((key) => [key, line[key]]));
    const write = this.queue.then(async () => {
      await mkdir(dirname(this.props.file), { recursive: true, mode: 0o700 });
      const handle = await this.props.open(this.props.file, 'a', 0o600);
      try {
        await handle.write(`${JSON.stringify(ordered)}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
    this.queue = write.catch(() => undefined);
    return write;
  }
}
