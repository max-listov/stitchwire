---
title: SDK adoption and installation contract
description: Package identity, exact door contract and artifact installation without stale release literals.
type: architecture
status: active
created: 2026-08-30
updated: 2026-11-27 16:16 +08:00
---

## Release inputs

The release-ready runtime and SDK versions, the exact Stitchkit the workspaces build on and the
Stitchkit range the SDK accepts are read from the root and package manifests; this document does not
copy their changing values.
Source or locally packed bytes are not a replacement for an immutable published archive.
Local package checks do not authorize consumer installation.
The local door version is exported as `LOCAL_API_VERSION`; runtime broker/agent handshakes require
identical runtime releases. The SDK is tested separately against that explicit door boundary,
without requiring client and daemon package versions to be equal.

The Door version number is defined once, in `packages/contracts/src/door/common.ts`. Unit fixtures
import that constant and packed fixtures read it from the public SDK export. A separate check
installs the packed SDK in isolation and compares its export with the source contract under Bun and
Node, including a refused incompatible revision. The current number is never copied into fixtures;
an older number appears only in tests that prove it is refused.

The release manifest and SHA256SUMS identify exact published bytes; a local build or this document
alone is not a publication receipt. No dependency named `latest` belongs in a consumer lockfile.

The public SDK entrypoint remains `@stitchwire/client`: createWireClient, createServiceFetch,
createServiceIngress, serviceCaller, WireServiceError, WireClientError, ClientErrorCodeSchema, decodeWireData, LOCAL_API_VERSION and
their declared types. No broker/agent internals or domain SDKs are exported.

## Installation

1. Install the SDK from npm (`bun add @stitchwire/client` or
   `npm install @stitchwire/client`) or obtain the versioned `stitchwire-client-<sdk-version>.tgz` and
   the signed checksum list (`SHA256SUMS` and `SHA256SUMS.sig`) from GitHub Releases.
2. When installing from a release tarball, verify the archive SHA-256 against `SHA256SUMS` (`shasum -a 256`
   on macOS, `sha256sum` on Linux) after authenticating the checksum list with the Ed25519 public key
   in the standalone installer. npm installations can verify registry signatures and provenance with
   `npm audit signatures` in the installed project.
3. The SDK declares Stitchkit and Zod as peer dependencies: the consumer owns those versions and needs
   no override to keep a single copy of each (the SDK hands its schemas to Stitchkit, which needs them
   from the consumer's one Zod). A consumer without its own Stitchkit or Zod gets the newest one in the
   declared range, so it declares them itself.
4. Adopt one shared configured Wire client, dispose it at shutdown, preserve owner exceptions
   and remove duplicate Wire parsers/sequence validators after conformance passes.

The declared range is a promise that Bun does not enforce; the packed SDK gate installs the SDK next to
a consumer on the lowest version of the range and on the one the workspaces build on, proves that
exactly one Stitchkit and one Zod are installed each time and runs every fixture there. The floor moves only when
the SDK starts to need a newer API.

ESM only. Supported floors: Node 22.3.0 and Bun 1.4.4. Packed NodeNext and Bundler typechecks do not
use skipLibCheck. Package gates exercise Unix-only access, bounds, terminal cleanup, continuous
large feeds, strict sequence/outcome validation and both owner-client composition styles.

## Contract and publication states

| Surface | Verdict |
| --- | --- |
| Valid frames carrying the SDK's exported local door version | SDK accepts additive object fields and validates required classifications |
| Missing classification or broken cross-frame sequence | SDK rejects explicitly; do not weaken schema to keep malformed producers |
| SDK and runtime with different local door versions | named `version` error; coordinated SDK/runtime cutover |
| Mixed runtime releases | refused by exact-version handshake; coordinated update/rollback |
| Package installation | `@stitchwire/client` from npm and from GitHub Releases (`SHA256SUMS`) |

SDK-only changes do not require daemon restart. Runtime releases that change the local door revision
require coordinated broker/agent rollout alongside the matching SDK version.
