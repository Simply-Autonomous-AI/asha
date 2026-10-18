// The headless browsers the browser tests drive (docs/plans/portal.md R12): playwright-core 1.63.0's pinned
// chromium-headless-shell and firefox builds, installed once per machine by INSTALL_STEP — never downloaded by
// `npm ci` or during a gate run. Each browser's executable is checked before it is launched, and a missing one fails
// naming that step (Playwright's own error names another package's command).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

import { chromium, firefox, type Browser, type BrowserType } from 'playwright-core';

/** The one-time install step, as the Testing page and the coding workflow give it. */
export const INSTALL_STEP = 'npx playwright-core install --no-remove chromium-headless-shell firefox';

export type BrowserName = 'chromium' | 'firefox';

/** Both browsers the tests run in: Chromium's headless shell and Firefox, the owner's default browser. */
export const BROWSERS: readonly BrowserName[] = ['chromium', 'firefox'];

interface BrowsersJson {
  readonly browsers: readonly { readonly name: string; readonly revision: string }[];
}

/** The revision playwright-core's browsers.json pins for `name`. */
export function pinnedRevision(name: 'chromium-headless-shell' | 'firefox' | 'ffmpeg'): string {
  const require = createRequire(import.meta.url);
  // browsers.json is not among the package's exports: found beside its package.json, which is.
  const file = join(dirname(require.resolve('playwright-core/package.json')), 'browsers.json');
  const json = JSON.parse(readFileSync(file, 'utf8')) as BrowsersJson;
  const entry = json.browsers.find((b) => b.name === name);
  if (entry === undefined) throw new Error(`playwright-core's browsers.json names no ${name}`);
  return entry.revision;
}

/** Where Playwright keeps its browsers: PLAYWRIGHT_BROWSERS_PATH, or its default cache on macOS. */
export function browsersPath(env: NodeJS.ProcessEnv = process.env): string {
  const set = env['PLAYWRIGHT_BROWSERS_PATH'];
  if (set !== undefined && set !== '' && set !== '0') return set;
  return join(homedir(), 'Library', 'Caches', 'ms-playwright');
}

/** The executable a pinned browser runs from, under `root` (macOS; asha runs on macOS only). */
function executableOf(name: BrowserName, root: string = browsersPath()): string {
  if (name === 'chromium') {
    const arch = process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
    return join(
      root,
      `chromium_headless_shell-${pinnedRevision('chromium-headless-shell')}`,
      `chrome-headless-shell-${arch}`,
      'chrome-headless-shell',
    );
  }
  return join(root, `firefox-${pinnedRevision('firefox')}`, 'firefox', 'Nightly.app', 'Contents', 'MacOS', 'firefox');
}

/** Fails, naming the install step, when a pinned browser is not installed. */
export function requireBrowser(name: BrowserName, root: string = browsersPath()): string {
  const executable = executableOf(name, root);
  if (!existsSync(executable)) {
    throw new Error(
      `the pinned ${name} for the browser tests is not installed (${executable} is missing): run ${INSTALL_STEP} once`,
    );
  }
  return executable;
}

const TYPES: Readonly<Record<BrowserName, BrowserType>> = { chromium, firefox };

/** Launches a pinned browser, headless, after checking its executable. */
export async function launchBrowser(name: BrowserName): Promise<Browser> {
  const executablePath = requireBrowser(name);
  return TYPES[name].launch({ headless: true, executablePath });
}
