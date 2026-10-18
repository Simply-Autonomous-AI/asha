import { defineConfig } from 'vitest/config';

// The opt-in live-vendor check (docs/plans/extension-modules.md R17): `npm run live:modules`, never part of the gate.
// It reaches a vendor through the module's container and the egress proxy in colima, after the checks of R18a; so this
// config has no network guard, and no gate step runs it.
export default defineConfig({
  test: {
    include: ['tests/live/**/*.test.ts'],
    // One vendor call takes seconds; the module image may need building first.
    testTimeout: 600_000,
    globalSetup: ['tests/helpers/run-temp.global.ts', 'tests/helpers/refuse-agent-suite.global.ts'],
  },
});
