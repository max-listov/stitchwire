/**
 * Configuration and the paths it lives at.
 *
 * Two files, never one: a broker holds every node's credential digest and the call policy, a node
 * holds only its own secret. Merging them would put the whole fleet's admission table on every
 * laptop, which is the opposite of what the split exists for.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigDir, defaultStateDir, envPath } from '../../../local-client/src/paths.ts';

export const HOME = homedir();
const CONFIG_DIR = defaultConfigDir();
const STATE_DIR = defaultStateDir();

export const paths = {
  configDir: CONFIG_DIR,
  brokerConfig: join(CONFIG_DIR, 'broker.json'),
  nodeConfig: join(CONFIG_DIR, 'node.json'),
  stateDir: STATE_DIR,
  /** The agent's local door. Short by construction: a Unix socket path is capped near 104 bytes on
   *  macOS, and a long state root would fail at bind() with a message that names neither. */
  agentSocket: join(STATE_DIR, 'agent.sock'),
  audit: join(STATE_DIR, 'audit.jsonl'),
  /** The fleet bundle this node keeps, whole or reduced to its own slice. */
  fleetCopy: join(CONFIG_DIR, 'fleet-bundle.json'),
  /** The fleet bundle a broker keeps. Its own file: a broker and a node on one machine write apart. */
  brokerFleetCopy: join(CONFIG_DIR, 'broker-fleet-bundle.json'),
  /** Where `stitchwire fleet keygen` puts a signing key unless told otherwise. */
  fleetSigningKey: join(CONFIG_DIR, 'fleet-signing.key'),
};

/** The agent socket an operator pointed the CLI at, or `undefined`. Read at call time: the CLI and its tests set it per process. */
export function agentSocketOverride(): string | undefined {
  return envPath('STITCHWIRE_AGENT_SOCKET');
}
