# The fleet bundle

A deployment of Wire has one declaration of authority — who belongs to the fleet and what each pair
of nodes may do — and many copies of it: capabilities, command grants, service grants and topics at
each broker, the matching halves at each node. The fleet bundle keeps those copies true without a
central machine that logs into the others.

## Parts

| Part | Where | Written by |
| --- | --- | --- |
| Manifest (`FleetManifestSchema`) | wherever the deployment keeps its source | the deployment |
| Signing key (Ed25519, PKCS#8, mode 600) | on each machine allowed to publish | `stitchwire fleet keygen` |
| `fleet.trust` — public keys accepted | every broker and node configuration | the deployment, once |
| Kept copy | `fleet.copy` on every broker and node | the process itself |
| Fleet tables | the broker and node configuration files | projected from the kept copy |

`fleet.trust` is never taken from a bundle: a bundle cannot vouch for the key that signed it.

## The manifest

```json
{
  "version": 1,
  "members": { "alpha": { "copy": "full" }, "gamma": { "copy": "own" } },
  "access": [
    { "from": "alpha", "to": "gamma", "commands": ["probe"], "services": { "owner.window": ["service-read"] } },
    { "from": "alpha", "to": "*", "peer": true }
  ],
  "topics": { "release.gamma.lifecycle": { "producer": "gamma", "subscribers": ["alpha"], "delivery": "ordered" } },
  "topicNamespaces": { "owner.gamma.": { "producer": "gamma", "subscribers": ["alpha"], "maxTopics": 8 } },
  "serviceNamespaces": { "gamma": ["owner."] }
}
```

Every node named anywhere must be a member. A pair is stated once and must grant something.

## The bundle

```text
bundle  { format, serial, full, slices }
full    signed { kind: full,  serial, issuedAt, manifest }
slices  signed { kind: slice, serial, issuedAt, node, tables }   one per `copy: own` member
```

Each part is signed on its own over the exact string it carries (keys sorted at every depth). A
receiver verifies every part against its own `fleet.trust`, and a full bundle must be consistent:
one slice per `own` member, each equal to the projection of the full manifest for that node.

`serial` is monotonic. A process keeps an edition only if it is newer than the one it keeps.
`stitchwire fleet publish` picks one past the kept edition and never behind the clock in seconds.

## Who holds what

| Holder | Keeps | Can repair |
| --- | --- | --- |
| broker | the full bundle | every node that connects to it |
| `copy: full` member | the full bundle | itself, and any broker that lost its copy |
| `copy: own` member | its own slice, `full: null` | itself |

A broker accepts only a complete bundle, because it must answer both kinds of member. A `copy: own`
member never receives the manifest; its slice carries only the tables projected for it.

## Flow

1. The signer runs `stitchwire fleet publish --manifest <file> --id <key-id>`. The bundle is
   verified with the public half and written to the signer's own kept copy.
2. The agent reads its kept copy every `fleet.pollMs` (5 s). A newer edition is kept, applied, and
   handed (`fleet:publish`) to every connected broker known to keep an older one.
3. A broker verifies it, keeps it, applies it to its own roster and offers it to every connected
   node (`fleet:offer`).
4. A node that hears an offer, or connects, asks its broker (`fleet:sync` with the serial it keeps).
   The broker answers with its serial and, when newer, the bundle reduced to what that node may
   hold. A `copy: full` member that finds its broker behind hands it the newer bundle. A question
   a broker left unanswered (sync or publication) is asked again on a later poll, at most once every
   six polls, and never while an earlier question to that broker is still open; a refusal is an
   answer and is not asked again.

## Applying

The fleet tables of a node are `events.publish`, `events.subscribe`, `events.namespaces`,
`services.grants` and `services.namespaces`. The fleet tables of a broker are `capabilities`,
`commandGrants`, `serviceGrants`, `topics`, `topicNamespaces` and `serviceNamespaces`, projected for
the nodes on its own roster. Everything else — identity, credentials, roster, command profiles,
bindings, owner descriptors, admission, audit — belongs to the machine and is carried through.

On every poll and every new edition the process compares its configuration file with the
projection:

- The file is rewritten when its fleet tables differ. The projected file must load under the same
  schema first; the previous file is kept as `<file>.before-bundle`.
- The process reloads in place when the tables it is running differ from the file. A hand edit
  that the process never loaded is undone on disk and nothing restarts.
- Every poll reads the kept copy's and the configuration's bytes; size and `mtime` are never
  trusted as identity. An unchanged kept copy is not parsed again (up to 1 MiB is retained per file;
  a larger one is simply parsed each time). The configuration is reconciled on every poll; after a
  write it is read back and checked with the same schema, and `checkedAt` moves on every poll.
- Comparisons are made on parsed configuration, so a default filled in by the schema never reads as
  a difference.
- At most three self-reloads per minute per file. A configuration two writers keep changing is
  reported as `drifted` instead of restarting the process in a loop.

`stitchwire broker` and `stitchwire agent` reload inside the same process: the new file is loaded
first, and a file that does not load leaves the running configuration in place. They also compare
the file's bytes with the ones they run every five seconds (`CONFIG_WATCH_MS`), so any edit that
loads — a table the bundle rewrote, a descriptor path an owner's installer added — runs without a
service restart. Rewriting identical bytes changes nothing.

A reload the supervisor declines (the file does not load, or is already the one loaded) leaves the
old process running, and that process goes on polling its sources and asking its brokers: the
request is held only until the supervisor settles it, and a repeated request stays bounded by the
three-reloads-per-minute limit above.

## Other delivery paths

`fleet.sources` names further files an edition may arrive in, read-only. A deployment can deliver
the bundle through any file-sync mechanism it already trusts; the node verifies it exactly as it
verifies one from a broker. `stitchwire fleet publish --also <file>` writes the signed bundle there.

## Observing it

- Node status `bundle`: `copy` (`none | full | own`), `serial`, `issuedAt`, `signer`, `config`
  (`unconfigured | unknown | aligned | drifted`), `detail`, and each lane's answered serial.
- Broker health `bundle`: the same edition fields and `config`.
- `doctor`: `bundle.copy`, `bundle.config`, `bundle.lane` on a node; `broker.bundle` on a broker.
- Broker audit `fleet-bundle`: every publication, accepted or refused, with the reason.
- `stitchwire fleet check [--broker]` exits 0 aligned, 1 drifted, 2 unknown.

## Limits

- A machine whose every lane is down receives nothing over the wire; `fleet.sources` or
  `stitchwire fleet install` are the paths left, and `stitchwire fleet apply` projects without a
  running process.
- The roster and each node's credential stay local. A broker cannot learn a new node, or a node a
  new broker, from a bundle.
- Bundles are integrity-protected, not encrypted. They travel inside the broker's TLS and rest at
  mode 600; an `own` member's slice is the confidentiality boundary.
