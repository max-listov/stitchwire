---
title: Local candidate distribution and verification
description: Supported artifacts, isolated installation checks and the boundary before public publication.
type: architecture
status: active
created: 2026-08-30
updated: 2026-11-27 16:15 +08:00
---

## Artifacts

`dist/stitchwire` is JavaScript with a Bun shebang, not a native executable. Install Bun 1.4.4
or a separately verified compatible version first. Runtime requires Linux or macOS Unix sockets.
On macOS the runtime also needs Stitchkit's native module, which reads a process's boot and start
identity for journal locks. The build writes it beside the artifact as
`dist/stitchwire.darwin-arm64.node` and `dist/stitchwire.darwin-x64.node`; install the one for the
machine's architecture at `../native/darwin-<arch>.node` relative to the binary (for
`~/.local/bin/stitchwire`, that is `~/.local/native/`). Without it a macOS lock records no process
identity and a reused PID cannot be told from the dead owner. Linux reads `/proc` and needs nothing.
The build finds both Darwin modules through Stitchkit's build-only `stitchkit/files/packaging`
API, which Stitchkit still marks as evolving: a change to its result is a build change here. One
plugin points the runtime, built as `bin/stitchwire`, at `native/darwin-<arch>.node`, and the
loader picks the module for the machine it runs on. The build must produce exactly one JavaScript
file. Packaging compares each module with the size and SHA256 that the Stitchkit package published
when it was built, and returns the verified bytes; the build writes those bytes and does not read
the file again. A module substituted after installation fails the build with
`NATIVE_ASSET_DIGEST_MISMATCH`. The digest proves the module is the one that package shipped, not
that the package is the one we locked: that is answered by the lockfile. Installation writes the same `bin/` and `native/`
layout. If the module for the running architecture is missing, the runtime reports the backend as
unavailable even when the other architecture's module is present. Running on arm64 does not prove
the x64 module works.
`dist/client/stitchwire-client-<version>.tgz` is the optional ESM SDK, packed from the publishable
copy `dist/client-package/` that `bun run build:client` writes; its declared engine floor
is Node 22.3.0 / Bun 1.4.4. It declares Stitchkit as a peer dependency, so an install holds the
consumer's copy and no second one. The local receipt must name which versions were actually tested.
Contracts are bundled internally, not a third public package, and are also exposed through the
browser-safe `@stitchwire/client/contracts` subpath (depending only on `zod`, with zero `node:*`,
`process` or `Buffer` runtime dependencies).

Run `bun install --frozen-lockfile --ignore-scripts`, then `bun run verify`.
The same command is available through an optional manually dispatched hosted workflow, without
deployment or publication credentials. Release certification runs directly on owned runners.
A separate trusted workflow publishes new npm versions. Record the exact source and
artifact hashes, executed checks and actual platforms; do not relabel unexecuted hosted jobs green.
This runs
all package typechecks/tests, the runtime build, standalone artifact and packed SDK gates.
It also generates `dist/dependency-inventory.json` and `dist/THIRD_PARTY_NOTICES.txt` from installed
package metadata/notices reached through root/workspace dependency edges. Nested package versions
and installed optional peers are retained; unused Bun cache entries and dependency development
tools are excluded. Missing required dependencies fail the gate. This includes workspace build/test
tools and is not a minimal bundled SBOM or legal
approval. Missing upstream notice files are reported explicitly for review, never fabricated.
The standalone gate installs the artifact with its native module outside the source tree, starts two brokers
and two agents. CLI init, validation, doctor, activation dry-run and actual service success/refusal
are exercised with synthetic temporary configurations, and every journal lock the agents take must
record its owner's process identity. Packed SDK gates install into another
temporary project and exercise Node/Bun plus strict TypeScript, bounds and cleanup.
The enrollment gate runs the installed artifact's CLI through planning, admission, service proof,
independent owner attachment and detach. Its Linux `--systemd` acceptance additionally checks real
supervision, process ownership, access refusals and fresh-install crash recovery.

Candidate packing is not release publication. `scripts/create-candidate.ts --baseline
<approved-prior-artifact> --signing-key <key-file> --out <new-directory>` writes one candidate directory with two sealed sets,
each with its own `manifest.json` and `SHA256SUMS`:

| Set | Holds | Leaves the machine |
| --- | --- | --- |
| `release/` | runtime, native modules, runtime and SDK npm archives, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `dependency-inventory.json` | yes: it is the release |
| `rollback/` | the predecessor binary and its native modules, byte for byte | never |

The rollback manifest names the release manifest's digest, so a rollback packet cannot be paired with
another candidate. Publication, smoke receipts, certification and SDK acceptance use one integrity
verifier, `verifyCandidate`. The operator must verify the predecessor against its trusted release
checksum before supplying it; executing `--version` alone is not artifact authentication. Existing
candidate directories are never overwritten. Rollback is byte-preserving and may contain historical
metadata unsuitable for public distribution, which is why it is a set of its own.

## Installation and removal

The gates a release passes, and what each one proves, are in the publication checklist's
[release decision](./publication.md#release-decision) — including the mixed-version smoke gate,
which needs the previous release's binary beside the candidate.

Install the runtime from npm
(`bun add -g stitchwire`, which ships `bin/stitchwire` beside `native/darwin-*.node` with zero external
runtime dependencies), or via the standalone installer (`contrib/install.sh`, which requires Bun and never installs it, and downloads `manifest.json`, `SHA256SUMS`,
`stitchwire-<version>` and, on macOS, its architecture sidecar into `~/.local/bin` and
`~/.local/native`). The installer authenticates `SHA256SUMS.sig` with its embedded Ed25519
public key before using any checksum. The signed list covers the runtime, native modules and
`manifest.json`. Mirrors serve identical signed bytes. An explicit pin to the original unsigned
public release uses its checksum-list digest embedded in the installer.
It downloads over https only (a `STITCHWIRE_RELEASE_BASE` of plain `http:` is accepted on loopback
alone) and follows no redirect off https. The candidate file name is `stitchwire-<version>`, and a
manifest that names any other file is refused before a download. The new runtime answers `--version`
from a staged copy beside its staged native module before any installed file is replaced; a run
stopped between the two replacements puts the previous pair back. The installer is for one machine:
it is not how a fleet rolls back, which is the release's own coordinated procedure over the copies
each node kept. `bun run check:runtime-package` packs `dist/runtime-package/stitchwire-<version>.tgz`
and exercises it in an isolated install through the `node_modules/.bin/stitchwire` symlink, verifying
both runtime health and native lock identity on macOS.

Place private `broker.json` or `node.json` under the operator's `STITCHWIRE_CONFIG_DIR`; use
`STITCHWIRE_STATE_DIR` for writable state. Local owners declare services and topics in sibling
`services.d/` and `events.d/` drop-in directories beside `node.json` (only a configuration file named
`node.json` has them; `0700` dirs and `0600` `*.json` files owned by the agent's user and writable by
nobody else) rather than editing `0600 node.json` or restarting the agent. Do not reuse another
node's credentials. A broker and an agent can have distinct config/state directories. Run
`stitchwire broker` or `stitchwire agent` with those explicit environment values. The agent refuses a
plain `http:` or `ws:` broker URL outside loopback. Production TLS termination and service
supervision are operator responsibilities, not installed by package import.

The `contrib/systemd` examples are user units installed under `~/.config/systemd/user`; use
`systemctl --user`. Their `%h` refers to that user's home and no `User=` template expansion is needed.
Install Bun in `~/.bun` and the runtime in `~/.local/bin`, and create writable state before enabling.
Both systemd and launchd examples name Bun explicitly, because a service's minimal PATH may not find it.
The launchd example needs all `USERNAME` placeholders replaced before bootstrap.

On macOS, `com.stitchwire.agent.plist` launches through `Stitchwire.app/Contents/MacOS/stitchwire-launcher`,
so macOS attributes local-network permissions to Stitchwire instead of a bare interpreter. The bundle
is built from a source checkout:

- `bun scripts/macos-bundle.ts` compiles the launcher with `clang` (Xcode Command Line Tools), builds
  the icon with `rsvg-convert` (`brew install librsvg`), `sips` and `iconutil`, and installs
  `~/Applications/Stitchwire.app`.
- It signs only with the operator's own Developer ID Application identity; there is no ad-hoc
  fallback. `--identity <SHA-1>` names one; otherwise a keychain with identities of several teams
  signs with the team the installed bundle is signed by, and with no installed bundle it refuses and
  lists them. A rebuild signed by another team is refused before it replaces the installed bundle:
  macOS ties the Local Network permission to the team, and would ask again.
- Without such an identity, remove the launcher entry from `ProgramArguments` and launchd runs Bun
  directly; macOS then attributes the agent's network access to Bun.
- An installed bundle records a fingerprint of its launcher source, compiler flags, Info.plist and
  icon, not of the signer. `bun scripts/macos-bundle.ts` rebuilds when it differs and says why;
  `--force` rebuilds a current one.
- The launcher forwards every signal it can safely catch to its child — not SIGSEGV, SIGBUS, SIGILL,
  SIGFPE or SIGTRAP, which macOS cannot tell from a fault — and ends by the child's signal or exit
  status.
- Its only launch guard is that launchd is its parent: any launchd job of the same user can run a
  program under the bundle's identity, which is therefore trusted exactly as the user account.

The [service recipe](../../examples/service/README.md) explains grants. For SDK-free reads, POST a
JSON `ServiceCall` to `/wire/services/invoke` using HTTP over the configured local Unix socket; the
body contains `to`, `service`, `revision`, `operation`, JSON-string `payload`, and `timeoutMs`.
Parse the versioned result and its delivery outcome, not just HTTP 200. The standalone gate executes
this path without importing the SDK. Every door path is composed by the contract that declares the
endpoint — `packages/contracts/src` — and quoted here for readers who will not import it.

Before removal, stop the exact supervised process and revoke its broker admission/grants. Remove
only its installed artifact and service definition. Preserve token/config copies, audit data and
rollback until the operator's retention decision; uninstall never recursively removes a home or
shared state directory. To remove the optional client dependency, use `bun remove @stitchwire/client`
in the consumer project after its imports are gone. Wire does not deploy or migrate that consumer.

## Publication boundary

The [publication input contract](publication.md) defines the history-free product snapshot, which
artifacts may enter a reviewed release packet and what must be true before the repository opens.
Public releases never attach private rollback packets: `scripts/publish-release.ts` uploads the
candidate's `release/` set, including the detached signature of its checksum manifest.

The publisher uploads the sealed assets to a GitHub Release draft. It checks the names and
versions inside both npm tarballs and dispatches the tagged workflow with the approved manifest digest.
A job with draft access transfers the candidate into an immutable Actions artifact. The publishing
job verifies its signature, tag, manifest digest and contents, then publishes with npm OIDC.
The operator checks the registry bytes, verifies signatures with `npm audit signatures`, and binds
each new archive to the workflow, tag and commit in its SLSA statement before opening the release.
A retry accepts a previously uploaded archive only when its bytes match the candidate.

`scripts/publication-guard.ts` keeps every source manifest `private: true` — the root and all four
workspaces — and checks that the two publishable manifests, `@stitchwire/client` and `stitchwire`,
are generated into `dist/` without it. It refuses `--publish`.

`scripts/content-audit.ts --inventory <external-json>` scans source, docs and candidate artifacts
against an operator-supplied deny inventory and returns locations and labels, never matched values.
It is a content audit, not secret detection, history clearance or a security review. The artifact
path and token-shape checks do not certify:

- branches, tags or commit metadata;
- LFS objects;
- release assets or logs.

No history rewrite, ref movement, registry publication or visibility change is part of local
verification.
