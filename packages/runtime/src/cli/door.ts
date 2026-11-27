/** Reaching the local agent: its socket path and a client for it. */

import { existsSync } from 'node:fs';
import { createWireClient, type WireClient } from '../../../local-client/src/index.ts';
import { loadNodeConfig } from '../config/io.ts';
import { agentSocketOverride, paths } from '../config/paths.ts';

import { fail } from './io.ts';

/** Talk to the local agent. Not a network call: the socket file is the whole address, so there is
 *  no host, port or credential to get wrong here. */
export function localClient(): WireClient {
  if (!existsSync(agentSocketPath())) {
    fail(`no agent socket at ${agentSocketPath()} — is 'stitchwire agent' running on this machine?`);
  }
  return createWireClient({ socketPath: agentSocketPath() });
}

export function agentSocketPath(): string {
  const override = agentSocketOverride();
  if (override !== undefined) return override;
  try {
    return loadNodeConfig().agentSocket;
  } catch {
    return paths.agentSocket;
  }
}
