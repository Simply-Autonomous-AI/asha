import { defineConfig } from 'vitest/config';

// The portal's screenshots for its user page (docs/plans/portal.md A8; portal-scene-chat A12): `ASHA_SCREENSHOTS=<probe
// folder> npm run portal:screenshots`, never part of the gate. Each view at 1280×800 and 390×844, written to
// evals/probes/<folder>/screenshots/, against the integration tier's daemon and fakes and its compiled page.
export default defineConfig({
  test: {
    include: ['tests/screenshots/**/*.screenshots.ts'],
    testTimeout: 120_000,
    globalSetup: [
      'tests/helpers/run-temp.global.ts',
      'tests/helpers/refuse-agent-suite.global.ts',
      'tests/helpers/portal-build.global.ts',
    ],
    setupFiles: ['tests/helpers/network-guard.setup.ts'],
  },
});
