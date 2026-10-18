// The persona the routing eval gives an agent: exactly what its recipe gives
// the running agent (docs/plans/collaborating-agents.md R10, A11) — the
// recipe's prompt as its role, its full-text documents as its guidance, and the
// tools the recipe selects, in its order. The running agent gets the same three
// from its welcome event (AgentContext.prompt, .guidance and .tools); the eval
// reads them from the recipe and its folder.

import { dirname } from 'node:path';

import { COMMON_TOOL_DEFINITIONS, type AgentPersona } from '../../src/agent-sdk/index.js';
import { guidanceOf, loadDocuments, type Recipe, type Team } from '../../src/daemon/definitions/index.js';
import { COMMON_TOOL_NAMES, type CommonToolName } from '../../src/shared/tools.js';

/** The recipe's tools. A tool that is not a common tool has no definition here, and fails loudly (PRINCIPLES §9). */
function toolsOf(recipe: Pick<Recipe, 'id' | 'tools'>): AgentPersona['tools'] {
  return recipe.tools.map((name) => {
    if (!(COMMON_TOOL_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `recipe ${recipe.id} selects "${name}", which is not a common tool: the routing eval offers only common tools`,
      );
    }
    return COMMON_TOOL_DEFINITIONS[name as CommonToolName];
  });
}

/** The persona of a recipe that names no documents. */
export function recipePersona(recipe: Pick<Recipe, 'id' | 'prompt' | 'tools' | 'documents'>): AgentPersona {
  if (recipe.documents.length > 0)
    throw new Error(
      `recipe ${recipe.id} names documents: the routing eval reads a team member's with teamMemberPersona`,
    );
  return { role: recipe.prompt, guidance: [], tools: toolsOf(recipe) };
}

/**
 * A team member's persona (collaborating-agents A11): its recipe's prompt, its full-text documents read from its
 * recipe's folder exactly as a launch reads them (loadDocuments, then guidanceOf), and its tools. A document that
 * is not full-text is read by the agent with its file tools from /workspace, which the eval does not give an agent,
 * so such a recipe cannot be measured here and fails loudly.
 */
export async function teamMemberPersona(
  team: Team,
  name: string,
): Promise<{ readonly recipe: Recipe; readonly persona: AgentPersona }> {
  const member = team.members.find((m) => m.name === name);
  if (member === undefined) throw new Error(`team ${team.id} has no member "${name}"`);
  const { recipe } = member;
  const read = recipe.documents.filter((d) => !d.fullText).map((d) => d.path);
  if (read.length > 0)
    throw new Error(
      `recipe ${recipe.id} names documents that are not full-text (${read.join(', ')}): the routing eval gives an agent no /workspace`,
    );
  const documents = await loadDocuments({ recipe, file: member.recipeFile, folder: dirname(member.recipeFile) });
  return {
    recipe,
    persona: { role: recipe.prompt, guidance: guidanceOf(member.recipeFile, documents), tools: toolsOf(recipe) },
  };
}
