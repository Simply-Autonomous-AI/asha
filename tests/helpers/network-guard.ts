// The unit and integration suites' network guard (docs/plans/extension-modules.md A17): every module test in the gate
// runs against fakes, so no test of these suites may open a connection to any address but loopback. Installed by the
// suites' setup file, it wraps net.Socket.prototype.connect — which node:net's connect, node:tls, node:http and fetch (undici)
// all reach — and throws, naming the address, for a TCP connection to anything but 127.0.0.0/8, ::1 or localhost.
// A Unix socket (a path) is local and allowed.

import net from 'node:net';

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost)$/;

export class NetworkGuardRefused extends Error {
  constructor(readonly host: string) {
    super(
      `network guard: a test opened a connection to ${host}, which is not loopback (extension-modules A17): use a fake`,
    );
    this.name = 'NetworkGuardRefused';
  }
}

/** The host a Socket.connect call names, or undefined for a Unix socket. */
export function connectHost(args: readonly unknown[]): string | undefined {
  const [first, second] = args;
  // connect(options[, listener]) or connect([options, listener]) as net.connect passes it.
  const options: unknown = Array.isArray(first) ? first[0] : first;
  if (typeof options === 'object' && options !== null) {
    const o = options as { path?: unknown; host?: unknown };
    if (typeof o.path === 'string') return undefined;
    return typeof o.host === 'string' ? o.host : 'localhost';
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return undefined; // connect(path[, listener])
  return typeof second === 'string' ? second : 'localhost'; // connect(port[, host][, listener])
}

/**
 * `net.Socket.prototype`, read as a holder of a plain function value rather than a method — so the type checker
 * never infers a `this` for it, and reading it is not the "unbound method" `.connect` really is: this capture is
 * always re-applied with the live socket's own `this` (below), never called bound to the prototype.
 */
interface UnboundSocketConnect {
  readonly connect: (...args: unknown[]) => net.Socket;
}

/** Installs the guard, once per process (the suites' setup file calls it: tests/helpers/network-guard.setup.ts). */
export function installNetworkGuard(): void {
  const original = (net.Socket.prototype as unknown as UnboundSocketConnect).connect;
  if (original.name === 'guardedConnect') return;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const host = connectHost(args);
    if (host !== undefined && !LOOPBACK.test(host)) throw new NetworkGuardRefused(host);
    return original.apply(this, args);
  };
}
