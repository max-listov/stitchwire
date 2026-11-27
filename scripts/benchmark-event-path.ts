import { MAX_EVENT_BYTES } from '../packages/contracts/src/protocol/bounds.ts';
import { LocalEventPublishSchema } from '../packages/contracts/src/door/requests.ts';
import { EventFrameSchema, EventPublishSchema } from '../packages/contracts/src/protocol/event.ts';
import { eventDeliverySize } from '../packages/runtime/src/event-delivery-size.ts';
import { prepareEventPublish } from '../packages/runtime/src/node/multi-home-publisher.ts';

/** Synthetic CPU, not production savings. No timer, network or batching affects delivery. */
function measure(run: () => number, iterations: number) {
  for (let i = 0; i < 100; i++) run();
  const samples: number[] = [];
  let checksum = 0;
  for (let round = 0; round < 5; round++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) checksum += run();
    samples.push(((performance.now() - start) * 1000) / iterations);
  }
  samples.sort((a, b) => a - b);
  return { medianUs: samples[2], checksum };
}

for (const size of [1200, 2400, 32768, MAX_EVENT_BYTES]) {
  const input = LocalEventPublishSchema.parse({
    topic: 'test.cost',
    bootId: crypto.randomUUID(),
    seq: 0,
    data: 'x'.repeat(size),
  });
  const frame = EventFrameSchema.parse({
    ...prepareEventPublish('publisher', input),
    subscriptionId: crypto.randomUUID(),
  });
  const historicalPrepare = () => {
    let total = 0;
    for (let lane = 0; lane < 3; lane++) {
      const bytes = new TextEncoder().encode(input.data);
      const event = EventPublishSchema.parse({
        ...input,
        producer: 'publisher',
        encoding: 'base64',
        data: Buffer.from(bytes).toString('base64'),
        bytes: bytes.byteLength,
      });
      total += event.bytes;
    }
    return total;
  };
  console.log(
    JSON.stringify({
      size,
      iterations: 500,
      fullJson: measure(() => Buffer.byteLength(JSON.stringify(frame)), 500),
      envelopeOnly: measure(() => eventDeliverySize(frame), 500),
      preparePerSource: measure(historicalPrepare, 500),
      prepareShared: measure(() => prepareEventPublish('publisher', input).bytes * 3, 500),
    }),
  );
}
