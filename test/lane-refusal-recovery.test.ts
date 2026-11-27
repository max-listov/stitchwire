import { afterAll, expect, test } from 'bun:test';
import type { BrokerHandle } from '../packages/runtime/src/broker/contracts.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { brokerConfig, freePort, until } from './support.ts';

/**
 * A broker that refuses a handshake is not a verdict about the future.
 *
 * One fleet runs one version, so during a rollout the fleet is mixed by construction and a node
 * that upgrades before its broker is refused for exactly that reason — for seconds. On 2026-09-10
 * a lane treated that refusal as final: refused at 11:14:30, its broker ready at 11:14:35, and the
 * lane still dark half an hour later because it had stopped asking.
 *
 * Here the refusal is manufactured with a token the broker does not know, so the FIRST dial is
 * refused for certain; the broker's roster is then made to accept it, and the lane must come back
 * on its own with no restart, no new agent and nobody touching it.
 */

const known = 'k'.repeat(40);
const brokers: BrokerHandle[] = [];
const agents: Agent[] = [];

afterAll(async () => {
  await Promise.all(agents.map((agent) => agent.stop()));
  await Promise.all(brokers.map((broker) => broker.stop()));
});

test('a lane refused at the handshake keeps asking, and returns without a restart', async () => {
  const port = freePort();
  // The roster knows a DIFFERENT digest, so the node's token cannot pass. Nothing about the dial
  // itself is broken: the broker is up, listening, and answering — it looks and says no.
  const config = brokerConfig({ late: 'a-token-the-node-does-not-have' }, { port });
  const broker = await startBroker(config);
  brokers.push(broker);

  const agent = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'late',
      brokers: [
        {
          id: 'only',
          url: `http://127.0.0.1:${port}`,
          token: known,
          // Dial fast so the test measures the behaviour, not the wall clock.
          reconnect: { minDelayMs: 100, maxDelayMs: 200 },
        },
      ],
    }),
  );
  agents.push(agent);

  const refused = await until(async () => {
    const [lane] = (await agent.status()).lanes;
    return lane?.lastFailure?.refused === true;
  }, 5_000);
  expect(refused).toBe(true);

  const before = await agent.status();
  expect(before.lanes[0]?.connected).toBe(false);
  // The refusal is reported as observed, not as a prophecy: the lane is down and still asking.
  expect(before.lanes[0]?.lastFailure?.refused).toBe(true);

  // Now the broker accepts it — exactly what an upgrade does mid-rollout.
  config.nodes[0]?.tokenSha256s.push(sha256(known));

  const recovered = await until(async () => (await agent.status()).lanes[0]?.connected === true, 15_000);
  expect(recovered).toBe(true);

  const after = await agent.status();
  // A healthy lane carries no ghost of the outage it recovered from.
  expect(after.lanes[0]?.lastFailure).toBeNull();
}, 30_000);
