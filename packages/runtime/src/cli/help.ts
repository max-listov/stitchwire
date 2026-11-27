/** The help text. */

import { paths } from '../config/paths.ts';
import { RELEASE_VERSION } from '../release-version.ts';

export const HELP = `stitchwire ${RELEASE_VERSION} — typed RPC, bounded streams and volatile events

  stitchwire broker                     run the router (reads ${paths.brokerConfig})
  stitchwire agent                      hold this node's connection and serve inbound calls
  stitchwire call <node> -- <argv...>   run an allowed command on <node>
  stitchwire stream <node> <profile> [--stdin] [-- <args...>]
                                        read a live bounded stream
  stitchwire events subscribe <topic>   print event deliveries as they arrive
                        [--resume <bootId>:<seq>]  ask the broker what was missed since that point
  stitchwire events publish <topic>     publish one event, body on stdin
  stitchwire nodes                      who is on the wire
  stitchwire status                     this node's link
  stitchwire doctor [--json] [--config <path>]  diagnose local node (0 ok, 1 warn, 2 fail, 3 unknown)
  stitchwire doctor --broker <url> [--json]    inspect one broker; no scheduler or automatic repair
  stitchwire config validate node [path]    validate a node config without starting it
  stitchwire config validate broker [path]  validate a broker config without starting it
  stitchwire config validate service <path> [--node <node.json>]  validate a service declaration; with --node also the
                                            node's namespace and collision checks
  stitchwire config inspect <node|broker> <path>  read effective fleet copy, tables and credential digests
  stitchwire config update <node|broker> <path> --request <json|-> [--check]  locked administrative transaction
  stitchwire init node --id <slug> --broker <url> [path]   write a valid node config
  stitchwire init broker --node <id>=<digest> [path]       write a valid broker config
  stitchwire fleet keygen --id <key-id> write a fleet signing key, print its trust entry
  stitchwire fleet publish --manifest <path> --id <key-id>
                                        sign the manifest; this node's agent hands it to every broker
  stitchwire fleet sign --manifest <path> --id <key-id> --out <path>   sign without installing
  stitchwire fleet install <bundle>     keep a signed bundle on this node
  stitchwire fleet show [<bundle>]      the kept (or named) bundle, verified
  stitchwire fleet apply [--broker]     rewrite this machine's fleet tables from the kept bundle
  stitchwire fleet check [--broker]     compare them (0 aligned, 1 drifted, 2 unknown)
  stitchwire enroll <plan|prepare|apply|status|detach> --request <file|->
                                        local versioned enrollment for a trusted orchestrator (JSON;
                                        - reads the request from stdin)
  stitchwire keygen                     print a fresh token and its digest
  stitchwire prune-rollbacks [--keep N]  remove stale rollback roots, newest N kept

Options
  --timeout <ms>   deadline for one call (default: the node's configured one)
  --stdin          read this process's stdin and send it as the command's stdin
  --json           machine-readable output
`;
