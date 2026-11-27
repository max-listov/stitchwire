/** Bounded passive tuple capture; never publishes, replays or exports event payloads. */
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createWireClient, WireClientError } from '../packages/client/src/index.ts';
import { TopicNameSchema } from '../packages/contracts/src/protocol/event.ts';

const args = parseArgs({
  options: {
    socket: { type: 'string' },
    topic: { type: 'string' },
    'duration-ms': { type: 'string', default: '60000' },
  },
}).values;
const input = z
  .object({
    socket: z.string().min(1),
    topic: TopicNameSchema,
    'duration-ms': z.coerce.number().int().min(1000).max(900000),
  })
  .parse(args);
using client = createWireClient({ socketPath: input.socket, openTimeoutMs: 3000 });
const status = await client.status();
const started = performance.now();
const signal = AbortSignal.timeout(input['duration-ms']);
console.log(
  JSON.stringify({
    kind: 'start',
    at: new Date().toISOString(),
    node: status.nodeId,
    version: status.version,
    lanes: status.lanes,
    topic: input.topic,
    durationMs: input['duration-ms'],
    maxRecords: 10000,
  }),
);
let records = 0;
try {
  for await (const item of client.subscribe({ topic: input.topic }, { signal })) {
    const frame = item.frame;
    const common = {
      receivedAt: new Date().toISOString(),
      elapsedMs: performance.now() - started,
      kind: item.kind,
      topic: frame.topic,
    };
    if (item.kind === 'event') {
      console.log(
        JSON.stringify({
          ...common,
          seq: item.frame.seq,
          bootId: item.frame.bootId,
          producer: item.frame.producer,
          observedAt: item.frame.observedAt,
          bytes: item.frame.bytes,
        }),
      );
    } else if (item.kind === 'gap') {
      console.log(
        JSON.stringify({
          ...common,
          fromSeq: item.frame.fromSeq,
          toSeq: item.frame.toSeq,
          reason: item.frame.reason,
          bootId: item.frame.bootId,
          producer: item.frame.producer,
        }),
      );
    } else {
      console.log(JSON.stringify({ ...common, failure: item.frame.failure, refusal: item.frame.refusal }));
    }
    if (++records >= 10000) break;
  }
} catch (error) {
  if (!(signal.aborted && error instanceof WireClientError && error.code === 'cancelled')) throw error;
} finally {
  console.log(
    JSON.stringify({
      kind: 'end',
      at: new Date().toISOString(),
      records,
      elapsedMs: performance.now() - started,
      deadlineReached: signal.aborted,
    }),
  );
}
