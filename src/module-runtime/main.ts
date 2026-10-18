// The module base image's entry point (docs/plans/extension-modules.md R5, R34, R37): reads the installed module's
// manifest at /module/module.json, imports its entry, gives it only the secrets the manifest declares (from this
// container's environment, which holds no other, R7), and serves the framing on stdin and stdout. Its own records go
// to stderr as JSON lines.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { handleLine, type ModuleEntry } from './runtime.js';

const MODULE_DIR = '/module';
const manifest = JSON.parse(readFileSync(join(MODULE_DIR, 'module.json'), 'utf8')) as {
  kind: string;
  entry: string;
  secrets: string[];
};
if (manifest.kind !== 'ToolModule' && manifest.kind !== 'ModelProvider')
  throw new Error(`the module base runs a ToolModule or a ModelProvider, not ${manifest.kind}`);
const secrets: Record<string, string> = {};
for (const name of manifest.secrets) {
  const value = process.env[name];
  if (value === undefined) throw new Error(`the secret ${name} is not in this container's environment`);
  secrets[name] = value;
}
const entry = (await import(pathToFileURL(join(MODULE_DIR, manifest.entry)).href)) as ModuleEntry;
const log = (record: Readonly<Record<string, unknown>>): void => {
  process.stderr.write(`${JSON.stringify(record)}\n`);
};
const kind: 'ToolModule' | 'ModelProvider' = manifest.kind;
const props = {
  kind,
  entry,
  secrets,
  write: (line: string) => {
    process.stdout.write(line);
  },
  log,
};
createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on('line', (line) => {
  // handleLine answers every handler failure itself; anything else (an answer that cannot be written as JSON) is a
  // defect of the module: logged, and the container exits, which fails its calls in flight on the daemon's side.
  handleLine(props, line).catch((error: unknown) => {
    log({ event: 'module.runtime_failed', detail: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
});
process.stdin.once('end', () => process.exit(0));
