import {
  PEER_MAX_INFLIGHT,
  PEER_MAX_PER_MINUTE,
  PEER_MAX_ROUTES,
  PEER_TIMEOUT_MS,
  PEER_WINDOW_MS,
  type PeerOutcome,
  type PeerReply,
} from '../../../contracts/src/peer-contract.ts';
import { createBoundedAdmission, type BoundedAdmission } from 'stitchkit/application';

interface Probe {
  caller: string;
  target: string;
  finish: (outcome: PeerOutcome) => void;
}
/** UUID-only round trips. No Socket.IO acknowledgement closures survive a missing reply. */
export class PeerProbes {
  private readonly pending = new Map<string, Probe>();
  private readonly rates = new Map<string, BoundedAdmission>();
  private readonly admission = createBoundedAdmission({
    policy: {
      global: { maxConcurrent: PEER_MAX_ROUTES },
      perKey: { maxConcurrent: PEER_MAX_INFLIGHT, maxKeys: PEER_MAX_ROUTES },
    },
  });
  constructor(
    private readonly send: (socket: string, event: 'echo' | 'result', reply: PeerReply) => void,
    private readonly timeoutMs = PEER_TIMEOUT_MS,
  ) {}

  open(caller: string, identity: string, target: string | undefined, allowed: boolean, id: string): void {
    const reply = (outcome: PeerOutcome) => this.send(caller, 'result', { id, outcome });
    if (!allowed) {
      reply('denied');
      return;
    }
    if (!target) {
      reply('offline');
      return;
    }
    if (this.pending.has(id)) {
      reply('capacity');
      return;
    }
    const admitted = this.admission.acquire(caller);
    if (admitted.outcome === 'refused') {
      reply('capacity');
      return;
    }
    const rate =
      this.rates.get(identity) ??
      createBoundedAdmission({
        policy: {
          global: { maxConcurrent: 1, rate: { limit: PEER_MAX_PER_MINUTE, intervalMs: PEER_WINDOW_MS } },
        },
      });
    this.rates.set(identity, rate);
    const limited = rate.acquire();
    if (limited.outcome === 'refused') {
      admitted.lease.release();
      reply('capacity');
      return;
    }
    limited.lease.release();
    const finish = (outcome: PeerOutcome) => {
      clearTimeout(timer);
      this.pending.delete(id);
      admitted.lease.release();
      reply(outcome);
    };
    const timer = setTimeout(() => finish('timeout'), this.timeoutMs);
    this.pending.set(id, { caller, target, finish });
    this.send(target, 'echo', { id, outcome: 'ok' });
  }
  answer(socket: string, id: string): void {
    const probe = this.pending.get(id);
    if (probe?.target === socket) probe.finish('ok');
  }
  disconnect(socket: string): void {
    for (const probe of this.pending.values())
      if (probe.caller === socket || probe.target === socket) probe.finish('offline');
  }
  stop(): void {
    this.admission.stopAdmission();
    for (const probe of this.pending.values()) probe.finish('offline');
    this.rates.clear();
  }
}
