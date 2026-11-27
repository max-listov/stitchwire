import {
  PEER_FRESH_MS,
  PEER_MAX_INFLIGHT,
  PEER_MAX_PER_MINUTE,
  PEER_MAX_ROUTES,
  PEER_MAX_SAMPLES,
  PEER_TIMEOUT_MS,
  PEER_WINDOW_MS,
  type PeerObservation,
  type PeerOutcome,
  type PeerRequest,
} from '../../../contracts/src/peer-contract.ts';
import { LOCAL_API_VERSION } from '../../../contracts/src/door/common.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';

export interface PeerRoute {
  id: string;
  url: string;
  epoch(target: string): string;
  probe(target: string): Promise<PeerOutcome>;
}
interface Sample {
  at: number;
  ms: number;
}
interface Entry {
  epoch: string;
  samples: Sample[];
  at: number;
  outcome: PeerOutcome;
  wall: string | null;
  pending?: Promise<PeerObservation>;
}

/** Request-driven observations shared by all local readers; no polling timer or domain payload. */
export class PeerObserver {
  private readonly entries = new Map<string, Entry>();
  private recent: number[] = [];
  private inflight = 0;
  constructor(
    private readonly observer: string,
    private readonly clock = () => performance.now(),
  ) {}

  unavailable(target: string, outcome: PeerOutcome): PeerObservation {
    return {
      v: LOCAL_API_VERSION,
      observer: this.observer,
      target,
      route: null,
      outcome,
      observedAt: null,
      freshnessMs: PEER_FRESH_MS,
      ageMs: null,
      aggregationWindowMs: PEER_WINDOW_MS,
      sampleCount: 0,
      latestMs: null,
      medianMs: null,
    };
  }
  read(request: PeerRequest, route: PeerRoute): Promise<PeerObservation> {
    const key = `${route.id}/${request.to}`,
      epoch = route.epoch(request.to),
      now = this.clock();
    let entry = this.entries.get(key);
    if (entry?.epoch !== epoch) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (entry?.pending) return entry.pending;
    const render = (held: Entry, outcome = held.outcome): PeerObservation => {
      const samples = held.samples.filter((s) => this.clock() - s.at <= PEER_WINDOW_MS);
      const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
      const middle = sorted[Math.floor(sorted.length / 2)];
      const lower = sorted[Math.floor((sorted.length - 1) / 2)];
      const ok = outcome === 'ok';
      return {
        ...this.unavailable(request.to, outcome),
        route: { id: route.id, url: route.url, epoch },
        observedAt: held.wall,
        ageMs: held.wall === null ? null : Math.max(0, this.clock() - held.at),
        sampleCount: ok ? samples.length : 0,
        latestMs: ok ? (samples.at(-1)?.ms ?? null) : null,
        medianMs: ok && middle !== undefined && lower !== undefined ? (middle + lower) / 2 : null,
      };
    };
    if (entry && now - entry.at <= PEER_FRESH_MS) return Promise.resolve(render(entry));
    if (request.mode === 'cached')
      return Promise.resolve(
        render(entry ?? { epoch, samples: [], at: now, outcome: 'stale', wall: null }, 'stale'),
      );
    this.recent = this.recent.filter((at) => now - at < PEER_WINDOW_MS);
    if (this.recent.length >= PEER_MAX_PER_MINUTE || this.inflight >= PEER_MAX_INFLIGHT)
      return Promise.resolve(this.unavailable(request.to, 'capacity'));
    if (!entry && this.entries.size >= PEER_MAX_ROUTES) {
      const evict = [...this.entries].find(([, value]) => !value.pending);
      if (evict) this.entries.delete(evict[0]);
    }
    const held: Entry = entry ?? { epoch, samples: [], at: now, outcome: 'stale', wall: null };
    this.entries.set(key, held);
    this.recent.push(now);
    this.inflight += 1;
    const started = this.clock();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<PeerOutcome>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), PEER_TIMEOUT_MS + 500);
    });
    held.pending = Promise.race([route.probe(request.to), deadline]).then((outcome) => {
      clearTimeout(timer);
      this.inflight -= 1;
      held.pending = undefined;
      if (route.epoch(request.to) !== epoch) {
        if (this.entries.get(key) === held) this.entries.delete(key);
        return this.unavailable(request.to, 'stale');
      }
      const ended = this.clock();
      held.at = ended;
      held.wall = nowIso();
      held.outcome = outcome;
      held.samples = held.samples.filter((s) => ended - s.at <= PEER_WINDOW_MS);
      if (outcome === 'ok') held.samples.push({ at: ended, ms: Math.max(0, ended - started) });
      held.samples = held.samples.slice(-PEER_MAX_SAMPLES);
      return render(held);
    });
    return held.pending;
  }
}
