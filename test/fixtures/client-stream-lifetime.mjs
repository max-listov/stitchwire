import assert from 'node:assert/strict';
import { LOCAL_API_VERSION, createWireClient } from '@stitchwire/client';
import { line, openDoor, runtime } from './_door.mjs';

const subscriptionId = crypto.randomUUID(),
  bootId = crypto.randomUUID();
const payload = Buffer.alloc(32768, 120).toString('base64');
const offered = 600;
let bytes = 0,
  requests = 0;
const door = await openDoor('stream-lifetime', (_req, response) => {
  requests++;
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  let sent = 0;
  const pump = () => {
    while (!response.destroyed && sent < offered) {
      const frame = line({
        v: LOCAL_API_VERSION,
        subscriptionId,
        topic: 'example.feed',
        producer: 'worker',
        bootId,
        seq: sent++,
        observedAt: null,
        cursor: null,
        encoding: 'base64',
        data: payload,
        bytes: 32768,
      });
      bytes += Buffer.byteLength(frame);
      if (!response.write(frame)) return;
    }
  };
  response.on('drain', pump);
  pump();
});
const client = createWireClient({ socketPath: door.socketPath });
try {
  let received = 0;
  for await (const item of client.subscribe(
    { topic: 'example.feed' },
    { signal: AbortSignal.timeout(10000) },
  )) {
    assert.equal(item.kind, 'event');
    assert.equal(item.frame.seq, received++);
    if (received === offered) break;
  }
  assert.equal(received, offered);
  assert.equal(requests, 1);
  assert.ok(bytes > 16 * 1024 * 1024);
  console.log(
    JSON.stringify({
      runtime,
      received,
      bytes,
      requests,
      lifetimeCap: false,
    }),
  );
} finally {
  client.close();
  await door.close();
}
