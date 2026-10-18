# Security

## Reporting a vulnerability

Email **admin@SimplyAutonomous.AI**, the one channel for reporting a vulnerability. Please do not open a public issue
for it: describe what you found and how to reproduce it in the email, and leave any key or credential out of it.

## Supported versions

The latest release only.

## What asha guards

- **The daemon listens on the loopback address only,** `127.0.0.1`, never on a network the Mac is on.
- **Its control API needs a credential,** a random secret in a file only your user may read, which the CLI and the
  portal present, and every request's `Host` and `Origin` must be the daemon's own; agents have tokens of their own,
  which open only the agent API, and every model server needs a key only the daemon holds.
- **Agent containers reach no port of your Mac but the daemon's:** every other destination — the host's other ports,
  the local network, the VM and the internet — is refused. An agent reaches a model only through the daemon, and a
  cloud service only when a module its recipe grants reaches it, through an egress proxy, to that module's hosts.

How each is built and tested: [Architecture](./docs/architecture/index.md) and [Testing](./docs/testing/index.md).
