import { afterAll, expect, mock, test } from 'bun:test';
import * as application from 'stitchkit/application';
import { z } from 'zod';
import { brokerConfig, freePort } from './support.ts';

/** Only what this test reads of the answer, every resource key kept. */
const WrittenResourcesSchema = z.object({
  application: z.object({ resources: z.record(z.string(), z.number()) }),
});

/**
 * A framework release may add a field to the projection of its lifecycle verdict. The broker's
 * `/health` and the agent's `/status` are strict writers, so a field that reached them would fail
 * every answer. Here the framework's projection carries one more resource field than this release
 * knows, and a real broker answers `/health` through its own output validation.
 */
const framework = { ...application };
mock.module('stitchkit/application', () => ({
  ...framework,
  projectApplicationStatus: (snapshot: Parameters<typeof framework.projectApplicationStatus>[0]) => {
    const status = framework.projectApplicationStatus(snapshot);
    return { ...status, resources: { ...status.resources, addedByFramework: 1 } };
  },
}));
afterAll(() => {
  mock.module('stitchkit/application', () => framework);
});

test('a resource field the framework adds does not fail the broker /health answer', async () => {
  const { startBroker } = await import('../packages/runtime/src/broker/runtime.ts');
  const port = freePort();
  const broker = await startBroker(brokerConfig({ worker: 'worker-secret-token-resources' }, { port }));
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    const { application: written } = WrittenResourcesSchema.parse(await response.json());
    expect(Object.keys(written.resources).sort()).toEqual(['degraded', 'failed', 'ready', 'total']);
  } finally {
    await broker.stop();
  }
});
