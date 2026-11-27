import { z } from 'zod';
import { LOCAL_API_VERSION } from '../../contracts/src/door/common.ts';
import { LocalEventSubscriptionStateSchema } from '../../contracts/src/door/event-lifecycle.ts';
import {
  LocalEventErrorSchema,
  LocalEventFrameSchema,
  LocalEventGapSchema,
  LocalStreamChunkSchema,
  LocalStreamEndSchema,
  LocalStreamErrorSchema,
} from '../../contracts/src/door/results.ts';
import { refusalRefinement } from '../../contracts/src/protocol/failure.ts';
import { LocalServiceResultSchema, ServiceOutcomeSchema } from '../../contracts/src/service/contracts.ts';
import { ServiceDiagnosticsSchema, ServicePhaseSchema } from '../../contracts/src/service/diagnostics.ts';
import {
  type CallResult,
  CallResultSchema,
  type PeerResult,
  PeerResultSchema,
  type PublishResult,
  PublishResultSchema,
  type StatusResult,
  StatusResultSchema,
} from './contracts.ts';
import { WireClientError } from './errors.ts';

const diagnosticsReader = ServiceDiagnosticsSchema.extend({
  phases: z.array(ServicePhaseSchema.strip()).max(16),
}).strip();

export const ServiceResultReaderSchema = LocalServiceResultSchema.extend({
  outcome: z.discriminatedUnion('status', [
    ServiceOutcomeSchema.options[0].extend({ diagnostics: diagnosticsReader.optional() }).strip(),
    ServiceOutcomeSchema.options[1].strip().safeExtend({ diagnostics: diagnosticsReader.optional() }),
  ]),
}).strip();

export {
  type CallResult,
  CallResultSchema,
  type PeerResult,
  PeerResultSchema,
  type PublishResult,
  PublishResultSchema,
  type StatusResult,
  StatusResultSchema,
};

const version = z.object({ v: z.number().int() });
export function readResponse<T>(schema: z.ZodType<T>, value: unknown, versioned = true): T {
  if (versioned) {
    const result = version.safeParse(value);
    if (result.success && result.data.v !== LOCAL_API_VERSION) {
      throw new WireClientError('version', 'Unsupported local Wire door version', 'unknown', {
        actualVersion: result.data.v,
      });
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new WireClientError('invalid-response', 'Invalid Wire response envelope', 'unknown', {
      cause: parsed.error,
    });
  return parsed.data;
}

export function decodeWireData(frame: { data: string; bytes: number }): Uint8Array {
  const decoded = Buffer.from(frame.data, 'base64');
  if (decoded.byteLength !== frame.bytes || decoded.toString('base64') !== frame.data) {
    throw new WireClientError(
      'invalid-response',
      'Wire payload encoding or byte count is invalid',
      'unknown',
    );
  }
  return decoded;
}

export type StreamItem =
  | { kind: 'chunk'; frame: z.output<typeof LocalStreamChunkSchema>; data: Uint8Array }
  | { kind: 'end'; frame: z.output<typeof LocalStreamEndSchema> }
  | { kind: 'error'; frame: z.output<typeof LocalStreamErrorSchema> };
export type EventItem =
  | { kind: 'subscription'; frame: z.output<typeof LocalEventSubscriptionStateSchema> }
  | { kind: 'event'; frame: z.output<typeof LocalEventFrameSchema>; data: Uint8Array }
  | { kind: 'gap'; frame: z.output<typeof LocalEventGapSchema> }
  | { kind: 'error'; frame: z.output<typeof LocalEventErrorSchema> };
/**
 * What a subscription yields when the caller did not ask for `lifecycle` — the topic's own flow.
 *
 * `subscription` frames are opt-in at the request and emitted nowhere else, so a caller who never
 * asked for them cannot receive one; without this type they still had to handle one, and a member
 * added to the full union moved the exhaustive `switch` of every consumer, including those who had
 * opted out of the feature that produced it.
 */
export type EventFlowItem = Exclude<EventItem, { kind: 'subscription' }>;

const shape = z.record(z.string(), z.unknown());
const chunkReader = LocalStreamChunkSchema.strip();
const endReader = LocalStreamEndSchema.strip();
const streamErrorReader = LocalStreamErrorSchema.strip().superRefine(refusalRefinement);
const subscriptionReader = LocalEventSubscriptionStateSchema.strip();
const eventReader = LocalEventFrameSchema.strip();
const gapReader = LocalEventGapSchema.strip();
const eventErrorReader = LocalEventErrorSchema.strip().superRefine(refusalRefinement);

export function readStreamItem(value: unknown): StreamItem {
  const raw = readResponse(shape, value);
  if ('data' in raw) {
    const frame = readResponse(chunkReader, raw);
    return { kind: 'chunk', frame, data: decodeWireData(frame) };
  }
  if ('lastSeq' in raw) return { kind: 'end', frame: readResponse(endReader, raw) };
  return { kind: 'error', frame: readResponse(streamErrorReader, raw) };
}

export function readEventItem(value: unknown): EventItem {
  const raw = readResponse(shape, value);
  if ('subscriptionState' in raw)
    return { kind: 'subscription', frame: readResponse(subscriptionReader, raw) };
  if ('data' in raw) {
    const frame = readResponse(eventReader, raw);
    return { kind: 'event', frame, data: decodeWireData(frame) };
  }
  if ('fromSeq' in raw) {
    const frame = readResponse(gapReader, raw);
    if (
      frame.fromSeq > frame.toSeq ||
      (frame.reason === 'boot-change'
        ? frame.nextBootId === undefined || frame.nextBootId === frame.bootId
        : frame.nextBootId !== undefined)
    )
      throw new WireClientError('invalid-response', 'Invalid Wire gap range', 'unknown');
    return { kind: 'gap', frame };
  }
  return { kind: 'error', frame: readResponse(eventErrorReader, raw) };
}
