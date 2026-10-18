import { defineConfig } from 'vitest/config';

// Unit tests: every collaborator is injected. No network beyond 127.0.0.1 listeners
// the tests start themselves, no docker, no model.
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // Not beside an agent suite or eval: its CPU load breaks their timing bounds (tests/helpers/suite-lock.ts).
    globalSetup: ['tests/helpers/run-temp.global.ts', 'tests/helpers/refuse-agent-suite.global.ts'],
    // No connection to any address but loopback (extension-modules A17): a test that reaches out fails, naming it.
    setupFiles: ['tests/helpers/network-guard.setup.ts', 'tests/helpers/fake-clock-guard.setup.ts'],
    // Line and branch coverage of the code the unit tests exercise: `npm run test:coverage`
    // (off for a plain `npm test`). Reports land in coverage/, which git ignores.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'images/*/src/**/*.ts'],
      reporter: ['text', 'json-summary', 'json'],
    },
  },
});
