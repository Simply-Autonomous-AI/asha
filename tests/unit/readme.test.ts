// The README (docs/plans/oss-release.md R18–R21; A15–A17): its sections in their order; its known limits, each by one
// phrase; every built demo of tests/agents/patterns/demos.json, in its order, with its page's title and exactly the
// commands its page's run block holds, and no other; its prerequisites with their numbers; a quickstart of at most five
// commands from `git clone` to `Hello World.`; and every relative link a `.md` (or other non-HTML) file that exists,
// with no `#fragment` into a docs page, since GitHub's heading ids differ from the renderer's.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { present } from '../../src/shared/assert-present.js';

const ROOT = join(import.meta.dirname, '..', '..');
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

/** README's text under one `## ` heading, up to the next. */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`no section "## ${heading}"`);
  const end = markdown.indexOf('\n## ', start + 1);
  return end === -1 ? markdown.slice(start) : markdown.slice(start, end);
}

/** Each demo README lists: its page, its title, and its commands, in the README's order. */
function listedDemos(
  markdown: string,
): { readonly page: string; readonly title: string; readonly commands: string[] }[] {
  return [
    ...section(markdown, 'The demos').matchAll(
      /^- \*\*\[([^\]]+)\]\(\.\/([^)]+)\)\*\*\n\n {2}```sh\n([\s\S]*?) {2}```$/gm,
    ),
  ].map((m) => ({
    title: present(m[1], 'the title'),
    page: present(m[2], 'the page'),
    commands: present(m[3], 'the commands')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== ''),
  }));
}

/** Each demo as its manifest and page give it: the page, its `# ` title, and its run block's `./asha` lines. */
function builtDemos(): { readonly page: string; readonly title: string; readonly commands: string[] }[] {
  const demos = JSON.parse(readFileSync(join(ROOT, 'tests', 'agents', 'patterns', 'demos.json'), 'utf8')) as {
    readonly page: string;
  }[];
  return demos.map((d) => {
    const page = readFileSync(join(ROOT, d.page), 'utf8');
    const block = present(/^```asha-run\n([\s\S]*?)^```/m.exec(page)?.[1], `${d.page}'s run block`);
    return {
      page: d.page,
      title: present(/^# (.+)$/m.exec(page)?.[1], `${d.page}'s title`),
      commands: block.split('\n').filter((l) => l.startsWith('./asha ')),
    };
  });
}

type Demo = ReturnType<typeof builtDemos>[number];

/** How one listed demo differs from its built one, at the place `i` it should be listed. */
function oneDemo(listed: readonly Demo[], l: Demo, b: Demo, i: number): string[] {
  const at = listed.indexOf(l);
  return [
    ...(at === i ? [] : [`${b.page}: listed at ${String(at + 1)}, not ${String(i + 1)}`]),
    ...(l.title === b.title ? [] : [`${b.page}: titled "${l.title}", not "${b.title}"`]),
    ...(JSON.stringify(l.commands) === JSON.stringify(b.commands)
      ? []
      : [`${b.page}: its commands differ from its page's`]),
  ];
}

/** Each way README's demo list differs from the built demos, naming the demo. */
function demoProblems(listed: readonly Demo[], built: readonly Demo[]): string[] {
  const problems: string[] = [];
  for (const [i, b] of built.entries()) {
    const l = listed.find((x) => x.page === b.page);
    problems.push(...(l === undefined ? [`${b.page}: not listed`] : oneDemo(listed, l, b, i)));
  }
  for (const l of listed)
    if (!built.some((b) => b.page === l.page)) problems.push(`${l.page}: listed, and no built demo`);
  return problems;
}

describe('the README (oss-release R18–R21; A15–A17)', () => {
  it('has the sections R18 names, in its order', () => {
    expect([...README.matchAll(/^## (.+)$/gm)].map((m) => m[1])).toEqual([
      'What asha is',
      'Why it exists',
      'Quickstart',
      'Architecture',
      'The demos',
      'Known limits',
      'Documentation',
      'Contributing and security',
      'Licence and model credits',
    ]);
    // The portal's Watch-tab screenshot, with its caption, opens the README: after the title, right before the first
    // section (the owner, 2026-10-18).
    const shot = README.indexOf('](assets/portal-watch.png)');
    expect(README.split('](assets/portal-watch.png)').length - 1).toBe(1);
    expect(shot).toBeGreaterThan(README.indexOf('\n# asha — '));
    const between = README.slice(README.indexOf('\n', shot), README.indexOf('\n## What asha is'));
    expect(between.trim()).toMatch(/^\*The portal's Watch tab[^*]*\*$/);
    // The demos open with the combined video's title card, linking the video on YouTube, and a caption whose figures
    // are the committed sidecar's (the owner, 2026-10-18).
    const video = 'https://www.youtube.com/watch?v=4QG465Mp5Hw';
    const demos = section(README, 'The demos').replace('\n## The demos\n', '').trimStart();
    const [image = '', , ...rest] = demos.split('\n');
    expect(image).toBe(
      `[![Watch the pattern demos on YouTube: the video's title card, ASHA - Autonomous Simple Harness for Agents, Demo: Multi-Agent Orchestration Patterns, with a play button](assets/demo-video.jpg)](${video})`,
    );
    const caption = rest.slice(0, rest.indexOf('')).join(' ');
    const reel = JSON.parse(readFileSync(resolve(ROOT, 'docs/patterns/videos/demos.json'), 'utf8')) as {
      parts: unknown[];
      durationMs: number;
      leftOut: string[];
    };
    const seconds = Math.round(reel.durationMs / 1000);
    expect(reel.parts).toHaveLength(24); // "Twenty-four": a new reel changes this line and the caption's word together
    expect(caption).toBe(
      `*Twenty-four of the demos below in one video, ${String(Math.floor(seconds / 60))} min ${String(seconds % 60)} s ` +
        `(${reel.leftOut.join(', ')} is not in it): [watch it on YouTube](${video}).*`,
    );
    const why = section(README, 'Why it exists');
    for (const phrase of [
      'locally, with open-weight models, at no',
      'not:** a hosted or production agent platform',
      'one maintainer',
      'before version 1.0',
    ])
      expect(why.replace(/\s+/g, ' '), phrase).toContain(phrase);
  });

  it('states each known limit R19 names', () => {
    const limits = section(README, 'Known limits').replace(/\s+/g, ' ');
    for (const phrase of [
      'macOS on Apple silicon only.** Linux, Windows and CUDA are deferred',
      'pass on their pinned models,** in their recorded runs; they are not claimed for any other model',
      'Small local models misroute,** and some demos pass only around what the model cannot do',
      'full gate needs a Mac with its GPU,** about 45 minutes',
      'continuous integration runs only the checks that need neither',
      'cloud modules are optional and have never been called live',
      'share one colima VM** with anything else that uses it',
      'callouts, fact boxes and heading ids show as raw Markdown',
    ])
      expect(limits, phrase).toContain(phrase);
  });

  it('lists every built demo, in its order, with its page title and exactly its commands, and no other (R20, A16)', () => {
    const built = builtDemos();
    expect(built).toHaveLength(25);
    expect(demoProblems(listedDemos(README), built)).toEqual([]);
  });

  it('names the demo when one is left out, or a command is changed (A16)', () => {
    const built = builtDemos();
    const listed = listedDemos(README);
    // P5 left out: it is named, and each demo after it is named as one place early.
    const at = listed.findIndex((l) => l.page.includes('p05-'));
    const without = listed.filter((_, i) => i !== at);
    expect(demoProblems(without, built)).toEqual([
      'docs/patterns/p05-orchestrator-workers.md: not listed',
      ...without.slice(at).map((l, i) => `${l.page}: listed at ${String(at + i + 1)}, not ${String(at + i + 2)}`),
    ]);
    const changed = listed.map((l) =>
      l.page.includes('p02-')
        ? { ...l, commands: [...l.commands.slice(0, -1), './asha to=router-1 message="Hi."'] }
        : l,
    );
    expect(demoProblems(changed, built)).toEqual(["docs/patterns/p02-router.md: its commands differ from its page's"]);
  });

  it('gives the prerequisites with their numbers, and a quickstart of at most five commands to Hello World. (R21)', () => {
    const quick = section(README, 'Quickstart');
    const engines = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { engines: { node: string } })
      .engines.node;
    expect(quick).toContain(`Node.js \`${engines}\``);
    const commands = present(/```sh\n([\s\S]*?)```/.exec(quick)?.[1], 'the quickstart block')
      .trim()
      .split('\n');
    expect(commands.length).toBeLessThanOrEqual(5);
    expect(commands[0]).toMatch(/^git clone /);
    expect(commands.at(-1)).toBe('./asha recipe=hello-world message="Please say: Hello World."');
    expect(quick).toContain('prints `Hello World.`');
    // Each model's size from its catalogue entry, as the README states it.
    for (const id of ['pico-v2-q8_0', 'qwen3-8b-q4_k_m', 'qwen3-embedding-0.6b-q8_0']) {
      const entry = JSON.parse(readFileSync(join(ROOT, 'catalogue', `${id}.json`), 'utf8')) as {
        files: { path: string; size: number }[];
      };
      const weights = present(
        entry.files.find((f) => f.path.endsWith('.gguf')),
        `${id}'s weights`,
      );
      expect(quick, id).toContain(`\`${id}\``);
      expect(quick, id).toContain(`${weights.size.toLocaleString('en-US')} bytes`);
    }
    for (const phrase of [
      'gitleaks 8.30.1',
      'Playwright',
      'Tested on:** an Apple M4 Pro',
      'No minimum memory, disk or macOS version has',
    ])
      expect(quick.replace(/\s+/g, ' '), phrase).toContain(phrase);
  });

  it('links only files that exist, docs pages by their .md source, with no #fragment into one (R21, A17)', () => {
    const bad: string[] = [];
    for (const m of README.matchAll(/\]\(([^)\s]+)\)|<img src="([^"]+)"/g)) {
      const url = present(m[1] ?? m[2], 'the link');
      if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue;
      const [path, fragment] = url.split('#', 2) as [string, string?];
      const file = resolve(ROOT, dirname('README.md'), path);
      if (!existsSync(file)) bad.push(`${url}: no such file`);
      if (path.endsWith('.html')) bad.push(`${url}: a rendered page, not its .md source`);
      if (fragment !== undefined && path.startsWith('./docs/')) bad.push(`${url}: a #fragment into a docs page`);
    }
    expect(bad).toEqual([]);
  });
});
