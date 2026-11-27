import { expect, test } from 'bun:test';
import { runExample } from '../examples/service/run.ts';

const notDispatched = { status: 'failure', delivery: 'not-dispatched' };

test('standalone synthetic owner client crosses two-broker transport and denies before dispatch', async () => {
  expect(await runExample()).toEqual({
    example: 'typed-service',
    brokers: 2,
    result: { key: 'example', value: 'synthetic example' },
    caller: 'reader',
    // Only the admitted typed read reached the owner; every refusal stopped before dispatch.
    ownerDispatches: 1,
    refusals: [
      { case: 'wrong revision', ...notDispatched },
      { case: 'undeclared target', ...notDispatched },
      { case: 'undeclared operation', ...notDispatched },
      { case: 'undeclared caller', ...notDispatched },
    ],
  });
});

test('bounded stream example completes and cancels a quiet producer', async () => {
  expect(await runExample('stream')).toEqual({
    example: 'stream',
    brokers: 2,
    boundedBytes: 4096,
    content: 'synthetic line\n',
    refused: false,
    quiet: 'cancelled',
  });
});

test('event example exposes retained data and retention gap and cancels while quiet', async () => {
  expect(await runExample('events')).toEqual({
    example: 'events',
    brokers: 2,
    acknowledged: [true, true, true],
    retainedEvent: true,
    explicitGap: true,
    refused: false,
    quiet: 'cancelled',
    durableResync: 'owner responsibility',
  });
});
