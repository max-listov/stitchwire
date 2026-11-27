import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_MAX_DESCRIPTOR_BYTES } from '../packages/contracts/src/service/contracts.ts';
import { ServiceBindingSchema } from '../packages/contracts/src/service/policy-schema.ts';
import { ServiceDescriptorStore } from '../packages/runtime/src/service/descriptor-store.ts';
import { catalogDescriptor, catalogOperation } from './service-stand.ts';

/**
 * The descriptor store opens the path once and judges and reads through that one handle: a path
 * that is not a regular file is refused before a byte is read, and a regular file is read no
 * further than one byte past the limit.
 */
describe('a descriptor is read through one handle', () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-descriptor-handle-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const bindingFor = (descriptorPath: string) =>
    ServiceBindingSchema.parse({
      service: 'owner.catalog',
      descriptorPath,
      socketPath: '/run/owner/owner.sock',
      endpointPath: '/invoke',
      maxInflight: 1,
      limits: { requestBytes: 1024, responseBytes: 1024, timeoutMs: 1000 },
    });
  const valid = JSON.stringify(catalogDescriptor([catalogOperation('peek', '/catalog/peek', 'read')]));
  const store = new ServiceDescriptorStore();

  test('a regular file loads', async () => {
    const path = join(root, 'regular.json');
    writeFileSync(path, valid);
    expect((await store.load(bindingFor(path))).state).toBe('loaded');
  });
  test('a file of exactly the limit loads, one byte more is refused', async () => {
    const exact = join(root, 'exact.json');
    writeFileSync(exact, valid + ' '.repeat(SERVICE_MAX_DESCRIPTOR_BYTES - valid.length));
    expect((await store.load(bindingFor(exact))).state).toBe('loaded');
    const over = join(root, 'over.json');
    writeFileSync(over, valid + ' '.repeat(SERVICE_MAX_DESCRIPTOR_BYTES - valid.length + 1));
    const loaded = await store.load(bindingFor(over));
    expect(loaded.state).toBe('invalid');
    if (loaded.state === 'loaded') throw new Error('an oversized descriptor was loaded');
    expect(loaded.detail).toContain(`exceeds ${SERVICE_MAX_DESCRIPTOR_BYTES}-byte limit`);
  });
  test('a directory is refused as not a regular file', async () => {
    const path = join(root, 'directory.json');
    mkdirSync(path);
    expect(await store.load(bindingFor(path))).toMatchObject({
      state: 'invalid',
      detail: expect.stringContaining('Not a regular file'),
    });
  });
  test('a FIFO with no writer is refused at once instead of waiting for one', async () => {
    const path = join(root, 'fifo.json');
    expect(Bun.spawnSync(['mkfifo', path]).exitCode).toBe(0);
    expect(await store.load(bindingFor(path))).toMatchObject({
      state: 'invalid',
      detail: expect.stringContaining('Not a regular file'),
    });
  });
  test('a missing path is unavailable, not invalid', async () => {
    expect((await store.load(bindingFor(join(root, 'absent.json')))).state).toBe('unavailable');
  });
});
