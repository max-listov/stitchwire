import type { BoundedAdmission } from 'stitchkit/application';
import type { LocalStreamRequest } from '../../../contracts/src/door/requests.ts';
import { MAX_STREAM_WINDOW_BYTES } from '../../../contracts/src/protocol/bounds.ts';
import { capacityRefusal, transportFailure } from '../../../contracts/src/protocol/failure.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import type {
  StreamAdmission,
  StreamCancel,
  StreamOpen,
  StreamWindow,
} from '../../../contracts/src/protocol/stream.ts';
import { LANE_ACK_TIMEOUT_MS, type LaneClient } from './lane-contract.ts';
import { StreamConsumer, type StreamConsumerEvent } from './stream-consumer.ts';
import type { StreamProducerManager } from './stream-producer.ts';

/** Realtime validates incoming frames before handing them to lane-local stream owners. */
export function bindLaneStreams(
  client: LaneClient,
  consumers: ReadonlyMap<string, StreamConsumer>,
  producers: StreamProducerManager,
): void {
  client.on('stream:invoke', (invoke) => producers.start(invoke));
  client.on('stream:window', (window) => producers.addCredit(window.streamId, window.creditBytes));
  client.on('stream:cancel', (cancel) => producers.cancel(cancel));
  client.on('stream:chunk', (chunk) => consumers.get(chunk.streamId)?.pushChunk(chunk));
  client.on('stream:end', (end) => consumers.get(end.streamId)?.pushEnd(end));
  client.on('stream:error', (error) => consumers.get(error.streamId)?.pushFailure(error));
}

interface LaneStreamTransport {
  window(window: StreamWindow): Promise<{ ok: boolean; detail: string }>;
  cancel(cancel: StreamCancel): Promise<{ ok: boolean; detail: string }>;
  open(request: StreamOpen, acknowledge: (admission: StreamAdmission) => void): boolean;
}

/** Owns one lane stream consumer through local admission and broker open acknowledgement. */
export function openLaneStream(
  config: {
    nodeId: string;
    defaultTimeoutMs: number;
    maxBufferedBytes: number;
    ackTimeoutMs?: number;
  },
  consumers: Map<string, StreamConsumer>,
  slots: BoundedAdmission,
  transport: LaneStreamTransport,
  request: LocalStreamRequest,
): AsyncIterableIterator<StreamConsumerEvent> {
  const streamId = crypto.randomUUID();
  let admissionTimer: ReturnType<typeof setTimeout> | undefined;
  const slot = slots.acquire();
  const consumer = new StreamConsumer(
    streamId,
    config.nodeId,
    config.maxBufferedBytes,
    { window: transport.window, cancel: transport.cancel },
    () => {
      clearTimeout(admissionTimer);
      consumers.delete(streamId);
      if (slot.outcome === 'leased') slot.lease.release();
    },
  );
  if (slot.outcome === 'refused') {
    consumer.pushFailure({
      streamId,
      from: 'broker',
      ...capacityRefusal('node local stream consumer limit reached'),
      reason: 'limit',
    });
    return consumer;
  }
  consumers.set(streamId, consumer);
  const timeoutMs = request.timeoutMs ?? config.defaultTimeoutMs;
  admissionTimer = setTimeout(() => {
    consumer.abort({
      streamId,
      from: 'broker',
      ...transportFailure(
        'acknowledgement-timeout',
        'broker stream admission acknowledgement timed out; request was not replayed',
      ),
      reason: 'timeout',
    });
  }, config.ackTimeoutMs ?? LANE_ACK_TIMEOUT_MS);
  const handed = transport.open(
    {
      streamId,
      ts: nowIso(),
      from: config.nodeId,
      to: request.to,
      source:
        'source' in request
          ? request.source
          : {
              kind: 'profile',
              profile: request.profile,
              args: request.args,
              stdin: request.stdin,
              cursor: request.cursor,
            },
      timeoutMs,
      requestedWindowBytes: Math.min(config.maxBufferedBytes, MAX_STREAM_WINDOW_BYTES),
    },
    (admission) => {
      clearTimeout(admissionTimer);
      if (admission.accepted && admission.limits !== null) {
        void consumer.start(admission.limits);
        return;
      }
      consumer.pushFailure({
        streamId,
        from: 'broker',
        failure: admission.failure,
        refusal: admission.refusal,
        retryAfterMs: admission.retryAfterMs,
        transportCause: admission.transportCause ?? null,
        reason:
          admission.refusal === 'capacity'
            ? 'limit'
            : admission.failure === 'denied'
              ? 'error'
              : admission.failure === 'timeout'
                ? 'timeout'
                : 'disconnect',
        detail: admission.detail,
      });
    },
  );
  if (!handed) {
    clearTimeout(admissionTimer);
    consumer.pushFailure({
      streamId,
      from: 'broker',
      ...transportFailure('no-connected-lane', 'not connected to the broker'),
      reason: 'disconnect',
    });
  }
  return consumer;
}
