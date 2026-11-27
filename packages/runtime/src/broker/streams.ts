import { type BoundedOperationLease, createBoundedAdmission } from 'stitchkit/application';
import {
  capacityRefusal,
  type Refused,
  requestRefusal,
  transportFailure,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';
import type {
  StreamAck,
  StreamCancel,
  StreamChunk,
  StreamEnd,
  StreamError,
  StreamInvoke,
  StreamLimits,
  StreamOpen,
  StreamTerminalReason,
  StreamWindow,
} from '../../../contracts/src/protocol/stream.ts';
import type { BrokerConfig } from '../config/broker.ts';

interface StreamState {
  leases: BoundedOperationLease[];
  open: StreamOpen;
  callerSocketId: string;
  producerSocketId: string;
  nextSeq: number;
  creditBytes: number;
  transferredBytes: number;
  limits: StreamLimits;
  slowTimer: ReturnType<typeof setTimeout> | null;
}

export interface StreamSink {
  invoke(socketId: string, invocation: StreamInvoke): void;
  chunk(socketId: string, chunk: StreamChunk): void;
  window(socketId: string, window: StreamWindow): void;
  cancel(socketId: string, cancel: StreamCancel): void;
  end(socketId: string, end: StreamEnd): void;
  error(socketId: string, error: StreamError): void;
  terminal?(event: { streamId: string; from: NodeId | 'broker'; reason: StreamTerminalReason }): void;
}

type StreamOpenDecision = { accepted: false; refused: Refused } | { accepted: true; limits: StreamLimits };

interface StreamRouterStatus {
  active: number;
}

/** A third node that learned a stream id may not touch the stream: only its two ends can. */
function participates(state: StreamState, nodeId: NodeId): boolean {
  return nodeId === state.open.from || nodeId === state.open.to;
}

/** In-memory live-flight state only. Every entry is bounded and deleted on every terminal path. */
export class StreamRouter {
  private readonly streams = new Map<string, StreamState>();
  private readonly global;
  /**
   * Keyed admissions, not maps of admissions: `maxKeys` bounds the registry by the declared roster,
   * which is also the only set of ids that can authenticate, and the aggregate snapshot and
   * per-reason counters cover all keys.
   */
  private readonly callers;
  private readonly producers;

  constructor(
    private readonly admission: BrokerConfig['admission'],
    private readonly sink: StreamSink,
    declaredNodes = 1,
  ) {
    const keys = Math.max(1, declaredNodes);
    this.global = createBoundedAdmission({
      policy: { global: { maxConcurrent: admission.maxStreamsTotal } },
    });
    this.producers = createBoundedAdmission({
      policy: {
        global: { maxConcurrent: admission.maxStreamsPerProducer * keys },
        perKey: { maxKeys: keys, maxConcurrent: admission.maxStreamsPerProducer },
      },
    });
    this.callers = createBoundedAdmission({
      policy: {
        global: {
          maxConcurrent: admission.maxStreamsPerCaller * keys,
          rate: { limit: admission.maxStreamOpensPerMinute * keys, intervalMs: 60_000 },
        },
        perKey: {
          maxKeys: keys,
          maxConcurrent: admission.maxStreamsPerCaller,
          rate: { limit: admission.maxStreamOpensPerMinute, intervalMs: 60_000 },
        },
      },
    });
  }

  status(): StreamRouterStatus {
    return { active: this.streams.size };
  }

  open(open: StreamOpen, callerSocketId: string, producerSocketId: string): StreamOpenDecision {
    if (this.streams.has(open.streamId)) {
      // `denied` stays the failure a client keys on; the refusal class says why.
      return { accepted: false, refused: requestRefusal('stream id is already active') };
    }
    const global = this.global.acquire();
    if (global.outcome === 'refused')
      return { accepted: false, refused: capacityRefusal('broker stream registry limit reached') };
    const producer = this.producers.acquire(open.to);
    if (producer.outcome === 'refused') {
      global.lease.release();
      return { accepted: false, refused: capacityRefusal(`stream producer limit reached for ${open.to}`) };
    }
    const caller = this.callers.acquire(open.from);
    if (caller.outcome === 'refused') {
      producer.lease.release();
      global.lease.release();
      return {
        accepted: false,
        refused: capacityRefusal(
          caller.reason === 'key-rate' || caller.reason === 'global-rate'
            ? `stream open rate reached for ${open.from}`
            : `stream caller limit reached for ${open.from}`,
          caller.retryAfterMs ?? null,
        ),
      };
    }
    const limits: StreamLimits = {
      maxChunkBytes: this.admission.maxStreamChunkBytes,
      maxWindowBytes: Math.min(open.requestedWindowBytes, this.admission.maxStreamWindowBytes),
      maxStreamBytes: this.admission.maxStreamBytes,
      slowConsumerTimeoutMs: this.admission.streamSlowConsumerTimeoutMs,
    };
    const state: StreamState = {
      leases: [global.lease, producer.lease, caller.lease],
      open,
      callerSocketId,
      producerSocketId,
      nextSeq: 0,
      creditBytes: 0,
      transferredBytes: 0,
      limits,
      slowTimer: null,
    };
    this.streams.set(open.streamId, state);
    this.armSlowTimer(state);
    this.sink.invoke(producerSocketId, { open, limits });
    return { accepted: true, limits };
  }

  window(nodeId: NodeId, window: StreamWindow): StreamAck {
    const state = this.streams.get(window.streamId);
    if (state === undefined) return { ok: false, detail: 'unknown stream' };
    if (nodeId !== state.open.from || window.from !== nodeId) {
      return { ok: false, detail: 'only the authenticated consumer may grant credit' };
    }
    if (state.creditBytes + window.creditBytes > state.limits.maxWindowBytes) {
      return this.fail(
        state,
        requestRefusal('window exceeds the per-stream credit ceiling', 'rejected'),
        'limit',
      );
    }
    state.creditBytes += window.creditBytes;
    this.clearSlowTimer(state);
    this.sink.window(state.producerSocketId, window);
    return { ok: true, detail: '' };
  }

  chunk(nodeId: NodeId, chunk: StreamChunk): StreamAck {
    const state = this.streams.get(chunk.streamId);
    if (state === undefined) return { ok: false, detail: 'unknown stream' };
    if (!participates(state, nodeId))
      return { ok: false, detail: 'only a stream participant may send chunks' };
    if (nodeId !== state.open.to || chunk.from !== nodeId) {
      return this.fail(
        state,
        unclassifiedFailure('rejected', 'only the authenticated producer may send chunks'),
        'error',
      );
    }
    if (chunk.seq !== state.nextSeq) {
      return this.fail(
        state,
        unclassifiedFailure('rejected', `expected sequence ${state.nextSeq}, received ${chunk.seq}`),
        'error',
      );
    }
    if (chunk.bytes > state.limits.maxChunkBytes) {
      return this.fail(
        state,
        requestRefusal('chunk exceeds the per-stream chunk ceiling', 'rejected'),
        'limit',
      );
    }
    if (chunk.bytes > state.creditBytes) {
      return this.fail(state, requestRefusal('chunk exceeds granted consumer credit', 'rejected'), 'limit');
    }
    if (state.transferredBytes + chunk.bytes > state.limits.maxStreamBytes) {
      return this.fail(state, requestRefusal('stream exceeds the total byte ceiling', 'rejected'), 'limit');
    }
    state.nextSeq += 1;
    state.creditBytes -= chunk.bytes;
    state.transferredBytes += chunk.bytes;
    this.sink.chunk(state.callerSocketId, chunk);
    if (state.creditBytes === 0) this.armSlowTimer(state);
    return { ok: true, detail: '' };
  }

  cancel(nodeId: NodeId, cancel: StreamCancel): StreamAck {
    const state = this.streams.get(cancel.streamId);
    if (state === undefined) return { ok: false, detail: 'unknown stream' };
    if (cancel.from !== nodeId || !participates(state, nodeId)) {
      return { ok: false, detail: 'only a stream participant may cancel it' };
    }
    if (nodeId === state.open.from) this.sink.cancel(state.producerSocketId, cancel);
    else this.sink.cancel(state.callerSocketId, cancel);
    this.emitEndToCaller(state, 'cancelled', 1, null);
    this.sink.terminal?.({ streamId: state.open.streamId, from: nodeId, reason: 'cancelled' });
    this.delete(state.open.streamId);
    return { ok: true, detail: '' };
  }

  end(nodeId: NodeId, end: StreamEnd): StreamAck {
    const state = this.streams.get(end.streamId);
    if (state === undefined) return { ok: false, detail: 'unknown stream' };
    if (!participates(state, nodeId)) return { ok: false, detail: 'only a stream participant may end it' };
    if (nodeId !== state.open.to || end.from !== nodeId) {
      return this.fail(
        state,
        unclassifiedFailure('rejected', 'only the authenticated producer may end a stream'),
        'error',
      );
    }
    if (end.lastSeq !== state.nextSeq - 1) {
      return this.fail(
        state,
        unclassifiedFailure('rejected', 'terminal sequence does not match delivered chunks'),
        'error',
      );
    }
    this.sink.end(state.callerSocketId, end);
    this.sink.terminal?.({ streamId: state.open.streamId, from: nodeId, reason: end.reason });
    this.delete(end.streamId);
    return { ok: true, detail: '' };
  }

  error(nodeId: NodeId, error: StreamError): StreamAck {
    const state = this.streams.get(error.streamId);
    if (state === undefined) return { ok: false, detail: 'unknown stream' };
    if (!participates(state, nodeId)) return { ok: false, detail: 'only a stream participant may fail it' };
    if (nodeId !== state.open.to || error.from !== nodeId) {
      return this.fail(
        state,
        unclassifiedFailure('rejected', 'only the authenticated producer may fail a stream'),
        'error',
      );
    }
    this.sink.error(state.callerSocketId, error);
    this.sink.terminal?.({ streamId: state.open.streamId, from: nodeId, reason: error.reason });
    this.delete(error.streamId);
    return { ok: true, detail: '' };
  }

  disconnect(socketId: string): void {
    for (const state of [...this.streams.values()]) {
      if (state.callerSocketId === socketId) {
        this.sink.cancel(state.producerSocketId, {
          streamId: state.open.streamId,
          from: state.open.from,
          reason: 'consumer disconnected',
        });
        this.sink.terminal?.({
          streamId: state.open.streamId,
          from: state.open.from,
          reason: 'disconnect',
        });
        this.delete(state.open.streamId);
      } else if (state.producerSocketId === socketId) {
        this.sink.error(state.callerSocketId, {
          streamId: state.open.streamId,
          from: 'broker',
          ...transportFailure('lane-lost-after-dispatch', 'producer disconnected before a terminal event'),
          reason: 'disconnect',
        });
        this.sink.terminal?.({ streamId: state.open.streamId, from: 'broker', reason: 'disconnect' });
        this.delete(state.open.streamId);
      }
    }
  }

  stop(): void {
    this.global.stopAdmission();
    for (const state of [...this.streams.values()]) {
      this.sink.cancel(state.producerSocketId, {
        streamId: state.open.streamId,
        from: state.open.from,
        reason: 'broker shutdown',
      });
      this.sink.terminal?.({ streamId: state.open.streamId, from: 'broker', reason: 'cancelled' });
      this.delete(state.open.streamId);
    }
  }

  private armSlowTimer(state: StreamState): void {
    this.clearSlowTimer(state);
    state.slowTimer = setTimeout(() => {
      this.fail(
        state,
        unclassifiedFailure('timeout', 'consumer did not replenish stream credit'),
        'slow-consumer',
      );
    }, state.limits.slowConsumerTimeoutMs);
  }

  private clearSlowTimer(state: StreamState): void {
    if (state.slowTimer !== null) clearTimeout(state.slowTimer);
    state.slowTimer = null;
  }

  private fail(state: StreamState, refused: Refused, reason: StreamTerminalReason): StreamAck {
    this.sink.error(state.callerSocketId, {
      streamId: state.open.streamId,
      from: 'broker',
      ...refused,
      reason,
    });
    this.sink.cancel(state.producerSocketId, {
      streamId: state.open.streamId,
      from: state.open.from,
      reason: refused.detail,
    });
    this.sink.terminal?.({ streamId: state.open.streamId, from: 'broker', reason });
    this.delete(state.open.streamId);
    return { ok: false, detail: refused.detail };
  }

  private emitEndToCaller(
    state: StreamState,
    reason: StreamTerminalReason,
    code: number,
    cursor: string | null,
  ): void {
    this.sink.end(state.callerSocketId, {
      streamId: state.open.streamId,
      from: state.open.to,
      lastSeq: state.nextSeq - 1,
      code,
      reason,
      cursor,
    });
  }

  private delete(streamId: string): void {
    const state = this.streams.get(streamId);
    if (state !== undefined) {
      this.clearSlowTimer(state);
      for (const lease of state.leases) lease.release();
    }
    this.streams.delete(streamId);
  }
}
