// No image carries a system prompt (docs/plans/collaborating-agents.md R1, A8):
// an agent's role is its recipe's `prompt`, handed over in the welcome event, so
// one image serves every recipe that names it. Checked by importing every module
// of every image and looking at what it exports — not by a text search, which
// would match the chat messages an image builds ({ role: 'user', … }).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const IMAGES = join(ROOT, 'images');

function sources(dir: string, extension: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return sources(join(dir, e.name), extension);
    return e.name.endsWith(extension) ? [join(dir, e.name)] : [];
  });
}

/** Every image's TypeScript sources, images/<image>/src/**. */
const files = readdirSync(IMAGES, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .flatMap((e) => sources(join(IMAGES, e.name, 'src'), '.ts'));
/** An image's entry point starts the agent when imported (it reads ASHA_URL and joins the channel), so it is not imported. */
const isEntry = (file: string): boolean => file.endsWith(join('src', 'main.ts'));

/** Every checked-in recipe's prompt — recipes/ and every team folder — so an image holding a copy of one is caught. */
const PROMPTS = [
  ...sources(join(ROOT, 'recipes'), '.json'),
  ...sources(join(ROOT, 'teams'), '.json').filter((f) => !f.endsWith('team.json')),
]
  .map((f) => (JSON.parse(readFileSync(f, 'utf8')) as { prompt?: unknown }).prompt)
  .filter((p): p is string => typeof p === 'string');

/**
 * The exports of a module that carry a role: one named like a role or prompt (`PERSONA`, `ROLE`, `PROMPT`,
 * `SYSTEM_PROMPT`, any case), an object with a string `role` or `prompt`, or a string holding a recipe's prompt.
 */
export function roleExports(module: Readonly<Record<string, unknown>>, prompts: readonly string[]): string[] {
  return Object.entries(module)
    .filter(
      ([name, value]) =>
        /^(persona|role|prompt|system_?prompt)$/i.test(name) ||
        (typeof value === 'object' &&
          value !== null &&
          ['role', 'prompt'].some((k) => typeof (value as Record<string, unknown>)[k] === 'string')) ||
        (typeof value === 'string' && prompts.some((p) => value.includes(p))),
    )
    .map(([name]) => name);
}

describe('no image carries a system prompt (collaborating-agents R1, A8)', () => {
  it('finds the modules it checks and the prompts it looks for: both images, their agents and the memory tiers', () => {
    const names = files.map((f) => relative(ROOT, f));
    expect(names).toEqual(
      expect.arrayContaining([
        'images/hello-world/src/agent.ts',
        'images/hello-world/src/main.ts',
        'images/memory/src/agent.ts',
        'images/memory/src/memory/index.ts',
      ]),
    );
    expect(PROMPTS.length).toBeGreaterThanOrEqual(3);
  });

  it.each(files.filter((f) => !isEntry(f)).map((f) => [relative(ROOT, f), f]))(
    '%s exports no role, persona or prompt',
    async (_, file) => {
      const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      expect(roleExports(module, PROMPTS)).toEqual([]);
    },
  );

  it.each(files.filter(isEntry).map((f) => [relative(ROOT, f), f]))(
    '%s, an entry point, exports nothing at all',
    (_, file) => {
      const exportsSomething = readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => /^\s*export\s/.test(line));
      expect(exportsSomething).toBe(false);
    },
  );

  it('the check itself names each shape a role can take: the old PERSONA and ROLE, an object with a role or prompt, a copied prompt', () => {
    const prompt = 'you say what you are asked to say.';
    expect(
      roleExports(
        {
          PERSONA: { tools: [] },
          ROLE: 'text',
          systemPrompt: 'x',
          persona: { role: 'you say things.' },
          setup: { prompt: 'p' },
          GREETING: `Hi. ${prompt}`,
          messages: [{ role: 'user' }],
          NAME: 'hewo',
          n: 3,
        },
        [prompt],
      ),
    ).toEqual(['PERSONA', 'ROLE', 'systemPrompt', 'persona', 'setup', 'GREETING']);
  });
});
