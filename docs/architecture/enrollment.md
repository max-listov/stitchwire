---
title: First enrollment of a node
description: A local, versioned enrollment for a trusted orchestrator, with separate credential, admission and verification steps.
type: architecture
status: active
created: 2026-11-16 12:50 +07:00
updated: 2026-11-25 12:18 +08:00
---

# Contract

`stitchwire enroll <operation> --request <file>` reads one UTF-8 JSON request of version 1 (`-`
reads it from stdin, under the same 1 MiB limit) and writes one JSON result. Exit code 0 means the
operation succeeded and 2 that it was refused; every outcome, a defect of the program included, is
one JSON result. The request and result schemas live in `packages/contracts/src/enrollment/`, and a
consumer takes them from the SDK entry `@stitchwire/client/enrollment`, whose exported names are the
public surface. The thin CLI calls `runtime/enrollment/operation.ts`.

This is a local administrative entry. A trusted orchestrator chooses the machine, delivers files and
runs the commands as the OS user that owns the configuration. Wire has no network admin listener,
no SSH client and no arbitrary shell.

| Operation | Where | What it does |
| --- | --- | --- |
| `plan` | broker or node | Reads the actual inputs, health and conflicts; creates nothing |
| `prepare` | node | Stores the node's one credential and its own fleet copy; returns digests only |
| `apply` | broker | Adds the digest to the roster, projects the signed policy, waits for the running broker to report it |
| `apply` | node | Binds the owner, installs the runtime when asked, verifies declarations and the requested service proof |
| `status` | broker or node | Reads the actual state again; on a node it makes the read proof when one is requested |
| `detach` | node | Removes one owner's descriptor paths; the agent and other owners stay |

A broker request has no `prepare` and no `detach`; a broker `apply` needs the digest. What can be
refused from the request and the operation alone is refused before any wait, record or lock, so such
a refusal leaves nothing behind and the same `requestId` stays usable.

`plan` and `status` create no lock, directory, record or credential. They read broker health and the
existing Unix door; no access or no answer is a named refusal.

# Bootstrap order

1. Publish the signed manifest with `fleet publish`. The new node is already a member with
   `copy: own`; its grants and service namespaces belong to that manifest.

2. On a broker, plan with an admission request. Its `material` holds only the signed slice of the
   addressed node and the public trust. Deliver that object to a private file on the node over a
   trusted channel; the trust is a statement of the local administrator, not a proof from the bundle.

   ```sh
   stitchwire enroll plan --request /var/lib/wire/admission-request.json
   ```

3. On the node, prepare. Each `credentials[].sha256` goes to the administrator of the named broker;
   the token itself stays in the node configuration.

   ```sh
   stitchwire enroll prepare --request /var/lib/wire/node-request.json
   ```

4. On every broker, apply the admission request with the digest it was given.

   ```sh
   stitchwire enroll apply --request /var/lib/wire/admission-request.json
   ```

5. On the node, apply the same node request. Success is `status: ready`: the lanes and declarations
   as observed and, when a proof was requested, a successful permitted service call made as this node.

   ```sh
   stitchwire enroll apply --request /var/lib/wire/node-request.json
   ```

# Requests

Common fields: `v: 1`, a UUID `requestId`, `kind`, `nodeId`, the exact `expectedVersion` and an
absolute `config`. A new `requestId` names a new desired operation. `prepare` and the `apply` that
follows share one `requestId`; `detach` takes a new one. Other inputs under a recorded `requestId`,
or turning its attach into a detach, are `request-conflict`. `material` is not part of the
fingerprint: it is evidence of an edition, not desired state, so a later operation of the same
request may omit it once the node keeps its own copy.

Admission request:

```json
{
  "v": 1,
  "kind": "admission",
  "requestId": "5fe6a1a8-f937-489b-82c2-913ec2ca6f21",
  "nodeId": "worker",
  "expectedVersion": "0.57.0",
  "config": "/var/lib/wire/broker.json"
}
```

`apply` adds `tokenSha256` from the node's `prepare`. It is a digest, not a secret. A node id the
broker already admits under another digest is `credential-conflict`: enrollment rotates no token and
adds no second one. Admission reads the full bundle from the broker's existing `config.fleet.copy`,
verifies it through the existing `fleet.trust` and checks membership. It signs and publishes
nothing, receives no signing key and grants nothing beyond what is signed.

A node request adds:

| Field | Meaning |
| --- | --- |
| `material` | Absolute path of the `material` object of a broker plan; needed only by a node without a kept signed copy |
| `brokers` | `{ id, url }` rows, at most 8, no credentials in the URL; HTTPS, or HTTP on loopback |
| `agentSocket` | Absolute path of the Unix door, at most 103 bytes |
| `owner` | `{ id, descriptors: [{ kind: "service" or "topic", path }], adopt? }` |
| `proof` | Optional. `{ descriptor, call, responseSha256 }`: the owner's descriptor, a service call and the digest of the expected answer |
| `supervisor` | `{ kind: "existing" }`, or `{ kind: "systemd", scope: "system" or "user", bun, unit?, artifact: { source, destination, sha256 } }` |

A new supervised installation always names its runtime and an existing agent never does: the
artifact is part of the systemd supervisor, so a request that names one without the other does not
parse.

One edition judges a request. A node without a kept copy is judged by the delivered `material`;
without that it is `material-required`. A node with a copy (`config.fleet.copy`, verified by
`config.fleet.trust`) is judged by it, and delivered material cannot roll it back: material older
than the copy is `bundle-stale`, other signed bytes at the same serial `bundle-conflict`, a damaged
or unreadable copy `bundle-invalid`. A connected node lives on its own copy, which the reconciler
keeps current: `status`, `detach` and a repeated `apply` need no trip to a broker after somebody
else's publication.

Delivered material is definitive, so `plan` and `status` with it answer at once. An operation judged
by the kept copy follows that copy: while a broker is ahead of it or behind it, or the tables wait
for the reconciler's self-reload (at most three a minute), the observation is read again, and
`bundle-stale` or `bundle-conflict` is named only after 90 seconds; a publication during the wait
is followed too. A mutation also waits up to 20 seconds for a broker to answer, a lane to connect and
its own effects to appear — an agent restart, acknowledged declarations. That ceiling is the sum of
the default periods those effects pass through — the agent's configuration watch (5 s), a broker's
fleet `pollMs` (5 s) and a lane's `reconnect.maxDelayMs` (10 s) — not a measurement; a node
configured with longer periods can need more. The service proof waits the same 20 seconds for a
route that is still settling (`offline`, `unavailable`); any other answer is final. Each ceiling bounds the
start of the last attempt, so a wait ends at most one attempt later. What cannot change during one
operation — the bytes of the artifact and the versions it and Bun report — is measured once and
remembered; a repeated attempt reads observations only. `status` writes nothing while it waits.

A proof chooses what `ready` certifies. Without `proof` no service call is made, the result's
`proof` is `null`, and `ready` certifies identity, exact version, every lane, the edition and the
accepted declarations, but not the service route. That mode is for a service owner who reads the new
node through a broker in the real direction of the call. With `proof`, `ready` also certifies a
permitted remote call: the mode for an orchestrator with no route check of its own. The mode is read
from the result itself: `status: ready` with a `proof` object, or with `proof: null`. Adding or
removing a proof under a recorded `requestId` is another desired operation, `request-conflict`.

`proof.call` holds `to`, `service`, `revision`, `operation`, a JSON string `payload` and
`timeoutMs`. The descriptor must declare a matching unary operation with `effect: read`; a write
proof is refused before dispatch. The answer must be 2xx and have the given SHA-256. The result
reports the measured HTTP status and nothing of the payload or the answer. A proof may be read again
on a retry, so it must fit the owner's read contract. `proof.call.to` must differ from `nodeId`: a
self-target is `proof-not-remote`, refused before any state, lock, record, credential, artifact or
supervisor, for every node operation including `status` and `detach`. An ordinary SDK self-call
keeps its local execution; it does not prove a broker route. A remote proof must pass the broker's
grant and the real target ingress, otherwise the result is `proof-failed`.

The owner sends the complete desired set of both kinds. Each `service` path is read as a service
declaration and each `topic` path as a topic descriptor. One path has one kind and one owner.

A path the configuration already binds with no recorded owner — written by an installer before
enrollment existed — is `owner-conflict` for an ordinary request. With `adopt: true` the owner takes
such paths over as they are: the configuration and the agent's declarations do not change, the
ownership record does, and from then on the paths are the owner's like any other — an ordinary
`apply` with the same set is `ready` and a `detach` removes them. A path another owner holds stays
`owner-conflict`, and an adopted path keeps the kind it is bound under.

```json
{
  "id": "example-app",
  "descriptors": [
    { "kind": "service", "path": "/var/lib/example/service-declaration.json" },
    { "kind": "topic", "path": "/var/lib/example/topic-descriptor.json" }
  ]
}
```

One configuration transaction changes `services.descriptors` and `events.descriptors`. The
application writes the contents of its files. Before a reload Wire validates the complete remaining
set with the policy the agent itself applies: namespaces, service, socket and topic collisions,
topics the node's configuration already declares, and the aggregate topic limit. A damaged file that
would remain is `declaration-invalid`, so one owner's reload cannot lose another owner's last valid
topics; a removed file that is invalid or missing does not prevent a detach.

The set includes the files of the node's `services.d/` and `events.d/` drop-in directories, in the
agent's force order: an explicit binding that would take the service, socket, topic or room of a
drop-in declaration in force now is `declaration-invalid`; a conflict already inside a drop-in
directory does not block an unrelated request. Enrollment reads drop-in files under the drop-in
policy as the agent's user reads them, whoever runs it: the files must be owned by the owner of
`node.json`, which only its agent reads (mode `600`), so root enrolling a node whose agent runs as
another user still sees every drop-in declaration in force. The drop-in directories are the ones
the running agent derives from its configuration path as it spells it (`status.config.path`): a
`node.json` reached through a link of another name has them beside the link. With no agent running
they are derived from the request's path, the one an installation starts its agent with. The canonical file
identity closes a second binding through a symlink; a Unix socket is compared by its canonical
directory and its name, because a live socket cannot be resolved by `realpath` on every platform.

The node's own slice carries no broker-side subscriber, count or retention ceilings; the broker
checks those when the node declares. Such a refusal after the configuration was written is
`declaration-refused`, a named partial outcome and not `ready`: the owner fixes its descriptor and
applies again, or withdraws it with a new detach request. A lane's positive acknowledgement is kept
only for its last send.

After the write, enrollment judges the running agent's answer as it judged the set before it: by
what belongs to the request. From the agent's status, every lane must have answered the complete set
the agent sends now, an empty withdrawal included — an entry the agent refused itself was never sent,
and a broker answers every entry it was sent, so an answer that counts them is the answer to the
current set and an earlier answer, or none, is refused. Nothing of this owner may be refused: a
service refused on the node with the owner's path, a grant of the owner's service or a topic of the
owner's refused by a broker, or a topic of the owner's the agent's plan does not give to the owner's
files. A topic refusal on the node carries no path, so a name that plan gives to the owner's file is
another file declaring it again. A refusal of another file — two drop-in files claiming one service,
a broker refusing another owner's grant — is that file's, shown in node status and `doctor`, and
never refuses this request.

# Installation and retry

A new installation supports Linux with systemd and Bun at least the minimum the contract exports
(`MINIMUM_BUN_VERSION`). A systemd request over an existing configuration needs the matching
reservation whether or not the Unix door answers: an unreachable door is no proof that an external
agent stopped. A fresh `prepare`, under the configuration lock, first stores the reservation of the
validated installation and then creates the configuration; a crash after either write resumes with
the same runtime and the token already written. A reservation proves no readiness: MainPID, process
birth, executable, argv, the listening door and the remote proof are verified separately. An
unmanaged existing configuration is not taken over by a new systemd installation; an explicit
`supervisor: existing` keeps its own contract.

An installed agent has one shape: `packages/runtime/src/enrollment/unit.ts` renders it, and the
example `contrib/systemd/stitchwire-agent.service` is the same render for the user scope with `%h`,
which a test compares. The unit is `stitchwire-agent.service` by default; `supervisor.unit` names
another only for a second agent on a host or an isolated stand beside a live agent. The unit, of
`Type=exec`, starts the absolute Bun and the exact artifact with `agent --config`. A unit of that
name that systemd loads from elsewhere, a masked one, or one with a drop-in for that name is
`runtime-conflict` before any write: enrollment does not override what it did not write. A drop-in
for the name is looked for in the manager's search path too, because systemd lists none for a unit
it cannot find. Drop-ins every service loads (`service.d/`) belong to the host.

The installation record keeps the SHA-256 of the unit as it was written. Verifying an installation
that exists — a request with `supervisor: existing`, and the verification of a running node —
compares the file with that digest, so a release that renders units differently still recognises an
installation made by an earlier one. A systemd request is compared with the render of the running
release and with the recorded artifact digest: other bytes are refused before any write.
The bytes the renderer writes for a layout are pinned by a test (`test/installed-unit-bytes.test.ts`):
a change of renderer changes the recorded digest of every installed node, whose repeated systemd
request is then refused, so it is made together with what those nodes need.

Configuration and state locations are passed explicitly, without reliance on an interactive PATH.
An existing unit with other bytes is not overwritten. A retry makes an idempotent start and keeps
the MainPID. `existing` reuses a compatible agent on macOS or Linux and does not change what
supervises it. Supervised readiness verifies the MainPID, the birth identity of the process, its
executable and argv, and its descriptor on the node's own Unix door; another healthy door does not
prove that the new unit started. In `ExecStart` a literal `$` is written as `$$`, separately from
environment assignments, per the
[systemd rules](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#Command%20lines).
Stitchkit `verifySupervisedProcess` checks the listening descriptor against the filesystem node
using procfs and iproute2 `ss`; enrollment re-reads systemd's MainPID after verification.
Without `ss` the listener cannot be certified (`runtime-unavailable`).
A listener that is missing or replaced during a configuration reload is a temporary
`runtime-unavailable` for the bounded read-back; a stable listener of another process is
`runtime-conflict`.

The `runtime` of a `ready` or `detached` result is a measurement, not an echo of the request: the
`version` the running agent reports, and `installation` — the `path` and `sha256` of the live
runtime file and the `service` (`manager`, `scope`, `unit`) that manages the agent. `installation`
is measured by the record enrollment left for this configuration; where it installed nothing it is
`null`. An orchestrator reads the state of the service only by the returned unit name. A Bun that is
missing at the requested path is `version-mismatch`.

After the runtime was updated in place (for example by a fleet rollout) the owner asks with a new
`requestId` (the fingerprint includes `expectedVersion`), `supervisor: { "kind": "existing" }` and
the CLI of the new version.

Before any change the exact runtime version in every broker's health, the version of the executing
CLI, the artifact's SHA-256 and its real `--version`, Bun, the trust, the signed own slice and the
declarations are checked; every broker is asked at once and the refusal reported is the first in the
request's own order. An incompatible runtime is not used to change a live network. Bootstrap updates
no broker and is no upgrade mechanism for an installed runtime. An artifact with other bytes at the
destination is refused.

The token is created directly in a configuration of mode 0600. Private directories are created
0700, atomic writes 0600, the artifact 0700. No token reaches argv or any output. The configuration
is the source of truth for the credential: after a lost answer a retry reads it and generates none.
Bundles do not roll back. An own-copy node never receives the full manifest.

Every configuration writer of enrollment and of fleet reconciliation uses one lock and an atomic
write to the canonical target. A symlink is preserved and an alias creates no second record. The
snapshot is read inside the lock, and other roster entries, bindings, descriptors and settings are
kept. An occupied configuration is `busy`, reported and not recorded as the request's first
failure; a dead local owner is reclaimed by the lock itself. An edition that changed while the lock
was being acquired publishes no earlier tables or verdict: the current edition is checked at once.

Beside the configuration, the directory `<config>.enrollment` keeps two kinds of record. One per
`requestId`, read by every operation and written only under the request's own lock: the request's
fingerprint, its intent, the phases it completed and the first refusal it met. One per
configuration, written only under the configuration lock: which owner bound which descriptor path,
and the single installation the configuration runs under. No token, request, payload or subprocess
output is stored. These are recovery evidence: success is always decided by reading back. The
journal is written when a mutation starts, so a refusal of the read that precedes the first write is
its first failure; a refusal before the mutation started leaves no record. The ownership intent is
written before the configuration; an interruption between the two is recovered from the desired and
the still-managed bindings. An existing descriptor of somebody else cannot be taken, and a path
shared by two owners is refused. A detach removes no configuration, credential, agent, supervisor,
descriptor of another owner or grant.

A detach is verified against the owner's recorded scope in the configuration and the runtime, even
when the request's list is empty. Both kinds are withdrawn by one write. The last owner leaves empty
service and topic declarations, which the broker must acknowledge. A retry with an unchanged set
rewrites nothing and restarts nothing.

Nothing in enrollment removes its own records. An installation record left by a `prepare` that was
interrupted before the configuration was written, and journals of finished requests, are removed by
the administrator of the machine; the record names nothing secret.

# Verification and refusals

A ready node has the requested node id, the exact version, the configuration's origin and mode,
every lane endpoint connected, an aligned bundle serial, the owner's descriptors loaded, no local
refusal and a positive declaration acknowledgement from every lane. With a proof in the request, the
service proof then checks the real path through a broker. A file write alone is not admission.

A result names its `status` and, by it, its fields:

| Status | Kind | Fields beyond the common ones |
| --- | --- | --- |
| `planned` | node | `credentials` |
| `prepared` | node | `credentials` |
| `ready` | node | `credentials`, `runtime`, `proof` |
| `detached` | node | `credentials`, `runtime` |
| `planned` | admission | `material`, `admitted` |
| `admitted` | admission | `material`, `admitted` |
| `failed` | — | `failure` |

Common fields are `v`, `requestId`, `nodeId`, `operation`, `observedAt`, `completed` and
`firstFailure`. `credentials` are `{ broker, sha256 }` rows of the node's own configuration;
`admitted` are the digests the broker holds for the node. A broker `status` answers `admitted` only
when its roster holds the node and the running broker reports it, and `planned` while it holds
nothing; a roster that holds the node while the running broker does not report it is refused at
once as `runtime-unavailable`. `completed` is the history of a mutation and no substitute for the
current reading: it lists the steps that ran, so an `existing` supervisor, for which enrollment
installs and starts nothing, never lists `artifact`, `supervisor-unit` or `supervisor`. The first
refusal of a mutation is kept after a successful resume.

A `failure` names the `code`, the `phase` — the innermost step that was running when the operation
refused, whichever check refused — the time, and `systemCode`: the code of the refusal underneath,
wherever it was measured — the operating system's, the runtime's or a lock's. Parser errors and
subprocess output are never returned.

| Code | Meaning |
| --- | --- |
| `invalid-request` | The request does not parse, or cannot have this operation |
| `version-mismatch` | A measured runtime or Bun version is not the requested one |
| `artifact-mismatch` | The artifact is missing, unreadable, or its SHA-256 differs |
| `admission-denied` | The fleet does not admit the node: no trust, or no membership in the signed edition |
| `permission-denied` | The operating system refused access to a local file and no step names it more exactly; under a step's own code (`artifact-mismatch`, `declaration-invalid`, `runtime-conflict`) the denial is read in `systemCode` |
| `credential-conflict` | The broker's own records hold another digest |
| `broker-unavailable` | A broker's health or a required lane is unreachable |
| `handshake-refused` | A broker refused the handshake; the node cannot observe why |
| `supervisor-failed` | An unsupported platform, or systemd refused |
| `runtime-unavailable` / `runtime-conflict` | The door is absent, or belongs to another configuration, identity or supervisor |
| `bundle-invalid` / `bundle-stale` / `bundle-conflict` | The signature, membership or edition does not fit |
| `owner-conflict` | The path belongs to another owner |
| `declaration-invalid` | A declaration file of the final set cannot be loaded here; no reload changes that |
| `declaration-refused` | A broker has not accepted the node's declarations |
| `proof-not-remote` | A self-target proves no broker route; refused before any mutation |
| `proof-not-read` / `proof-failed` | An unsafe proof, or an unsuccessful real remote call |
| `material-required` | A node without a kept signed copy was given no broker `material` |
| `request-conflict` / `busy` / `io-failed` | Inconsistent inputs, an occupied lock, an I/O failure |
| `state-invalid` | A damaged record, or a result outside its own contract: the defect is named on stderr and the journal's history is kept |

A handshake reveals no secret and no internal reason: a wrong token is confirmed on the broker by a
digest conflict; the node does not guess it from a general refusal.

Standalone check: `bun run build && bun run check:enrollment`. On an isolated Linux stand,
`bun scripts/check-enrollment.ts --artifact <runtime> --systemd` adds a real installation, MainPID
and child bindings, two owners, detach, positive and negative service calls with no dispatch for a
refusal, an unprivileged user for the operating system's refusal, a foreign unit that is never
overwritten or run — a unit of the requested name with other bytes, a drop-in for it, or one systemd
loads from another directory of its search path — and recovery of a real installation after an
abrupt child exit. The crash runner defaults to
`test/fixtures/enrollment-crash.ts`; a bundled check names it with `--crash-runner <bundle>`. The
script uses only the given runtime and synthetic state; no fleet is needed.

The acceptance is one registry of scenarios, `test/enrollment-scenarios/registry.ts`: each scenario
is a whole story on its own fleet and says whether it needs a systemd host. Two drivers run the
list: `bun test` against the source entry (`test/enrollment-scenarios.test.ts`) and
`check:enrollment` against a built artifact. The controls a scenario is made of are in
`test/enrollment-controls/`.

# The fleet operator's entry

Bootstrap needs the node's membership in the signed manifest, admission on every broker and the
operator's own record of the new runtime. That is the operator's half: it lives where the manifest,
the signing key and the records of the fleet's runtimes are, outside Wire. Wire defines its
contract — `packages/contracts/src/enrollment/fleet-admission.ts`, exported by the same SDK entry —
so that an orchestrator enrolls a node without knowing one fleet's conventions.

The request holds `v: 1`, `requestId`, `nodeId`, `target` (how the operator reaches the machine, in
its own words), `grants` (the node's service namespaces, and topic namespaces with subscribers,
`maxTopics` and an optional `maxRetainedBytes`) and, after the node's `prepare`,
`credentials [{ broker, sha256 }]`. The operations are `plan`, `apply`, `status` and `withdraw`. The
admission has the phases `inventory`, `membership`, `admission` and `activation`, and every
operation reads where it stands; `apply` also makes the operator's moves, `plan` and `status` are
its reading half. `withdraw` takes back an admission given up before the node was activated: it
makes the operator's moves backwards and undoes only what that admission did. An activated node is
refused as `node-active`: removing a member of a fleet is the operator's own procedure.

A member is `ready` only while it answers the way `activation` reads it; then nothing changes, and
digests it did not present are `credential-conflict`. A member that no longer answers — its machine
reinstalled, its credential lost — is admitted again by `apply`: the result names what it fails,
carries the node fragment, and with the digests of its new `prepare` every broker keeps exactly the
new digest for it, so the previous credential is admitted nowhere. Nothing is replaced while the
node is still connected under its previous credential.

A result that is not a refusal says whose move the admission waits for:

| Status | The next move |
| --- | --- |
| `awaiting-operator` | An operator `apply` would act now |
| `awaiting-credentials` | The node is a member: run node `enroll prepare`, then apply with its digests |
| `awaiting-node` | Every broker admits it: run node `enroll apply`, then apply again. In a withdrawal: the node is still connected — stop its agent, then withdraw again |
| `ready` | None: the node is an ordinary member of the fleet |
| `withdrawn` | None: nothing of the admission is left |

It carries `phase` (the first phase that is not complete), `waiting` (what that phase waits for, by
name), the exact `delta` (manifest entries and operator records the admission adds, or a withdrawal
takes back), `unrecorded`
(operator records it changed that the operator has not recorded yet; a failed recording is
`record-failed`) and `node`: the fragment of the node request the operator owns — `nodeId`,
`expectedVersion`, `config`, `brokers`, `agentSocket` and the systemd `supervisor` with the
artifact's `destination` and `sha256` — and `delivery`: the `material` object the orchestrator
writes to a private file on the target, and the path of the runtime on the operator's machine. The
orchestrator adds the delivered `source`, its own owner and its proof. A refusal names the code, the
phase and, when it belongs to one, the broker.
