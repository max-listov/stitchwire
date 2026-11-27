import type { CapabilityOperation } from '../packages/runtime/src/config/broker.ts';
import { brokerConfig } from './support.ts';

export const budgetTopic = 'test.budget';
export const budgetToken = 'test-only'.padEnd(40, 'x');

export function budgetBroker(port: number, allowed = true) {
  const operations: CapabilityOperation[] = allowed ? ['publish', 'subscribe'] : ['publish'];
  return brokerConfig(
    { reader: budgetToken },
    {
      port,
      capabilities: { reader: operations.map((operation) => ({ operation, targets: ['reader'] })) },
      topics: { [budgetTopic]: { producer: 'reader', subscribers: ['reader'], delivery: 'ordered' } },
    },
  );
}
