import { expect, test } from 'bun:test';
import {
  ServiceDeclareAckSchema,
  ServiceDeclareSchema,
} from '../packages/contracts/src/service/declaration.ts';
import { ServiceGrantRegistry } from '../packages/runtime/src/service/grant-registry.ts';
import { TopicRegistry } from '../packages/runtime/src/broker/topic-registry.ts';
import { EventDeclareAckSchema, EventDeclareSchema } from '../packages/contracts/src/protocol/topic.ts';

test('every declaration refusal fits its output contract, including aggregate grants and many outside readers', () => {
  const grants = Array.from({ length: 1025 }, (_, index) => ({
    caller: `reader-${index}`,
    target: 'worker',
    service: 'owner.catalog',
    scope: { kind: 'service-read' as const },
  }));
  const request = ServiceDeclareSchema.parse({ target: 'worker', grants });
  const namespaces = Array.from({ length: 16 }, (_, index) => `${`n${index}`.padEnd(126, 'x')}.`);
  const refused = new ServiceGrantRegistry({
    serviceGrants: [],
    serviceNamespaces: { worker: namespaces },
  }).declare('worker', request);
  expect(ServiceDeclareAckSchema.parse(refused).refused).toHaveLength(1025);
  expect(refused.refused.every((entry) => entry.detail.length <= 512)).toBe(true);
  const accepted = new ServiceGrantRegistry({
    serviceGrants: [],
    serviceNamespaces: { worker: ['owner.'] },
  }).declare('worker', request);
  expect(ServiceDeclareAckSchema.parse(accepted)).toEqual({ accepted: 1025, refused: [] });
  const prefix = `${'n'.repeat(120)}.`,
    topic = `${prefix}a`;
  const registry = new TopicRegistry({
    topics: {},
    topicNamespaces: {
      [prefix]: {
        producer: 'worker',
        subscribers: ['allowed'],
        maxTopics: 256,
        maxRetainedBytes: 1024 * 1024,
      },
    },
  });
  const declaration = EventDeclareSchema.parse({
    producer: 'worker',
    topics: {
      [topic]: {
        delivery: 'ordered',
        subscribers: Array.from({ length: 256 }, (_, index) => `outside-${index}`),
      },
    },
  });
  const ack = EventDeclareAckSchema.parse(registry.declare('worker', declaration).ack);
  expect(ack.refused).toHaveLength(1);
  expect(ack.refused[0]?.detail).toContain('256 outside subscriber');
  expect(
    EventDeclareAckSchema.parse(
      registry.declare(
        'worker',
        EventDeclareSchema.parse({
          producer: 'worker',
          topics: { [topic]: { delivery: 'ordered', subscribers: ['allowed'] } },
        }),
      ).ack,
    ).accepted,
  ).toEqual([topic]);
});
