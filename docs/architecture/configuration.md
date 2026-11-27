---
title: Reading and changing configuration
description: One file boundary, one identity and one lock for every reader and writer of a configuration.
type: architecture
status: active
created: 2026-11-16 17:20 +07:00
updated: 2026-11-25 18:16 +08:00
---

## The file boundary

`stitchkit/files` serves synchronous and asynchronous bounded regular-file reads (`readRegularFileSync`,
`readRegularFile`, `readJsonFileSync`, `readJsonOnce`, `PolledJsonFile`, `PolledJsonFiles`). Each
reader opens the path with `O_NONBLOCK`, checks through the open handle that it is a regular file,
and reads at most its declared byte limit. A FIFO, a directory and a device are refused; a symlink
to a regular file is followed, except under `noFollow` (`O_NOFOLLOW`, a drop-in declaration), where
it is refused. A file replaced, retargeted through a symlink, or changed while it is read is read
once more, then refused. A caller that judges the file by more than its type — the mode of a signing
key, the owner and mode of a drop-in file — runs its `accept` predicate on the same open handle the
bytes come from. JSON is decoded as strict UTF-8 and refuses `__proto__` keys, by one parser for
files and stdin (`parseJsonBytes`). Polled JSON caches keep a bounded payload cache (4 MiB default)
and always re-read and compare bytes for files changed within the last 3 seconds; older unchanged
files reuse their cached reading only when full stat identity (including mode, owner and link count)
and read options remain identical.

Every read names its ceiling explicitly; none relies on `stitchkit/files`'s 1 MiB default. A file an
operator or the fleet writes for the runtime to read whole — a broker or node configuration, a fleet
manifest, bundle or kept copy, a `config update` request — is bounded by `MAX_CONFIG_FILE_BYTES`,
16 MiB (`config/io.ts`). A contract with a smaller ceiling names its own: an enrollment record or
request 1 MiB, a service descriptor 256 KiB, a topic descriptor 64 KiB. An enrollment artifact is
bounded by 64 MiB; a signing key and a supervisor unit by 64 KiB.

A missing drop-in directory costs no polling timer: `PolledDeclarer` watches for its appearance
through `waitForDirectory` (`match: 'entry'`, `keepAlive: false`) from `stitchkit/files`, waking as
soon as any directory entry (directory, regular file, symlink or FIFO) appears at that path so the
drop-in policy runs immediately. If watching cannot be armed, it logs once and falls back to polling.

The configuration supervisor computes its digest through the same reader and ceiling as the load.
A new configuration that does not load, or a file it cannot read at all, is refused with one line
on stderr and the running configuration stays in force; the same refusal is not written again while
the file stays as it is.

## Identity and lock

`config/identity.ts` gives one canonical path to every reader and writer: a symlink alias is its
target, including a target that does not exist yet, and a Unix socket is its canonical directory and
its own name. `config/transaction.ts` gives one lock per canonical configuration. Two paths to one
configuration make no second lock and no second enrollment record. Ordinary contention answers
`busy` at once, without a hidden wait.

Enrollment, fleet reconciliation and administrative changes write only inside that lock, from the
configuration as it reads there. An atomic rename without the shared transaction does not protect
another writer's change. A reconciliation that finds the file already carrying its edition takes no
lock: one reading of an atomically replaced file is one whole edition of it, and a poll that locked
to write nothing would answer `busy` to the writer behind it.

## The administrative CLI

`stitchwire config inspect <node|broker> <path>` reads one snapshot of a configuration and of its
actual `fleet.copy`. Its JSON holds the verified serial, the signers, the trust, the verdict on the
tables and the digests of credentials, never a token. An unverified bundle is a named `unknown`,
not a zero edition. This inspects files; the health of a running process is a separate question.

```sh
stitchwire config update node /opt/wire/node.json --request /opt/wire/update.json --check
```

`--request -` reads bounded JSON from stdin. `--check` makes the same reads and checks under the
lock and keeps the configuration; without it the result is written. The request and result schemas
belong to `config/update.ts`; a result holds `state`, `beforeSha256` and `afterSha256`, never a
credential. A command that is not given its arguments is refused in one line, like every other
command of the CLI.

| Operation | Fields | Checked before the write |
| --- | --- | --- |
| `replace` | `expectedSha256`, `value` | The digest of the bytes actually read matches; the whole new configuration passes its schema |
| `roster` | `expectedNodes`, `nodes` | A broker only; the current roster is the one that was read; every other raw field is kept |
| `trust` | `trust` | The kept full bundle or own slices open under the proposed keys; a node has its own tables |

Trust is checked by signature and key material. A matching key id does not permit replacing a public
key when the kept bytes were signed by another. A missing, unreadable or unverified bundle stops the
update.

The file is written atomically with the exact mode `0600`. For a new configuration `init` validates
the schema before it is published and creates it only if absent: an existing file, and a concurrent
creator that won, are kept. A restrictive umask does not make a written configuration unreadable to
its owner.

Whether a delivered artifact has this command is checked in that artifact; the number of an earlier
release does not prove it.

## Service activation and admission

Activation keeps `services.namespaces`, `services.descriptors` and every other existing field and
changes only its own bindings and grants. A binding's timeout covers the largest opening timeout and
stream lifetime of its operations; the opening deadline and the lifetime after headers stay separate
budgets. A prepared configuration is applied by compare-and-swap inside the shared transaction.

Service admission counts the calls an owner socket runs, unary and streams together, in one small
ceiling (`service/socket-ceiling.ts`). The socket is the resource: a new descriptor inode, revision
or limit does not free the places in use, and each new call is held to the ceiling it brings. The
identity of a bound socket path is resolved once per policy. A policy that changes during descriptor
or endpoint I/O answers `unavailable` before dispatch, so a descriptor of one edition is never used
with a binding of another. An equivalent refresh keeps the current edition: the fingerprint covers
only the bindings and grants the executor owns, so a first local call does not collide with the
refresh at start.

## Broker lanes

A lane URL in `brokers[].url` is a URL with no credentials, query string or fragment (an empty `?`
or `#` included), and it is `https:` or `wss:`; `http:` and `ws:` only to this machine —
`localhost` (trusted by its name, not resolved), `::1` or an address of 127.0.0.0/8, read after URL
normalisation. `localhost.`, `*.localhost` and `::ffff:127.0.0.1` are refused. Anything else fails
the schema with the reason (`laneUrlRefusal`) and never the URL itself, which may hold credentials.
Every route by which a lane reaches an agent passes this one schema (`LaneUrlSchema`): the agent's
load of `node.json`, `init node --broker`, `config validate node`, `config update` and the
configuration enrollment writes. An enrollment request's endpoints use the same schema, and
`doctor --broker` and the client's `readBrokerHealth` ask the same rule.

## Paths and environment

A node's files live in one layout, the client SDK's (`local-client/src/paths.ts`) and the example
unit's alike: configuration under `<home>/.config/stitchwire`, the door socket and journals under
`<home>/.local/state/stitchwire`. A system unit uses the same layout under its user's home.
`STITCHWIRE_CONFIG_DIR`, `STITCHWIRE_STATE_DIR` and `STITCHWIRE_AGENT_SOCKET` override it verbatim;
set to the empty string they count as unset, and nothing is trimmed. The runtime and the SDK read
them through one function (`envPath`).

## Declarations and streams

Owner declarations come from two places: the paths `services.descriptors` and `events.descriptors`
bind, and the drop-in directories `services.dropInDir` and `events.dropInDir` — absent meaning
`services.d/` and `events.d/` beside a configuration file named `node.json`, `null` meaning none.
One resolver (`config/drop-in.ts`, `dropInDirs`) gives the agent, its stream admission, enrollment
and `config validate` the same directories, and one scan gives them the same files in the same force
order. Their rules are in `service-declarations.md` and `topic-namespaces.md`.

A node announces the complete current table of its topics, at most 256 names. One policy decides
which declared names are announced, for the agent and for enrollment alike: a name outside the
node's namespaces, a name the node's configuration or an earlier file already declares, and
everything past the aggregate limit are local refusals, reported by name. A corrected, bounded
replacement goes on withdrawing removed topics.

A local stream admission timeout cancels a remote producer that may exist. A terminal consumer
grants no credit on a late acknowledgement, and a cancel is not sent twice. A reconnect stop removes
only the sessions of its own snapshot; a final shutdown closes admission.

Checks: `config-update.test.ts`, `config-identity-links.test.ts`, `service-preflight.test.ts`,
`service-activation-stream.test.ts`, `socket-ceiling.test.ts`, `topic-declaration-policy.test.ts`,
`topic-aggregate-overflow.test.ts`, `producer-reconnect-stop.test.ts`, `drop-in-declarations.test.ts`,
`drop-in-set.test.ts`, `lane-url-tls.test.ts` and the standalone runtime and enrollment checks.

## Editions of the signed policy

A serial names one exact signed edition. Replaying it after it was reduced to an own slice is
idempotent; other signed bytes at the same serial are refused by the CLI and by a broker, and a
follower keeps the copy it accepted and records the conflict. A newer edition is accepted the
ordinary way.

A broker and an agent hold their configuration to the edition they keep through one reconciler
(`fleet/reconcile.ts`): one reconciliation at a time, run again when another edition arrived while
it waited for the configuration lock, and followed by a reload only when the tables the process
runs differ from the file.

A new enrollment artifact and unit are published by create-if-absent of the resource itself.
Concurrent installations from different configuration roots keep the bytes that won; equal bytes
let an interrupted installation continue, different ones are a conflict.
