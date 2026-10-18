// The guard that the daemon's secrets cannot reach a container (docs/plans/control-api-auth.md
// R3 and R8, A4): the code that starts containers — the supervisor and the container
// runtime — never names the control credential, daemon.json or the model server's key, and
// the contracts a container is built from declare no member that could carry one.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Where containers are specified and started. */
const CONTAINER_CODE = ['src/daemon/agents', 'src/daemon/container-runtime'];
/** The identifiers that hold, or lead to, a secret: the credential, its file, the model server's key and its file. */
const SECRET_IDENTIFIERS = /\b(credential|daemonFile|modelServerKey|apiKey|keyFile)\b/gi;
/** The contracts a container is built from, and where each is declared. */
const CONTRACTS = [
  ['AgentSupervisorProps', 'src/daemon/agents/index.ts'],
  ['ContainerSpec', 'src/daemon/container-runtime/index.ts'],
  ['ContainerRuntime', 'src/daemon/container-runtime/index.ts'],
] as const;

function sources(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(dir, f));
}

/** Each `file: line` naming a secret identifier. */
function secretReferences(files: readonly string[], read: (file: string) => string): string[] {
  return files.flatMap((file) =>
    read(file)
      .split('\n')
      .flatMap((line, i) => [...line.matchAll(SECRET_IDENTIFIERS)].map((m) => `${file}:${String(i + 1)}: ${m[0]}`)),
  );
}

/** The member names an `interface <name> { … }` declares, read from its source. */
function interfaceMembers(source: string, name: string): string[] {
  const start = source.indexOf(`export interface ${name} {`);
  if (start < 0) throw new Error(`interface ${name} not found`);
  const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('\n}', start));
  // Members sit at two spaces of indentation: `  readonly name:`, `  name(`, `  name?:`.
  return [...body.matchAll(/^ {2}(?:readonly )?([A-Za-z_$][\w$]*)\??[(:<]/gm)].map((m) =>
    present(m[1], "the member-name regex's capture group"),
  );
}

describe('no secret reaches a container (A4)', () => {
  const read = (file: string) => readFileSync(join(REPO_ROOT, file), 'utf8');

  it('the supervisor and the container runtime never name the credential, daemon.json or the model server key', () => {
    const files = CONTAINER_CODE.flatMap(sources);
    expect(files.length).toBeGreaterThan(1);
    expect(secretReferences(files, read)).toEqual([]);
  });

  it.each(CONTRACTS)('%s declares no member that could hold a secret', (name, file) => {
    const members = interfaceMembers(read(file), name);
    expect(members.length).toBeGreaterThan(0);
    expect(members.filter((m) => /credential|secret|key|password/i.test(m))).toEqual([]);
  });

  it('reads interface members and finds secret references as it claims', () => {
    expect(
      interfaceMembers(
        'export interface X {\n  readonly a: string;\n  b?: number;\n  c(x: number): void;\n  /** readonly d: no */\n}\n',
        'X',
      ),
    ).toEqual(['a', 'b', 'c']);
    expect(secretReferences(['f.ts'], () => 'const x = 1;\nenv.credential = paths.daemonFile;\n')).toEqual([
      'f.ts:2: credential',
      'f.ts:2: daemonFile',
    ]);
  });
});
