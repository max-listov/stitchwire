import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EventDeclare } from '../packages/contracts/src/protocol/topic.ts';
import type { ServiceDeclare } from '../packages/contracts/src/service/declaration.ts';
import { ServiceDeclarer } from '../packages/runtime/src/node/service-declarations.ts';
import { TopicDeclarer } from '../packages/runtime/src/node/topic-declarations.ts';
import { settle, until } from './support.ts';

/**
 * A declaration a broker never answered is put to it again on a later poll, as the fleet bundle
 * question is; it does not stay unanswered until the lane next reconnects. An answer that arrives
 * ends the asking, and no second question goes out beside one still open.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-declaration-retry-'));
const POLL_MS = 100;
const declarers: Array<{ stop(): void }> = [];
afterAll(() => {
  for (const declarer of declarers) declarer.stop();
  rmSync(root, { recursive: true, force: true });
});

/** Answers the third question and not the first two, and counts how many it was ever asked at once. */
function broker(answerAfterMs = 0) {
  const asked: number[] = [];
  let open = 0;
  let overlapped = false;
  const answer = async <T>(done: () => T): Promise<T | null> => {
    asked.push(Date.now());
    if (++open > 1) overlapped = true;
    await Bun.sleep(answerAfterMs);
    open -= 1;
    return asked.length < 3 ? null : done();
  };
  return { asked, answer, overlapped: () => overlapped };
}

test('an unanswered topic declaration is asked again until the broker answers, and the answer reaches the status', async () => {
  const path = join(root, 'topics.json');
  writeFileSync(path, JSON.stringify({ topics: { 'example.data': { delivery: 'ordered' } } }));
  const lane = broker();
  const topics = new TopicDeclarer(
    'worker',
    { descriptors: [path], namespaces: { publish: ['example.'] } },
    POLL_MS,
  );
  declarers.push(topics);
  topics.attach('lane', {
    connected: true,
    declareTopics: (request: EventDeclare) =>
      lane.answer(() => ({ accepted: Object.keys(request.topics), refused: [] })),
  });
  topics.start();
  expect(await until(() => topics.snapshot().lanes.length === 1)).toBe(true);
  expect(topics.snapshot().lanes[0]).toMatchObject({ lane: 'lane', accepted: 1 });
  expect(lane.asked).toHaveLength(3);
  // Once answered it is left alone: no lane owes an answer, so the next poll has nobody to ask,
  // while the bound file is still watched.
  expect([topics.owing, topics.polling]).toEqual([[], true]);
}, 30_000);

test('an unanswered service declaration is asked again, one question at a time', async () => {
  const path = join(root, 'service.json');
  writeFileSync(
    path,
    JSON.stringify({
      binding: {
        service: 'example.data',
        descriptorPath: join(root, 'descriptor.json'),
        socketPath: join(root, 'service.sock'),
        endpointPath: '/invoke',
        maxInflight: 4,
        limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 },
      },
      callers: [{ caller: 'reader', scope: { kind: 'service-read' } }],
    }),
  );
  // Each answer takes longer than a poll, so every poll lands while a question is open.
  const lane = broker(3 * POLL_MS);
  const services = new ServiceDeclarer(
    'worker',
    { bindings: [], grants: [], namespaces: ['example.'], descriptors: [path] },
    () => {},
    POLL_MS,
  );
  declarers.push(services);
  services.attach('lane', {
    connected: true,
    declareServices: (request: ServiceDeclare) =>
      lane.answer(() => ({ accepted: request.grants.length, refused: [] })),
  });
  services.start();
  expect(await until(() => services.snapshot().lanes.length === 1)).toBe(true);
  expect(services.snapshot().lanes[0]).toMatchObject({ lane: 'lane', accepted: 1 });
  expect(lane.asked).toHaveLength(3);
  expect(lane.overlapped()).toBe(false);
}, 30_000);

test('a late answer to an older declaration does not replace the answer to a newer one', async () => {
  const path = join(root, 'changing-topics.json');
  const write = (topics: string[]) =>
    writeFileSync(
      path,
      JSON.stringify({ topics: Object.fromEntries(topics.map((topic) => [topic, { delivery: 'ordered' }])) }),
    );
  write(['example.first']);
  const topics = new TopicDeclarer(
    'worker',
    { descriptors: [path], namespaces: { publish: ['example.'] } },
    POLL_MS,
  );
  declarers.push(topics);
  let asked = 0;
  const releaseFirst = Promise.withResolvers<void>();
  let firstReturned = false;
  topics.attach('lane', {
    connected: true,
    declareTopics: async (request: EventDeclare) => {
      // The first question is held until the second one, which follows the file's edit, was answered.
      if (++asked === 1) {
        await releaseFirst.promise;
        firstReturned = true;
      }
      return { accepted: Object.keys(request.topics), refused: [] };
    },
  });
  topics.start();
  expect(await until(() => asked === 1)).toBe(true);
  write(['example.first', 'example.second']);
  expect(await until(() => topics.snapshot().lanes[0]?.accepted === 2)).toBe(true);
  // The older answer arrives now and leaves the newer one in place.
  releaseFirst.resolve();
  expect(await until(() => firstReturned)).toBe(true);
  await settle();
  expect(topics.snapshot().lanes[0]).toMatchObject({ lane: 'lane', accepted: 2 });
}, 30_000);

test('a late answer to an older declaration does not end the retry of a newer one nobody answered', async () => {
  const path = join(root, 'unanswered-newer-topics.json');
  const write = (topics: string[]) =>
    writeFileSync(
      path,
      JSON.stringify({ topics: Object.fromEntries(topics.map((topic) => [topic, { delivery: 'ordered' }])) }),
    );
  write(['example.first']);
  const topics = new TopicDeclarer(
    'worker',
    { descriptors: [path], namespaces: { publish: ['example.'] } },
    POLL_MS,
  );
  declarers.push(topics);
  let asked = 0;
  const releaseFirst = Promise.withResolvers<void>();
  topics.attach('lane', {
    connected: true,
    declareTopics: async (request: EventDeclare) => {
      const question = ++asked;
      // The first answer is held until the second question was put and is left unanswered: it says
      // nothing about the second, which must still be asked again.
      if (question === 1) await releaseFirst.promise;
      if (question === 2) return null;
      return { accepted: Object.keys(request.topics), refused: [] };
    },
  });
  topics.start();
  expect(await until(() => asked === 1)).toBe(true);
  write(['example.first', 'example.second']);
  expect(await until(() => asked === 2)).toBe(true);
  releaseFirst.resolve();
  expect(await until(() => asked >= 3)).toBe(true);
  expect(await until(() => topics.snapshot().lanes[0]?.accepted === 2)).toBe(true);
}, 30_000);

test('empty startup withdraws the last bindings, retries a lost ack without reconnect and then stops polling', async () => {
  const topics = new TopicDeclarer('worker', { descriptors: [], namespaces: { publish: [] } }, POLL_MS);
  declarers.push(topics);
  let sends = 0;
  topics.attach('lane', {
    connected: true,
    async declareTopics(request) {
      expect(request.topics).toEqual({});
      return ++sends === 1 ? null : { accepted: [], refused: [] };
    },
  });
  topics.start();
  expect(await until(() => topics.snapshot().lanes[0]?.accepted === 0)).toBe(true);
  expect(sends).toBe(2);
  // Nothing is bound and nothing is owed: no poll is scheduled any more.
  expect([topics.owing, topics.polling]).toEqual([[], false]);
  const services = new ServiceDeclarer(
    'worker',
    { bindings: [], grants: [], namespaces: [], descriptors: [] },
    () => {},
    POLL_MS,
  );
  declarers.push(services);
  services.attach('lane', {
    connected: true,
    async declareServices(request) {
      expect(request.grants).toEqual([]);
      return { accepted: 0, refused: [] };
    },
  });
  services.start();
  expect(await until(() => services.snapshot().lanes[0]?.accepted === 0)).toBe(true);
});

test('a positive old acknowledgement disappears while the changed declaration awaits its own answer', async () => {
  const path = join(root, 'current-ack.json');
  writeFileSync(path, JSON.stringify({ topics: { 'example.first': { delivery: 'ordered' } } }));
  const topics = new TopicDeclarer(
    'worker',
    { descriptors: [path], namespaces: { publish: ['example.'] } },
    POLL_MS,
  );
  declarers.push(topics);
  const release = Promise.withResolvers<void>();
  let sends = 0;
  topics.attach('lane', {
    connected: true,
    async declareTopics(request) {
      if (++sends === 2) await release.promise;
      return { accepted: Object.keys(request.topics), refused: [] };
    },
  });
  await topics.refresh();
  expect(topics.snapshot().lanes[0]?.accepted).toBe(1);
  writeFileSync(path, JSON.stringify({ topics: {} }));
  const pending = topics.refresh();
  expect(await until(() => sends === 2)).toBe(true);
  expect(topics.snapshot().lanes).toEqual([]);
  release.resolve();
  await pending;
  expect(topics.snapshot().lanes[0]?.accepted).toBe(0);
});
