# Generic product boundary

Treat every new or edited tracked surface as potentially public, even while repository visibility
is private. This requirement applies to source, tests, examples, docs, release notes,
commit messages, generated files and artifacts.

- Do not add private consumer/project names, operator identities, fleet topology, internal URLs,
  machine paths, customer payloads or links to private companion repositories. Use standalone
  generic technical requirements and synthetic test fixtures.
- Private deployment/integration evidence belongs outside this repository. The product must
  install, build, test and run with no private companion, neighboring checkout or fleet credential.
- Product documentation omits executor journals; authorship stays in private working records.
  (Check: the operator's external content inventory during the publication-surface audit.)
- Runtime owns transport identity, routing, grants, limits, cancellation and delivery certainty.
  Services own domain schemas, collection, freshness, journals, cursors and business decisions.
- Do not replace domain-specific branches with a plugin containing the same knowledge here.
  An explicitly approved breaking cutover removes adapters outright, without migration layers,
  legacy aliases or fallback. Consumer readiness is not a removal gate for that cutover;
  local implementation does not authorize changing installed configurations or consumer code.
- Reuse public Stitchkit primitives; upstream requests must be generic and supported by a concrete
  requirement. Do not move transport policy into the framework merely to reduce line count.
- Public-ready does not authorize a visibility change, public package publication, history rewrite,
  force-push or movement of existing tags. Preserve current operator review buffers.
- This source repository has no backlog. Internal task lifecycle is maintained outside the
  publishable source boundary in the project's declared private working context. Resolve that
  canonical location before task operations; do not create a local backlog, task copies or a
  symlink as a fallback. Keep private repository names and paths out of this source tree.
- Existing private content is migration debt, not precedent. Private project planning defines
  its reviewed separation and complete publication-surface audit.
- Release certification uses exact-source isolated local/owned-runner gates, packed-artifact
  checks and release/rollback smoke. Hosted GitHub Actions is optional, never a billing-dependent
  publication prerequisite. A failed or unavailable hosted job is not relabelled successful;
  record the actual direct gate evidence. Do not skip tests or change payment settings.

# How a change proves itself here

Each rule names the check that holds it; a rule with no check says so.

- Support is claimed after it works through the consumer's path. "The SDK supports X" in a
  changelog or a door contract needs a test that goes through broker and client, not a schema parse
  or a direct call of the inner function. (Check: review; the cooperative-command tests through a
  broker in `test/cooperative-broker.test.ts` are the pattern.)
- A performance change is measured on the traffic it will meet, reproducibly from this repository
  for both the old and the new version. A benchmark that feeds only the case the change optimises
  says nothing about production. (Check: each benchmark is a `benchmark:*` script; the audit
  benchmark takes a `mixed` workload and uses it by default.)
- Every new state, deadline and timeout says why in a comment, and an explanation already in the
  code is kept when the code around it is rewritten. (Check: review only.)
- Tests wait on conditions, with the clock only as a ceiling, and assert no durations (ADR 0012).
  `bun run check` runs the suite through `bun run test`, which sets the 30-second hang bound.
- A document is written in one language and describes the present; how something was measured
  belongs to the measurement, not to the architecture. (Check: review only.)
- A commit's type and title describe its own diff; a version bump of a dependency is not a fix
  made here. (Check: review only.)
- Enrollment certifies effects and their current process owner, never an intent or a checkpoint
  alone: a supervised verdict measures the unit's process and its ownership of the Unix door, and
  recovery tests interrupt real writes. What each verdict holds is in `docs/architecture/enrollment.md`.
  (Checks: `test/enrollment-recovery.test.ts` and `check:enrollment --systemd`, including the
  fresh-install crash runner.)
- An enrollment refusal names the innermost step that was running. An error carries a code and its
  cause; the operation's step runner names the phase, so a check shared by several steps never names
  one, and a step that returned gives the phase back to the step around it.
  (Check: `test/enrollment-failure.test.ts`.)
- A request that cannot be executed is refused by its schema, or before any wait, record or lock.
  (Checks: `test/enrollment-client-surface.test.ts` and `test/enrollment-failure.test.ts`.)
- Owner binding changes validate the complete remaining service and topic set before a reload, with
  the policy the agent itself applies to a declaration file. (Checks: the scenario registry
  `test/enrollment-scenarios/`, `test/topic-declaration-policy.test.ts`,
  `test/declaration-retry.test.ts` and standalone `check:enrollment`.) A declaration control retries
  a lost acknowledgement on the lane it has, without a reconnect.
- An enrollment proof addresses another node before any state or mutation, and its control reads the
  exact proof trace in the broker audit: delivered with target ingress, and not dispatched when only
  the broker grant is removed. It decodes the diagnostic journal frame that owns the trace, where
  `accepted` is a boolean for a call and a count for declarations. (Checks: the scenario registry
  `test/enrollment-scenarios/`, `test/enrollment-proof.test.ts` and standalone `check:enrollment`.)
- An enrollment acceptance scenario is added once, to the registry; `bun test` and
  `check:enrollment` both run that list, so a scenario is never written twice for two drivers.
  (Check: `test/enrollment-scenarios.test.ts`.)
- A name exported by `@stitchwire/client/enrollment` is added on purpose, never by `export *`.
  (Check: `test/enrollment-client-surface.test.ts`.)
- Test conditions wait boundedly on the real configuration lock and on observations, without
  changing what the CLI does: the stand's CLI and crash injection ask again only on the exact `busy`
  refusal of that lock, with one ceiling, and every other result stays terminal. Contention that
  persists fails the wait: it is never read as the refusal the control intended. (Checks:
  `test/enrollment-lock.ts`, `test/enrollment-crash-runner.ts` and
  `test/enrollment-fixture-controls.test.ts`.)

- An equivalent effective service policy refresh preserves in-flight preflight. Edition fingerprints
  project only executor-owned bindings/grants, even when construction receives a larger node config.
  A real replacement still refuses before dispatch. (Checks: `test/service-preflight.test.ts` and
  immediate first self-call in `test/service-loopback.test.ts`.)

- An unreachable external door does not authorize a new supervisor over a pre-existing config.
  Systemd config birth follows its durable runtime reservation under the shared config lock;
  readiness still needs actual process/listener proof. (Checks: `test/enrollment-runtime-claim.test.ts`
  and standalone Linux acceptance with the external child paused and its door unlinked.)
