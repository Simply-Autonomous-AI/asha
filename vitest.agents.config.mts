import { configDefaults, defineConfig } from 'vitest/config';

import { buildingExcluded, readBuilding } from './tests/agents/patterns/building.js';

// Agent tests: real agents in their real containers, through ./asha — the
// daemon, colima, the pinned model on llama-server, the agent image and the
// channel. Single-agent and multi-agent scenarios, each recording its full
// transcript for the report (npm run report). Files run one at a time: each
// starts its own daemon, and two would load the 5 GB model twice. The bounds
// are guards: a cold run downloads the model; a run that hits one is a failed
// run (PRINCIPLES §14.5), never a flaky one. A pattern demo still being built —
// listed in tests/agents/patterns/building.json — is left out, unless a recorded
// run names it in ASHA_RECORDED_RUN (docs/plans/patterns-phase-3.md R5).
export default defineConfig({
  test: {
    include: ['tests/agents/**/*.test.ts'],
    exclude: [...configDefaults.exclude, ...buildingExcluded(readBuilding(import.meta.dirname), process.env)],
    // One agent suite or eval at a time on this machine, and no unit or integration run beside it (tests/helpers/suite-lock.ts).
    globalSetup: ['tests/helpers/run-temp.global.ts', 'tests/helpers/take-agent-suite-lock.global.ts'],
    fileParallelism: false,
    testTimeout: 1_200_000,
    hookTimeout: 120_000,
  },
});
