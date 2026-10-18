import { defineConfig } from 'vitest/config';

// Eval: the real thing end to end through ./asha — the auto-started daemon,
// colima, the pinned model on llama-server, the agent image, the channel, and
// the exact reply. The bound is generous
// because a cold run downloads the 5 GB model and starts llama-server; it is a guard, and a
// run that hits it is a failed run (PRINCIPLES §14.5), never a flaky one.
export default defineConfig({
  test: {
    include: ['tests/eval/**/*.test.ts'],
    // One agent suite or eval at a time on this machine, and no unit or integration run beside it (tests/helpers/suite-lock.ts).
    globalSetup: ['tests/helpers/run-temp.global.ts', 'tests/helpers/take-agent-suite-lock.global.ts'],
    // One file at a time: each starts its own daemons, and two at once would load the 5 GB model more times over.
    fileParallelism: false,
    testTimeout: 1_200_000,
    hookTimeout: 120_000,
  },
});
