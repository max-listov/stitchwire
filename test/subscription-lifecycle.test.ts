import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWireClient } from '../packages/client/src/index.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { budgetBroker, budgetToken, budgetTopic } from './subscription-budget-fixture.ts';
import { freePort, until, waitConnected } from './support.ts';

test('real quiet readers have independent admission, reconnect readiness and cancellation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-quiet-'));
  const port = freePort();
  let broker = await startBroker(budgetBroker(port));
  const socketPath = join(root, 'agent.sock');
  const agent = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'reader',
      agentSocket: socketPath,
      brokers: [{ id: 'test-lane', url: `http://127.0.0.1:${port}`, token: budgetToken }],
      events: { subscribe: [budgetTopic] },
      admission: { maxEventSubscriptions: 2 },
    }),
  );
  using client = createWireClient({ socketPath, openTimeoutMs: 5000 });
  try {
    await waitConnected(agent);
    const first = client.subscribe({ topic: budgetTopic, lifecycle: true });
    const second = client.subscribe({ topic: budgetTopic, lifecycle: true });
    const firstOpening = await first.next();
    expect(firstOpening).toMatchObject({
      value: { kind: 'subscription', frame: { subscriptionState: 'opening', lanes: [] } },
    });
    if (firstOpening.done) throw new Error('missing admission');
    const firstId = firstOpening.value.frame.subscriptionId;
    const ready = {
      value: { kind: 'subscription', frame: { subscriptionState: 'ready', lanes: ['test-lane'] } },
    };
    expect(await first.next()).toMatchObject(ready);
    // A late live reader inherits acknowledged upstream readiness, not a synthetic reconnect.
    const secondReady = await second.next();
    expect(secondReady).toMatchObject(ready);
    if (secondReady.done) throw new Error('missing admission');
    expect(firstId).not.toBe(secondReady.value.frame.subscriptionId);
    const excess = client.subscribe({ topic: budgetTopic, lifecycle: true });
    expect(await excess.next()).toMatchObject({ value: { kind: 'error', frame: { refusal: 'capacity' } } });
    expect((await client.status()).events.activeSubscriptions).toBe(2);
    const lostFirst = first.next();
    const lostSecond = second.next();
    await broker.stop();
    expect(await lostFirst).toMatchObject({
      value: { frame: { subscriptionId: firstId, subscriptionState: 'opening', lanes: [] } },
    });
    expect(await lostSecond).toMatchObject({ value: { frame: { subscriptionState: 'opening' } } });
    broker = await startBroker(budgetBroker(port));
    expect(await first.next()).toMatchObject(ready);
    expect(await second.next()).toMatchObject(ready);
    const pending = first.next().catch((error: unknown) => error);
    await first.return();
    expect(await pending).toMatchObject({ code: 'cancelled' });
    expect(await until(async () => (await client.status()).events.activeSubscriptions === 1)).toBe(true);
    await second.return();
    expect(await until(async () => (await client.status()).events.activeSubscriptions === 0)).toBe(true);
  } finally {
    client.close();
    await agent.stop();
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test('broker policy refusal cannot produce ready and closes an admitted quiet handle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-quiet-denied-'));
  const port = freePort();
  const broker = await startBroker(budgetBroker(port, false));
  const socketPath = join(root, 'agent.sock');
  const agent = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'reader',
      agentSocket: socketPath,
      brokers: [{ id: 'test-lane', url: `http://127.0.0.1:${port}`, token: budgetToken }],
      events: { subscribe: [budgetTopic] },
    }),
  );
  using client = createWireClient({ socketPath });
  try {
    await waitConnected(agent);
    const feed = client.subscribe({ topic: budgetTopic, lifecycle: true });
    const items = [];
    for await (const item of feed) items.push(item);
    expect(items.map((item) => item.kind)).toEqual(['subscription', 'error']);
    expect(items[0]).toMatchObject({ frame: { subscriptionState: 'opening' } });
    expect(items[1]).toMatchObject({ frame: { refusal: 'policy' } });
    expect(await until(async () => (await client.status()).events.activeSubscriptions === 0)).toBe(true);
    const localDenied = client.subscribe({ topic: 'test.undeclared', lifecycle: true });
    expect(await localDenied.next()).toMatchObject({
      value: { kind: 'error', frame: { refusal: 'policy' } },
    });
  } finally {
    client.close();
    await agent.stop();
    await broker.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
