import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceDeclarer } from '../packages/runtime/src/node/service-declarations.ts';

const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 };

/**
 * A service drop-in fails closed, unlike a topic descriptor that keeps its last valid version: what
 * cannot be read grants nothing, so a caller an owner meant to remove loses access in that poll.
 */
test('a damaged edit that drops a caller withdraws the binding and every grant in that same poll', async () => {
  const work = await mkdtemp(join(tmpdir(), 'sw-dropin-damaged-'));
  try {
    const dir = join(work, 'services.d');
    await mkdir(dir, { mode: 0o700 });
    const path = join(dir, 'owner.json');
    const declaration = (callers: string[]) =>
      JSON.stringify({
        binding: {
          service: 'owner.svc',
          descriptorPath: join(work, 'owner.descriptor.json'),
          socketPath: join(work, 'owner.sock'),
          endpointPath: '/wire',
          maxInflight: 4,
          limits,
        },
        callers: callers.map((caller) => ({ caller, scope: { kind: 'service-read' } })),
      });
    await writeFile(path, declaration(['kept', 'revoked']), { mode: 0o600 });
    const sent: string[][] = [];
    let served: string[] = [];
    const declarer = new ServiceDeclarer(
      'worker',
      { bindings: [], grants: [], namespaces: ['owner.'], descriptors: [] },
      (policy) => {
        served = policy.bindings.map((binding) => binding.service);
      },
      60_000,
      dir,
    );
    declarer.attach('primary', {
      connected: true,
      declareServices: async (request) => {
        sent.push(request.grants.map((grant) => grant.caller));
        return { accepted: request.grants.length, refused: [] };
      },
    });
    await declarer.refresh();
    expect(sent.at(-1)).toEqual(['kept', 'revoked']);
    expect(served).toEqual(['owner.svc']);

    // The owner removes `revoked` in place, by hand, and leaves a trailing comma: the file no
    // longer parses. A grant allows a call, so an intent that cannot be read is not kept: the
    // binding and both grants leave in this very poll, and `revoked` is answered `denied`.
    await writeFile(path, declaration(['kept']).replace('}}]', '}},]'));
    await declarer.refresh();
    expect(sent.at(-1)).toEqual([]);
    expect(served).toEqual([]);
    expect(declarer.snapshot().descriptors).toMatchObject([{ path, state: 'invalid', callers: 0 }]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
