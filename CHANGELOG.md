# Changelog

## 0.58.1 — Signed standalone updates and trusted npm publication

- The standalone installer verifies an Ed25519 signature covering the release manifest, runtime and native modules before installing or upgrading. The original public release remains installable by exact version and checksum.
- The runtime and SDK (0.31.1) are published from the smoke-tested archives by the tagged GitHub Actions workflow. Each new npm version carries provenance linking it to the release commit.

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
