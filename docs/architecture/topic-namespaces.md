# Topic namespaces — owners declare their own topics

## Why

A fleet topic lives in broker configuration with both of its ends: producer, readers, delivery and
limits. Whoever edits that configuration is the only one who can add a topic, so an application
owner who needs a new one either asks for it or edits live configuration by hand — and a hand edit
is exactly the drift a fleet cannot see until something breaks.

Services already solved the same problem. The fleet grants a pair; the owner's descriptor, installed
beside the application, declares the operations. Topics now have the same border.

| Decided by | What |
| --- | --- |
| The fleet (broker configuration) | which producer owns a namespace, which nodes may read it, how many topics and how much retained memory it may cost the broker |
| The owner (a descriptor on the producing node) | the names inside that namespace, and each topic's delivery, publication mode and limits |

## Model

```json
// broker.json
"topicNamespaces": {
  "owner.node.": { "producer": "node", "subscribers": ["reader"], "maxTopics": 16, "maxRetainedBytes": 0 }
}

// node.json of the producer
"events": { "namespaces": { "publish": ["owner.node."] }, "descriptors": ["/opt/owner/topics.json"] }

// node.json of a reader
"events": { "namespaces": { "subscribe": ["owner.node."] } }

// /opt/owner/topics.json — written by the owner's installer
{ "topics": { "owner.node.metrics": { "delivery": "latest-wins", "publicationMode": "periodic" } } }
```

- A namespace is a topic-name prefix ending in `.` or `:`. It holds a name only when the name
  continues past it: `owner.node.` holds `owner.node.metrics`, not `owner.nodes.metrics` and not
  `owner.node.` itself.
- One namespace has one producer. Configuration refuses two namespaces where one could hold a name
  of the other, and a fleet topic inside a namespace granted to a different producer. So a name has
  at most one producer by construction, not by which declaration happened to arrive first.
- A declared topic's readers default to the namespace's readers and may be narrowed, never widened.
- `namespaces.publish` and `namespaces.subscribe` on a node are written by the fleet together with
  the rest of its event permissions. `descriptors` and the `events.d/` drop-in directory belong to
  the owners' installers.

## The drop-in directory

An owner's installer can declare topics without editing `node.json`: one `*.json` descriptor file in
the node's `events.d/` drop-in directory (`writeTopicDescriptorFile` and `removeTopicDescriptorFile`
in `@stitchwire/client` write and remove it). The directory follows exactly the rules of the
service drop-in directory (`service-declarations.md`): `events.dropInDir`, absent meaning `events.d/`
beside a file named `node.json`, `null` meaning none; a real directory and regular files owned by
the agent's user and writable by nobody else, checked by one rule for the SDK writer and the agent;
only `*.json`, no dot-files; read with the agent's next poll, no restart; not polled while it does not
exist. Specific to topics:

- **Force order.** The descriptors `events.descriptors` binds, in their order, then the drop-in files
  by file name (code-unit order); within one file, names in sorted order. A name already declared by
  the node's configuration or by an earlier file is refused locally with both paths.
- **Ceiling.** Explicit and drop-in descriptor files together are at most
  `MAX_TOPIC_DESCRIPTOR_FILES` (16), explicit ones first; the files past it are ignored and status
  shows one `invalid` entry with the directory's path. The aggregate topic limit counts every file.
- **Last valid version.** A drop-in file that stops parsing keeps its last parsed version declared,
  as a bound one does; a file that is removed withdraws its names in that poll, and a new file under
  the same name starts without a previous version.
- **Enrollment** refuses an owner's explicit descriptor that would take a name a drop-in file holds
  now (`declaration-invalid`).

## Flow

1. The producing node reads its bound descriptors and its drop-in descriptor files, keeps the names
   inside its publish namespaces and refuses the rest locally (outside every namespace, or declared
   by two descriptors).
2. Every broker lane receives the complete set as `event:declare` when it connects, and again
   whenever the set changes. Descriptors are re-read every five seconds.
3. The broker judges each name on its own and answers per name: accepted, or refused with a reason —
   no namespace holds it, the namespace belongs to another producer, the fleet already declares it,
   a reader the namespace does not admit, or the namespace's topic or retention ceiling.
4. A declaration replaces the producer's previous one whole. A name left out is withdrawn and the
   broker releases the sequence, cadence and retention state it kept for it, and ends its open
   subscriptions with `offline`, `target-offline`: the answer an undeclared name gives, so the
   subscriber waits and asks again.
5. A name that stays declared under a changed declaration is judged again for its open
   subscriptions. A subscriber the new allowlist no longer names is ended with the `policy` refusal
   a new subscribe would get. The others keep their subscription under the new declaration, and one
   whose queue the new declaration outgrows (another delivery mode, a deeper queue, larger events)
   is ended like a withdrawn name, because a queue cannot be resized in place.

Declarations are not persisted. After a broker restart the producer's reconnect declares again.

Every poll reads the descriptor's bytes and rebuilds the declared set only when they changed, never
on `mtime` alone. A deleted descriptor contributes an empty set in that same poll. A damaged,
unreadable or oversized (above 64 KiB) one is not a deleted one: the last version of it that parsed
stays declared, and the node's status reads `invalid` with the reason. A reconnect always sends the
current complete declaration.

## Failure semantics

| Situation | Answer |
| --- | --- |
| Subscribe to a name no namespace holds | `rejected`, `unknown topic` — permanent |
| Subscribe to a name inside a granted namespace that its producer has not declared | `offline`, `target-offline`; the subscribing lane waits and asks again |
| Publish to an undeclared name | `rejected`: the producer's descriptor must name it first |
| Declaration from a node for another producer | every name refused; nothing registered |

The `offline` answer is what lets a subscriber that reconnects before the producer — the normal
order after a broker restart — keep its subscription instead of giving up on it.

## Budgets

Every namespace counts at its ceiling: fleet topics plus the sum of `maxTopics` must fit
`admission.maxTopics`, and fleet retention plus the sum of `maxRetainedBytes` must fit
`maxRetainedBytesTotal`. What owners declare can never make the broker hold more than its
configuration was checked for.

## Observability

- Broker `/health` lists every topic with `source: fleet | owner`.
- Node status carries `events.namespaces` and `events.declarations`: each descriptor's state
  (`loaded`, `missing`, `invalid` with the first schema issue), names refused locally, and each
  lane's last answer with the names it refused.
- `stitchwire doctor` adds `topics.descriptor` and `topics.declared` checks when a descriptor is
  bound, and says nothing when none is: a node that declares nothing has nothing to report.

## Limits

- A node that starts with a descriptor that already fails to parse has no earlier version to keep,
  so that descriptor contributes nothing until it is fixed, and the doctor names why.
- Fleet topics remain for everything declared before namespaces existed. They are migrated by their
  owners; there is no second route to the same name.
