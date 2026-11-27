import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { LOCAL_API_VERSION, createWireClient } from '@stitchwire/client';
import { line, openDoor, readJson, runtime } from './_door.mjs';

const responses = [];
let requests = 0;
const door = await openDoor('subscription-lifecycle', async (request, response) => {
  const parsed = await readJson(request);
  assert.equal(parsed.lifecycle, true);
  requests++;
  response.writeHead(200, { 'content-type': 'application/x-ndjson' });
  response.write('\n');
  responses.push(response);
  if (parsed.topic === 'test.timeout') return;
  const frame = { v: LOCAL_API_VERSION, topic: parsed.topic, subscriptionId: crypto.randomUUID() };
  response.write(line({ ...frame, subscriptionState: 'opening', lanes: [] }));
  response.write(line({ ...frame, subscriptionState: 'ready', lanes: ['broker'] }));
});
// The open deadline has to be met by subscriptions that answer at once, also on a loaded host, and
// outlived by a quiet ready subscription below; one second leaves both sides clear.
const OPEN_TIMEOUT_MS = 1_000;
const client = createWireClient({
  socketPath: door.socketPath,
  openTimeoutMs: OPEN_TIMEOUT_MS,
  maxConcurrentRequests: 2,
});
try {
  const timeout = client.subscribe({ topic: 'test.timeout', lifecycle: true });
  await assert.rejects(timeout.next(), { code: 'timeout' });
  const first = client.subscribe({ topic: 'test.quiet', lifecycle: true });
  const second = client.subscribe({ topic: 'test.quiet', lifecycle: true });
  const a = await first.next();
  const b = await second.next();
  assert.equal(a.value.kind, 'subscription');
  assert.equal(a.value.frame.subscriptionState, 'opening');
  assert.notEqual(a.value.frame.subscriptionId, b.value.frame.subscriptionId);
  assert.equal((await first.next()).value.frame.subscriptionState, 'ready');
  assert.equal((await second.next()).value.frame.subscriptionState, 'ready');
  const pending = first.next().catch((error) => error);
  // Quiet for longer than the open deadline: a ready subscription is not under it.
  await sleep(OPEN_TIMEOUT_MS + 250);
  await first.return();
  assert.equal((await pending).code, 'cancelled');
  await second.return();
  assert.equal(requests, 3);
  console.log(
    JSON.stringify({
      quietLifecycle: true,
      headerOnlyTimeout: true,
      isolatedReaders: true,
      cancelled: true,
      runtime,
    }),
  );
} finally {
  client.close();
  for (const response of responses) response.destroy();
  await door.close();
}
