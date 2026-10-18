// Teams and recipe documents on the real model (docs/plans/collaborating-agents.md
// A2–A5): team folders launched with `./asha --launch team=<team>`, agents whose
// recipes place documents in their /workspace, and members that keep their own
// memory — real agents in their containers, through ./asha, the daemon and the
// pinned model. The fixture teams are teams/suite-*/. Nothing is faked.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeKey } from '../../images/memory/src/memory/index.js';
import { fileTools } from '../../src/agent-sdk/file-tools.js';
import { present } from '../../src/shared/assert-present.js';
import { REPO, agentSuite, containerOf, eventually, outputs, readContainerMemory, type AgentSuite } from './support.js';

const DOCKER_HOST = `unix://${homedir()}/.colima/default/docker.sock`;
const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

/** Runs a command against colima's docker; a hung one is killed and fails (PRINCIPLES §14.5). */
function docker(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      [...args],
      { env: { ...process.env, DOCKER_HOST }, timeout: 60_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error && error.killed) {
          reject(new Error(`docker ${args.join(' ')} exceeded 60 s\n${stderr}`));
          return;
        }
        if (error && typeof error.code !== 'number') {
          const dockerError: Error = present(error, 'the docker exec error');
          reject(dockerError);
          return;
        }
        resolve({ code: typeof error?.code === 'number' ? error.code : 0, stdout, stderr });
      },
    );
  });
}

let suite: AgentSuite;

type LogRecord = Record<string, unknown>;
/**
 * The file each write record belongs to, and the tool that made it: every `tool.file_written` is logged inside its
 * call, which then logs `tool.called` (src/agent-sdk/tools.ts), so each write record pairs with the next call record.
 */
function writesByTool(
  records: readonly LogRecord[],
): { readonly path: string; readonly tool: string; readonly size: unknown; readonly sha256: unknown }[] {
  const pairs = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = present(records[i], `records[${String(i)}]`);
    if (record['event'] !== 'tool.file_written') continue;
    const call = records.slice(i + 1).find((r) => r['event'] === 'tool.called' || r['event'] === 'tool.failed');
    pairs.push({
      path: String(record['path']),
      tool: (call?.['tool'] as string | undefined) ?? 'none',
      size: record['size'],
      sha256: record['sha256'],
    });
  }
  return pairs;
}

/** The JSON records of one agent's log; plain lines are skipped. */
function agentRecords(container: string): LogRecord[] {
  return readFileSync(join(suite.home, 'logs', 'agents', `${container}.log`), 'utf8')
    .split('\n')
    .flatMap((line) => {
      if (!line.startsWith('{')) return [];
      try {
        return [JSON.parse(line) as LogRecord];
      } catch (error) {
        // A plain line that starts with a brace is not a record; anything else is a defect of this helper.
        if (error instanceof SyntaxError) return [];
        throw error;
      }
    });
}

const GUIDE = join(REPO, 'teams', 'suite-guided', 'guides', 'keeping.md');

/**
 * The result list_files returns for `guides` in a workspace holding the recipe folder's documents: the real tool run
 * on the recipe folder itself, whose `guides` is what the container's copy starts as. Its JSON is what the agent's
 * `tool.called` record hashes (src/agent-sdk/tools.ts).
 */
async function guidesListing(): Promise<string> {
  const log = {
    info: () => undefined,
    warn: () => undefined,
    error: (event: string) => {
      throw new Error(`list_files logged ${event}`);
    },
  };
  const listed = await present(
    fileTools({
      workspace: join(REPO, 'teams', 'suite-guided'),
      channelSpace: null,
      handle: 'keeper-1',
      log,
    }).get('list_files'),
    'the list_files tool',
  ).run({ path: 'guides' }, new AbortController().signal);
  if (!listed.ok) throw new Error(`list_files of the recipe folder's guides failed: ${listed.reason}`);
  return JSON.stringify(listed.value);
}

beforeAll(async () => {
  suite = await agentSuite('teams', 'crew');
});

afterAll(async () => {
  await suite.finish();
});

describe('teams and recipe documents on the real model', () => {
  it('launches a two-member team on one channel, each member under its team name; broken teams fail naming the member (A4)', async (ctx) => {
    suite.begin(ctx, {
      id: 'team-launch',
      title: 'Launch teams/suite-duo, then two broken teams',
      agents: [],
      expectation:
        'suite-duo exits 0, printing lead-1 and helper-1, and --status lists both on channel crew; suite-missing-recipe and suite-outside-document exit 1, naming the member and the reason.',
    });
    const duo = await suite.send(ctx, ['--launch', 'team=suite-duo', 'channel=crew'], 900_000);
    expect([duo.code, duo.stdout], duo.stderr).toEqual([0, 'lead-1\nhelper-1\n']);
    const status = await suite.asha(['--status'], 60_000);
    expect(status.code).toBe(0);
    expect(status.stdout.split('\n').filter((l) => l.startsWith('  '))).toEqual([
      '  helper-1  channel=crew recipe=sayer image=hello-world',
      '  lead-1  channel=crew recipe=sayer image=hello-world',
    ]);

    const missing = await suite.asha(['--launch', 'team=suite-missing-recipe', 'channel=broken'], 300_000);
    expect([missing.code, missing.stdout]).toEqual([1, '']);
    expect(missing.stderr).toContain(`member "ghost": recipe "ghost.json" does not exist in the team's folder`);
    const outside = await suite.asha(['--launch', 'team=suite-outside-document', 'channel=broken'], 300_000);
    expect([outside.code, outside.stdout]).toEqual([1, '']);
    expect(outside.stderr).toContain('team suite-outside-document: member "stray" did not start:');
    expect(outside.stderr).toContain(`document "borrowed.md" resolves to ${GUIDE}, outside`);
    // Neither broken team left a member on the channel.
    const after = await suite.asha(['--status'], 60_000);
    expect(after.stdout.split('\n').filter((l) => l.startsWith('  ') && l.includes('channel=broken'))).toEqual([]);
  });

  it("an agent lists its /workspace, reads its recipe's document there, and appends a line to it (A2)", async (ctx) => {
    suite.begin(ctx, {
      id: 'documents-in-workspace',
      title: 'keeper-1 lists, reads and appends to guides/keeping.md',
      agents: ['keeper-1'],
      expectation:
        "A list_files call returns the listing of the recipe folder's guides/ (keeping.md, at its size); the read returns the recipe folder's bytes; after the append, the copy in the container ends with the line.",
    });
    expect((await suite.send(ctx, ['--launch', 'team=suite-guided', 'channel=docs'], 900_000)).code).toBe(0);
    // list_files lists one directory (not recursive), so the agent is asked for the document's folder: a request
    // for "every path" was answered with the top level alone, `guides` (run at 7ec14b0, 2026-09-29).
    const listed = await suite.send(
      ctx,
      ['channel=docs', 'to=keeper-1', 'user=alice', 'message=List the files in the guides folder of your workspace.'],
      300_000,
    );
    expect(listed.code, listed.stderr).toBe(0);
    expect(listed.stdout).toContain('keeping.md');

    const guide = readFileSync(GUIDE, 'utf8');
    // The bytes read are proven by the tool's result hash below; the reply need only carry the title. Asked for
    // "its first line exactly", keeper-1 replied "#" alone (run at e9b3bbb, 2026-09-29).
    const title = present(guide.split('\n')[0], "the guide's first line").replace(/^# /, '');
    const read = await suite.send(
      ctx,
      ['channel=docs', 'to=keeper-1', 'user=alice', 'message=Read guides/keeping.md and reply with its title.'],
      300_000,
    );
    expect(read.code, read.stderr).toBe(0);
    expect(read.stdout).toContain(title);
    // The read returned the recipe folder's bytes: a read_file result whose sha256 is that of the whole file's result.
    const whole = JSON.stringify({ content: guide, size: Buffer.byteLength(guide) });
    const records = agentRecords(containerOf(suite.home, 'docs', 'keeper-1'));
    expect(
      records.filter((r) => r['event'] === 'tool.called' && r['tool'] === 'read_file').map((r) => r['resultSha256']),
    ).toContain(sha256(whole));
    // The listing is proven by the tool's own result, not the reply: keeping.md is a full-text document, so its name
    // is in the system prompt and a reply could name it with no listing at all (the completion review, 2026-09-29).
    expect(
      records.filter((r) => r['event'] === 'tool.called' && r['tool'] === 'list_files').map((r) => r['resultSha256']),
    ).toContain(sha256(await guidesListing()));

    const appended = await suite.send(
      ctx,
      ['channel=docs', 'to=keeper-1', 'user=alice', "message=Add the line 'checked by keeper' to guides/keeping.md."],
      300_000,
    );
    expect(appended.code, appended.stderr).toBe(0);
    const container = containerOf(suite.home, 'docs', 'keeper-1');
    const copy = await docker(['exec', container, 'cat', '/workspace/guides/keeping.md']);
    expect(copy.code, copy.stderr).toBe(0);
    expect(copy.stdout.startsWith(readFileSync(GUIDE, 'utf8'))).toBe(true);
    expect(copy.stdout.trimEnd().endsWith('checked by keeper')).toBe(true);
    expect(outputs(appended.events).map((o) => o.from)).toEqual(['keeper-1']);
  });

  it("an agent's writes change only its own copy, recorded, and a new launch starts from the recipe folder's documents (A3)", async (ctx) => {
    suite.begin(ctx, {
      id: 'documents-per-run',
      title: 'keeper-1 edits its guidance and writes notes; a new launch starts clean',
      agents: ['keeper-1'],
      expectation:
        "The recipe folder's guidance is byte-identical afterwards; the agent log holds one write record per write and append, each matching the copy; after a relaunch the guidance is the recipe folder's again and notes.txt is gone.",
    });
    const before = sha256(readFileSync(GUIDE));
    expect((await suite.send(ctx, ['--launch', 'team=suite-guided', 'channel=runs'], 900_000)).code).toBe(0);
    const append = await suite.send(
      ctx,
      ['channel=runs', 'to=keeper-1', 'user=alice', "message=Add the line 'edited in this run' to guides/keeping.md."],
      300_000,
    );
    expect(append.code, append.stderr).toBe(0);
    const write = await suite.send(
      ctx,
      [
        'channel=runs',
        'to=keeper-1',
        'user=alice',
        "message=Write the file notes.txt with exactly the text 'remember the milk'.",
      ],
      300_000,
    );
    expect(write.code, write.stderr).toBe(0);

    const container = containerOf(suite.home, 'runs', 'keeper-1');
    const records = agentRecords(container);
    const written = records.filter((r) => r['event'] === 'tool.file_written');
    // Exactly one write record per write_file and append_file call the log shows: as many records as such calls, and
    // the guidance changed by an append, the notes by a write — at least one of each.
    const calls = records.filter(
      (r) => r['event'] === 'tool.called' && (r['tool'] === 'write_file' || r['tool'] === 'append_file'),
    );
    expect(written).toHaveLength(calls.length);
    const pairs = writesByTool(records);
    expect(pairs.filter((p) => p.path === '/workspace/guides/keeping.md').map((p) => p.tool)).toContain('append_file');
    expect(pairs.filter((p) => p.path === '/workspace/notes.txt').map((p) => p.tool)).toContain('write_file');
    expect(
      pairs.every((p) => p.tool === 'write_file' || p.tool === 'append_file'),
      JSON.stringify(pairs),
    ).toBe(true);
    for (const w of written) {
      expect(w['handle']).toBe('keeper-1');
      expect(w['sha256']).toMatch(/^[0-9a-f]{64}$/);
    }
    // The last record of each file matches the copy in the container now.
    for (const path of ['/workspace/guides/keeping.md', '/workspace/notes.txt']) {
      const last = present(written.filter((w) => w['path'] === path).at(-1), `a write record for ${path}`);
      const copy = await docker(['exec', container, 'cat', path]);
      expect(copy.code, copy.stderr).toBe(0);
      expect([sha256(copy.stdout), Buffer.byteLength(copy.stdout)], path).toEqual([last['sha256'], last['size']]);
    }
    expect(sha256(readFileSync(GUIDE)), "the recipe folder's document").toBe(before);

    // Stopped and launched again: the copy is the recipe folder's, and the run's own file is gone.
    expect((await suite.asha(['--stop'], 100_000)).code).toBe(0);
    expect((await suite.send(ctx, ['--launch', 'team=suite-guided', 'channel=runs'], 900_000)).code).toBe(0);
    const again = containerOf(suite.home, 'runs', 'keeper-1');
    expect(again).not.toBe(container);
    const fresh = await docker(['exec', again, 'cat', '/workspace/guides/keeping.md']);
    expect(sha256(fresh.stdout)).toBe(before);
    const notes = await docker(['exec', again, 'ls', '/workspace']);
    expect(notes.stdout.split('\n').filter((l) => l !== '')).toEqual(['guides']);
  });

  it('each memory member of a team keeps its own tiers: a fact told to ann is not recalled by bob (A5)', async (ctx) => {
    suite.begin(ctx, {
      id: 'team-memory',
      title: 'Tell ann-1 a fact, then ask bob-1',
      agents: ['ann-1', 'bob-1'],
      expectation:
        "ann-1's memory holds the code and bob-1's does not; bob-1 does not state it. Its recipe says to reply that it does not know when written to; the pinned model has passed instead (debt D36), so either is accepted, a pass answered by the harness with exit 1.",
    });
    expect((await suite.send(ctx, ['--launch', 'team=suite-memory-pair', 'channel=memo'], 900_000)).code).toBe(0);
    const told = await suite.send(
      ctx,
      ['channel=memo', 'to=ann-1', 'user=alice', 'message=Please remember that my locker code is 4417.'],
      300_000,
    );
    expect(told.code, told.stderr).toBe(0);
    // The isolation itself, read from each member's own store: ann-1 keeps the code, bob-1 holds nothing of it.
    const alice = scopeKey({ channel: 'memo', user: 'alice' });
    const memoryOf = (handle: string) => readContainerMemory(containerOf(suite.home, 'memo', handle), alice);
    const ann = await eventually(
      () => memoryOf('ann-1'),
      (m) => JSON.stringify(m).includes('4417'),
      90_000,
    );
    expect(JSON.stringify(ann), 'ann-1 remembers the code').toContain('4417');
    expect(JSON.stringify(await memoryOf('bob-1')), 'bob-1 holds nothing of it').not.toContain('4417');

    const asked = await suite.send(
      ctx,
      ['channel=memo', 'to=bob-1', 'user=alice', 'message=What is my locker code?'],
      300_000,
    );
    expect(asked.stdout).not.toContain('4417');
    expect(asked.stderr).not.toContain('4417');
    const replied = outputs(asked.events).filter((o) => o.from === 'bob-1');
    const passed = asked.events.filter((e) => e.type === 'status' && e.from === 'bob-1' && e.text.startsWith('pass'));
    // Exactly one of the two: bob-1's own reply (its recipe), or its pass and the harness's answer (D36).
    expect([replied.length, passed.length], asked.stderr).toSatisfy(
      ([r, p]: number[]) => (r === 1 && p === 0) || (r === 0 && p === 1),
    );
    if (passed.length === 1) {
      expect(outputs(asked.events)).toEqual([{ from: 'asha', to: 'alice' }]);
      expect(asked.stdout).toMatch(/^No agent could answer this:\n- bob-1 passed(: .+)?\n$/);
      expect(asked.code).toBe(1);
    } else {
      expect(outputs(asked.events)).toEqual([{ from: 'bob-1', to: 'alice' }]);
      expect(asked.code, asked.stderr).toBe(0);
    }
  });
});
