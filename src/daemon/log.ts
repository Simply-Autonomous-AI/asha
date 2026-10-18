// The daemon's one logging facade (PRINCIPLES §11). Every record is one JSON
// line in <home>/logs/daemon.jsonl, echoed to stderr so `asha --server` in a
// terminal shows it live. The 3am query:
//
//   jq -c 'select(.level=="error")' ~/.simplyautonomous/harness/logs/daemon.jsonl

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  /** `error` is serialized with its name, message, stack and cause chain. */
  error(event: string, fields: LogFields & { readonly error: unknown }): void;
}

export interface JsonLinesLoggerProps {
  readonly file: string;
  readonly echo: (line: string) => void;
  readonly clock: () => Date;
}

export class JsonLinesLogger implements Logger {
  constructor(private readonly props: JsonLinesLoggerProps) {}

  info(event: string, fields: LogFields = {}): void {
    this.write('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write('warn', event, fields);
  }

  error(event: string, fields: LogFields & { readonly error: unknown }): void {
    this.write('error', event, { ...fields, error: serializeError(fields.error) });
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    const ts = this.props.clock().toISOString();
    // ts, level and event lead the line, and are set again after the fields so
    // no field can overwrite them — a field named `level` must never hide an
    // error from the 3am query.
    const line = JSON.stringify(Object.assign({ ts, level, event }, fields, { ts, level, event }));
    // Synchronous on purpose: a record must be on disk before a crash that
    // follows it, or the crash erases its own explanation.
    try {
      appendFileSync(this.props.file, `${line}\n`);
    } catch (error) {
      // A home with no logs/ yet (one a module command, or `--set-secret`, made before any daemon ran): its folder is
      // made, never the home above it, which ensureHome makes 0700 — so with no home this still fails ENOENT.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      mkdirSync(dirname(this.props.file));
      appendFileSync(this.props.file, `${line}\n`);
    }
    this.props.echo(line);
  }
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: SerializedError | string;
}

export function serializeError(error: unknown): SerializedError | string {
  return error instanceof Error ? serializeErrorObject(error) : serializeNonError(error);
}

function serializeErrorObject(error: Error): SerializedError {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(error.cause === undefined ? {} : { cause: serializeError(error.cause) }),
  };
}

function serializeNonError(error: unknown): SerializedError | string {
  if (typeof error !== 'object' || error === null) return String(error);
  try {
    return JSON.stringify(error);
  } catch {
    // Circular or otherwise unserializable: its type is all that can be said.
    return Object.prototype.toString.call(error);
  }
}
