// P12 · Group chat, self-selection: the demo of docs/patterns/p12-self-selection.md on the real model (docs/plans/patterns-phase-1.md R2).
// It runs the team's launch and each scenario's message exactly as the page's
// run-command block gives them, and asserts each scenario only through its
// checker (tests/agents/patterns/phase-1.ts), whose proof it records for the
// report. Nothing is faked.

import { afterAll, beforeAll, describe, it } from 'vitest';

import { readRunBlock } from '../../evals/patterns/run-block.js';
import { launchTeam, runScenario } from './patterns/demo.js';
import { P12_A, P12_B, P12_C } from './patterns/phase-1.js';
import { REPO, agentSuite, type AgentSuite } from './support.js';

const block = readRunBlock('docs/patterns/p12-self-selection.md', REPO);
let suite: AgentSuite;

beforeAll(async () => {
  suite = await agentSuite('p12-self-selection', 'main');
});

afterAll(async () => {
  await suite.finish();
});

describe('P12 · Group chat, self-selection — teams/self-select/', () => {
  it('launches the team', async (context) => {
    await launchTeam(suite, context, block, ['greeter-1', 'translator-1']);
  });

  it('p12-a: a translation to everyone', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p12-a',
      title: 'p12-a: a translation to everyone',
      expectation: 'translator-1 replies "Bonjour"; greeter-1 passes; no agent forwards it.',
      agents: ['greeter-1', 'translator-1'],
      claims: P12_A,
    });
  });

  it('p12-b: a "say" to everyone', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p12-b',
      title: 'p12-b: a "say" to everyone',
      expectation: 'greeter-1 replies "Hello World"; translator-1 passes.',
      agents: ['greeter-1', 'translator-1'],
      claims: P12_B,
    });
  });

  it('p12-c: work no member does, to everyone', async (context) => {
    await runScenario({
      suite,
      context,
      block,
      id: 'p12-c',
      title: 'p12-c: work no member does, to everyone',
      expectation: 'Both pass; the harness says no agent could answer, listing both; the command exits 1.',
      agents: ['greeter-1', 'translator-1'],
      claims: P12_C,
    });
  });
});
