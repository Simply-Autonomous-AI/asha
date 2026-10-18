// P2 · Router (triage): the demo of docs/patterns/p02-router.md on the real model (docs/plans/patterns-phase-1.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-1.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P02_A, P02_B, P02_C } from './patterns/phase-1.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p02-router.md', REPO);
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p02-router', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P2 · Router (triage) — teams/router/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, ['router-1', 'desk-a-1', 'desk-b-1', 'desk-c-1']);
  });

  it('p02-a: router-1 routes a translation', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p02-a',
      title: 'p02-a: router-1 routes a translation',
      expectation: 'router-1 sends the request to desk-a-1 alone, which replies "Merci"; no other desk takes part.',
      agents: ['router-1', 'desk-a-1', 'desk-b-1', 'desk-c-1'],
      claims: P02_A,
    });
  });

  it('p02-b: router-1 routes a sum', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p02-b',
      title: 'p02-b: router-1 routes a sum',
      expectation: 'router-1 sends the request to desk-b-1 alone, which replies 42.',
      agents: ['router-1', 'desk-a-1', 'desk-b-1', 'desk-c-1'],
      claims: P02_B,
    });
  });

  it('p02-c: router-1 routes a "say"', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p02-c',
      title: 'p02-c: router-1 routes a "say"',
      expectation: 'router-1 sends the request to desk-c-1 alone, which replies "Hello World".',
      agents: ['router-1', 'desk-a-1', 'desk-b-1', 'desk-c-1'],
      claims: P02_C,
    });
  });
});
