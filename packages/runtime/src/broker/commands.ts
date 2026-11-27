import type { BoundedOperationLease } from 'stitchkit/application';
import { transportFailure, unclassifiedFailure } from '../../../contracts/src/protocol/failure.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';
import {
  type Cancel,
  type Invocation,
  type Result,
  syntheticResult,
} from '../../../contracts/src/protocol/rpc.ts';
import type { Audit } from './audit.ts';

/**
 * Grace beyond the caller's own deadline before the broker answers for a silent target, so a late
 * answer loses to the caller's clock rather than racing it and producing two verdicts for one call.
 */
const BROKER_GRACE_MS = 2_000;

/** One command call in flight: who placed it, which socket it went to, and what it holds. */
interface PendingCall {
  lease: BoundedOperationLease;
  invocation: Invocation;
  callerSocketId: string;
  /** The socket the call was dispatched to: the one whose loss means the call is lost. */
  targetSocketId: string;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface CommandSink {
  cancel(socketId: string, cancel: Cancel): void;
  result(socketId: string, result: Result): void;
}

/**
 * Owns the command calls in flight, from dispatch to the one place each ends.
 *
 * A call ends when its target answers, when its caller withdraws, when either socket is lost, or
 * when the deadline plus a grace passes — and every one of those settles it exactly once: the lease
 * is released, the audit journal gets the result, the caller hears it. A caller that leaves takes
 * its call with it: the target is told to stop, because a command nobody waits for is work nobody
 * will read.
 */
export class CommandRouter {
  private readonly pending = new Map<string, PendingCall>();

  constructor(
    private readonly audit: Pick<Audit, 'write'>,
    private readonly sink: CommandSink,
    /** How long past a call's own deadline the broker waits before answering for its target; a test shortens it. */
    private readonly graceMs = BROKER_GRACE_MS,
  ) {}

  has(id: string): boolean {
    return this.pending.has(id);
  }

  /** Registers a call that was just dispatched; the broker answers for a silent target when its time is up. */
  begin(call: Omit<PendingCall, 'startedAt' | 'timer'>): void {
    const { id, to, timeoutMs } = call.invocation;
    const timer = setTimeout(
      () =>
        this.settle(
          id,
          syntheticResult(id, unclassifiedFailure('timeout', `${to} did not answer within ${timeoutMs}ms`)),
        ),
      timeoutMs + this.graceMs,
    );
    this.pending.set(id, { ...call, startedAt: Date.now(), timer });
  }

  /** The caller withdraws. Only the socket that placed the call may. */
  cancel(callerSocketId: string, cancel: Cancel): void {
    const entry = this.pending.get(cancel.id);
    if (entry === undefined || entry.callerSocketId !== callerSocketId) return;
    this.sink.cancel(entry.targetSocketId, cancel);
    this.settle(
      cancel.id,
      syntheticResult(cancel.id, unclassifiedFailure('cancelled', 'the caller withdrew the call')),
    );
  }

  /**
   * A node answers a call. Only the node the call was dispatched to may: otherwise any authenticated
   * node could answer any other node's call, which the audit journal would then record as truth.
   */
  answer(nodeId: NodeId, result: Result): boolean {
    const entry = this.pending.get(result.id);
    if (entry === undefined || entry.invocation.to !== nodeId) return false;
    this.settle(result.id, { ...result, from: nodeId });
    return true;
  }

  /**
   * A socket is gone. A call dispatched to it will never be answered, so it fails now rather than at
   * its deadline; a call it placed is withdrawn on the target, which keeps running it otherwise.
   */
  disconnect(socketId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.targetSocketId === socketId) {
        this.settle(
          id,
          syntheticResult(
            id,
            transportFailure(
              'lane-lost-after-dispatch',
              `${entry.invocation.to} disconnected before answering`,
            ),
          ),
        );
      } else if (entry.callerSocketId === socketId) {
        const { invocation } = entry;
        this.sink.cancel(entry.targetSocketId, {
          id,
          from: invocation.from,
          to: invocation.to,
          reason: 'the caller disconnected',
        });
        this.settle(id, syntheticResult(id, unclassifiedFailure('cancelled', 'the caller disconnected')));
      }
    }
  }

  stop(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.lease.release();
    }
    this.pending.clear();
  }

  /** Ends a call once: a late answer after a timeout finds nothing and is ignored. */
  settle(id: string, result: Result): void {
    const entry = this.pending.get(id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.lease.release();
    this.audit.write({
      kind: 'result',
      id,
      from: entry.invocation.to,
      to: entry.invocation.from,
      code: result.code,
      failure: result.failure,
      refusal: result.refusal,
      transportCause: result.transportCause ?? null,
      ms: Date.now() - entry.startedAt,
    });
    this.sink.result(entry.callerSocketId, result);
  }
}
