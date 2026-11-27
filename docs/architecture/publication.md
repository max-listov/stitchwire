---
title: Publication inputs and pre-release verification
description: Product-only source selection, artifact integrity and explicit authorization gates.
type: architecture
status: active
created: 2026-08-30
updated: 2026-11-27 14:13 +08:00
---

## Source boundary

A publication source snapshot is distinct from the working repository and its history.
`scripts/public-source.ts` selects:

- root files: package and build metadata, `.passport.json`, `AGENTS.md`, license, readme, security
  policy, contributing guide, changelog and `docs/VISION.md`;
- trees: `packages`, `scripts`, `test`, `examples`, `contrib`, `docs/architecture`,
  `docs/decisions`, `docs/assets` and `.github/workflows`.

It excludes Git data, internal backlog, operational state, dependencies, generated outputs and
unrelated root files.
Unexpected file types, hidden files inside source trees, links, home paths and recognized credential
shapes fail preparation. This finite pattern scan is not a comprehensive secret or security audit.

The destination must not exist and must be outside the source tree. No tracked file, index, branch,
tag or remote is changed. On failure only the newly created destination is removed.
The manifest lists each file's SHA256, size and normalized executable mode; it contains no timestamp,
absolute operator path or source Git identity. Verification rejects changed bytes, modes, extra
files, Git data, links and paths outside the selected product surface. Hashes are integrity checks,
not a publisher signature: retain the manifest checksum through a trusted channel.

```sh
bun scripts/public-source.ts --out ../wire-public-source
bun scripts/public-source.ts --verify ../wire-public-source
cd ../wire-public-source
bun install --frozen-lockfile --ignore-scripts
bun run verify
```

Verify the untouched snapshot before dependency installation: its manifest deliberately rejects
extra generated/dependency files. Retain an untouched copy for review; use a separate copy for gates.
`verify` requires no Git metadata. `verify:clean` is a repository-review check using Git inventory,
not the installation command for a history-free source snapshot.

## Artifact boundary

The runtime artifact requires its MIT license and bundled third-party notices. The SDK archive
includes its own license and declares external runtime dependencies. The resolved dependency
inventory includes build/test tools as well as runtime packages and is not a minimal bundled SBOM.
License/NOTICE files are copied verbatim. Missing notices or undeclared licenses remain explicit
review entries; a package manifest license declaration is not independent legal approval.

Permitted candidate outputs are the reviewed source snapshot, runtime, packed SDK, the runtime npm
package (`dist/runtime-package/stitchwire-<version>.tgz`), LICENSE, THIRD_PARTY_NOTICES, dependency
inventory and exact checksums. `contrib/install.sh` is source, fetched from the repository, and
installs only assets listed in a release's `SHA256SUMS`. Installation tests must use those
same bytes. Do not attach operator configuration, tokens, logs, rollback artifacts or unreviewed
historical archives. A private rollback packet and a public release set are different outputs: a
candidate directory holds them as `rollback/` and `release/`, each sealed by its own manifest and
`SHA256SUMS`, and publication uploads `release/` only.

## Release decision

Every source manifest declares `private: true`. The build packs `@stitchwire/client` and
`stitchwire` into `dist/`. The publisher uploads the sealed release set to a GitHub draft,
checks the downloaded assets, publishes the exact tarballs to npm, and verifies the bytes
anonymous users receive before opening the GitHub Release. A release requires an approved version, a trusted
publication destination, a private security reporting channel, license/provenance review and exact
tested artifact checksums. The release pipeline must actually run its advertised OS/runtime matrix;
configuration alone is not a passing CI receipt.

Public source distribution uses a history-free snapshot (`scripts/public-source.ts`). Unreviewed
private history and rollback artifacts never enter a public release packet. Existing repository
history and release attachments are not in the snapshot and must not be exposed by changing
repository visibility.

Runtime activation is a separate operational step: all brokers and agents use the exact same
release. Config validation, coordinated upgrade, rollback and real post-install calls belong to
that activation receipt. A locally green snapshot is not proof of installed fleet health.

### Before the repository opens

Opening is a separate decision from a release, and it waits for all of these:

1. **History-free lineage.** The public repository starts from a verified snapshot; no existing
   repository becomes public by a visibility switch.
2. **Security reporting channel.** Private vulnerability reporting is enabled on the public
   repository and a test report has reached the maintainer. `SECURITY.md` names only that channel.
3. **Publication destination.** The npm names `stitchwire` and `@stitchwire/client` and the GitHub
   repository in `package.json` `repository` belong to the publisher.
4. **Packages before readers.** The npm packages and the GitHub Release that the README's install
   commands name exist before the repository opens. After the release each of those commands is run
   once on a clean machine.
5. **Final content audit.** The operator inventory audit of the final snapshot, run after its last
   edit, has zero findings.

### The gates a release actually passes

In order. Each proves something different, and the last one is the one the decision turns on.

1. `bun run verify` — typecheck, lint, the whole test suite, the runtime build, the packed client
   installed and typechecked on both runtimes, the dependency inventory and the publication guard.
   It proves the tree is internally consistent. It does **not** exercise two releases against each
   other, so a green `verify` is not a release decision.
1b. **The content audit, and it runs BEFORE the tag exists.** `verify` cannot include it: the audit
   needs an operator inventory that lives outside this repository, and a path into it must not
   appear in this tree. So the operator runs it — `scripts/content-audit.ts --inventory <path>` —
   and runs it LAST, after every edit this release will carry. Three releases in a row were refused
   here instead, i.e. after the tag was already pushed, and each refusal was a true finding: a
   consumer named in a comment, an owner project named in the changelog, an operator literal
   spelled out in a test fixture rather than assembled at runtime. Nothing about those is caught by
   any gate above, and an audit run before the last edit answers about a tree that no longer
   exists.
2. `bun scripts/create-candidate.ts` — the release set (artifact, runtime notices, manifest and
   checksums) and the private rollback packet beside it.
3. `bun run smoke -- --candidate-binary <candidate>/release/stitchwire-<version> --rollback-binary
   <candidate>/rollback/stitchwire-<previous>.rollback` (`scripts/release-smoke.ts`)
   — the mixed-version matrix. Ten scenarios across RPC, streams, events, resume, peer RTT, config
   preflight and rollback.
4. Coordinated activation, then post-rollout observation.

**The smoke gate needs two binaries, not one.** It runs the candidate against the *previous
release*, so that previous artifact has to be kept, not rebuilt from a tag on the day. Without
`--rollback-binary` the script refuses to start; there is no single-binary mode and there should not
be one, because half a fleet is the state a flag day actually passes through.

Retention is therefore part of releasing, not housekeeping: when a release ships, its runtime file
is kept so the NEXT release has something to run against. `dist/retained/stitchwire-<version>` is
that place. A release that ships without retaining its own artifact leaves the following release
unable to run this gate at all.

**Both version pins move at release time.** The script asserts the exact candidate and rollback
versions it was given and throws otherwise. The pin is deliberate — one fleet runs one version, so
"do these two interoperate" has a single answer per release and the matrix asserts it rather than
re-deciding it. Bump both; never loosen the guard to make a run pass.

**There is no NO-GO branch.** The ten `GO` values in the final JSON are constants: a failing
scenario throws, and the absence of an exception is the verdict. Read it as "nothing refused",
not as a judgement the script formed.


## Complete publication history

Before creation, SDK immutability checks read the complete paginated release catalog, validate its shape,
and compare every matching archive's downloaded digest. Catalog or download failure refuses publication.
Native CLI adapters preserve the operator environment required by GitHub authentication and tool lookup;
bounded output is captured without printing credential values.

History content and secret audits require successful `rev-list` and both `cat-file` commands. Every requested
object must return the matching identity, type, byte length and complete newline-framed body. Missing,
malformed, truncated or extra frames cannot attest completed coverage. Consumers require the complete report
and its corresponding exit status; missing fields never become measured zero findings.

Every reachable tree leaf path is inspected separately from deduplicated blob contents, including
old names sharing identical bytes and gitlinks whose target belongs to another repository.
An identity-document exemption applies only when all paths of those bytes are identity documents.

A release resumed after smoke requires a successful receipt for its exact source commit, version,
predecessor and verified candidate manifest digest. Starting smoke invalidates the previous receipt;
the complete packet digest must remain identical before and after the real smoke. Every external
stage checks this receipt before acting. A gate-only receipt cannot authorize publication.
