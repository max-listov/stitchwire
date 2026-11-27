import { createRevisionSignal, type RevisionSignal } from 'stitchkit/application';
import type { TransportCause } from '../../../contracts/src/protocol/failure.ts';
import type { Presence } from '../../../contracts/src/protocol/presence.ts';

/** A roster belongs to one live connection. Ordered presence notices keep its snapshot current. */
export class LanePresence {
  private nodes = new Map<string, Presence>();
  private generation = 0;
  private readonly revisions = new Map<string, number>();
  private initialized = false;
  private awaitingSnapshot = false;
  private snapshot: Promise<void> = Promise.resolve();
  private finish: (() => void) | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly onChange: () => void = () => {}) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    this.onChange();
    for (const listener of this.listeners) listener();
  }

  get ready(): boolean {
    return this.initialized;
  }

  get pending(): boolean {
    return this.awaitingSnapshot;
  }

  serves(target: string): boolean {
    const node = this.nodes.get(target);
    return this.initialized && node?.online === true && node.serves;
  }

  /** Immutable view of the authoritative connection-local roster. */
  list(): Presence[] {
    return [...this.nodes.values()];
  }

  disconnect(): void {
    this.generation += 1;
    this.initialized = false;
    this.awaitingSnapshot = false;
    this.nodes.clear();
    this.revisions.clear();
    if (this.finish === undefined) this.notify();
    else this.finish();
  }

  connect(snapshot: (accept: (nodes: Presence[]) => void) => boolean, timeoutMs = 5_000): void {
    this.disconnect();
    this.awaitingSnapshot = true;
    const generation = this.generation;
    this.snapshot = new Promise((resolve) => {
      const timer = setTimeout(() => this.finish?.(), timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        if (this.finish === finish) this.finish = undefined;
        this.awaitingSnapshot = false;
        resolve();
        this.notify();
      };
      this.finish = finish;
      const handed = snapshot((nodes) => {
        if (generation !== this.generation) return;
        this.nodes = new Map(nodes.map((node) => [node.nodeId, node]));
        this.initialized = true;
        finish();
      });
      if (!handed) finish();
    });
  }

  update(node: Presence): void {
    // The initial snapshot is newer than notices received before its acknowledgement.
    if (this.initialized) {
      this.nodes.set(node.nodeId, node);
      this.revisions.set(node.nodeId, (this.revisions.get(node.nodeId) ?? 0) + 1);
      this.notify();
    }
  }

  epoch(target: string): string {
    return `${this.generation}:${this.revisions.get(target) ?? 0}:${this.serves(target)}`;
  }

  wait(): Promise<void> {
    return this.snapshot;
  }
}

interface RoutableLane {
  readonly connected: boolean;
  /** A handshake refusal cannot be repaired by waiting for this same lane to reconnect. */
  readonly terminal?: boolean;
  readonly presence: LanePresence;
}

type LaneSelection<T> =
  | { state: 'selected'; lane: T }
  | { state: 'aborted' }
  | {
      state: 'unavailable';
      cause: Extract<TransportCause, 'no-connected-lane' | 'presence-pending-timeout'>;
    };

export type ConnectedLaneSelection<T> =
  | { state: 'selected'; lanes: T[] }
  | { state: 'aborted' }
  | { state: 'unavailable'; cause: 'no-connected-lane' };

/** Selection happens once, before dispatch. Neither policy nor a result can trigger a retry. */
export class TargetLaneSelector<T extends RoutableLane> {
  private next = 0;
  constructor(
    private readonly lanes: T[],
    private readonly availability: RevisionSignal = createRevisionSignal({ maxWaiters: 4_096 }),
  ) {
    for (const lane of lanes) lane.presence.subscribe(() => this.availability.advance());
  }

  private serving(target: string): T | undefined {
    return this.pick((lane) => lane.presence.serves(target));
  }

  private pick(accept: (lane: T) => boolean): T | undefined {
    for (let offset = 0; offset < this.lanes.length; offset += 1) {
      const index = (this.next + offset) % this.lanes.length;
      const lane = this.lanes[index];
      if (lane === undefined || !lane.connected || !accept(lane)) continue;
      this.next = (index + 1) % this.lanes.length;
      return lane;
    }
    return undefined;
  }

  async select(target: string, timeoutMs = 5_000, signal?: AbortSignal): Promise<LaneSelection<T>> {
    const deadline = performance.now() + Math.min(timeoutMs, 5_000);
    while (true) {
      const revision = this.availability.getSnapshot().revision;
      if (signal?.aborted === true) return { state: 'aborted' };
      const serving = this.serving(target);
      if (serving !== undefined) return { state: 'selected', lane: serving };
      const connected = this.lanes.filter((lane) => lane.connected);
      if (connected.length === 0 && this.lanes.every((lane) => lane.terminal === true)) {
        return { state: 'unavailable', cause: 'no-connected-lane' };
      }
      const presencePending = connected.some((lane) => !lane.presence.ready);
      // Confirmed absence still reaches one broker: it owns policy-before-offline admission.
      if (connected.length > 0 && !presencePending) {
        const lane = this.pick(() => true);
        if (lane !== undefined) return { state: 'selected', lane };
      }
      if (presencePending && !connected.some((lane) => lane.presence.pending)) {
        return { state: 'unavailable', cause: 'presence-pending-timeout' };
      }
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) {
        return {
          state: 'unavailable',
          cause: presencePending ? 'presence-pending-timeout' : 'no-connected-lane',
        };
      }
      const result = await this.availability.wait(
        revision,
        signal === undefined ? { timeoutMs: remaining } : { timeoutMs: remaining, signal },
      );
      if (result.outcome === 'aborted') return { state: 'aborted' };
      if (result.outcome !== 'changed') {
        return {
          state: 'unavailable',
          cause: presencePending ? 'presence-pending-timeout' : 'no-connected-lane',
        };
      }
    }
  }

  async selectConnected(timeoutMs = 5_000, signal?: AbortSignal): Promise<ConnectedLaneSelection<T>> {
    const deadline = performance.now() + Math.min(timeoutMs, 5_000);
    while (true) {
      const revision = this.availability.getSnapshot().revision;
      if (signal?.aborted === true) return { state: 'aborted' };
      const connected = this.lanes.filter((lane) => lane.connected);
      if (connected.length > 0) return { state: 'selected', lanes: connected };
      if (this.lanes.every((lane) => lane.terminal === true)) {
        return { state: 'unavailable', cause: 'no-connected-lane' };
      }
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) return { state: 'unavailable', cause: 'no-connected-lane' };
      const result = await this.availability.wait(
        revision,
        signal === undefined ? { timeoutMs: remaining } : { timeoutMs: remaining, signal },
      );
      if (result.outcome === 'aborted') return { state: 'aborted' };
      if (result.outcome !== 'changed') return { state: 'unavailable', cause: 'no-connected-lane' };
    }
  }
}
