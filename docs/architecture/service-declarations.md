# Owner-declared services

A service owner decides what it serves and who may call it. The deployment decides which service
names a node may serve at all. This page describes how the two meet.

## Two parties, two files

| What | Who writes it | Where |
| --- | --- | --- |
| Service-name prefixes a node may serve | the deployment | broker `serviceNamespaces`, node `services.namespaces` |
| One service: its binding and its callers | the owner's installer | a declaration file, bound in node `services.descriptors` or placed in the node's `services.d/` drop-in directory |

A declaration file:

```json
{
  "binding": {
    "service": "owner.window",
    "descriptorPath": "/opt/owner/window-descriptor.json",
    "socketPath": "/run/owner/window/window.sock",
    "endpointPath": "/invoke",
    "maxInflight": 4,
    "limits": { "requestBytes": 1024, "responseBytes": 4096, "timeoutMs": 5000 }
  },
  "callers": [
    { "caller": "reader", "scope": { "kind": "service-read" } },
    { "caller": "operator", "scope": { "kind": "operation", "operation": "window.reset" } }
  ]
}
```

The owner's installer decides where `callers` comes from; Wire only reads the file. An installer that
manages many services keeps the callers of every service it installs in one place on the node, as a
rule keyed by service name, so that no product's source has to name a caller.

`binding` has the shape of a configured binding. `callers` has the shape of a configured grant
without `target` and `service`: the target is always the declaring node, the service is the
binding's.

A route path (`endpointPath` here, an operation's `path` in the descriptor) is judged by one schema,
`OwnerRoutePathSchema`: it starts with `/`, uses letters, digits, `.`, `_` and `-`, and has no empty,
`.` or `..` segment and no trailing `/`. A path crosses a URL parser on its way to the owner, which
resolves dot segments; a `..` would let a `read` operation run the owner's `write` route, so a
descriptor containing one is refused whole, and `/` alone is not a route.

The file is checked by `parseServiceDeclaration`, exported by `@stitchwire/client`: the node agent
calls exactly this function, so an installer that calls it first reaches the node's schema verdict with the
node's one-line reason, and `stitchwire config validate service <path>` prints the
same. That verdict is the schema's: the node also refuses a declaration whose service lies outside its
`services.namespaces` or collides with a binding or an earlier declaration. `stitchwire config
validate service <path> --node <node.json>` judges the file inside the whole set that node's agent
reads — its fleet bindings, the declarations `services.descriptors` binds and the files of its drop-in
directory, in the agent's force order (below) — with the plan the agent applies
(`planServiceDeclarations`). A file not yet in the set is judged as if added last, so `accepted` means
it takes nothing another declaration holds now; a drop-in file the agent would not read (its mode, its
owner) is named as such.
A declaration file is read as strict UTF-8 and may not exceed `SERVICE_MAX_DECLARATION_BYTES` (64 KiB).

## The drop-in directory

An owner's installer can declare a service without editing `node.json`: it places the declaration as
one `*.json` file in the node's drop-in directory, and removes the file to withdraw it. The agent
picks up an added, changed or removed file on its next poll, with no restart. `@stitchwire/client`
writes and removes such files (`writeServiceDeclarationFile`, `removeServiceDeclarationFile`): it
validates the declaration first, writes the owner's value as given — the agent applies its own
defaults — and replaces the file atomically through a dot-named staging file the agent never reads.

- **Where.** `services.dropInDir` in `node.json`, an absolute path; absent, `services.d/` beside a
  configuration file named `node.json`, as the agent's path spells it; `null`, none. A configuration
  of any other name has no default drop-in directory, so two configurations in one directory never
  serve one set of files. The SDK resolves the same default from the `node.json` path it is given;
  an agent whose `node.json` sets `dropInDir` reads only that directory, and the writer must be
  passed it. The SDK refuses a relative `dropInDir`, `configPath` or `STITCHWIRE_*` directory: the
  writer and the agent would resolve it against two different working directories.
- **Who may write.** The directory must be a real directory (not a symlink), owned by the agent's
  user and writable by nobody else (`mode & 0o022 == 0`); otherwise none of its files is read and
  status shows one `invalid` entry with the directory's path and the reason. Each file is judged on
  the handle it is read from (`O_NOFOLLOW`, `fstat`): a regular file owned by the agent's user and
  writable by nobody else; a symlink or another file is `invalid`. The writer and the agent therefore
  run as the same user. One rule (`dropInRefusal`) serves the SDK writer, the agent, enrollment and
  `config validate`; the last two judge by the agent's user — the owner of `node.json` — whoever
  runs them.
- **Which files.** Only `*.json`, not dot-files and not subdirectories. A path `services.descriptors`
  already binds is read once.
- **Force order.** The declarations `services.descriptors` binds, in their order, then the drop-in
  files by file name (code-unit order). Where two files claim one service or one socket, the earlier
  keeps it and the later is `refused` with its path: an explicit binding precedes every drop-in, and
  `a.json` precedes `b.json` whatever their age.
- **Ceiling.** Explicit and drop-in declarations together are at most `MAX_DECLARED_SERVICES` (32),
  explicit ones first; the files past it are ignored and status shows one `invalid` entry with the
  directory's path and the count, which `doctor` reports as a failed `services.descriptor`.
- **Enrollment.** Before the write, enrollment judges the final set with the drop-in files included:
  an owner's explicit binding that would take the service, the socket or the room of a drop-in
  declaration in force now is `declaration-invalid`, not a silent displacement. After the write it
  judges the agent's status by the same measure: every lane must answer the complete set the agent
  sends, and only a refusal of the owner's own file, service or topic is `declaration-refused`. A
  conflict already inside the directory, or a broker refusing a drop-in's grant, blocks an unrelated
  request at neither point.
- **Confirmation.** A written file is not yet a loaded declaration. Node status lists every file of
  the set by path under `services.declarations.descriptors` with its state, and `refused` names a
  declaration the node will not serve; an agent that predates drop-in directories reads none.
- **Idle cost.** A drop-in directory that does not exist is not polled: the agent watches the nearest
  existing parent for it to appear (`fs.watch`, plus one re-scan shortly after each new watch), and
  polls the directory only while it exists. A second watch, on that parent's own parent, hears the
  parent itself removed — a watch on a removed directory hears nothing more — and the agent then
  watches from the nearest parent left. A watch that cannot be made (no read access) is logged once,
  and the agent polls for the directory instead. A node with no bound declaration and no drop-in
  directory holds no declaration timer.
- **Damaged files.** A service declaration that cannot be read — a write caught half-done, a typo in
  an edit — withdraws its binding and every grant in that poll; an `invalid` topic descriptor keeps
  its last valid topics. The difference is deliberate: a grant allows a call, so an owner's intent
  that cannot be read is closed, while a topic only names what may be published. A file is therefore
  replaced atomically — the SDK writer writes a dot-named staging file and renames it — and a hand
  edit of a declaration in force is a withdrawal until it reads again.

## Flow

1. The node reads every bound declaration and every file of an existing drop-in directory every five
   seconds (`DECLARATION_POLL_MS`).
2. It keeps a declaration only if its service lies inside one of `services.namespaces` and neither
   the service nor its socket is already bound on the node or by an earlier file in force order. Anything else is refused locally, with
   the file path, in node status.
3. From the kept declarations it builds what the node serves by — configured bindings and grants
   plus declared ones — and hands that to the service executor. The next call uses it.
4. It sends each connected broker lane `service:declare` with the complete set of declared grants,
   on every lane connect and whenever the set changes.
5. The broker (`ServiceGrantRegistry`) accepts a grant only when its target is the declaring node
   and its service lies inside a prefix `serviceNamespaces` grants that node. The declaration
   replaces the node's previous one whole. Routing reads configured and declared grants together.

Nothing on the broker is persisted. After a broker restart a declared grant is absent until the
node reconnects and declares again, which it does on connect.

Every poll reads the file, and parses and validates it only when its bytes changed; size and
`mtime` are not trusted to say so, so an edit of the same length is still seen. A missing, damaged,
non-UTF-8 or oversized (above 64 KiB) declaration contributes nothing, which withdraws its binding and grants
in that same poll. The size limit is checked both before reading and on the bytes actually read. A
reconnect always sends the current complete set.

## Borders

- A node grants calls only to itself. Another node's declaration cannot open a route to it.
- A namespace prefix ends in `.` and may repeat across nodes: one owner runs the same service on
  many machines, and each node grants only its own.
- The node still checks every call against the descriptor and grants it serves by, exactly as for a
  configured binding. The socket must be a private endpoint (`isPrivateUnixEndpoint`).
- A caller the broker does not register is accepted and inert: it can never reach this broker.

## What a caller hears

A call is judged twice, and each judge has one answer of its own.

| Answer | Who gives it | It means |
| --- | --- | --- |
| `denied`, refusal `policy`, delivery `not-dispatched` | the broker | no grant, configured or declared, names this caller, target, service and operation; no node was asked |
| `unsupported`, refusal `none` | the target node | the call is granted, and the node serves no such service, revision or operation |

A declared service holds its grants in the same file as its binding, so withdrawing it removes both
and its settled answer is the broker's `denied`. That holds for every way of withdrawing: emptied
`callers`, a deleted or unreadable file, and an agent that starts with the descriptor unbound. An
agent with nothing bound and no drop-in file has no file to poll and still sends each broker the empty declaration, on
every connect, until the broker acknowledges it: the grants its previous process declared do not
outlive it.

Between the poll that drops the binding and the broker's acknowledgement a call already routed can
be answered `unsupported` by the node. A caller that waits for a withdrawal to take effect waits for
`denied`. `unsupported` as a settled answer belongs to a grant written in the fleet configuration
whose service the node does not bind.

`test/service-withdrawal.test.ts` holds both answers through a broker.

## Giving a namespace to a new owner

The deployment does this once per owner and per node that will serve the owner's services.

1. Choose a prefix that ends in `.` and belongs to that owner alone. A prefix two owners share lets
   either declare the other's service names; the owner's own identifier, not a topic word such as
   `notify.`, is the prefix, and the service is `<owner>.<name>`. One owner may hold the same
   prefix on several nodes.
2. Add it to `serviceNamespaces` of each serving node in the manifest, and to nothing else. Two
   nodes' lists are independent; a node holds exactly the prefixes written for it, at most 16.
3. Sign and publish the manifest. `stitchwire fleet check` answers `0` on every broker and node once
   the edition arrived; each process reloads its own tables in place, with no restart by hand.
4. The owner's installer writes the declaration (binding and `callers`) and binds it in the node's
   `services.descriptors`, or places it in the node's drop-in directory. Within one poll, node status lists the descriptor as `loaded` with its
   callers, `lanes[].accepted` counts the grants every connected broker took, and `doctor` reports
   `services.descriptor` and `services.declared` without a warning.
5. Check that the borders hold, not only that the service answers. A caller with no entry in `callers`
   and a caller whose scope is `service-read` asking for a `write` operation are both answered `denied`
   with delivery `not-dispatched` and the owner never sees the call. A declaration for a service
   outside the node's prefixes appears under `refused` in node status with the file path.
6. To withdraw one service, the owner deletes its declaration or empties `callers`: the grants leave
   in the same poll, and its callers are answered `denied`. To withdraw a prefix, remove it from the node's list and publish: the node and
   the broker reload with the new tables, and a declaration outside the prefixes is refused from then on.

`test/service-declarations.test.ts` holds the status half of item 4, item 5 and the owner's half of item 6
against real brokers and agents, including a document and an answer near the 1 MiB ceilings;
`test/declaration-checks.test.ts` holds what `doctor` reports in item 4.

## The descriptor file

The descriptor named by `binding.descriptorPath` is read on each call, from a regular file of at
most `SERVICE_MAX_DESCRIPTOR_BYTES` (256 KiB), as strict UTF-8 JSON. A directory, a device or a larger
file makes the owner's calls fail as an invalid descriptor before any byte is read.

## Status and doctor

Node status carries `services.namespaces` and `services.declarations` (`descriptors`, `refused`,
`lanes`); `descriptors` lists bound and drop-in files alike, plus one entry for a refused or
overflowing drop-in directory. `doctor` reports `services.descriptor` per file and
`services.declared` per broker lane, and is silent when nothing is bound.
