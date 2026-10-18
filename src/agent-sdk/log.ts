// The agent's logging facade (PRINCIPLES §11): one JSON line per record on the
// agent's stdout, which the harness appends to logs/agents/<container>.log on
// the host. Tool failures, tool crashes and file writes go through it
// (docs/plans/agent-tools.md R4, R9), so one query over those files finds them:
//
//   jq -cR 'fromjson? | select(.event=="tool.failed" or .event=="tool.crashed")' "$ASHA_HOME"/logs/agents/*.log
//
// (`-R … fromjson?`: an agent's log also holds plain lines, such as "joining
// the channel as hewo" and a crash's stack trace, which plain `jq` stops at.)

export type AgentLogFields = Readonly<Record<string, unknown>>;

export interface AgentLog {
  info(event: string, fields: AgentLogFields): void;
  warn(event: string, fields: AgentLogFields): void;
  /** `error` is written with its name, message and cause chain. */
  error(event: string, fields: AgentLogFields & { readonly error: unknown }): void;
}

export interface JsonLinesAgentLogProps {
  /** Writes one line; the agent's main passes stdout. */
  readonly write: (line: string) => void;
  readonly clock: () => Date;
}

export class JsonLinesAgentLog implements AgentLog {
  constructor(private readonly props: JsonLinesAgentLogProps) {}

  info(event: string, fields: AgentLogFields): void {
    this.line('info', event, fields);
  }

  warn(event: string, fields: AgentLogFields): void {
    this.line('warn', event, fields);
  }

  error(event: string, fields: AgentLogFields & { readonly error: unknown }): void {
    this.line('error', event, { ...fields, error: describeError(fields.error) });
  }

  private line(level: 'info' | 'warn' | 'error', event: string, fields: AgentLogFields): void {
    const ts = this.props.clock().toISOString();
    // ts, level and event lead and win: no field can hide a record from the query.
    this.props.write(`${JSON.stringify(Object.assign({ ts, level, event }, fields, { ts, level, event }))}\n`);
  }
}

interface DescribedError {
  readonly name: string;
  readonly message: string;
  readonly cause?: DescribedError | string;
}

function describeError(error: unknown): DescribedError | string {
  return error instanceof Error ? describeErrorObject(error) : String(error);
}

function describeErrorObject(error: Error): DescribedError {
  return {
    name: error.name,
    message: error.message,
    ...(error.cause === undefined ? {} : { cause: describeError(error.cause) }),
  };
}
