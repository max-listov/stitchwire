import { expect, test } from 'bun:test';
import { ServiceDescriptorSchema } from '../packages/contracts/src/service/policy-schema.ts';
import { startDoorStand } from './door-stand.ts';

for (const [opening, lifetime, headersDelay] of [
  [1000, 30000, 0],
  [30000, 1000, 1100],
]) {
  test(`activated stream preserves both opening ${opening} and lifetime ${lifetime} through SDK/broker/agent/owner`, async () => {
    if (opening === undefined || lifetime === undefined || headersDelay === undefined)
      throw new Error('invalid control');
    const descriptor = ServiceDescriptorSchema.parse({
      service: 'example.feed',
      revision: '1',
      maxInflight: 1,
      operations: [
        {
          id: 'follow',
          path: '/follow',
          effect: 'read',
          limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: opening },
          response: { kind: 'stream', lifetimeMs: lifetime },
        },
      ],
    });
    let reached = 0;
    const stand = await startDoorStand({
      descriptor,
      activatePolicy: true,
      owner: async () => {
        reached++;
        await Bun.sleep(headersDelay);
        return new Response('ready\n', { headers: { 'content-type': 'application/x-ndjson' } });
      },
    });
    try {
      expect(stand.policy.namespaces).toEqual(['retained.']);
      expect(stand.policy.descriptors[0]?.endsWith('/retained-declaration.json')).toBe(true);
      expect(stand.policy.bindings[0]?.limits.timeoutMs).toBe(Math.max(opening, lifetime));
      const response = await stand.post('/follow');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('ready\n');
      expect(reached).toBe(1);
      const refused = stand.wire.stream({
        to: 'worker',
        source: {
          kind: 'service',
          service: descriptor.service,
          revision: '1',
          operation: 'follow',
          payload: '{}',
        },
        timeoutMs: Math.max(opening, lifetime) + 10000,
      });
      const terminal = await refused.next();
      expect(terminal.value).toMatchObject({ kind: 'error', frame: { refusal: 'request' } });
      await refused.return?.();
      expect(reached).toBe(1);
    } finally {
      await stand.stop();
    }
  }, 10000);
}
