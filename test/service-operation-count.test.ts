import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineContract, type EndpointDef } from 'stitchkit';
import { z } from 'zod';
import {
  createServiceIngress,
  parseServiceDeclaration,
  SERVICE_MAX_DESCRIPTOR_BYTES,
  ServiceBindingSchema,
  serviceDescriptorFromContract,
} from '../packages/client/src/index.ts';
import { ServiceDescriptorStore } from '../packages/runtime/src/service/descriptor-store.ts';
import { catalogDescriptor, catalogOperation, startServiceStand } from './service-stand.ts';
import { CALL_POLL_MS, until } from './support.ts';

/**
 * How many operations a service has is the owner contract's decision. The descriptor file's byte
 * limit bounds what a node reads; no count stands in front of it, so a contract that grows past a
 * round number is not refused whole by the client that projects it or by the node that serves it.
 */

const OPERATIONS = 300;
/** Even operations read, odd ones write, so the declaration below grants each write on its own. */
const effectOf = (index: number) => (index % 2 === 0 ? 'read' : 'write');
const endpoint = (index: number): EndpointDef => ({
  method: 'POST',
  effect: effectOf(index),
  path: `/op-${index}`,
  desc: `operation ${index}`,
  input: z.strictObject({}),
  output: z.strictObject({ served: z.string() }),
  maxJsonBodyBytes: 1024,
  timeout: 3000,
});
const names = Array.from({ length: OPERATIONS }, (_, index) => `op-${index}`);
const contract = defineContract(
  { prefix: '/catalog' },
  Object.fromEntries(names.map((name, index) => [name, endpoint(index)])),
);
const descriptor = serviceDescriptorFromContract(contract, {
  service: 'owner.catalog',
  revision: '1',
  maxInflight: 4,
  responseBytes: Object.fromEntries(names.map((name) => [name, 4096])),
});
const writes = names.filter((_, index) => effectOf(index) === 'write');
/** One caller holding every write one by one, as an owner's installer writes it: one entry per operation. */
const callers = [
  { caller: 'reader', scope: { kind: 'service-read' } },
  ...writes.map((operation) => ({ caller: 'reader', scope: { kind: 'operation', operation } })),
];

describe('a client projects and serves a contract of any size', () => {
  test('every operation of the contract is in the descriptor, and the owner door accepts it', () => {
    expect(descriptor.operations).toHaveLength(OPERATIONS);
    expect(JSON.stringify(descriptor).length).toBeLessThan(SERVICE_MAX_DESCRIPTOR_BYTES);
    expect(() => createServiceIngress({ descriptor, handler: () => new Response() })).not.toThrow();
  });
  test('a declaration naming the caller once per write operation is valid', () => {
    const declaration = parseServiceDeclaration({
      binding: {
        service: 'owner.catalog',
        descriptorPath: '/run/owner/descriptor.json',
        socketPath: '/run/owner/owner.sock',
        endpointPath: '/invoke',
        maxInflight: 4,
        limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 3000 },
      },
      callers,
    });
    expect(declaration).toMatchObject({ ok: true });
    expect(callers.length).toBe(1 + OPERATIONS / 2);
  });
});

describe('a node serves every operation of a large descriptor through the broker', () => {
  test('the last read and the last write reach the owner under their declared scopes', async () => {
    const stand = await startServiceStand();
    try {
      stand.writeDescriptor(descriptor);
      stand.writeDeclaration({}, callers);
      const lastRead = names.at(-2) ?? '';
      const lastWrite = names.at(-1) ?? '';
      expect(await stand.served(lastRead)).toBe(true);
      expect(stand.reached.at(-1)).toBe(`/invoke:${lastRead}`);
      // The write grant travels in the same declaration; it is in force once the call is answered.
      expect(
        await until(async () => (await stand.invoke(lastWrite)).status === 'response', 12_000, CALL_POLL_MS),
      ).toBe(true);
      expect(stand.reached.at(-1)).toBe(`/invoke:${lastWrite}`);
    } finally {
      await stand.stop();
    }
  }, 60_000);
});

describe('the byte limit still bounds a descriptor made only of real operations', () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-operation-count-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  test('a descriptor whose operations pass the limit is refused with its size', async () => {
    const operation = (index: number) =>
      catalogOperation(`op-${index}`, `/catalog/${'segment-'.repeat(40)}${index}`, 'read');
    const large = catalogDescriptor(Array.from({ length: 1000 }, (_, index) => operation(index)));
    const text = JSON.stringify(large);
    expect(text.length).toBeGreaterThan(SERVICE_MAX_DESCRIPTOR_BYTES);
    const path = join(root, 'large.json');
    writeFileSync(path, text);
    const store = new ServiceDescriptorStore();
    const loaded = await store.load(
      ServiceBindingSchema.parse({
        service: 'owner.catalog',
        descriptorPath: path,
        socketPath: join(root, 'owner.sock'),
        endpointPath: '/invoke',
        maxInflight: 1,
        limits: { requestBytes: 1024, responseBytes: 1024, timeoutMs: 1000 },
      }),
    );
    expect(loaded.state).toBe('invalid');
    if (loaded.state === 'loaded') throw new Error('an oversized descriptor was loaded');
    expect(loaded.detail).toContain(`exceeds ${SERVICE_MAX_DESCRIPTOR_BYTES}-byte limit`);
  });
});
