// The egress proxy (docs/plans/extension-modules.md R6 (b)–(e)): the one way a module's container reaches the
// internet. An HTTP CONNECT proxy listening once on each module network's own address, applying that network's
// module's allowlist only. A CONNECT is allowed only to port 443 of a host on the list; the TLS ClientHello that
// follows must name that same host (no domain fronting); the host is resolved once, IPv4 only, and every address it
// resolves to must be public unicast, or the connection is refused; the proxy then connects to that address and
// nothing else. Each connection is bounded by a 10 s connect timeout and a 60 s inactivity timeout, and each
// connection and each refusal is one JSON line on stderr — module, host, duration, bytes, outcome — never a body.
//
// The resolver and the refused ranges are constructor properties: the image's entry point (main.ts) passes the
// system resolver and REFUSED_RANGES and reads nothing that could change either (R6 (e)); unit tests pass a fake
// resolver and ranges that leave loopback open, to prove an allowed path end to end.

import { createServer, isIPv4, type Server, type Socket } from 'node:net';

import { present } from '../shared/assert-present.js';
import { hostAllowed } from '../shared/modules.js';

/** R6 (c)'s refused IPv4 ranges: every one that is not public unicast (colima's 192.168.5.0/24 and the host gateway among them). */
export const REFUSED_RANGES = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
] as const;

const CONNECT_TIMEOUT_MS = 10_000;
const IDLE_TIMEOUT_MS = 60_000;
/** The request head a client may send before its CONNECT is judged, and the ClientHello's first record. */
const MAX_HEAD_BYTES = 8 * 1024;
const MAX_HELLO_BYTES = 16 * 1024 + 5;
/** The port every module listener uses on its network's address. */
export const PROXY_PORT = 3128;

/** Why a connection was refused: the `rule` of `egress.refused`. */
export type RefusalRule =
  | 'not_connect'
  | 'bad_request'
  | 'port'
  | 'not_allowed'
  | 'sni_missing'
  | 'sni_mismatch'
  | 'address_refused'
  | 'head_timeout';

/** How an allowed connection ended: the `outcome` of `egress.connection`. */
type ConnectionOutcome = 'closed' | 'resolve_failed' | 'connect_failed' | 'connect_timeout' | 'idle_timeout' | 'reset';

export type ProxyRecord =
  | { readonly event: 'egress.refused'; readonly module: string; readonly host: string; readonly rule: RefusalRule }
  | { readonly event: 'egress.handle_failed'; readonly module: string; readonly host: string; readonly detail: string }
  | {
      readonly event: 'egress.connection';
      readonly module: string;
      readonly host: string;
      readonly address: string | null;
      readonly durationMs: number;
      readonly bytesUp: number;
      readonly bytesDown: number;
      readonly outcome: ConnectionOutcome;
    };

/** A timer that can be cancelled: the seam an injected clock replaces (A6). */
export type SetTimer = (callback: () => void, ms: number) => () => void;

export const realTimer: SetTimer = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  return () => {
    clearTimeout(timer);
  };
};

export interface EgressProxyProps {
  /** IPv4 (`A`) records of a host: the system resolver in the image; a fake in tests. Rejects when there are none. */
  readonly resolve4: (host: string) => Promise<readonly string[]>;
  /** Refused ranges, CIDR: REFUSED_RANGES in the image. */
  readonly refused: readonly string[];
  /** Opens the upstream connection to a checked address: `net.connect` in the image; tests reach a local server. */
  readonly dial: (address: string, port: number) => Socket;
  readonly log: (record: ProxyRecord) => void;
  readonly setTimer: SetTimer;
  readonly now: () => number;
}

interface Cidr {
  readonly base: number;
  readonly mask: number;
}

function ipv4ToInt(address: string): number {
  return address.split('.').reduce((n, octet) => (n << 8) + Number(octet), 0) >>> 0;
}

function parseCidr(cidr: string): Cidr {
  const [address, bits] = cidr.split('/');
  const prefix = Number(bits);
  if (address === undefined || !isIPv4(address) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32)
    throw new Error(`not an IPv4 CIDR: ${cidr}`);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (ipv4ToInt(address) & mask) >>> 0, mask };
}

/** Whether an IPv4 address lies in one of the ranges. */
function inRanges(address: string, ranges: readonly Cidr[]): boolean {
  const n = ipv4ToInt(address);
  return ranges.some((r) => (n & r.mask) >>> 0 === r.base);
}

/**
 * Within a ClientHello's server_name extension body (starting at `at`, `length` bytes long), the first DNS host
 * name (a type-0 entry in the list), lowercased and validated.
 */
function serverNameFromExtension(record: Buffer, at: number, length: number): string | undefined {
  let p = at + 2;
  const listEnd = Math.min(at + length, at + 2 + record.readUInt16BE(at));
  while (p + 3 <= listEnd) {
    const nameType = present(record[p], 'record[p]');
    const nameLength = record.readUInt16BE(p + 1);
    p += 3;
    // Each byte as itself (latin1, never 'ascii', which drops a byte's high bit and so reads 0xe1 as 'a'); a
    // name of anything but letters, digits, dots and hyphens is no name (review of 2026-10-02, B-20).
    if (nameType === 0) {
      const name = record
        .subarray(p, p + nameLength)
        .toString('latin1')
        .toLowerCase();
      return /^[a-z0-9.-]+$/.test(name) ? name : undefined;
    }
    p += nameLength;
  }
  return undefined;
}

/** Scans a ClientHello's extensions (from `at` to `extensionsEnd`) for the server_name extension (type 0). */
function scanExtensions(record: Buffer, at: number, extensionsEnd: number): string | undefined {
  let p = at;
  while (p + 4 <= extensionsEnd) {
    const type = record.readUInt16BE(p);
    const length = record.readUInt16BE(p + 2);
    p += 4;
    if (type === 0x0000) return serverNameFromExtension(record, p, length);
    p += length;
  }
  return undefined;
}

/** The server name of a TLS ClientHello's first record, or undefined when it names none or is not one. */
export function serverName(record: Buffer): string | undefined {
  try {
    if (record.length < 5 || record[0] !== 0x16) return undefined;
    const end = Math.min(record.length, 5 + record.readUInt16BE(3));
    let at = 5;
    if (record[at] !== 0x01) return undefined;
    at += 4; // handshake type and its 3-byte length
    at += 2 + 32; // client version, random
    at += 1 + present(record[at], 'record[at]'); // session id
    at += 2 + record.readUInt16BE(at); // cipher suites
    at += 1 + present(record[at], 'record[at]'); // compression methods
    const extensionsEnd = Math.min(end, at + 2 + record.readUInt16BE(at));
    at += 2;
    return scanExtensions(record, at, extensionsEnd);
  } catch {
    // A truncated or malformed hello reads past its end: it names no server, and is refused for that.
    return undefined;
  }
}

/** What readUntil (and readHello, built on it) can resolve with besides the bytes it collected. */
type ReadOutcome = 'timeout' | 'closed' | 'too_long';

/** One module network's listener: its address, its module, and that module's allowlist. */
interface Listener {
  readonly module: string;
  readonly hosts: readonly string[];
  readonly server: Server;
  readonly sockets: Set<Socket>;
}

export class EgressProxy {
  private readonly listeners = new Map<string, Listener>();
  private readonly ranges: readonly Cidr[];

  constructor(private readonly props: EgressProxyProps) {
    this.ranges = props.refused.map(parseCidr);
  }

  /** Listens on `address:port` for `module`'s connections, judged against `hosts` only. */
  listen(address: string, port: number, module: string, hosts: readonly string[]): Promise<void> {
    if (this.listeners.has(address)) return Promise.reject(new Error(`already listening on ${address}`));
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      // Handled per socket: handle() destroys the client on every path it takes; an unexpected rejection destroys it
      // too and is logged, never lost (PRINCIPLES §11) — a floating rejection here would be an unhandledRejection.
      this.handle(socket, module, hosts).catch((error: unknown) => {
        socket.destroy();
        this.props.log({
          event: 'egress.handle_failed',
          module,
          host: '',
          detail: error instanceof Error ? error.message : String(error),
        });
      });
    });
    this.listeners.set(address, { module, hosts, server, sockets });
    return new Promise((resolve, reject) => {
      server.once('error', (error) => {
        this.listeners.delete(address);
        reject(error);
      });
      server.listen(port, address, () => {
        resolve();
      });
    });
  }

  /** Stops listening on `address` and ends its connections. */
  close(address: string): Promise<void> {
    const listener = this.listeners.get(address);
    if (listener === undefined) return Promise.resolve();
    this.listeners.delete(address);
    for (const socket of listener.sockets) socket.destroy();
    return new Promise((resolve) =>
      listener.server.close(() => {
        resolve();
      }),
    );
  }

  /** The port a listener got (tests listen on port 0). */
  port(address: string): number {
    const bound = this.listeners.get(address)?.server.address();
    if (bound === null || bound === undefined || typeof bound === 'string')
      throw new Error(`not listening on ${address}`);
    return bound.port;
  }

  /** Logs the refusal and ends the connection: with an HTTP status before the tunnel is established, by a reset after (`null`). */
  private refuse(
    socket: Socket,
    module: string,
    host: string,
    rule: RefusalRule,
    status: string | null = '403 Forbidden',
  ): void {
    this.props.log({ event: 'egress.refused', module, host, rule });
    if (status !== null && !socket.destroyed)
      socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    socket.destroy();
  }

  /** Reads bytes from `socket` until `done` says it has enough, bounded by `max` bytes and CONNECT_TIMEOUT_MS. */
  private readUntil(socket: Socket, max: number, done: (buffer: Buffer) => boolean): Promise<Buffer | ReadOutcome> {
    return new Promise((resolve) => {
      let buffer = Buffer.alloc(0);
      const finish = (value: Buffer | ReadOutcome): void => {
        cancel();
        socket.off('data', onData);
        socket.off('close', onClose);
        socket.pause();
        resolve(value);
      };
      const onData = (chunk: Buffer): void => {
        buffer = Buffer.concat([buffer, chunk]);
        if (done(buffer)) finish(buffer);
        else if (buffer.length > max) finish('too_long');
      };
      const onClose = (): void => {
        finish('closed');
      };
      const cancel = this.props.setTimer(() => {
        finish('timeout');
      }, CONNECT_TIMEOUT_MS);
      socket.on('data', onData);
      socket.once('close', onClose);
      socket.resume();
    });
  }

  private async handle(client: Socket, module: string, hosts: readonly string[]): Promise<void> {
    client.on('error', () => client.destroy());
    const head = await this.readUntil(client, MAX_HEAD_BYTES, (b) => b.includes('\r\n\r\n'));
    if (head === 'closed') return;
    if (head === 'timeout' || head === 'too_long') {
      this.refuse(client, module, '', head === 'timeout' ? 'head_timeout' : 'bad_request', '400 Bad Request');
      return;
    }
    const end = head.indexOf('\r\n\r\n');
    const firstLine = head.subarray(0, head.indexOf('\r\n')).toString('latin1');
    const m = /^(\S+) (\S+) HTTP\/1\.[01]$/.exec(firstLine);
    if (m === null) {
      this.refuse(client, module, '', 'bad_request', '400 Bad Request');
      return;
    }
    const requestTarget = present(m[2], "the request line's target");
    if (m[1] !== 'CONNECT') {
      // A plain-HTTP request through the proxy (an http:// URL): never forwarded.
      const host = /^https?:\/\/([^/:]+)/i.exec(requestTarget)?.[1]?.toLowerCase() ?? '';
      this.refuse(client, module, host, 'not_connect');
      return;
    }
    const target = /^([a-z0-9.-]+):(\d{1,5})$/i.exec(requestTarget);
    if (target === null) {
      this.refuse(client, module, requestTarget.slice(0, 255), 'bad_request', '400 Bad Request');
      return;
    }
    const host = present(target[1], "the CONNECT target's host").toLowerCase();
    if (target[2] !== '443') {
      this.refuse(client, module, host, 'port');
      return;
    }
    if (!hostAllowed(host, hosts)) {
      this.refuse(client, module, host, 'not_allowed');
      return;
    }
    // Bytes after the head belong to the tunnel: the ClientHello, when the client sent it with the CONNECT.
    const early = head.subarray(end + 4);
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const hello = await this.checkedHello(client, module, host, early);
    if (hello === undefined) return;
    await this.tunnel(client, module, host, hello);
  }

  /**
   * Reads the ClientHello (already in `early`, or the rest of it from the wire) and checks its SNI names `host`;
   * refuses (or, if the client is already gone, does nothing) and resolves `undefined` on any mismatch.
   */
  private async checkedHello(client: Socket, module: string, host: string, early: Buffer): Promise<Buffer | undefined> {
    const hello =
      early.length >= 5 && early.length >= 5 + early.readUInt16BE(3) ? early : await this.readHello(client, early);
    if (hello === 'closed') return undefined;
    if (hello === 'timeout' || hello === 'too_long') {
      this.refuse(client, module, host, 'sni_missing', null);
      return undefined;
    }
    const sni = serverName(hello);
    if (sni === undefined) {
      this.refuse(client, module, host, 'sni_missing', null);
      return undefined;
    }
    if (sni !== host) {
      this.refuse(client, module, host, 'sni_mismatch', null);
      return undefined;
    }
    return hello;
  }

  private async readHello(client: Socket, early: Buffer): Promise<Buffer | ReadOutcome> {
    const rest = await this.readUntil(client, MAX_HELLO_BYTES, (b) => {
      const all = Buffer.concat([early, b]);
      return all.length >= 5 && all.length >= 5 + all.readUInt16BE(3);
    });
    return typeof rest === 'string' ? rest : Buffer.concat([early, rest]);
  }

  /** Resolves once, checks every address, connects to the first, and relays both ways until either side ends. */
  private async tunnel(client: Socket, module: string, host: string, hello: Buffer): Promise<void> {
    const started = this.props.now();
    let bytesUp = 0;
    let bytesDown = 0;
    let address: string | null = null;
    let logged = false;
    const done = (outcome: ConnectionOutcome): void => {
      if (logged) return;
      logged = true;
      this.props.log({
        event: 'egress.connection',
        module,
        host,
        address,
        durationMs: this.props.now() - started,
        bytesUp,
        bytesDown,
        outcome,
      });
    };
    let addresses: readonly string[];
    try {
      addresses = await this.props.resolve4(host);
    } catch {
      client.destroy();
      done('resolve_failed');
      return;
    }
    const usable = addresses.filter((a) => isIPv4(a));
    if (usable.length === 0) {
      client.destroy();
      done('resolve_failed');
      return;
    }
    // Every address must be public: a name that also points inside is refused whole (no second lookup, no choice).
    if (usable.some((a) => inRanges(a, this.ranges))) {
      this.refuse(client, module, host, 'address_refused', null);
      return;
    }
    address = present(usable[0], 'usable[0]');
    const upstream = this.props.dial(address, 443);
    let cancelConnect: (() => void) | undefined = this.props.setTimer(() => {
      upstream.destroy();
      client.destroy();
      done('connect_timeout');
    }, CONNECT_TIMEOUT_MS);
    let cancelIdle: (() => void) | undefined;
    const idle = (): void => {
      cancelIdle?.();
      cancelIdle = this.props.setTimer(() => {
        upstream.destroy();
        client.destroy();
        done('idle_timeout');
      }, IDLE_TIMEOUT_MS);
    };
    const end = (outcome: ConnectionOutcome): void => {
      cancelConnect?.();
      cancelIdle?.();
      upstream.destroy();
      client.destroy();
      done(outcome);
    };
    upstream.once('error', () => {
      end(cancelConnect === undefined ? 'reset' : 'connect_failed');
    });
    client.once('error', () => {
      end('reset');
    });
    upstream.once('connect', () => {
      cancelConnect?.();
      cancelConnect = undefined;
      idle();
      upstream.write(hello);
      bytesUp += hello.length;
      client.on('data', (chunk: Buffer) => {
        bytesUp += chunk.length;
        idle();
        upstream.write(chunk);
      });
      upstream.on('data', (chunk: Buffer) => {
        bytesDown += chunk.length;
        idle();
        client.write(chunk);
      });
      client.resume();
    });
    upstream.once('close', () => {
      end('closed');
    });
    client.once('close', () => {
      end('closed');
    });
  }
}
