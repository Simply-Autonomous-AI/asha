// The egress proxy's logic (docs/plans/extension-modules.md R6 (b)–(e), A6), on loopback: an allowed CONNECT carried
// end to end to a local TLS server (with ranges that leave loopback open — R6 (e)), and every refusal with the
// production ranges; its bounds with an injected clock; its records; and its entry point, which reads nothing that
// could change its resolver or ranges.

import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createConnection, createServer, Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connect as tlsConnect, createServer as createTlsServer, type Server as TlsServer } from 'node:tls';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  EgressProxy,
  REFUSED_RANGES,
  serverName,
  type ProxyRecord,
  type SetTimer,
} from '../../src/egress-proxy/proxy.js';
import { present } from '../../src/shared/assert-present.js';
import { byCodeUnit } from '../../src/shared/order.js';

const HOST = 'api.allowed.test';

/** Timers that fire only when the test says, and a clock it moves. */
class ManualTime {
  now = 1_000_000;
  readonly timers: { callback: () => void; ms: number; cancelled: boolean }[] = [];
  readonly setTimer: SetTimer = (callback, ms) => {
    const timer = { callback, ms, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  /** Advances the clock and fires every live timer of exactly `ms`. */
  fire(ms: number): number {
    this.now += ms;
    const due = this.timers.filter((t) => !t.cancelled && t.ms === ms);
    for (const t of due) {
      t.cancelled = true;
      t.callback();
    }
    return due.length;
  }
}

let cert: { key: Buffer; cert: Buffer };

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'asha-proxy-cert-'));
  await promisify(execFile)('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
    '-days',
    '1',
    '-subj',
    `/CN=${HOST}`,
    '-addext',
    `subjectAltName=DNS:${HOST}`,
  ]);
  cert = { key: await readFile(join(dir, 'key.pem')), cert: await readFile(join(dir, 'cert.pem')) };
}, 30_000);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  // Last opened, first closed: the proxy before the servers its connections reach.
  for (const close of closers.splice(0).reverse()) await close();
});

/** A proxy listening on 127.0.0.1 for module `mod`, its upstream dialled to `upstreamPort` on loopback. */
async function proxyFor(props: {
  hosts: readonly string[];
  resolve4: (host: string) => Promise<readonly string[]>;
  refused?: readonly string[];
  upstreamPort?: number;
  dial?: (address: string, port: number) => Socket;
  time?: ManualTime;
}) {
  const records: ProxyRecord[] = [];
  const dialled: string[] = [];
  const time = props.time ?? new ManualTime();
  const proxy = new EgressProxy({
    resolve4: props.resolve4,
    refused: props.refused ?? REFUSED_RANGES,
    dial:
      props.dial ??
      ((address, port) => {
        dialled.push(`${address}:${String(port)}`);
        return createConnection({ host: '127.0.0.1', port: props.upstreamPort ?? 1 });
      }),
    log: (r) => records.push(r),
    setTimer: time.setTimer,
    now: () => time.now,
  });
  await proxy.listen('127.0.0.1', 0, 'mod', props.hosts);
  closers.push(() => proxy.close('127.0.0.1'));
  return { proxy, records, dialled, port: proxy.port('127.0.0.1'), time };
}

/** Sends `head` to the proxy and resolves with the socket and the proxy's first answer line. */
async function ask(port: number, head: string): Promise<{ socket: Socket; answer: string }> {
  const socket = createConnection({ host: '127.0.0.1', port });
  // The proxy resets a refused tunnel: an expected end, never an unhandled error.
  socket.on('error', () => undefined);
  await new Promise<void>((resolve) =>
    socket.once('connect', () => {
      resolve();
    }),
  );
  socket.write(head);
  const answer = await new Promise<string>((resolve) => {
    let got = '';
    const onData = (chunk: Buffer) => {
      got += chunk.toString('latin1');
      if (got.includes('\r\n\r\n')) {
        socket.off('data', onData);
        resolve(present(got.split('\r\n')[0], "the proxy's first answer line"));
      }
    };
    socket.on('data', onData);
    socket.once('close', () => {
      resolve(got.split('\r\n')[0] ?? '');
    });
  });
  return { socket, answer };
}

/** Waits until `check` holds, polling the event loop (bounded). */
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A real ClientHello naming `name`, as tls.connect sends it, captured from a socket that answers nothing. */
async function clientHello(name: string): Promise<Buffer> {
  const server = createServer();
  const hello = new Promise<Buffer>((resolve) =>
    server.on('connection', (s) =>
      s.once('data', (d: Buffer) => {
        resolve(d);
      }),
    ),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const client = tlsConnect({ host: '127.0.0.1', port, servername: name, rejectUnauthorized: false });
  client.on('error', () => undefined);
  const bytes = await hello;
  client.destroy();
  server.close();
  return bytes;
}

describe('the allowed path, end to end (R6 (b), (c), (e); A6)', () => {
  it('carries an allowlisted CONNECT to a local TLS server, and logs the connection with its bytes and duration', async () => {
    const tls: TlsServer = createTlsServer(cert, (s) => s.end('pong'));
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise((resolve) =>
          tls.close(() => {
            resolve();
          }),
        ),
    );
    const upstreamPort = (tls.address() as { port: number }).port;
    // Ranges that leave loopback open, so the allowed path can reach a local server (R6 (e)).
    const { records, dialled, port } = await proxyFor({
      hosts: [HOST],
      resolve4: () => Promise.resolve(['127.0.0.1']),
      refused: REFUSED_RANGES.filter((r) => r !== '127.0.0.0/8'),
      upstreamPort,
    });
    const { socket, answer } = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\nHost: ${HOST}:443\r\n\r\n`);
    expect(answer).toBe('HTTP/1.1 200 Connection Established');
    const secure = tlsConnect({ socket, servername: HOST, rejectUnauthorized: false });
    const body = await new Promise<string>((resolve, reject) => {
      let got = '';
      secure.on('data', (d: Buffer) => (got += d.toString()));
      secure.once('end', () => {
        resolve(got);
      });
      secure.once('error', reject);
    });
    expect(body).toBe('pong');
    await until(() => records.some((r) => r.event === 'egress.connection'));
    expect(dialled).toEqual(['127.0.0.1:443']);
    const record = present(
      records.find((r) => r.event === 'egress.connection'),
      'the egress.connection record',
    );
    expect(record).toMatchObject({
      event: 'egress.connection',
      module: 'mod',
      host: HOST,
      address: '127.0.0.1',
      outcome: 'closed',
    });
    expect(record.bytesUp).toBeGreaterThan(0);
    expect(record.bytesDown).toBeGreaterThan(0);
    expect(Object.keys(record).sort(byCodeUnit)).toEqual([
      'address',
      'bytesDown',
      'bytesUp',
      'durationMs',
      'event',
      'host',
      'module',
      'outcome',
    ]);
  });
});

describe('refusals with the production ranges (R6 (c); A6)', () => {
  const firsts = REFUSED_RANGES.map((r) => present(r.split('/')[0], 'the range address part'));
  for (const address of firsts) {
    it(`refuses ${address} before any connection`, async () => {
      const { records, dialled, port } = await proxyFor({ hosts: [HOST], resolve4: () => Promise.resolve([address]) });
      const { socket } = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`);
      socket.write(await clientHello(HOST));
      await until(() => records.length > 0);
      expect(records).toEqual([{ event: 'egress.refused', module: 'mod', host: HOST, rule: 'address_refused' }]);
      expect(dialled).toEqual([]);
      socket.destroy();
    });
  }

  it('refuses a name that resolves to a public and a private address (no choice of the public one)', async () => {
    const { records, dialled, port } = await proxyFor({
      hosts: [HOST],
      resolve4: () => Promise.resolve(['8.8.8.8', '192.168.5.2']),
    });
    const { socket } = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`);
    socket.write(await clientHello(HOST));
    await until(() => records.length > 0);
    expect(records[0]).toMatchObject({ rule: 'address_refused' });
    expect(dialled).toEqual([]);
    socket.destroy();
  });

  it('an IPv6-only answer is never dialled', async () => {
    const { records, dialled, port } = await proxyFor({
      hosts: [HOST],
      resolve4: () => Promise.resolve(['::1', '::ffff:10.0.0.1', '64:ff9b::a00:1']),
    });
    const { socket } = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`);
    socket.write(await clientHello(HOST));
    await until(() => records.length > 0);
    expect(records[0]).toMatchObject({
      event: 'egress.connection',
      outcome: 'resolve_failed',
      address: null,
      bytesUp: 0,
      bytesDown: 0,
    });
    expect(dialled).toEqual([]);
  });

  it('a name that does not resolve is logged resolve_failed', async () => {
    const { records, port } = await proxyFor({
      hosts: [HOST],
      resolve4: async () => Promise.reject(new Error('queryA ESERVFAIL')),
    });
    const { socket } = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`);
    socket.write(await clientHello(HOST));
    await until(() => records.length > 0);
    expect(records[0]).toMatchObject({ event: 'egress.connection', host: HOST, outcome: 'resolve_failed' });
  });

  it('refuses a host off the list, another port, plain HTTP and a request that is not HTTP, each with its rule', async () => {
    const { records, port, dialled } = await proxyFor({ hosts: [HOST], resolve4: () => Promise.resolve(['8.8.8.8']) });
    expect((await ask(port, 'CONNECT evil.test:443 HTTP/1.1\r\n\r\n')).answer).toBe('HTTP/1.1 403 Forbidden');
    expect((await ask(port, `CONNECT ${HOST}:80 HTTP/1.1\r\n\r\n`)).answer).toBe('HTTP/1.1 403 Forbidden');
    expect((await ask(port, `GET http://${HOST}/v1 HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`)).answer).toBe(
      'HTTP/1.1 403 Forbidden',
    );
    expect((await ask(port, 'hello\r\n\r\n')).answer).toBe('HTTP/1.1 400 Bad Request');
    expect(records).toEqual([
      { event: 'egress.refused', module: 'mod', host: 'evil.test', rule: 'not_allowed' },
      { event: 'egress.refused', module: 'mod', host: HOST, rule: 'port' },
      { event: 'egress.refused', module: 'mod', host: HOST, rule: 'not_connect' },
      { event: 'egress.refused', module: 'mod', host: '', rule: 'bad_request' },
    ]);
    expect(dialled).toEqual([]);
  });

  it('refuses a ClientHello that names another host (domain fronting) and one that names none', async () => {
    const { records, port, dialled } = await proxyFor({ hosts: [HOST], resolve4: () => Promise.resolve(['8.8.8.8']) });
    const first = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`);
    first.socket.write(await clientHello('evil.test'));
    await until(() => records.length === 1);
    const second = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`);
    second.socket.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00]));
    await until(() => records.length === 2);
    expect(records).toEqual([
      { event: 'egress.refused', module: 'mod', host: HOST, rule: 'sni_mismatch' },
      { event: 'egress.refused', module: 'mod', host: HOST, rule: 'sni_missing' },
    ]);
    expect(dialled).toEqual([]);
  });

  it("applies each listener's module's list only: module A cannot reach module B's host", async () => {
    const time = new ManualTime();
    const records: ProxyRecord[] = [];
    const proxy = new EgressProxy({
      resolve4: () => Promise.resolve(['8.8.8.8']),
      refused: REFUSED_RANGES,
      dial: () => new Socket(),
      log: (r) => records.push(r),
      setTimer: time.setTimer,
      now: () => time.now,
    });
    await proxy.listen('127.0.0.1', 0, 'module_a', ['a.example.test']);
    await proxy.listen('::1', 0, 'module_b', ['b.example.test']);
    closers.push(
      () => proxy.close('127.0.0.1'),
      () => proxy.close('::1'),
    );
    const viaA = await ask(proxy.port('127.0.0.1'), 'CONNECT b.example.test:443 HTTP/1.1\r\n\r\n');
    expect(viaA.answer).toBe('HTTP/1.1 403 Forbidden');
    expect(records).toEqual([
      { event: 'egress.refused', module: 'module_a', host: 'b.example.test', rule: 'not_allowed' },
    ]);
  });
});

describe('an unexpected failure inside a connection (lint-format R11)', () => {
  it('is logged as egress.handle_failed and closes the client: never an unhandled rejection, never a hung client', async () => {
    const { records, port } = await proxyFor({
      hosts: [HOST],
      resolve4: () => Promise.resolve(['8.8.8.8']),
      dial: () => {
        throw new Error('dial exploded');
      },
    });
    const { socket, answer } = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`);
    expect(answer).toBe('HTTP/1.1 200 Connection Established');
    socket.write(await clientHello(HOST));
    await until(() => socket.closed);
    expect(records).toEqual([{ event: 'egress.handle_failed', module: 'mod', host: '', detail: 'dial exploded' }]);
  });
});

describe('bounds (R6 (c); A6)', () => {
  it('refuses a peer that never answers at 10 s, logging duration and outcome and no body', async () => {
    const time = new ManualTime();
    const never = new Socket();
    let dialled = false;
    const { records, port } = await proxyFor({
      hosts: [HOST],
      resolve4: () => Promise.resolve(['8.8.8.8']),
      dial: () => {
        dialled = true;
        return never;
      },
      time,
    });
    const { socket } = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`);
    socket.write(await clientHello(HOST));
    await until(() => dialled);
    // The head's and the hello's reads have their own 10 s bounds, cancelled once read: the live one is the connect's.
    expect(time.fire(10_000)).toBe(1);
    await until(() => records.length > 0);
    expect(records).toEqual([
      {
        event: 'egress.connection',
        module: 'mod',
        host: HOST,
        address: '8.8.8.8',
        durationMs: 10_000,
        bytesUp: 0,
        bytesDown: 0,
        outcome: 'connect_timeout',
      },
    ]);
  });

  it('cuts a connection after 60 s of inactivity, and not before: traffic restarts the bound', async () => {
    const time = new ManualTime();
    const held: Socket[] = [];
    const stall: Server = createServer((s) => {
      held.push(s);
      s.on('error', () => undefined);
      s.write('first');
    });
    await new Promise<void>((resolve) => stall.listen(0, '127.0.0.1', resolve));
    closers.push(() => {
      for (const s of held) s.destroy();
      return new Promise((resolve) =>
        stall.close(() => {
          resolve();
        }),
      );
    });
    const upstreamPort = (stall.address() as { port: number }).port;
    const { records, port } = await proxyFor({
      hosts: [HOST],
      resolve4: () => Promise.resolve(['8.8.8.8']),
      dial: () => createConnection({ host: '127.0.0.1', port: upstreamPort }),
      time,
    });
    const { socket } = await ask(port, `CONNECT ${HOST}:443 HTTP/1.1\r\n\r\n`);
    const got: Buffer[] = [];
    socket.on('data', (d: Buffer) => got.push(d));
    const hello = await clientHello(HOST);
    socket.write(hello);
    await until(() => Buffer.concat(got).toString() === 'first');
    // Each byte re-armed the inactivity bound: exactly one is live.
    expect(time.timers.filter((t) => t.ms === 60_000 && !t.cancelled)).toHaveLength(1);
    expect(records).toEqual([]);
    expect(time.fire(60_000)).toBe(1);
    await until(() => records.length > 0);
    expect(records[0]).toMatchObject({
      event: 'egress.connection',
      outcome: 'idle_timeout',
      bytesUp: hello.length,
      bytesDown: 5,
    });
  });
});

describe('the ClientHello parser', () => {
  it('reads the server name of a real ClientHello, and none from bytes that are not one', async () => {
    expect(serverName(await clientHello('Bucket.S3.us-east-1.amazonaws.com'))).toBe(
      'bucket.s3.us-east-1.amazonaws.com',
    );
    expect(serverName(Buffer.from('GET / HTTP/1.1\r\n'))).toBeUndefined();
    expect(serverName(Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff, 0x01]))).toBeUndefined();
  });

  it('reads a name with a byte past 0x7f as no name, never as its low seven bits (0xe1 "pi" is not "api"; B-20)', async () => {
    const hello = await clientHello('xpi.example.com');
    const at = hello.indexOf(Buffer.from('xpi.example.com'));
    hello[at] = 0xe1;
    expect(serverName(hello)).toBeUndefined();
    const plain = await clientHello('api.example.com');
    expect(serverName(plain)).toBe('api.example.com');
  });
});

describe('the entry point (R6 (e))', () => {
  it('reads no environment variable or argument, and passes the system resolver and the fixed ranges', async () => {
    const main = await readFile(join(import.meta.dirname, '../../src/egress-proxy/main.ts'), 'utf8');
    const code = main.replace(/^[ \t]*\/\/.*$/gm, '');
    expect(code).not.toMatch(/process\.env|process\.argv|getenv|parseArgs/);
    expect(code).toContain('refused: REFUSED_RANGES,');
    expect(code).toContain("import { resolve4 } from 'node:dns/promises';");
    expect(code).toContain('resolve4: (host) => resolve4(host),');
  });
});
