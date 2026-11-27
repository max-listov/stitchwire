import {
  PEER_MAX_INFLIGHT,
  PEER_TIMEOUT_MS,
  type PeerOutcome,
} from '../../../contracts/src/peer-contract.ts';
import type { LaneClient } from './lane-contract.ts';

/** Bounded peer probes belong to one live connection; disconnect settles every outstanding probe. */
export class LanePeerProbes {
  private readonly pending = new Map<string, (outcome: PeerOutcome) => void>();
  constructor(private readonly client: LaneClient) {
    client.on('peer:echo', (request) => {
      client.emit('peer:echo', request);
    });
    client.on('peer:result', (reply) => this.pending.get(reply.id)?.(reply.outcome));
  }
  probe(to: string): Promise<PeerOutcome> {
    return new Promise((resolve) => {
      if (!this.client.connected) {
        resolve('offline');
        return;
      }
      if (this.pending.size >= PEER_MAX_INFLIGHT) {
        resolve('capacity');
        return;
      }
      const id = crypto.randomUUID();
      const finish = (outcome: PeerOutcome) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => finish('timeout'), PEER_TIMEOUT_MS + 250);
      this.pending.set(id, finish);
      if (!this.client.emit('peer:probe', { id, to })) finish('offline');
    });
  }
  disconnect(): void {
    for (const finish of this.pending.values()) finish('offline');
  }
}
