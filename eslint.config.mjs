// The linter: ESLint with typescript-eslint's type-checked strict rules, ESLint's recommended rules and SonarJS's
// recommended rules (docs/quality/index.md#lint). `npm run lint` runs it with `--max-warnings 0`, so every finding fails.
//
// Every rule of those three presets is on, at error, with its default options, but for the exemptions below, each
// with its reason; tests/unit/lint.test.ts fails on any other rule switched off, loosened or set to warn. An exemption
// lives in this file, never in the code: `noInlineConfig` makes an `eslint-disable` comment inert and reports it,
// and `reportUnusedDisableDirectives` and `reportUnusedInlineConfigs` make a stale one an error too.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import sonarjs from 'eslint-plugin-sonarjs';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // Not linted: what .gitignore keeps out of git (dependencies, build output, scratch); .claude/, where agents keep
    // their own whole checkouts, and .qa/, the sdlc reviews' runs, both kept out by .git/info/exclude; and
    // evals/probes/, the dated probes kept byte for byte as they ran, the record their plans cite, with the copies of
    // them that shipped tests read (tests/fixtures/probes/, tests/fixtures/README.md).
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'coverage/**',
      '.tmp/**',
      '.vitest/**',
      '.playwright-mcp/**',
      '.claude/**',
      '.qa/**',
      'evals/probes/**',
      'tests/fixtures/probes/**',
    ],
  },

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  sonarjs.configs.recommended,

  {
    linterOptions: {
      noInlineConfig: true,
      reportUnusedDisableDirectives: 'error',
      reportUnusedInlineConfigs: 'error',
    },
    languageOptions: {
      parserOptions: {
        // The three programs `npm run typecheck` checks: the Node one, the portal's page, and the page's DOM tests.
        project: ['./tsconfig.json', './tsconfig.portal.json', './tsconfig.dom-tests.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // asha and its tools run the owner's own git, npm, brew, ps and open from PATH, on the owner's machine, as a
      // shell would; an absolute path would differ between Homebrew prefixes and machines.
      'sonarjs/no-os-command-from-path': 'off',
      // The addresses are the design: the egress proxy's private-range blocklist, colima's fixed host gateway
      // (HOST_GATEWAY, docs/architecture/index.md) and the TEST-NET resolver agents are given.
      'sonarjs/no-hardcoded-ip': 'off',
    },
  },

  {
    // Plain JavaScript is in neither TypeScript program, so it gets the rules that need no types.
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    // In the tests a /tmp path is a path inside an agent's container, or the suites' shared lock files, which live in
    // /tmp by design (rules/gate-and-tests.md).
    files: ['tests/**'],
    rules: { 'sonarjs/publicly-writable-directories': 'off' },
  },
  {
    // These two implement and test the docs' gap marker, so they name it (its test moved with the plans' checks into
    // docs-plans.test.ts, docs/plans/oss-release.md R2).
    files: ['tools/docs/render.mts', 'tests/unit/docs-plans.test.ts'],
    rules: { 'sonarjs/todo-tag': 'off' },
  },
);
