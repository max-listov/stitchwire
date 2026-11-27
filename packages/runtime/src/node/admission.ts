import { ownEntry } from '../json.ts';
import { createBoundedAdmission } from 'stitchkit/application';
import { type EventAck, rejectedEventAck } from '../../../contracts/src/protocol/event.ts';
import {
  capacityRefusal,
  type Refused,
  transportFailure,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import { MAX_DECLARED_SERVICES } from '../../../contracts/src/service/declaration.ts';
import type { NodeConfig } from '../config/node.ts';

type AdmissionLease = { accepted: false; refused: Refused } | { accepted: true; release(): void };

type ExecutionProfiles = Readonly<Record<string, { concurrency: number }>>;

/**
 * Command and stream execution share one admission; only the label they audit under differs.
 */
export class ExecutionAdmission {
  private readonly pool;
  constructor(
    limits: { maxInflight: number; maxCallsPerMinute?: number | undefined },
    profiles: ExecutionProfiles = {},
    private readonly label = 'node',
    additionalKeys = 0,
    fallbackConcurrency = 1,
  ) {
    this.pool = createBoundedAdmission({
      policy: {
        global: {
          maxConcurrent: limits.maxInflight,
          ...(limits.maxCallsPerMinute === undefined
            ? {}
            : { rate: { limit: limits.maxCallsPerMinute, intervalMs: 60_000 } }),
        },
        perKey: {
          maxKeys: Math.max(1, Object.keys(profiles).length + additionalKeys),
          limits: (name) => ({ maxConcurrent: ownEntry(profiles, name)?.concurrency ?? fallbackConcurrency }),
        },
      },
    });
  }
  stopAdmission(): void {
    this.pool.stopAdmission();
  }
  async drain(): Promise<void> {
    await this.pool.drain();
  }
  acquire(name: string): AdmissionLease {
    const result = this.pool.acquire(name);
    if (result.outcome === 'leased') return { accepted: true, release: () => result.lease.release() };
    return {
      accepted: false,
      refused: capacityRefusal(
        result.reason === 'global-rate'
          ? 'node rate limit reached'
          : result.reason === 'key-concurrency'
            ? `${this.label} concurrency limit reached for '${name}'`
            : `${this.label} inflight limit reached`,
        result.retryAfterMs ?? null,
      ),
    };
  }
}

/** The stream producer's execution admission, which differs from a command's only by its label. */
export function streamExecutionAdmission(
  config: Pick<NodeConfig, 'admission' | 'streams'> & {
    services: { bindings: unknown[]; descriptors: unknown[] };
  },
  serviceDropInActive = false,
): ExecutionAdmission {
  const maxInflight = config.admission.maxStreamProducers;
  // A service stream is admitted under its own key, one per bound or declared service. With a
  // services.d/ drop-in directory any declaration may arrive later: the whole declared-service
  // ceiling is reserved, explicit descriptors included (both count against it).
  const declaredSlots = serviceDropInActive ? MAX_DECLARED_SERVICES : config.services.descriptors.length;
  const serviceKeys = config.services.bindings.length + declaredSlots;
  return new ExecutionAdmission(
    { maxInflight },
    config.streams,
    'node stream producer',
    serviceKeys,
    maxInflight,
  );
}

interface PendingPublish {
  settle(ack: EventAck): void;
}

/**
 * One broker lane's bound on publishes awaiting its acknowledgement. The node-wide pending and rate
 * budget is `MultiHomePublisher`'s, decided before local delivery.
 */
export class PublishAdmission {
  private readonly pending = new Map<string, PendingPublish>();
  private readonly pool;

  constructor(
    private readonly limits: Pick<NodeConfig['admission'], 'maxPendingPublishes' | 'publishAckTimeoutMs'>,
  ) {
    this.pool = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: limits.maxPendingPublishes },
      },
    });
  }

  dispatch(
    send: (acknowledge: (ack: EventAck) => void) => boolean | Promise<EventAck>,
    signal?: AbortSignal,
  ): Promise<EventAck> {
    if (signal?.aborted === true)
      return Promise.resolve(this.failure('cancelled', 'the caller withdrew before publish dispatch'));
    const admitted = this.pool.acquire();
    if (admitted.outcome === 'refused')
      return Promise.resolve(
        rejectedEventAck(
          capacityRefusal('node pending publish limit reached', admitted.retryAfterMs ?? null),
        ),
      );
    const release = (): void => {
      this.pending.delete(id);
      admitted.lease.release();
    };
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      let settled = false;
      let physical = false;
      let dispatching = true;
      const settle = (ack: EventAck): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!physical && !dispatching) release();
        resolve(ack);
      };
      const timer = setTimeout(
        () => settle(this.failure('timeout', 'broker publish acknowledgement timed out')),
        this.limits.publishAckTimeoutMs,
      );
      this.pending.set(id, { settle });
      try {
        const sent = send(settle);
        if (typeof sent === 'boolean') {
          dispatching = false;
          if (settled) release();
          if (!sent) settle(this.failure('transport', 'not connected to the broker'));
        } else {
          physical = true;
          dispatching = false;
          void sent
            .then(settle, () =>
              settle(
                rejectedEventAck(
                  transportFailure('lane-lost-after-dispatch', 'broker acknowledgement unavailable'),
                ),
              ),
            )
            .finally(release);
        }
      } catch {
        dispatching = false;
        settle(this.failure('transport', 'broker publication dispatch failed'));
        if (settled && !physical) release();
      }
    });
  }

  disconnect(): void {
    for (const pending of [...this.pending.values()]) {
      pending.settle(
        rejectedEventAck(
          transportFailure('lane-lost-after-dispatch', 'lost the broker connection while publishing'),
        ),
      );
    }
  }

  status(): { pending: number } {
    return { pending: this.pending.size };
  }

  private failure(failure: EventAck['failure'], detail: string): EventAck {
    if (failure === 'transport') return rejectedEventAck(transportFailure('no-connected-lane', detail));
    if (failure === 'timeout') return rejectedEventAck(transportFailure('acknowledgement-timeout', detail));
    return rejectedEventAck(unclassifiedFailure(failure, detail));
  }
}
