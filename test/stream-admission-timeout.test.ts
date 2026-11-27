import { expect, test } from 'bun:test';
import { createBoundedAdmission } from 'stitchkit/application';
import { StreamAdmissionSchema } from '../packages/contracts/src/protocol/stream.ts';
import { openLaneStream } from '../packages/runtime/src/node/lane-stream.ts';
import type { StreamConsumer } from '../packages/runtime/src/node/stream-consumer.ts';

const limits = { maxWindowBytes: 64, maxChunkBytes: 32, maxStreamBytes: 1024, slowConsumerTimeoutMs: 1000 };
const accepted = StreamAdmissionSchema.parse({
  accepted: true,
  limits,
  failure: 'none',
  refusal: 'none',
  retryAfterMs: null,
  transportCause: null,
  detail: '',
});

test('stream admission timeout cancels exactly once and a late accepted ACK cannot grant credit', async () => {
  const consumers = new Map<string, StreamConsumer>();
  const slots = createBoundedAdmission({ policy: { global: { maxConcurrent: 1 } } });
  let acknowledge: ((ack: typeof accepted) => void) | undefined;
  let cancels = 0,
    windows = 0;
  const consumer = openLaneStream(
    { nodeId: 'reader', defaultTimeoutMs: 1000, maxBufferedBytes: 64, ackTimeoutMs: 20 },
    consumers,
    slots,
    {
      open(_request, callback) {
        acknowledge = callback;
        return true;
      },
      window: async () => {
        windows++;
        return { ok: true, detail: '' };
      },
      cancel: async () => {
        cancels++;
        return { ok: true, detail: '' };
      },
    },
    { to: 'worker', profile: 'quiet', args: [], stdin: null, cursor: null },
  );
  expect(await consumer.next()).toMatchObject({ value: { transportCause: 'acknowledgement-timeout' } });
  expect(cancels).toBe(1);
  expect(consumers.size).toBe(0);
  acknowledge?.(accepted);
  await consumer.return?.();
  expect(windows).toBe(0);
  expect(cancels).toBe(1);
  const lease = slots.acquire();
  expect(lease.outcome).toBe('leased');
  if (lease.outcome === 'leased') lease.lease.release();
  const timely = openLaneStream(
    { nodeId: 'reader', defaultTimeoutMs: 1000, maxBufferedBytes: 64 },
    consumers,
    slots,
    {
      open(_request, callback) {
        callback(accepted);
        return true;
      },
      window: async () => {
        windows++;
        return { ok: true, detail: '' };
      },
      cancel: async () => {
        cancels++;
        return { ok: true, detail: '' };
      },
    },
    { to: 'worker', profile: 'quiet', args: [], stdin: null, cursor: null },
  );
  expect(windows).toBe(1);
  await timely.return?.();
  expect(cancels).toBe(2);
});
