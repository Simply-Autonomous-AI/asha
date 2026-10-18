// The record of user IDs issued per channel. A user ID is never reused — not
// after the user goes offline, not across daemon restarts — because agents
// will keep memory keyed on it. The ledger holds the highest `user-<n>` each
// channel has issued or seen; the file implementation keeps it in the harness
// home and replaces it atomically (write a temp file, rename), so a crash
// mid-write leaves the previous ledger intact.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface UserLedger {
  /** The next never-used user number for the channel; it is recorded as used. */
  issue(channel: string): number;
  /** A user named themselves `user-<n>`: numbers up to n are never issued. */
  observe(channel: string, n: number): void;
}

/** The ledger file is not a JSON object of channel → highest number. */
export class UserLedgerCorrupt extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`${file} is not a valid user ledger: ${detail}`);
    this.name = 'UserLedgerCorrupt';
  }
}

export class FileUserLedger implements UserLedger {
  private readonly highest: Record<string, number>;

  constructor(private readonly file: string) {
    this.highest = load(file);
  }

  issue(channel: string): number {
    const n = (this.highest[channel] ?? 0) + 1;
    this.highest[channel] = n;
    this.save();
    return n;
  }

  observe(channel: string, n: number): void {
    if (n <= (this.highest[channel] ?? 0)) return;
    this.highest[channel] = n;
    this.save();
  }

  private save(): void {
    const temp = `${this.file}.${String(process.pid)}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.highest, null, 2)}\n`);
    renameSync(temp, this.file);
  }
}

function load(file: string): Record<string, number> {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    // No ledger yet: nothing has been issued. Any other read failure is real.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UserLedgerCorrupt(file, (error as Error).message);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new UserLedgerCorrupt(file, 'not an object');
  for (const [channel, n] of Object.entries(parsed)) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      throw new UserLedgerCorrupt(file, `channel "${channel}" has ${JSON.stringify(n)}, not a whole number`);
    }
  }
  return parsed as Record<string, number>;
}
