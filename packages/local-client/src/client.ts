import { z } from 'zod';
import {
  LocalCallSchema,
  LocalEventPublishSchema,
  LocalEventSubscribeSchema,
  LocalStreamRequestSchema,
} from '../../contracts/src/door/requests.ts';
import { PEER_TIMEOUT_MS, PeerRequestSchema } from '../../contracts/src/peer-contract.ts';
import { MAX_STREAM_TOTAL_BYTES } from '../../contracts/src/protocol/bounds.ts';
import { type ServiceCall, ServiceCallSchema } from '../../contracts/src/service/contracts.ts';
import type { ServiceClientTrace } from '../../contracts/src/service/diagnostics.ts';
import { DOOR } from './door-paths.ts';
import { localError, WireClientError } from './errors.ts';
import { eventSequence } from './event-sequence.ts';
import { createFeed, type WireFeed } from './feed.ts';
import { ClientSession } from './operation.ts';
import {
  ClientOptionsSchema,
  COMMAND_RESULT_GRACE_MS,
  STREAM_TERMINAL_GRACE_MS,
  type RequestOptions,
  requestInput,
  type WireClientOptions,
} from './options.ts';
import {
  CallResultSchema,
  type EventFlowItem,
  type EventItem,
  PeerResultSchema,
  PublishResultSchema,
  readEventItem,
  readStreamItem,
  ServiceResultReaderSchema,
  StatusResultSchema,
} from './readers.ts';
import { unary } from './unary.ts';

export type CallRequest = z.input<typeof LocalCallSchema>;
export type StreamRequest = z.input<typeof LocalStreamRequestSchema>;
export type PublishRequest = z.input<typeof LocalEventPublishSchema>;
export type SubscribeRequest = z.input<typeof LocalEventSubscribeSchema>;
export type PeerRequest = z.input<typeof PeerRequestSchema>;
export interface ServiceRequestOptions extends RequestOptions {
  /** Called before validation/admission/dispatch so an outer deadline can retain correlation. */
  onTrace?: (trace: ServiceClientTrace) => void;
}

/** Borrows the local agent's identity; never launches a daemon or connects to a broker. */
export function createWireClient(options: WireClientOptions) {
  const config = requestInput(ClientOptionsSchema, options);
  const session = new ClientSession(config);
  /**
   * The feed's item type follows the option that produces the extra frames.
   *
   * Three signatures rather than one conditional type, because the conditional forms all get one of
   * the five cases wrong, and the wrong one is the dangerous direction. Measured before writing
   * this: with `subscribe<T extends SubscribeRequest>`, `T['lifecycle']` on a request that OMITS
   * the key resolves through the constraint to `boolean | undefined`, so the common case never
   * narrows at all; and a form keyed on `T extends { lifecycle: true }` narrows a variable of type
   * `boolean`, which is the type lying about what can arrive at runtime.
   *
   * Overloads answer all five: absent and literal `false` narrow, literal `true` widens, and both
   * "a boolean whose value is unknown here" and "a whole SubscribeRequest value" fall through to
   * the last signature and widen. Narrow only where it is provable; widen wherever it is not.
   */
  function subscribe(
    input: SubscribeRequest & { lifecycle: true },
    options?: RequestOptions,
  ): WireFeed<EventItem>;
  function subscribe(
    input: SubscribeRequest & { lifecycle?: false },
    options?: RequestOptions,
  ): WireFeed<EventFlowItem>;
  function subscribe(input: SubscribeRequest, options?: RequestOptions): WireFeed<EventItem>;
  function subscribe(input: SubscribeRequest, options: RequestOptions = {}): WireFeed<EventItem> {
    const request = requestInput(LocalEventSubscribeSchema, input);
    const sequence = eventSequence(request.topic, request.resume);
    const lifecycle = request.lifecycle === true;
    return createFeed(
      session,
      DOOR.subscribe,
      request,
      (value) => {
        const item = sequence(readEventItem(value));
        /**
         * Makes the narrowed type true by CONSTRUCTION rather than by agreement with the server.
         * Three layers already gate these frames on the request, so this refuses nothing a healthy
         * peer sends; what it removes is the one way the narrow type could become a lie — a frame
         * the caller never asked for, delivered anyway, into code that no longer has a branch for
         * it. A protocol violation is not a data condition, so it refuses rather than drops.
         */
        if (!lifecycle && item.kind === 'subscription') {
          throw new WireClientError(
            'invalid-response',
            'Wire sent a subscription lifecycle frame to a feed that did not request one',
            'unknown',
          );
        }
        return item;
      },
      z.object({ kind: z.literal('error') }),
      options.signal,
      undefined,
      lifecycle
        ? (item) => item.kind === 'subscription' && item.frame.subscriptionState === 'ready'
        : undefined,
    );
  }
  return {
    async invokeService(input: ServiceCall, options: ServiceRequestOptions = {}) {
      const traceId = input.traceId ?? crypto.randomUUID();
      options.onTrace?.({ traceId, phase: 'start' });
      try {
        const parsed = requestInput(ServiceCallSchema, { ...input, traceId });
        const result = await unary(session, DOOR.invokeService, parsed, ServiceResultReaderSchema, {
          traceId,
          timeoutMs: parsed.timeoutMs,
          signal: options.signal,
          versioned: true,
        });
        options.onTrace?.({
          traceId,
          phase: 'result',
          diagnostics: result.outcome.diagnostics,
          ...(result.outcome.status === 'failure'
            ? { cancellationOrigin: result.outcome.cancellationOrigin }
            : {}),
        });
        return { ...result, traceId };
      } catch (error) {
        const failure = localError(error, 'not-sent');
        // Every `start` gets its `result`: a caller pairing the two sees a call that ended, not one
        // still open, and how it was cancelled when the door said so.
        const origin = failure.metadata.cancellationOrigin;
        options.onTrace?.({
          traceId,
          phase: 'result',
          ...(origin === undefined ? {} : { cancellationOrigin: origin }),
        });
        throw new WireClientError(failure.code, failure.message, failure.delivery, {
          ...failure.metadata,
          traceId,
        });
      }
    },
    call(input: CallRequest, options: RequestOptions = {}) {
      const parsed = requestInput(LocalCallSchema, input);
      const request = { ...parsed, timeoutMs: parsed.timeoutMs ?? config.timeoutMs };
      return unary(session, DOOR.call, request, CallResultSchema, {
        timeoutMs: request.timeoutMs + COMMAND_RESULT_GRACE_MS,
        signal: options.signal,
        versioned: true,
      });
    },
    status(options: RequestOptions = {}) {
      return unary(session, DOOR.status, undefined, StatusResultSchema, {
        timeoutMs: config.openTimeoutMs,
        signal: options.signal,
        versioned: true,
      });
    },
    peerObservation(input: PeerRequest, options: RequestOptions = {}) {
      return unary(session, DOOR.peerObservation, requestInput(PeerRequestSchema, input), PeerResultSchema, {
        timeoutMs: PEER_TIMEOUT_MS + config.openTimeoutMs,
        signal: options.signal,
        versioned: true,
      });
    },
    publish(input: PublishRequest, options: RequestOptions = {}) {
      return unary(session, DOOR.publish, requestInput(LocalEventPublishSchema, input), PublishResultSchema, {
        timeoutMs: config.timeoutMs,
        signal: options.signal,
        versioned: false,
        maxBytes: 16 * 1024,
      });
    },
    stream(input: StreamRequest, options: RequestOptions = {}) {
      const parsed = requestInput(LocalStreamRequestSchema, input);
      const request = { ...parsed, timeoutMs: parsed.timeoutMs ?? config.timeoutMs };
      let streamId: string | undefined;
      let nextSeq = 0;
      let bytes = 0;
      return createFeed(
        session,
        DOOR.stream,
        request,
        (value) => {
          const item = readStreamItem(value);
          streamId ??= item.frame.streamId;
          if (streamId !== item.frame.streamId)
            throw new WireClientError('invalid-response', 'Wire stream identity changed', 'unknown');
          if (item.kind === 'chunk') {
            if (item.frame.from !== request.to || item.frame.seq !== nextSeq++)
              throw new WireClientError(
                'invalid-response',
                'Wire stream source or sequence changed',
                'unknown',
              );
            bytes += item.data.byteLength;
            if (bytes > MAX_STREAM_TOTAL_BYTES)
              throw new WireClientError('limit', 'Wire stream exceeds total byte limit', 'unknown');
          }
          if (item.kind === 'end' && (item.frame.from !== request.to || item.frame.lastSeq !== nextSeq - 1)) {
            throw new WireClientError(
              'invalid-response',
              'Wire stream terminal sequence is inconsistent',
              'unknown',
            );
          }
          return item;
        },
        z.object({ kind: z.enum(['end', 'error']) }),
        options.signal,
        request.timeoutMs + STREAM_TERMINAL_GRACE_MS,
      );
    },
    subscribe,
    close() {
      session.close();
    },
    [Symbol.dispose]() {
      session.close();
    },
  };
}
export type WireClient = ReturnType<typeof createWireClient>;
