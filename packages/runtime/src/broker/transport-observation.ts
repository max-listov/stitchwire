import { createManagedSchedule } from 'stitchkit/application';
import type { Audit } from './audit.ts';
import type { TransportObservationSnapshot } from './contracts.ts';
import { EventLoopDelayMonitor } from './event-loop-delay.ts';
import { StallAuditWindow } from './stall-audit.ts';
import { LaneVolumeMeter } from '../transport/lane-volume.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';

/** One owner for the broker-local transport facts exposed by health and persisted by audit. */
export class BrokerTransportObservation {
  private lastDisconnect: TransportObservationSnapshot['lastDisconnect'] = null;
  private readonly stalls: StallAuditWindow;
  private readonly eventLoopDelay: EventLoopDelayMonitor;
  readonly schedule;
  readonly volume;

  constructor(
    private readonly broker: string,
    private readonly audit: () => Audit,
  ) {
    this.volume = new LaneVolumeMeter((row) => this.audit().write(row));
    this.stalls = new StallAuditWindow(broker, (event) => this.audit().write(event));
    this.eventLoopDelay = new EventLoopDelayMonitor();
    this.schedule = createManagedSchedule({
      id: 'event-loop-delay',
      dependsOn: ['audit'],
      everyMs: 100,
      overlap: { mode: 'skip' },
      run: (context) => {
        const sampledAt = nowIso();
        this.volume.flushDue();
        this.eventLoopDelay.observe(context.scheduledAt, context.startedAt, sampledAt);
        this.stalls.observe(
          Math.max(0, context.startedAt - context.scheduledAt),
          context.startedAt,
          sampledAt,
        );
      },
    });
  }

  flush(): void {
    this.stalls.flush();
  }

  recordDisconnect(nodeId: string, reason: string, observedAt: string): void {
    this.lastDisconnect = { nodeId, reason, observedAt };
    this.audit().write({ kind: 'disconnect', nodeId, broker: this.broker, reason });
  }

  snapshot(): TransportObservationSnapshot {
    return {
      broker: this.broker,
      lastDisconnect: this.lastDisconnect,
      eventLoopDelay: this.eventLoopDelay.snapshot(),
    };
  }
}
