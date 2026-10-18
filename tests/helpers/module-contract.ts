// The shared module contract suite (docs/plans/extension-modules.md R22, A21): runs a ToolModule's or ModelProvider's
// own entry through the real module runtime (`handleLine`, the code inside the module container) with `fetch` replaced
// by a recorded fake, and checks what every module owes the harness, whatever its vendor:
//
//   - exactly one response line per request, carrying the request's id, and delta lines only before it;
//   - a failure's reason drawn from its kind's closed set (TOOL_FAILURE_REASONS or MODEL_FAILURE_REASONS);
//   - every fetch to a host the manifest lists, over https, and nothing else reaching the network (the fake is the
//     only `fetch`, and it fails the test on an unlisted host);
//   - each secret sent only as the Authorization header to a listed host, never in a URL, a body, a response, a
//     delta or a log line (R7, R24).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { expect } from 'vitest';

import { handleLine, type ModuleEntry } from '../../src/module-runtime/runtime.js';
import { present } from '../../src/shared/assert-present.js';
import { parseModuleManifest, type ModuleManifest } from '../../src/shared/modules.js';
import { byCodeUnit } from '../../src/shared/order.js';
import { MODEL_FAILURE_REASONS } from '../../src/shared/protocol.js';
import { TOOL_FAILURE_REASONS } from '../../src/shared/tools.js';
import { fixtureSecret } from './modules.js';

const MODULES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'modules');
export const FAKES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'modules');

/** One request the module made through the fake. */
export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
}

/** The fake's answer to one request: a status and a body (whole, or the chunks of a stream), or a thrown error. */
export type FakeAnswer =
  { readonly status: number; readonly body: string | readonly string[] } | { readonly throws: Error };

export interface ContractRun {
  /** Every line the module wrote, parsed. */
  readonly lines: readonly Readonly<Record<string, unknown>>[];
  /** The one response line. */
  readonly response: Readonly<Record<string, unknown>>;
  readonly deltas: readonly unknown[];
  readonly calls: readonly FetchCall[];
  readonly logs: readonly Readonly<Record<string, unknown>>[];
}

function loadManifest(id: string): ModuleManifest {
  return parseModuleManifest(
    JSON.parse(readFileSync(join(MODULES_ROOT, id, 'module.json'), 'utf8')),
    `modules/${id}/module.json`,
    id,
  );
}

async function loadEntry(id: string): Promise<ModuleEntry> {
  const manifest = loadManifest(id);
  return (await import(pathToFileURL(join(MODULES_ROOT, id, manifest.entry)).href)) as ModuleEntry;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => (out[key] = value));
  return out;
}

/**
 * The fake `fetch` a contract run installs: records the call, rejects anything off the manifest's allow-list
 * (host and https), then hands off to `answer` for the response or its thrown failure. Extracted out of
 * `runContract` so that function's own branching stays under the cognitive-complexity limit; exactly the logic
 * that lambda had, as a non-async function (R6's `require-await`) whose two failure sites reject instead of
 * throwing, since an async function's own throw was already a rejection, never a synchronous one (PRINCIPLES §9).
 */
function fakeFetch(
  manifest: ModuleManifest,
  answer: (call: FetchCall, index: number) => FakeAnswer,
  calls: FetchCall[],
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const call: FetchCall = {
      url,
      method: init?.method ?? 'GET',
      headers: headersOf(init),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(call);
    const host = new URL(url).hostname;
    if (!manifest.hosts.includes(host) || new URL(url).protocol !== 'https:')
      return Promise.reject(
        new Error(`contract: the module fetched ${url}, not an https URL on a host its manifest lists`),
      );
    const picked = answer(call, calls.length - 1);
    if ('throws' in picked) return Promise.reject(picked.throws);
    const chunks = typeof picked.body === 'string' ? [picked.body] : picked.body;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: picked.status }));
  };
}

/**
 * The one-response-last contract: every written line is itself one JSON object on one line, carries the
 * request's id, and the last is the one with `ok`; every earlier line is a `{ delta, id }` pair. Returns what
 * `runContract` hands back to its caller. Extracted out of `runContract` for its cognitive complexity.
 */
function assertSingleResponse(
  written: readonly string[],
  manifest: ModuleManifest,
): {
  readonly lines: readonly Readonly<Record<string, unknown>>[];
  readonly response: Readonly<Record<string, unknown>>;
  readonly deltas: readonly unknown[];
} {
  for (const line of written) expect(line.endsWith('\n') && !line.slice(0, -1).includes('\n')).toBe(true);
  const lines = written.map((line) => JSON.parse(line) as Record<string, unknown>);
  for (const line of lines) expect(line['id']).toBe('req-1');
  const responses = lines.filter((line) => 'ok' in line);
  expect(responses).toHaveLength(1);
  expect(lines.at(-1)).toBe(responses[0]);
  const response = present(responses[0], 'the one response line');
  const deltas = lines.slice(0, -1).map((line) => line['delta']);
  for (const line of lines.slice(0, -1)) expect(Object.keys(line).sort(byCodeUnit)).toEqual(['delta', 'id']);
  if (response['ok'] === false) {
    const reasons: readonly string[] = manifest.kind === 'ModelProvider' ? MODEL_FAILURE_REASONS : TOOL_FAILURE_REASONS;
    expect(reasons).toContain(response['reason']);
  }
  return { lines, response, deltas };
}

/** Each secret only as the Authorization header to a listed host, never anywhere else a line was written or logged. */
function assertSecretsConfined(
  secrets: Readonly<Record<string, string>>,
  calls: readonly FetchCall[],
  written: readonly string[],
  logs: readonly Readonly<Record<string, unknown>>[],
): void {
  for (const value of Object.values(secrets)) {
    for (const call of calls) {
      expect(call.url).not.toContain(value);
      expect(call.body ?? '').not.toContain(value);
      for (const [key, header] of Object.entries(call.headers))
        if (key !== 'authorization') expect(header).not.toContain(value);
    }
    for (const line of [...written, ...logs.map((l) => JSON.stringify(l))]) expect(line).not.toContain(value);
  }
}

/**
 * Runs one request through the module's entry and the real runtime, with `answer` as every fetch's answer, and
 * checks the contract on everything that came out. The returned run is for the caller's exact assertions.
 */
export async function runContract(props: {
  readonly id: string;
  readonly tool: string;
  readonly arguments: unknown;
  readonly answer: (call: FetchCall, index: number) => FakeAnswer;
  readonly idempotencyKey?: string;
}): Promise<ContractRun> {
  const manifest = loadManifest(props.id);
  const entry = await loadEntry(props.id);
  const secrets = Object.fromEntries(manifest.secrets.map((name) => [name, fixtureSecret(name)]));
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = fakeFetch(manifest, props.answer, calls);
  const written: string[] = [];
  const logs: Record<string, unknown>[] = [];
  try {
    await handleLine(
      {
        kind: manifest.kind === 'ModelProvider' ? 'ModelProvider' : 'ToolModule',
        entry,
        secrets,
        write: (line) => written.push(line),
        log: (record) => logs.push({ ...record }),
      },
      JSON.stringify({
        id: 'req-1',
        tool: props.tool,
        arguments: props.arguments,
        ...(props.idempotencyKey === undefined ? {} : { idempotencyKey: props.idempotencyKey }),
      }),
    );
  } finally {
    globalThis.fetch = original;
  }

  const { lines, response, deltas } = assertSingleResponse(written, manifest);
  assertSecretsConfined(secrets, calls, written, logs);
  return { lines, response, deltas, calls, logs };
}

/** The fixture value of a module's secret, as the contract suite passes it. */
export function contractSecret(name: string): string {
  return fixtureSecret(name);
}
