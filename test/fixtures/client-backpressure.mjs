import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { LOCAL_API_VERSION, createWireClient } from '@stitchwire/client';
import { line, openDoor, runtime } from './_door.mjs';

const id = crypto.randomUUID();
const payload = Buffer.alloc(32768, 120).toString('base64');
let written = 0;
let stopped = false;
const door = await openDoor('backpressure', (_request, response) => {
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const pump = () => {
    while (!stopped && written < 512) {
      const frame = {
        v: LOCAL_API_VERSION,
        streamId: id,
        from: 'worker',
        seq: written++,
        channel: 'stdout',
        encoding: 'base64',
        data: payload,
        bytes: 32768,
        cursor: null,
      };
      if (!response.write(line(frame))) return;
    }
  };
  response.on('drain', pump);
  pump();
});
const client = createWireClient({ socketPath: door.socketPath });
const before = process.memoryUsage().rss;
try {
  const feed = client.stream({ to: 'worker', profile: 'logs' });
  assert.equal((await feed.next()).value.kind, 'chunk');
  await delay(100);
  const at100 = written;
  await delay(100);
  console.log(
    JSON.stringify({
      runtime,
      version: process.versions.bun ?? process.versions.node,
      packed: true,
      chunkBytes: 32768,
      offered: 512,
      writtenAt100ms: at100,
      writtenAt200ms: written,
      rssBefore: before,
      rssAfter: process.memoryUsage().rss,
      bounded: written < 512,
    }),
  );
  stopped = true;
  await feed.return();
  if (written === 512) process.exitCode = 1;
} finally {
  stopped = true;
  client.close();
  await door.close();
}
