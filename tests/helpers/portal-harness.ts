// The portal's integration harness (docs/plans/portal.md A2–A22): the real daemon on a loopback port serving the
// page compiled for this run (builtPortal), its container runtime and model server fakes — the fake container runs
// the real hello-world agent in-process, and the "model server" is a real HTTP server streaming as llama-server does —
// the CLI run against the same daemon, and a pinned headless browser opened on the page as `asha --portal` opens it.

import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Browser, BrowserContext, Page } from 'playwright-core';

import {
  AgentTelemetry,
  HarnessClient,
  serveAgent,
  type AgentProcess,
  type DeliveryHandler,
} from '../../src/agent-sdk/index.js';
import { runCli, type CliContext } from '../../src/cli/commands.js';
import { startDaemon, type RunningDaemon } from '../../src/daemon/compose.js';
import { JsonLinesLogger, type LogFields } from '../../src/daemon/log.js';
import type { ContainerSpec } from '../../src/daemon/container-runtime/index.js';
import { present } from '../../src/shared/assert-present.js';
import { harnessPaths, type HarnessPaths } from '../../src/shared/paths.js';
import { NAME, handleHelloWorld } from '../../images/hello-world/src/agent.js';
import {
  FIXTURE_RECIPE,
  FakeModelServer,
  FakeRuntime,
  FakeStore,
  REAL_STATE,
  TEST_LIFETIME,
  fixtureRoot,
} from './daemon-fakes.js';
import { ManualSchedule, NOT_INTERACTIVE, NO_PORTAL, RecordingAgentLog, RecordingLogger } from './fakes.js';
import { llamaChunks, scriptOf, sseText } from './llama-stream.js';
import { builtPortal } from './portal-folders.js';

/** The fixture recipe, named as the plan's criteria name it. */
// A delivery's bound long enough for a model failure's turn to end on its own (the fixture's 2 s expired one).
export const HELLO_RECIPE = { ...FIXTURE_RECIPE, id: 'hello-world', messageTimeoutMs: 20_000 };

/**
 * What the fake model answers a chat with: the reply text (the reply tool); 'fail' (a 500, a model failure); 'hang'
 * (headers, then nothing: a turn in progress, which holds the daemon's stop while its agent drains); or `{ask}`, an
 * ask_user call with that question (patterns-phase-3 R23), for a recipe that selects it.
 */
/**
 * How the fake model answers one chat: a reply's text, a failure, a hang, an ask of the user, a consult of other agents
 * (portal-scene-chat A8, A20), or a pass.
 */
export type ModelAnswer =
  | string
  | { readonly ask: string }
  | { readonly consult: readonly { readonly to: string; readonly text: string }[] }
  | { readonly pass: string };

export interface PortalHarness {
  readonly root: string;
  readonly daemon: RunningDaemon;
  readonly base: string;
  readonly paths: HarnessPaths;
  readonly runtime: FakeRuntime;
  readonly logger: RecordingLogger;
  readonly credential: string;
  readonly clock: ManualSchedule;
  /** How the fake model answers each chat: by default the text "Hello World!" for any message. */
  answer: (incoming: string) => ModelAnswer;
  /** The user turn of every chat the model was sent: what each agent's delivery said. */
  readonly prompts: string[];
  /**
   * Runs the CLI against this daemon, with or without --verbose. `stop` ends a --watch as Ctrl-C does; `fetch` stands
   * in for the CLI's fetch (a fixture's answers, the same the page is given).
   */
  cli(
    argv: readonly string[],
    options?: {
      readonly verbose?: boolean;
      readonly cwd?: string;
      readonly stop?: Promise<void>;
      readonly fetch?: typeof fetch;
      readonly live?: { readonly out: string[]; readonly err: string[] };
    },
  ): Promise<{ code: number; out: string; err: string }>;
  /** teams/crew/ in this root: a lead and a helper, each on the fixture recipe's image and model. */
  crew(): Promise<void>;
  /**
   * Holds the daemon's stop at its first agent's stop until `release` is called: the daemon stays stopping — its
   * control routes answering 503 — while a test looks. Needs an agent online.
   */
  holdStop(): { release(): void };
  /** A page opened as `asha --portal` opens it: the fragment carrying the credential and the user ID. */
  open(
    browser: Browser,
    user?: string,
    options?: {
      readonly reducedMotion?: boolean;
      readonly viewport?: { width: number; height: number };
      /** A credential other than the daemon's (a wrong one); the page then never reaches the daemon. */
      readonly credential?: string;
      /** Installs Playwright's manual clock before the page loads (the page's timers then move only when the test says). */
      readonly clock?: boolean;
      /** Run before the page loads: routes a test intercepts. */
      readonly before?: (page: Page) => Promise<void>;
      /** Whether to wait for the page's health line (false for a daemon that is stopping). Default true. */
      readonly wait?: boolean;
      /**
       * Whether the send and watch views open in their command-line views (portal-scene-chat R9), the CLI's lines shown
       * as portal's A4 and A5 compare them. Default true; a test of the chats passes false.
       */
      readonly commandLine?: boolean;
    },
  ): Promise<PortalPage>;
  /** Stops the daemon (once) and the fakes. */
  close(): Promise<void>;
}

export interface PortalPage {
  readonly context: BrowserContext;
  readonly page: Page;
  /** Every console error and page error the page met. */
  readonly errors: string[];
  /** Every Content-Security-Policy violation the page reported. */
  readonly violations: string[];
  /** Every request the page made, as `METHOD path`. */
  readonly requests: string[];
  /** When the page last sent each `METHOD path`, by the test's clock (Date.now). */
  readonly sentAt: Map<string, number>;
}

/** The recording logger the tests read, writing each record to ASHA_HOME/logs/daemon.jsonl too, as the daemon's own does. */
class FileAndRecordingLogger extends RecordingLogger {
  constructor(private readonly file: JsonLinesLogger) {
    super();
  }
  override info(event: string, fields: LogFields = {}): void {
    super.info(event, fields);
    this.file.info(event, fields);
  }
  override warn(event: string, fields: LogFields = {}): void {
    super.warn(event, fields);
    this.file.warn(event, fields);
  }
  override error(event: string, fields: LogFields & { readonly error: unknown }): void {
    super.error(event, fields);
    this.file.error(event, fields);
  }
}

const NO_SIGNALS: AgentProcess = { onTerminate: () => () => undefined, exit: () => undefined };
const NO_IMAGE_TOOLS = {
  manifest: { tools: [], answerTools: [], keepsMemory: false, eraseUser: false, stateSchema: null },
  handlers: {},
} as const;

export async function portalHarness(): Promise<PortalHarness> {
  const root = await fixtureRoot(HELLO_RECIPE);
  const home = await mkdtemp(join(tmpdir(), 'asha-portal-'));
  const workspace = await mkdtemp(join(tmpdir(), 'asha-portal-ws-'));
  const paths = harnessPaths({ ASHA_HOME: home });
  const logger = new FileAndRecordingLogger(
    new JsonLinesLogger({ file: join(paths.logsDir, 'daemon.jsonl'), echo: () => undefined, clock: () => new Date() }),
  );
  const clock = new ManualSchedule();
  const agentsDone: Promise<unknown>[] = [];
  // Declared at the wider type the call site and the setter both need: a 0-param function literal satisfies it
  // (a function may always be called with fewer arguments than it declares), with no unused parameter to name.
  const state: { answer: (incoming: string) => ModelAnswer } = { answer: () => 'Hello World!' };
  const prompts: string[] = [];

  // The model: a real HTTP server streaming each chat's answer as llama-server does.
  const model: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      if (req.url === '/tokenize' || req.url === '/completion') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(req.url === '/tokenize' ? { tokens: [13] } : { content: ' x' }));
        return;
      }
      const request = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const incoming = request.messages.find((m) => m.role === 'user')?.content ?? '';
      prompts.push(incoming);
      const answer = state.answer(incoming);
      if (answer === 'hang') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.flushHeaders();
        return;
      }
      if (answer === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'the fake model failed, as asked' } }));
        return;
      }
      let toolCall: { readonly name: string; readonly arguments: string };
      if (typeof answer === 'string') toolCall = { name: 'reply', arguments: JSON.stringify({ text: answer }) };
      else if ('ask' in answer) toolCall = { name: 'ask_user', arguments: JSON.stringify({ text: answer.ask }) };
      else if ('consult' in answer)
        toolCall = { name: 'consult', arguments: JSON.stringify({ requests: answer.consult }) };
      else toolCall = { name: 'pass', arguments: JSON.stringify({ reason: answer.pass }) };
      const message = {
        role: 'assistant',
        content: null,
        tool_calls: [{ type: 'function', id: 'c1', function: toolCall }],
      };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        sseText(
          llamaChunks({
            ...scriptOf(message),
            usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } },
          }),
        ),
      );
    });
  });
  await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));

  const runtime = new FakeRuntime('127.0.0.1');
  const run = (handler: DeliveryHandler) => (spec: ContainerSpec) => {
    const environment = {
      harnessUrl: present(spec.env['ASHA_URL'], 'ASHA_URL env var'),
      agentToken: present(spec.env['ASHA_AGENT_TOKEN'], 'ASHA_AGENT_TOKEN env var'),
    };
    const telemetry = AgentTelemetry.forHarness(environment, () => undefined);
    const client = new HarnessClient({
      environment,
      chatTimeoutMs: 5_000,
      requestTimeoutMs: 5_000,
      filesRequestTimeoutMs: 30_000,
      streamIdleTimeoutMs: 5_000,
      fetch: globalThis.fetch,
      telemetry,
    });
    agentsDone.push(
      serveAgent({
        client,
        telemetry,
        name: NAME,
        handler,
        process: NO_SIGNALS,
        imageTools: NO_IMAGE_TOOLS,
        workspace,
        channelSpace: null,
        log: new RecordingAgentLog(),
        drainMs: 5_000,
      }).catch((e: unknown) => e),
    );
  };
  runtime.onStart = run(handleHelloWorld);
  const daemon = await startDaemon({
    paths,
    root,
    version: '0.0.0-test',
    build: 'test-build-1',
    pid: process.pid,
    logger,
    dependencies: {
      runtime,
      modelServer: new FakeModelServer(`http://127.0.0.1:${String((model.address() as AddressInfo).port)}`),
      store: new FakeStore(),
      ...REAL_STATE,
      fetch: globalThis.fetch,
    },
    heartbeatMs: 1_000,
    chatTimeoutMs: 5_000,
    schedule: clock.schedule,
    lifetime: TEST_LIFETIME,
    portal: builtPortal(),
  });
  const credential = (JSON.parse(await readFile(paths.daemonFile, 'utf8')) as { credential: string }).credential;
  const base = `http://127.0.0.1:${String(daemon.port)}`;
  let closed = false;

  const harness: PortalHarness = {
    root,
    daemon,
    base,
    paths,
    runtime,
    logger,
    credential,
    clock,
    prompts,
    get answer() {
      return state.answer;
    },
    set answer(next) {
      state.answer = next;
    },
    async cli(argv, options = {}) {
      const out: string[] = options.live?.out ?? [];
      const err: string[] = options.live?.err ?? [];
      const ctx: CliContext = {
        env: { ASHA_HOME: home },
        stdout: (t) => out.push(t),
        stderr: (t) => err.push(t),
        fetch: options.fetch ?? globalThis.fetch,
        root,
        version: '0.0.0-test',
        build: 'test-build-1',
        pid: process.pid,
        startDaemon,
        createLogger: () => logger,
        dependencies: () => {
          throw new Error('not used');
        },
        shutdownSignals: (listener) => {
          void options.stop?.then(() => {
            listener('SIGINT');
          });
          return () => undefined;
        },
        spawnServer: () => Promise.reject(new Error('the daemon is already running; the CLI must not spawn another')),
        kill: () => undefined,
        isAlive: () => true,
        sleep: () => Promise.resolve(undefined),
        // No process holds any pid a test names: a stopping lookup finds no asha daemon (debt-paydown R15).
        processCommand: () => Promise.resolve(null),
        timing: {
          serverStartMs: 1_000,
          serverStopMs: 1_000,
          streamIdleMs: 60_000,
          pollMs: 10,
          uploadAnswerMs: 260_000,
          downloadIdleMs: 30_000,
        },
        ...NOT_INTERACTIVE,
        ...NO_PORTAL,
        loginName: () => 'olga',
        cwd: () => options.cwd ?? home,
        homeDir: () => home,
      };
      const code = await runCli(options.verbose === true ? ['--verbose', ...argv] : [...argv], ctx);
      return { code, out: out.join(''), err: err.join('') };
    },
    holdStop() {
      const original = runtime.onStop;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      runtime.onStop = async (name, mode) => {
        await gate;
        await original(name, mode);
      };
      return { release };
    },
    async crew() {
      const dir = join(root, 'teams', 'crew');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'team.json'),
        JSON.stringify({
          id: 'crew',
          description: 'A crew.',
          members: [
            { name: 'lead', recipe: 'lead.json' },
            { name: 'helper', recipe: 'helper.json' },
          ],
        }),
      );
      await writeFile(
        join(dir, 'lead.json'),
        JSON.stringify({ ...HELLO_RECIPE, id: 'lead', description: 'Leads.', prompt: 'you lead the crew.' }),
      );
      await writeFile(
        join(dir, 'helper.json'),
        JSON.stringify({ ...HELLO_RECIPE, id: 'helper', description: 'Helps.', prompt: 'you help the crew.' }),
      );
    },
    async open(browser, user, options = {}) {
      const context = await browser.newContext({
        viewport: options.viewport ?? { width: 1280, height: 800 },
        ...(options.reducedMotion === true ? { reducedMotion: 'reduce' as const } : {}),
        acceptDownloads: true,
      });
      const page = await context.newPage();
      const errors: string[] = [];
      const violations: string[] = [];
      const requests: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`));
      const sentAt = new Map<string, number>();
      page.on('request', (r) => {
        const key = `${r.method()} ${new URL(r.url()).pathname}`;
        requests.push(key);
        sentAt.set(key, Date.now());
      });
      await page.exposeBinding('__violation', (_source, text: string) => violations.push(text));
      // Page-side code as text: this file is type-checked for Node, without the DOM's names.
      await page.addInitScript({
        content:
          "document.addEventListener('securitypolicyviolation', (e) => { void window.__violation(e.violatedDirective + ' ' + e.blockedURI); });",
      });
      if (options.clock === true) await page.clock.install();
      // The views' command-line checkboxes, as their own state in the tab's storage (R9), on the daemon's page only.
      if (options.commandLine !== false) {
        await page.addInitScript({
          content:
            "if (location.protocol === 'http:') { sessionStorage.setItem('asha.portal.send-cli', '1'); sessionStorage.setItem('asha.portal.watch-cli', '1'); }",
        });
      }
      await options.before?.(page);
      const fragment = new URLSearchParams({
        c: options.credential ?? credential,
        ...(user === undefined ? {} : { u: user }),
      });
      await page.goto(`${base}/#${fragment.toString()}`);
      // Waited on through locators, never a page-side function: the page's policy refuses a string evaluated as script.
      if (options.credential === undefined && options.wait !== false)
        await page.locator('#daemon-line', { hasText: /^daemon pid / }).waitFor();
      return { context, page, errors, violations, requests, sentAt };
    },
    async close() {
      if (!closed) {
        closed = true;
        await daemon.stop();
      }
      await Promise.all(agentsDone);
      model.closeAllConnections();
      await new Promise((resolve) => model.close(resolve));
    },
  };
  return harness;
}
