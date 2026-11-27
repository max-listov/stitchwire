import assert from 'node:assert/strict';
import { LOCAL_API_VERSION, createWireClient } from '@stitchwire/client';
import { line, openDoor, runtime } from './_door.mjs';

const bootId = crypto.randomUUID(),
  nextBootId = crypto.randomUUID();
const base = {
  v: LOCAL_API_VERSION,
  subscriptionId: crypto.randomUUID(),
  topic: 'example.events',
  producer: 'worker',
  bootId,
};
const event = (seq, boot = bootId) => ({
  ...base,
  bootId: boot,
  seq,
  observedAt: null,
  cursor: null,
  encoding: 'base64',
  data: 'e30=',
  bytes: 2,
});
const gap = (fromSeq, toSeq, reason = 'overflow') => ({ ...base, fromSeq, toSeq, reason });
const transition = { ...gap(500, 500, 'boot-change'), nextBootId };
const terminal = {
  v: LOCAL_API_VERSION,
  subscriptionId: base.subscriptionId,
  topic: base.topic,
  from: 'broker',
  failure: 'denied',
  refusal: 'capacity',
  transportCause: null,
  retryAfterMs: 123,
  detail: '',
};
let frames = [],
  requests = 0;
const door = await openDoor('event-sequence', (_req, res) => {
  requests++;
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  res.end(frames.map(line).join(''));
});
const client = createWireClient({ socketPath: door.socketPath, maxConcurrentRequests: 1 });
const read = async (resume) => {
  const items = [];
  for await (const item of client.subscribe({ topic: base.topic, resume })) items.push(item);
  return items;
};
try {
  for (const values of [
    [event(40), event(41), gap(42, 44), event(45)],
    [event(0), transition, event(91, nextBootId), event(92, nextBootId)],
  ]) {
    frames = [...values, terminal];
    const result = await read();
    assert.deepEqual(result.at(-1).frame, terminal);
  }
  frames = [gap(8, 8, 'resume'), event(9), terminal];
  assert.equal((await read({ bootId, afterSeq: 8 }))[1].frame.seq, 9);
  for (const values of [
    [event(0), event(0)],
    [event(0), event(2)],
    [event(0), event(0, nextBootId)],
    [event(0), gap(2, 3)],
    [event(0), { ...event(1), producer: 'other' }],
    [event(0), { ...event(1), subscriptionId: crypto.randomUUID() }],
    [event(0), { ...transition, nextBootId: undefined }],
    [event(0), { ...terminal, refusal: undefined }],
    [event(0), { ...terminal, retryAfterMs: undefined }],
  ]) {
    frames = [...values, terminal];
    const before = requests;
    await assert.rejects(() => read(), { code: 'invalid-response', delivery: 'unknown' });
    assert.equal(requests, before + 1);
  }
  frames = [event(0)];
  await assert.rejects(() => read(), { code: 'unexpected-eof' });
  console.log(
    JSON.stringify({
      eventSequence: true,
      outcomes: true,
      singleSlotReleased: true,
      noReplay: true,
      runtime,
    }),
  );
} finally {
  client.close();
  await door.close();
}
