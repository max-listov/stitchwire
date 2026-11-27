import { afterAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { type EventStand, NAMESPACE, startEventStand } from './event-stand.ts';
import { until } from './support.ts';

/**
 * A descriptor its owner has broken is not a descriptor its owner has emptied. The broker keeps
 * routing what the last good version declared, and the node's status says why the current file is
 * not in force; a file that is gone is a different answer and withdraws its topics.
 */

let stand: EventStand | undefined;
afterAll(async () => {
  await stand?.stop();
});

test('an invalid descriptor keeps its last valid topics declared, a missing one withdraws them', async () => {
  // A second descriptor is how this test knows the declarer has acted on the first one's breakage:
  // its edit is only declared by a declarer that went through the broken file's poll before it.
  stand = await startEventStand(['reader'], 1);
  const { producer } = stand;
  const [watched, marker] = stand.descriptors;
  if (watched === undefined || marker === undefined)
    throw new Error('the stand did not create two descriptors');
  const describeMarker = (topics: string[]) =>
    writeFileSync(
      marker,
      JSON.stringify({
        topics: Object.fromEntries(topics.map((name) => [`${NAMESPACE}${name}`, { delivery: 'ordered' }])),
      }),
    );
  const declaredCount = async () => (await producer.status()).events.declarations.lanes[0]?.accepted;
  const reading = async () => (await producer.status()).events.declarations.descriptors[0];
  const publishKept = async () => (await stand?.publish(crypto.randomUUID(), 0))?.ok;
  describeMarker(['marker']);
  expect(await until(async () => (await declaredCount()) === 2)).toBe(true);

  writeFileSync(watched, '{ "topics": ');
  expect(await until(async () => (await reading())?.state === 'invalid')).toBe(true);
  describeMarker(['marker', 'second']);
  // The broker holds the last valid the stand's topic, `marker` and the new `second`; an emptied `watched`
  // would have left it two.
  expect(await until(async () => (await declaredCount()) === 3)).toBe(true);
  expect(await publishKept()).toBe(true);
  expect((await reading())?.detail).toContain('last valid version stays declared');

  rmSync(watched);
  expect(await until(async () => (await declaredCount()) === 2)).toBe(true);
  expect((await reading())?.state).toBe('missing');
  expect(await publishKept()).toBe(false);
}, 60_000);
