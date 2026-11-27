# Changelog

## 0.58.0 — First public release

Stitchwire connects services on machines behind NAT through a trusted broker. Agents dial
outbound over TLS. Applications use a local Unix socket for typed calls, bounded streams
and events. Broker and agent grants control what each caller may do.

- Install the broker, agent and CLI from npm as `stitchwire`, or download the standalone
  runtime and its SHA-256 checksums from GitHub Releases. The runtime supports macOS and Linux.
- Install the ESM client as `@stitchwire/client` at version 0.31.0. It includes TypeScript
  declarations, a browser-safe contracts entry point and helpers for service calls and broker health.
- Broker and agent versions must match. The SDK checks the local door protocol independently.

See the [quick start](README.md) for installation and a working service example.
