// The egress proxy's entry point, in its own container (docs/plans/extension-modules.md R6 (e)): the system resolver
// (`A` records only) and R6 (c)'s fixed refused ranges, nothing read from the environment or the arguments that could
// change either. The daemon drives it over stdin, one JSON line per order:
//
//   {"op":"listen","address":"<its address on a module network>","module":"<id>","hosts":[...]}
//   {"op":"close","address":"..."}
//
// and it answers each on stdout, `{"op":"listening","address"}`, `{"op":"closed","address"}` or
// `{"op":"failed","address","detail"}`, after a first line `{"op":"ready","address":""}` once it reads its orders.
// Its records (each connection and refusal) are JSON lines on stderr, which the daemon re-logs through its facade
// (R35).

import { resolve4 } from 'node:dns/promises';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

import { EgressProxy, PROXY_PORT, REFUSED_RANGES, realTimer } from './proxy.js';

const proxy = new EgressProxy({
  resolve4: (host) => resolve4(host),
  refused: REFUSED_RANGES,
  dial: (address, port) => connect({ host: address, port }),
  log: (record) => process.stderr.write(`${JSON.stringify(record)}\n`),
  setTimer: realTimer,
  now: () => Date.now(),
});

const answer = (value: Readonly<Record<string, unknown>>): void => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let order: { op?: unknown; address?: unknown; module?: unknown; hosts?: unknown };
  try {
    order = JSON.parse(line) as typeof order;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'egress.control_invalid', detail: (error as Error).message })}\n`);
    return;
  }
  const address = typeof order.address === 'string' ? order.address : '';
  if (
    order.op === 'listen' &&
    typeof order.module === 'string' &&
    Array.isArray(order.hosts) &&
    order.hosts.every((h) => typeof h === 'string')
  ) {
    proxy.listen(address, PROXY_PORT, order.module, order.hosts).then(
      () => {
        answer({ op: 'listening', address });
      },
      (error: unknown) => {
        answer({ op: 'failed', address, detail: (error as Error).message });
      },
    );
  } else if (order.op === 'close') {
    void proxy.close(address).then(() => {
      answer({ op: 'closed', address });
    });
  } else {
    answer({ op: 'failed', address, detail: 'not an order this proxy takes' });
  }
});

// The daemon closing stdin, or stopping the container, ends the proxy.
process.stdin.once('end', () => process.exit(0));

// The first line: the container exists and the program reads its orders. The daemon connects no module network to the
// proxy before it (a `docker network connect` to a container `docker run` has not made yet finds no such container).
answer({ op: 'ready', address: '' });
