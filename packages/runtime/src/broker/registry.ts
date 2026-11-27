import { ownEntry } from '../json.ts';
/**
 * Who is registered, who is connected, and who may call whom.
 *
 * The two questions are deliberately separate. Authentication says "this socket is really `alpha`";
 * authorisation says "`alpha` may call `worker`". Collapsing them is how a valid credential turns into
 * blanket reach across the whole fleet.
 */

import { timingSafeEqual } from 'node:crypto';
import type { BrokerConfig, CapabilityOperation } from '../config/broker.ts';
import { sha256 } from '../config/io.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';
import type { Departure, DepartureKind, Presence } from '../../../contracts/src/protocol/presence.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';

interface Connection {
  /** Socket.IO puts every socket in a room named by its own id, so this doubles as the
   *  one-connection address that contract-validated `to()` needs. */
  socketId: string;
  nodeId: NodeId;
  serves: boolean;
  version: string;
  since: string;
}

/** Compare digests, not secrets, and in constant time: a token check that returns early leaks its
 *  own answer through timing. Digests are fixed length, so the lengths never differ. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Read the transport's reason, and refuse to over-read it.
 *
 * The mapping is a closed list because the classification is a promise: `announced` means the node
 * said goodbye, and nothing else may claim that. Everything unrecognised — a socket.io version with
 * new wording, a reason we have never seen — becomes `lost`, which is the value that promises the
 * least. Defaulting the other way would let an unexplained absence read as an explained one, which
 * is the failure this whole field exists to remove.
 */
export function classifyDeparture(reason: string): DepartureKind {
  if (reason === 'client namespace disconnect' || reason === 'server namespace disconnect')
    return 'announced';
  if (reason === 'server shutting down' || reason === 'forced server close') return 'broker-restart';
  return 'lost';
}

export class Registry {
  private readonly known: Map<NodeId, string[]>;
  private readonly capabilities: BrokerConfig['capabilities'];
  private readonly commandGrants: BrokerConfig['commandGrants'];
  private readonly sockets = new Map<string, Connection>();
  /** The last departure per node, kept for nodes that are currently offline AND for ones that
   *  came back: "it flapped an hour ago" is information a live row should not hide. */
  private readonly departures = new Map<NodeId, Departure>();
  /**
   * When this registry started remembering.
   *
   * `departure: null` means "no departure recorded", and that is two different facts: the node has
   * never left, or this broker was restarted since and forgot. Without this horizon a consumer
   * cannot tell them apart — and after every rollout every row is null, so the reassuring reading
   * is the wrong one exactly when the fleet has just been disturbed.
   */
  readonly observingSince: string = nowIso();

  constructor(config: BrokerConfig) {
    this.known = new Map(config.nodes.map((n) => [n.id, n.tokenSha256s]));
    this.capabilities = config.capabilities;
    this.commandGrants = config.commandGrants;
  }

  authenticate(nodeId: string, token: string): boolean {
    const expected = this.known.get(nodeId);
    if (expected === undefined) return false;
    const actual = sha256(token);
    return expected.some((digest) => digestsMatch(actual, digest));
  }

  /** Default-deny. An unlisted caller reaches nobody, and `*` is the only way to say "everyone". */
  mayPerform(operation: CapabilityOperation, from: NodeId, to: NodeId): boolean {
    const grants = ownEntry(this.capabilities, from);
    if (grants === undefined) return false;
    return grants.some(
      (grant) => grant.operation === operation && (grant.targets.includes('*') || grant.targets.includes(to)),
    );
  }

  /**
   * Whether this caller may run this exact command on this target.
   *
   * Default-deny, like `mayPerform`, and with one difference that is the point of the whole field:
   * the command has no wildcard. A target may be `*` because rosters change; a command may not,
   * because the moment it can, the table stops saying which operations exist.
   */
  mayInvokeCommand(from: NodeId, to: NodeId, command: string): boolean {
    return this.commandGrants.some(
      (grant) =>
        grant.caller === from &&
        grant.command === command &&
        (grant.targets.includes('*') || grant.targets.includes(to)),
    );
  }

  attach(socketId: string, conn: Connection): void {
    this.sockets.set(socketId, conn);
  }

  detach(socketId: string): Connection | undefined {
    const conn = this.sockets.get(socketId);
    this.sockets.delete(socketId);
    return conn;
  }

  /**
   * The single connection that receives inbound calls for a node.
   *
   * Newest wins: an agent that reconnects after a network drop may briefly overlap with its own
   * half-dead predecessor, and routing to the older socket would deliver into a void. A one-shot
   * caller never qualifies, so a CLI invocation cannot shadow the real agent for the moment it is
   * connected.
   */
  serverFor(nodeId: NodeId): Connection | undefined {
    let best: Connection | undefined;
    for (const conn of this.sockets.values()) {
      if (conn.nodeId !== nodeId || !conn.serves) continue;
      if (best === undefined || conn.since >= best.since) best = conn;
    }
    return best;
  }

  connectionsOf(nodeId: NodeId): Connection[] {
    return [...this.sockets.values()].filter((c) => c.nodeId === nodeId);
  }

  /** Record how a node's socket ended. Called for every disconnect, including the ones caused by
   *  this broker stopping — those are recorded too, precisely so a reader can tell them apart from
   *  the node's own departure instead of inferring. */
  recordDeparture(nodeId: NodeId, reason: string, at: string): void {
    this.departures.set(nodeId, { at, reason, kind: classifyDeparture(reason) });
  }

  /** Every registered node, connected or not — absence is information, so an offline node is a row
   *  rather than a missing one. */
  presence(): Array<Omit<Presence, 'behind' | 'versionSeenAt'>> {
    return [...this.known.keys()].map((nodeId) => {
      const conns = this.connectionsOf(nodeId);
      const server = this.serverFor(nodeId);
      const first = conns.reduce<string | null>(
        (acc, c) => (acc === null || c.since < acc ? c.since : acc),
        null,
      );
      return {
        nodeId,
        online: conns.length > 0,
        serves: server !== undefined,
        connections: conns.length,
        since: first,
        version: server?.version ?? conns[0]?.version ?? null,
        departure: this.departures.get(nodeId) ?? null,
        observingSince: this.observingSince,
      };
    });
  }
}
