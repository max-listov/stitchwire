import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import type { HandshakeSchema } from '../../../contracts/src/protocol/rpc.ts';
import { RELEASE_VERSION } from '../release-version.ts';
import type { Audit } from './audit.ts';
import type { WireIdentity } from './contracts.ts';
import type { Registry } from './registry.ts';
import type { z } from 'zod';

/**
 * Nodes refused for their version, and the build each one brought.
 *
 * Bounded by the registered roster: a node id that is not registered never reaches the version
 * check, so this cannot grow past the fleet's own size. Entries are dropped the moment that node
 * connects successfully — a rollout that finished should leave no trace of the minute it took.
 */
export type StrandedNodes = Map<string, { version: string; at: string }>;

/**
 * The admission gate, as the framework's typed handshake: a socket that fails it never reaches the
 * contract layer, and the accepted identity lands in `socket.data` TYPED — no handler re-derives who
 * it is talking to from casts. Refusals are audited here because this is the only place that still
 * knows why.
 */
export function admitNode(
  registry: Registry,
  audit: Audit,
  stranded: StrandedNodes,
): (parsed: z.infer<typeof HandshakeSchema>) => WireIdentity | null {
  return (parsed) => {
    if (!registry.authenticate(parsed.nodeId, parsed.token)) {
      audit.write({ kind: 'connect-refused', nodeId: parsed.nodeId, detail: 'bad token or unknown node' });
      return null;
    }
    // One fleet runs one version; an explicit mismatch remains distinct from authentication.
    if (parsed.version !== RELEASE_VERSION) {
      audit.write({
        kind: 'connect-refused',
        nodeId: parsed.nodeId,
        detail: `node runs ${parsed.version}, this broker runs ${RELEASE_VERSION}`,
      });
      // A refused handshake is the only observation of the version that node brought.
      stranded.set(parsed.nodeId, { version: parsed.version, at: nowIso() });
      return null;
    }
    stranded.delete(parsed.nodeId);
    return { nodeId: parsed.nodeId, serves: parsed.serves, version: parsed.version };
  };
}
