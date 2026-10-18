// Runs the colima VM's rule scripts (installScript) for real, under /bin/sh,
// against a fake `iptables` and `iptables-restore` that keep the filter table
// in a JSON file. The fake prints rules the way iptables -S does where the
// scripts depend on it: comments quoted, and a bare `-j REJECT` completed
// with its default `--reject-with icmp-port-unreachable`. Only the paths the
// scripts hard-code for the VM (/etc/hosts, the lock file) are redirected.

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Rule {
  readonly chain: string;
  readonly spec: string;
}

export interface Table {
  readonly chains: readonly string[];
  readonly rules: readonly Rule[];
}

export interface ScriptRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Built-in chains and Docker's, as the VM has them before any asha rule. */
export const DOCKER_TABLE: Table = {
  chains: ['INPUT', 'FORWARD', 'OUTPUT', 'DOCKER', 'DOCKER-USER', 'DOCKER-FORWARD'],
  rules: [
    { chain: 'FORWARD', spec: '-j DOCKER-USER' },
    { chain: 'FORWARD', spec: '-j DOCKER-FORWARD' },
  ],
};

const FAKE = `
const fs = require('fs');
const state = process.env.FAKE_IPTABLES_STATE;
const builtin = ['INPUT', 'FORWARD', 'OUTPUT'];
const load = () => JSON.parse(fs.readFileSync(state, 'utf8'));
const save = (t) => fs.writeFileSync(state, JSON.stringify(t));
/** The one form rules are compared in: no quotes, no default reject type. */
const norm = (spec) => spec.replace(/"/g, '').replace(/ --reject-with icmp-port-unreachable$/, '').trim().split(/\\s+/).join(' ');
const print = (spec) => spec.replace(/--comment (\\S+)/, '--comment "$1"').replace(/ -j REJECT$/, ' -j REJECT --reject-with icmp-port-unreachable');
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };
function apply(t, op, chain, rest) {
  if (!t.chains.includes(chain)) fail('iptables: No chain/target/match by that name: ' + chain);
  if (op === '-A') t.rules.push({ chain, spec: norm(rest.join(' ')) });
  else if (op === '-I') {
    const at = Number(rest[0]) - 1;
    const inChain = t.rules.map((r, i) => [r, i]).filter(([r]) => r.chain === chain);
    const index = at < inChain.length ? inChain[at][1] : (inChain.length ? inChain[inChain.length - 1][1] + 1 : t.rules.length);
    t.rules.splice(index, 0, { chain, spec: norm(rest.slice(1).join(' ')) });
  } else if (op === '-D') {
    const i = t.rules.findIndex((r) => r.chain === chain && r.spec === norm(rest.join(' ')));
    if (i < 0) fail('iptables: Bad rule (does a matching rule exist in that chain?): ' + rest.join(' '));
    t.rules.splice(i, 1);
  } else fail('fake iptables: unsupported ' + op);
}
const name = require('path').basename(process.argv[1], '.cjs');
const args = process.argv.slice(2).filter((a) => a !== '-w');
const t = load();
if (name === 'iptables-restore') {
  if (args.join(' ') !== '--noflush') fail('fake iptables-restore: only --noflush is supported');
  const drop = process.env.FAKE_IPTABLES_DROP;
  const lines = fs.readFileSync(0, 'utf8').split('\\n').filter((l) => l.trim() !== '');
  if (lines[0] !== '*filter' || lines[lines.length - 1] !== 'COMMIT') fail('fake iptables-restore: not one *filter ... COMMIT block');
  for (const line of lines.slice(1, -1)) {
    if (drop && line.includes(drop)) continue;
    const words = line.replace(/'/g, '').split(/\\s+/);
    apply(t, words[0], words[1], words.slice(2));
  }
  save(t);
  process.exit(0);
}
const [op, chain, ...rest] = args;
if (op === '-S') {
  const out = builtin.map((c) => '-P ' + c + ' ACCEPT');
  for (const c of t.chains) if (!builtin.includes(c)) out.push('-N ' + c);
  for (const r of t.rules) out.push('-A ' + r.chain + ' ' + print(r.spec));
  process.stdout.write(out.join('\\n') + '\\n');
} else if (op === '-N') {
  if (t.chains.includes(chain)) fail('iptables: Chain already exists.');
  t.chains.push(chain);
  save(t);
} else if (op === '-C') {
  if (!t.chains.includes(chain)) fail('iptables: No chain/target/match by that name.');
  if (!t.rules.some((r) => r.chain === chain && r.spec === norm(rest.join(' ')))) fail('iptables: Bad rule (does a matching rule exist in that chain?).');
} else {
  apply(t, op, chain, rest);
  save(t);
}
`;

/**
 * The fake `iptables`, `iptables-restore` and `flock`, written once per test process and shared by every VM: each takes
 * its VM's table from FAKE_IPTABLES_STATE. macOS assesses an executable file on its first run — about 1 s a file on
 * 2026-10-16, against 3 ms for `/bin/sh -c true` — so three new ones for each VM timed out tests that make two.
 */
let sharedBin: Promise<string> | undefined;

function fakeCommands(): Promise<string> {
  sharedBin ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-fake-iptables-'));
    const bin = join(dir, 'bin');
    await mkdir(bin);
    // One copy of the fake per command: it learns which command it is from its own file name.
    for (const name of ['iptables', 'iptables-restore']) {
      const cjsPath = join(dir, `${name}.cjs`);
      await writeFile(cjsPath, FAKE);
      await writeFile(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${cjsPath}" "$@"\n`);
      await chmod(join(bin, name), 0o755);
    }
    await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
    await chmod(join(bin, 'flock'), 0o755);
    return bin;
  })();
  return sharedBin;
}

/**
 * Runs each shared fake once, so that macOS's first-run assessment of the three files falls in the caller's `beforeAll`,
 * under its own bound, not in the first test's 5 s. Each run's exit code is not looked at; a fake that cannot start fails.
 */
export async function warmFakeCommands(): Promise<void> {
  const bin = await fakeCommands();
  const state = join(bin, '..', 'warm-table.json');
  await writeFile(state, JSON.stringify({ chains: ['INPUT'], rules: [] }));
  for (const [name, args] of [
    ['iptables', ['-S']],
    ['iptables-restore', ['--test']],
    ['flock', []],
  ] as const) {
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        join(bin, name),
        [...args],
        { env: { FAKE_IPTABLES_STATE: state }, timeout: 20_000 },
        (error) => {
          if (error !== null && typeof error.code !== 'number')
            reject(error instanceof Error ? error : new Error(JSON.stringify(error)));
          else resolve();
        },
      );
      child.stdin?.end('');
    });
  }
}

export class FakeVm {
  private constructor(
    private readonly shared: string,
    private readonly dir: string,
    private readonly state: string,
  ) {}

  /** A VM whose filter table starts as `table` and whose /etc/hosts maps host.lima.internal to `hostAddress`. */
  static async create(table: Table, hostAddress = '192.168.5.2'): Promise<FakeVm> {
    const shared = await fakeCommands();
    const dir = await mkdtemp(join(tmpdir(), 'asha-fake-vm-'));
    // The VM's own commands (addCommand), first on its PATH.
    await mkdir(join(dir, 'bin'));
    await writeFile(join(dir, 'hosts'), `127.0.0.1 localhost\n${hostAddress} host.lima.internal\n`);
    const state = join(dir, 'table.json');
    await writeFile(state, JSON.stringify(table));
    return new FakeVm(shared, dir, state);
  }

  /** Adds a command to the VM's PATH (a fake `docker` for the reclaim's sweeps). */
  async addCommand(name: string, script: string): Promise<void> {
    await writeFile(join(this.dir, 'bin', name), script);
    await chmod(join(this.dir, 'bin', name), 0o755);
  }

  async table(): Promise<Table> {
    return JSON.parse(await readFile(this.state, 'utf8')) as Table;
  }

  /** The rules of one chain, in order, as `iptables -S` would print their specs (unquoted). */
  async chain(name: string): Promise<string[]> {
    return (await this.table()).rules.filter((r) => r.chain === name).map((r) => r.spec);
  }

  /**
   * Runs a rule script under /bin/sh. `drop`, when set, makes iptables-restore
   * silently skip every line containing it — a rule change that did not land.
   */
  run(script: string, options: { readonly drop?: string } = {}): Promise<ScriptRun> {
    const redirected = script
      .replaceAll('/etc/hosts', join(this.dir, 'hosts'))
      .replaceAll('/run/asha-iptables.lock', join(this.dir, 'lock'));
    const env: NodeJS.ProcessEnv = {
      PATH: `${join(this.dir, 'bin')}:${this.shared}:/usr/bin:/bin`,
      FAKE_IPTABLES_STATE: this.state,
      ...(options.drop === undefined ? {} : { FAKE_IPTABLES_DROP: options.drop }),
    };
    return new Promise((resolve, reject) => {
      const child = execFile('/bin/sh', ['-s'], { env, timeout: 20_000 }, (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== 'number') {
          reject(error instanceof Error ? error : new Error(JSON.stringify(error)));
          return;
        }
        resolve({ code: error === null ? 0 : (error.code as number), stdout, stderr });
      });
      child.stdin?.end(redirected);
    });
  }
}
