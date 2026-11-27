# Typed service over two broker lanes

Run `bun run example:service` from the repository after `bun install`. It creates an isolated
synthetic catalog, two local brokers, two agents and a typed client, performs a successful read and
four no-dispatch refusals, reports what happened, then shuts down all resources. `test/service-example.test.ts`
holds the expected report. No installed fleet state is read.

The catalog uses Stitchkit `defineContract`, `implement` and `createClient`. Its schemas and data
stay with the owner. The descriptor declares `lookup`; operator policy separately grants the
reader access and binds the worker to its Unix endpoint. `createServiceFetch` connects the owner
client to Wire; it does not rewrite owner request IDs or inspect domain values.

The owner listens through Stitchkit's `bindUnixSocket` (`stitchkit/files`), so its socket is `0600` from the
moment it exists. A socket takes the process umask at bind, and a `chmod` after `listen` leaves it on disk with
the wider mode until the `chmod` runs: the node agent and release checks refuse a socket they find in that state.
The example's socket sits in a fresh `mkdtemp` directory (`0700`); a persistent one needs a directory no other
user can enter.

For a standalone client, install the locally built tarball from `dist/client/` using `bun add
<absolute-archive-path>`. Import `createWireClient`, `createServiceFetch`, `createServiceIngress`,
`serviceCaller` and `serviceDescriptorFromContract` from `@stitchwire/client`, not repository source.
`bun run check:client-package` proves that isolated installation on Bun/Node. Runtime installation requires Bun and the executable `dist/stitchwire`.

Operator sequence for persistent deployment:

1. Generate node configs with `stitchwire init node --id <id> --broker <tls-url> <new-file>`.
   Keep tokens private; transfer only the printed digest into the broker registry.
2. Generate a default-deny broker config using `stitchwire init broker --node <id>=<digest> <new-file>`.
3. Generate the Wire descriptor from the owner Stitchkit contract, then add `descriptorPath`,
   private socket bindings, service-read scopes and exact action grants using the
   [activation utility](../../scripts/activate-service-policy.ts). Inspect its dry-run and preserve
   backups before an authorized activation. A descriptor alone does not grant access.
4. Validate both configs with `stitchwire config validate node|broker <path>`, set the documented
   config environment for the process, start broker/agent, then run `stitchwire doctor`.
5. Make a real typed read and a wrong-revision/caller refusal, as `bun run example:service` does in isolation, then confirm in the owner's own log that it saw only the admitted call.

From the source workspace, create a private review candidate with the existing activation tool:

```sh
bun scripts/activate-service-policy.ts --kind node --config ./node.json \
  --descriptor ./descriptor.json --caller reader --read worker \
  --socket /run/example/owner.sock --endpoint /invoke --apply no --out ./node.candidate.json
```

`--out` uses exclusive creation and mode 0600. It never replaces an existing candidate or the live
config. Review the exact file difference locally, selecting only `services` / `serviceGrants` with
your JSON tool; never paste the complete node config (it contains tokens). All unrelated fields,
including credentials, must remain byte-value-equivalent. Preserve the original private config
as a separate non-overwritten backup. After explicit deployment authorization, repeat the same
arguments with `--apply yes` and without `--out`; compare the result with the reviewed candidate
before restarting the exact service. Broker policy uses `--kind broker` and no socket/endpoint flags.
`bun run check:runtime` exercises dry-run, backup, exact candidate/application equality and validation.

Use TLS outside this isolated loopback example. An owner response is separate from transport
certainty: a timeout after dispatch can mean unknown execution and must not trigger automatic replay.
