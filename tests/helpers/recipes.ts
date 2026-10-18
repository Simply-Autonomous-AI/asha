// The checked-in recipes as the tests need them: an agent's persona is its
// recipe's prompt and tools (docs/plans/collaborating-agents.md R1, R10), read
// from recipes/*.json through the daemon's own parser, never copied into a test.

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { AgentPersona } from '../../src/agent-sdk/index.js';
import { parseRecipe, type Recipe } from '../../src/daemon/definitions/index.js';
import { recipePersona } from '../../evals/routing/persona.js';

const ROOT = resolve(import.meta.dirname, '..', '..');

/** recipes/<name>.json, parsed. */
function checkedInRecipe(name: string): Recipe {
  const file = join(ROOT, 'recipes', `${name}.json`);
  return parseRecipe(JSON.parse(readFileSync(file, 'utf8')), file);
}

/** The hello-world agent's persona: recipes/hello-world.json's prompt and its six common tools. */
export const HELLO_WORLD_PERSONA: AgentPersona = recipePersona(checkedInRecipe('hello-world'));

/** The memory agent's role: recipes/memory.json's prompt. */
export const MEMORY_PROMPT: string = checkedInRecipe('memory').prompt;
