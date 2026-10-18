// The pattern demos the watch view can run (docs/plans/portal-scene-chat.md R16, A19): listDemos over the repo's own
// docs/patterns/ — every page, its team and bound as the agent suite's parser reads them, P20 not runnable (it stops
// the daemon) — and the words-to-request mapping compared, for every message command of every page, with the CLI's
// own parser given the same words; then fixture roots: a malformed block, an unmapped word, no docs/patterns/ at all,
// and the fresh channel past one in use.

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseMessageArgs } from '../../src/cli/commands.js';
import { INJECTED_FAULTS, listDemos } from '../../src/daemon/demos/index.js';
import { demoRequest } from '../../src/shared/demo-request.js';
import { byCodeUnit } from '../../src/shared/order.js';
import type { Demo, DemoProblem } from '../../src/shared/protocol.js';
import { isControl, parseRunBlock } from '../../src/shared/run-block.js';

const REPO = join(import.meta.dirname, '..', '..');
const isDemo = (d: Demo | DemoProblem): d is Demo => !('problem' in d);

describe('listDemos over the repo (portal-scene-chat R16, A19)', () => {
  it("lists every page in order with its team and bound as the suite's parser reads them; P20 is not runnable, naming --stop", async () => {
    const pages = (await readdir(join(REPO, 'docs', 'patterns')))
      .filter((n) => /^p\d{2}-.+\.md$/.test(n))
      .sort(byCodeUnit);
    const answer = await listDemos({ root: REPO, channelExists: () => false });
    expect(answer.shipped).toBe(true);
    expect(answer.demos.map((d) => d.page)).toEqual(pages.map((n) => `docs/patterns/${n}`));
    expect(answer.demos.length).toBeGreaterThanOrEqual(25);
    for (const demo of answer.demos) {
      expect(isDemo(demo), demo.page).toBe(true);
      if (!isDemo(demo)) continue;
      const block = parseRunBlock(demo.page, await readFile(join(REPO, demo.page), 'utf8'));
      expect([demo.team, demo.boundMs]).toEqual([block.team, block.boundMs]);
      expect(demo.channel).toBe(`${demo.page.slice('docs/patterns/'.length, 'docs/patterns/'.length + 3)}-1`);
      expect(demo.title).not.toMatch(/^P\d+ · /);
    }
    const notRunnable = answer.demos.filter(isDemo).flatMap((d) => (d.runnable ? [] : [[d.pattern, d.reason]]));
    expect(notRunnable).toEqual([
      ['P20', 'scenario p20-a runs "./asha --stop", which this page cannot (portal-restart)'],
      [
        'P25',
        "its scenarios need a fault the agent suite injects (worker-1's container paused, then killed), which this page cannot",
      ],
    ]);
    expect(answer.demos.filter(isDemo).find((d) => d.pattern === 'P20')?.scenarios).toEqual([]);
  });

  it('INJECTED_FAULTS names exactly the demos whose agent-suite file pauses or kills a container (PRINCIPLES §21)', async () => {
    const suites = (await readdir(join(REPO, 'tests', 'agents')))
      .filter((n) => /^p\d{2}-.+\.test\.ts$/.test(n))
      .sort(byCodeUnit);
    expect(suites.length).toBeGreaterThanOrEqual(25);
    const faulted: string[] = [];
    for (const name of suites) {
      const text = await readFile(join(REPO, 'tests', 'agents', name), 'utf8');
      if (/docker\(\[\s*'(pause|kill|unpause)'/.test(text) || /\['(pause|kill)',/.test(text))
        faulted.push(`P${String(Number(name.slice(1, 3)))}`);
    }
    expect(faulted).toEqual(Object.keys(INJECTED_FAULTS).sort(byCodeUnit));
  });

  it("maps every message command of every page to the body the CLI's parser gives the same words, channel= appended", async () => {
    let compared = 0;
    for (const name of (await readdir(join(REPO, 'docs', 'patterns'))).filter((n) => /^p\d{2}-.+\.md$/.test(n))) {
      const block = parseRunBlock(name, await readFile(join(REPO, 'docs', 'patterns', name), 'utf8'));
      for (const commands of block.scenarios.values()) {
        for (const args of commands) {
          if (isControl(args)) continue;
          const cli = parseMessageArgs([...args, 'channel=p99-1']);
          expect(typeof cli, `${name}: ${args.join(' ')}`).toBe('object');
          if (typeof cli === 'string') continue;
          expect(cli.files).toEqual([]);
          // Compared before the page replaces @previous: the CLI's parser passes the literal through too.
          expect(demoRequest(args, 'p99-1'), `${name}: ${args.join(' ')}`).toEqual(cli.request);
          compared += 1;
        }
      }
    }
    // Every message command of the 25 pages at eb1755b; an empty loop would compare none.
    expect(compared).toBe(45);
  });
});

describe('demoRequest (R16)', () => {
  it('maps the words the CLI maps, and names the first word it does not', () => {
    expect(demoRequest(['to=lead-1', 'user=alice', 'message=hi'], 'c')).toEqual({
      user: 'alice',
      channel: 'c',
      to: 'lead-1',
      message: 'hi',
    });
    expect(demoRequest(['user=alice', 'conversation=@previous', 'message=yes'], 'c')).toEqual({
      user: 'alice',
      channel: 'c',
      conversation: '@previous',
      message: 'yes',
    });
    expect(demoRequest(['to=ping-1', 'posts=8', 'user=alice', 'message=go'], 'c')).toEqual({
      user: 'alice',
      channel: 'c',
      to: 'ping-1',
      message: 'go',
      budget: { posts: 8 },
    });
    expect(demoRequest(['file=notes.txt', 'message=hi'], 'c')).toEqual({ unmapped: 'file=' });
    expect(demoRequest(['recipe=x', 'message=hi'], 'c')).toEqual({ unmapped: 'recipe=' });
    expect(demoRequest(['to=a-1', 'to=b-1', 'message=hi'], 'c')).toEqual({ unmapped: 'to=' });
    expect(demoRequest(['to=a-1', 'topic=t', 'message=hi'], 'c')).toEqual({ unmapped: 'topic=' });
    expect(demoRequest(['posts=0', 'message=hi'], 'c')).toEqual({ unmapped: 'posts=' });
    expect(demoRequest(['to=a-1'], 'c')).toEqual({ unmapped: 'message= (missing)' });
    expect(demoRequest(['conversation=@previous', 'to=a-1', 'message=hi'], 'c')).toEqual({
      unmapped: 'to= beside conversation=',
    });
  });
});

const made: string[] = [];
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function root(pages: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asha-demos-'));
  made.push(dir);
  await mkdir(join(dir, 'docs', 'patterns'), { recursive: true });
  for (const [name, text] of Object.entries(pages)) await writeFile(join(dir, 'docs', 'patterns', name), text);
  return dir;
}

const page = (heading: string, block: string): string =>
  `---\ntitle: T\n---\n\n# ${heading}\n\n\`\`\`asha-run\n${block}\n\`\`\`\n`;

describe('listDemos over fixture roots (R16, A19)', () => {
  it('a malformed block is listed with its problem; a page using file= is not runnable, naming it', async () => {
    const dir = await root({
      'p01-good.md': page(
        'P1 · Good',
        './asha --launch team=crew\n# bound: 20000 ms\n# p01-a\n./asha to=lead-1 user=alice message="hi"\n# p01-b\n./asha to=lead-1 user=alice message="again"\n./asha user=alice conversation=@previous message="yes"',
      ),
      'p02-bad.md': page('P2 · Bad', './asha to=lead-1 message="no launch first"'),
      'p03-files.md': page(
        'P3 · Files',
        './asha --launch team=crew\n# bound: 20000 ms\n# p03-a\n./asha to=lead-1 user=alice file=notes.txt message="read it"',
      ),
    });
    const answer = await listDemos({ root: dir, channelExists: () => false });
    expect(answer).toEqual({
      shipped: true,
      demos: [
        {
          pattern: 'P1',
          title: 'Good',
          page: 'docs/patterns/p01-good.md',
          team: 'crew',
          boundMs: 20_000,
          channel: 'p01-1',
          runnable: true,
          scenarios: [
            { id: 'p01-a', steps: [{ user: 'alice', channel: 'p01-1', to: 'lead-1', message: 'hi' }] },
            {
              id: 'p01-b',
              steps: [
                { user: 'alice', channel: 'p01-1', to: 'lead-1', message: 'again' },
                { user: 'alice', channel: 'p01-1', conversation: '@previous', message: 'yes' },
              ],
            },
          ],
        },
        {
          pattern: 'P2',
          page: 'docs/patterns/p02-bad.md',
          problem:
            'its first line must be "./asha --launch team=<team>", not: ./asha to=lead-1 message="no launch first"',
        },
        {
          pattern: 'P3',
          title: 'Files',
          page: 'docs/patterns/p03-files.md',
          team: 'crew',
          boundMs: 20_000,
          channel: 'p03-1',
          runnable: false,
          reason: 'scenario p03-a uses file=, which this page does not send',
          scenarios: [],
        },
      ],
    });
  });

  it('the channel is the first pNN-<k> the daemon has not used', async () => {
    const dir = await root({
      'p05-x.md': page(
        'P5 · X',
        './asha --launch team=crew\n# bound: 20000 ms\n# p05-a\n./asha to=lead-1 user=alice message="hi"',
      ),
    });
    const used = new Set(['p05-1', 'p05-2']);
    const answer = await listDemos({ root: dir, channelExists: (name) => used.has(name) });
    expect(answer.demos.map((d) => (isDemo(d) ? [d.channel, d.scenarios[0]?.steps[0]?.channel] : null))).toEqual([
      ['p05-3', 'p05-3'],
    ]);
  });

  it('a root with no docs/patterns/ answers {shipped: false, demos: []}', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asha-demos-none-'));
    made.push(dir);
    expect(await listDemos({ root: dir, channelExists: () => false })).toEqual({ shipped: false, demos: [] });
  });

  it('a page with no "# " heading is listed with its problem', async () => {
    const dir = await root({
      'p07-x.md':
        '```asha-run\n./asha --launch team=crew\n# bound: 20000 ms\n# p07-a\n./asha to=lead-1 user=alice message="hi"\n```\n',
    });
    expect((await listDemos({ root: dir, channelExists: () => false })).demos).toEqual([
      { pattern: 'P7', page: 'docs/patterns/p07-x.md', problem: 'it has no "# " heading' },
    ]);
  });
});
