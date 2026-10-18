// Where the code reaches the network (docs/plans/extension-modules.md A17, R6, R17, R20): every network call site under
// src/, images/, harness-images/ and modules/, by file and enclosing symbol, is on this list, and a new one fails here,
// named, until it is added with its reason; the suites' network guard refuses any connection but loopback; and no
// shipped recipe uses a hosted model or grants the reference AWS CLI plugin before its page records R6 (b)'s evidence.

import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { byCodeUnit } from '../../src/shared/order.js';
import { connectHost, NetworkGuardRefused } from '../helpers/network-guard.js';
import { networkSites, type NetworkSite } from '../helpers/network-sites.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Each site and why it reaches out. `plan`: the sites extension-modules added. */
const SITES: readonly (NetworkSite & {
  readonly why: string;
  readonly plan?: 'extension-modules' | 'patterns-phase-3';
})[] = [
  {
    file: 'modules/bedrock/index.mjs',
    symbol: 'chat',
    call: 'fetch',
    why: "Bedrock's Chat Completions, through the egress proxy (R6 (b), R19)",
    plan: 'extension-modules',
  },
  {
    file: 'modules/bedrock/index.mjs',
    symbol: 'lifecycle',
    call: 'fetch',
    why: "Bedrock's GetFoundationModel, through the egress proxy (R20)",
    plan: 'extension-modules',
  },
  {
    file: 'modules/tavily/index.mjs',
    symbol: 'call',
    call: 'fetch',
    why: "Tavily's search, through the egress proxy (R6 (b), R24)",
    plan: 'extension-modules',
  },
  {
    file: 'src/agent-sdk/index.ts',
    symbol: 'HarnessClient.blackboardPost',
    call: 'fetch',
    why: 'the agent to its harness',
  },
  {
    file: 'src/agent-sdk/index.ts',
    symbol: 'HarnessClient.blackboardRead',
    call: 'fetch',
    why: 'the agent to its harness',
  },
  {
    file: 'src/agent-sdk/index.ts',
    symbol: 'HarnessClient.launchAgent',
    call: 'fetch',
    why: "the agent to its harness's launch route, bounded at 35,000 ms by its own timer (R30)",
    plan: 'patterns-phase-3',
  },
  {
    file: 'src/agent-sdk/index.ts',
    symbol: 'HarnessClient.moduleCall',
    call: 'fetch',
    why: "the agent to its harness's module-call route (R8)",
    plan: 'extension-modules',
  },
  { file: 'src/agent-sdk/index.ts', symbol: 'HarnessClient.post_', call: 'fetch', why: 'the agent to its harness' },
  { file: 'src/agent-sdk/index.ts', symbol: 'HarnessClient.roster', call: 'fetch', why: 'the agent to its harness' },
  { file: 'src/agent-sdk/index.ts', symbol: 'HarnessClient.stream', call: 'fetch', why: 'the agent to its harness' },
  { file: 'src/cli/commands.ts', symbol: 'converse', call: 'fetch', why: 'the CLI to the loopback daemon' },
  { file: 'src/cli/commands.ts', symbol: 'findDaemon', call: 'fetch', why: 'the CLI to the loopback daemon' },
  { file: 'src/cli/commands.ts', symbol: 'followChannel', call: 'fetch', why: 'the CLI to the loopback daemon' },
  { file: 'src/cli/commands.ts', symbol: 'launch', call: 'fetch', why: 'the CLI to the loopback daemon' },
  { file: 'src/cli/commands.ts', symbol: 'stopChannel', call: 'fetch', why: 'the CLI to the loopback daemon' },
  { file: 'src/cli/files.ts', symbol: 'prepareSpace', call: 'fetch', why: 'the CLI to the loopback daemon' },
  { file: 'src/cli/files.ts', symbol: 'saveReturned', call: 'fetch', why: 'the CLI to the loopback daemon' },
  { file: 'src/cli/files.ts', symbol: 'upload', call: 'fetch', why: 'the CLI to the loopback daemon' },
  {
    file: 'src/cli/modules.ts',
    symbol: 'approveCommand',
    call: 'fetch',
    why: "--approve's GET to the loopback daemon (R12 (b))",
    plan: 'extension-modules',
  },
  {
    file: 'src/cli/modules.ts',
    symbol: 'approveCommand',
    call: 'fetch',
    why: "--approve's POST to the loopback daemon (R12 (b))",
    plan: 'extension-modules',
  },
  {
    file: 'src/cli/modules.ts',
    symbol: 'enableCommand',
    call: 'fetch',
    why: '--enable-module to the loopback daemon (R36)',
    plan: 'extension-modules',
  },
  { file: 'src/cli/state.ts', symbol: 'control', call: 'fetch', why: 'the CLI to the loopback daemon' },
  { file: 'src/cli/state.ts', symbol: 'eraseUser', call: 'fetch', why: 'the CLI to the loopback daemon' },
  {
    file: 'src/daemon/model-gateway/index.ts',
    symbol: 'chatCompletion',
    call: 'fetch',
    why: 'the daemon to its loopback llama-server',
  },
  {
    file: 'src/daemon/model-gateway/index.ts',
    symbol: 'embeddings',
    call: 'fetch',
    why: 'the daemon to its loopback llama-server',
  },
  {
    file: 'src/daemon/model-gateway/index.ts',
    symbol: 'storeIdlePrompts.post',
    call: 'fetch',
    why: 'the daemon to its loopback llama-server',
  },
  {
    file: 'src/daemon/model-server/index.ts',
    symbol: 'LlamaCppServer.pollHealth',
    call: 'fetch',
    why: 'the daemon to its loopback llama-server',
  },
  {
    file: 'src/daemon/model-store/index.ts',
    symbol: 'HuggingFaceModelStore.download',
    call: 'fetch',
    why: 'model weights from Hugging Face, pinned by revision (AGENTS.md §3)',
  },
  {
    file: 'src/portal/client.ts',
    symbol: 'DaemonClient.health',
    call: 'fetch',
    why: "the portal's page to its own daemon, same origin (docs/plans/portal.md R14)",
  },
  {
    file: 'src/portal/client.ts',
    symbol: 'DaemonClient.report',
    call: 'fetch',
    why: "the portal's page to its own daemon, same origin (R6)",
  },
  {
    file: 'src/portal/client.ts',
    symbol: 'DaemonClient.send',
    call: 'fetch',
    why: "the portal's page to its own daemon, same origin (R7)",
  },
  {
    file: 'src/egress-proxy/main.ts',
    symbol: 'dial',
    call: 'node:net connect',
    why: 'the egress proxy to the address it resolved and checked (R6 (c))',
    plan: 'extension-modules',
  },
];

const key = (s: NetworkSite) => `${s.file} ${s.symbol} ${s.call}`;

describe('network call sites (A17)', () => {
  it('finds exactly the listed sites: a new one fails here, named by file and symbol', () => {
    const found = networkSites(ROOT, ['src', 'images', 'harness-images', 'modules']).map(key).sort(byCodeUnit);
    const listed = SITES.map(key).sort(byCodeUnit);
    expect(found.filter((k) => !listed.includes(k))).toEqual([]);
    expect(listed.filter((k) => !found.includes(k))).toEqual([]);
    expect(found).toEqual(listed);
  });

  it('names a site it was not told of, by file and symbol (a fixture tree)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asha-sites-'));
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src', 'leak.ts'),
      "import { connect as dial } from 'node:net';\nimport * as https from 'node:https';\n// fetch('https://comment.example') never counts\nexport class Uploader {\n  send(): void {\n    void fetch('https://x.example');\n    https.request('https://y.example');\n    dial(443, 'z.example');\n    void 'fetch(string)';\n  }\n}\nexport const later = () => new WebSocket('wss://w.example');\n",
    );
    expect(networkSites(root, ['src'])).toEqual([
      { file: 'src/leak.ts', symbol: 'Uploader.send', call: 'fetch' },
      { file: 'src/leak.ts', symbol: 'Uploader.send', call: 'https.request' },
      { file: 'src/leak.ts', symbol: 'Uploader.send', call: 'node:net dial' },
      { file: 'src/leak.ts', symbol: 'later', call: 'new WebSocket' },
    ]);
  });

  it('detects http request alias import as network site', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asha-sites-alias-'));
    await mkdir(join(root, 'src'));
    await writeFile(
      join(root, 'src', 'alias.ts'),
      "import { request as httpRequest } from 'node:http';\nexport function f() { httpRequest('https://example.com'); }\n",
    );
    const sites = networkSites(root, ['src']);
    expect(sites).toContainEqual({ file: 'src/alias.ts', symbol: 'f', call: 'http httpRequest' });
  });
});

describe("the suites' network guard (A17)", () => {
  it('refuses a connection to 192.0.2.1, naming it, and allows loopback', async () => {
    expect(() => connect(443, '192.0.2.1')).toThrow(NetworkGuardRefused);
    expect(() => connect({ host: '192.0.2.1', port: 443 })).toThrow(
      'network guard: a test opened a connection to 192.0.2.1, which is not loopback',
    );
    const insecureScheme = 'http';
    await expect(fetch(`${insecureScheme}://192.0.2.1/`, { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
    expect(connectHost([{ host: '127.0.0.1', port: 1 }])).toBe('127.0.0.1');
    expect(connectHost([{ path: '/tmp/x.sock' }])).toBeUndefined();
    const socket = connect(1, '127.0.0.1');
    socket.on('error', () => undefined);
    socket.destroy();
  });
});

describe('shipped recipes (A17, R17, R20)', () => {
  async function definitions(): Promise<{ file: string; recipe: Record<string, unknown> }[]> {
    const out: { file: string; recipe: Record<string, unknown> }[] = [];
    for (const name of await readdir(join(ROOT, 'recipes')))
      if (name.endsWith('.json'))
        out.push({
          file: `recipes/${name}`,
          recipe: JSON.parse(await readFile(join(ROOT, 'recipes', name), 'utf8')) as Record<string, unknown>,
        });
    for (const team of await readdir(join(ROOT, 'teams'))) {
      const raw = JSON.parse(await readFile(join(ROOT, 'teams', team, 'team.json'), 'utf8')) as {
        members?: Record<string, unknown>[];
      };
      for (const [i, member] of (raw.members ?? []).entries())
        out.push({ file: `teams/${team}/team.json#${String(i)}`, recipe: member });
    }
    return out;
  }

  it('none names a hosted model: no gate suite uses a cloud model (R20)', async () => {
    const hosted = (await definitions()).filter(({ recipe }) =>
      [recipe['model'], recipe['embeddingModel']].some((m) => typeof m === 'string' && m.includes('/')),
    );
    expect(hosted.map((d) => d.file)).toEqual([]);
  });

  it("none grants the reference AWS CLI plugin until its page records R6 (b)'s proxy evidence", async () => {
    const page = await readFile(join(ROOT, 'docs', 'architecture', 'modules-aws-cli.md'), 'utf8');
    const evidence = /^## R6 \(b\) proxy evidence\n+Recorded \d{4}-\d{2}-\d{2}/m.test(page);
    const granting = (await definitions()).filter(
      ({ recipe }) =>
        Array.isArray(recipe['modules']) && (recipe['modules'] as string[]).some((m) => m.startsWith('aws_cli/')),
    );
    if (!evidence) expect(granting.map((d) => d.file)).toEqual([]);
  });
});
