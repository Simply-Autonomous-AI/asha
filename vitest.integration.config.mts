import { defineConfig } from 'vitest/config';

// Integration tests: the real daemon HTTP server on a loopback port, every
// endpoint over the real wire contract. Container runtime and model server are
// fakes; the fake container runs the real hello-world agent code against the
// daemon over HTTP.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // Not beside an agent suite or eval: its CPU load breaks their timing bounds (tests/helpers/suite-lock.ts).
    // Then the portal's page, compiled into a folder of this run's own (docs/plans/portal.md R2).
    globalSetup: [
      'tests/helpers/run-temp.global.ts',
      'tests/helpers/refuse-agent-suite.global.ts',
      'tests/helpers/portal-build.global.ts',
    ],
    // No connection to any address but loopback (extension-modules A17): a test that reaches out fails, naming it.
    setupFiles: ['tests/helpers/network-guard.setup.ts', 'tests/helpers/fake-clock-guard.setup.ts'],
  },
});
