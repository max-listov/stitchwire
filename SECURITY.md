# Security Policy

## Supported versions

Stitchwire is pre-1.0. Security fixes land on the latest `0.x` release only, and brokers and agents
across a fleet must run the same runtime release.

| Component | Supported |
| --- | --- |
| Runtime (`stitchwire` `0.x`) | latest release only |
| Client (`@stitchwire/client` `0.x`) | latest release matching current door revision |

## Trust model

The broker authenticates machine tokens against stored SHA-256 digests. It receives the actual
token during authentication and sees routed payloads. Digest storage is not end-to-end encryption.
Use TLS with verified certificates between nodes and brokers. The agent, enrollment and the client's
`readBrokerHealth` refuse a plain `http:` or `ws:` broker URL outside loopback, and any broker URL
with credentials, a query string or a fragment; loopback is for local tests or a trusted local reverse proxy. A compromised broker can observe, drop or misroute traffic and
impersonate caller assertions: do not treat it as an untrusted encrypted relay.

The node independently constrains permitted operations and resources. A compromised authenticated
peer is still restricted by broker and target grants. An application able to open the agent socket
has that node's local authority; per-user authorization belongs above Wire. Protect agent/config
directories and tokens with OS ownership and permissions. Never expose the Unix door over a public
network proxy or log complete configuration files.

Declared service sockets must satisfy checked ownership and private socket/directory permissions.
Operators control their containing directories and filesystem; validation is not isolation from a
malicious same-UID process. Services must still validate their own domain input. No descriptor
automatically authorizes its operations. Commands use fixed executable profiles, not caller paths.

## Failure and update contract

An admission refusal marked not-dispatched is distinct from unknown delivery after handoff.
Timeout/cancel does not mean a remote write failed. Never automatically replay uncertain work.
Streams are bounded and events volatile; gaps are not silently repaired or converted to empty data.

All brokers and agents must have the same release version. Quiesce affected callers, retain prior
binary/config copies, upgrade the full group, verify identity/health and real positive/negative calls.
Rollback is coordinated too; it cannot undo domain side effects or restore volatile event history.
The SDK version and local door revision are independent identities, but each SDK accepts exactly
the door revision it declares. Mixed runtime rolling upgrades,
E2E encryption, browser transport and durable broker storage are not supported promises.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Do not include tokens, private paths,
payloads or vulnerability details in public discussions.

Report it privately through GitHub private vulnerability reporting on this repository: the
**Security** tab → *Report a vulnerability*. That channel is switched on when the repository is
public. If the button is not there, the channel is not available yet; wait rather than use a public
issue.

Please include:

- the affected component and version (`stitchwire` runtime or `@stitchwire/client`),
- a description of the issue and its impact,
- a minimal reproduction if possible.

## Verification

`test/security.test.ts`, `test/service-runtime.test.ts`, `test/refusal.test.ts`,
`test/deployment.test.ts`, `test/one-version.test.ts`, `test/target-lane.test.ts` and the isolated
packed client gate cover authorization, socket ownership, version refusal, timeout, cancellation,
bounds and no alternate-lane retry. Passing tests is not a comprehensive external security audit.
