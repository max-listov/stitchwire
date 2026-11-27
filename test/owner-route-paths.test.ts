import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PolledJsonFile } from 'stitchkit/files';
import { createServiceFetch, createServiceIngress, createWireClient } from '../packages/client/src/index.ts';
import { SERVICE_MAX_DESCRIPTOR_BYTES } from '../packages/contracts/src/service/contracts.ts';
import { OwnerRoutePathSchema } from '../packages/contracts/src/service/owner-route-path.ts';
import {
  ServiceBindingSchema,
  ServiceDescriptorSchema,
} from '../packages/contracts/src/service/policy-schema.ts';
import { anyJson, MAX_CONFIG_FILE_BYTES } from '../packages/runtime/src/config/io.ts';
import { ServiceDescriptorStore } from '../packages/runtime/src/service/descriptor-store.ts';
import { catalogDescriptor, catalogOperation, startServiceStand } from './service-stand.ts';
import { CALL_POLL_MS, until } from './support.ts';

/**
 * A route path crosses a URL parser on its way to the owner, which resolves `.` and `..` segments:
 * a read operation spelled `/catalog/x/../erase` would run the owner's write route `/catalog/erase`.
 * One schema judges the path of an operation and the endpoint of a binding.
 */

const accepted = ['/wire', '/a/b-c_d', '/a.b', '/v1.2/x', '/a/.hidden', '/a/b..c', '/a/...'];
const refused = [
  '/',
  '/wire/',
  '/a//b',
  '/a/./b',
  '/a/../b',
  '/..',
  '/a/..',
  '/.',
  'wire',
  '/a b',
  '/a%2e%2e/b',
  '',
];

const limits = { requestBytes: 1024, responseBytes: 1024, timeoutMs: 1000 };
const binding = (endpointPath: string) => ({
  service: 'owner.catalog',
  descriptorPath: '/run/owner/descriptor.json',
  socketPath: '/run/owner/owner.sock',
  endpointPath,
  maxInflight: 1,
  limits,
});
const descriptor = (path: string) => catalogDescriptor([catalogOperation('peek', path, 'read')]);

describe('one rule judges every owner route path', () => {
  test.each(accepted)('%s is accepted as an operation path and as an endpoint', (path) => {
    expect(OwnerRoutePathSchema.safeParse(path).success).toBe(true);
    expect(ServiceDescriptorSchema.safeParse(descriptor(path)).success).toBe(true);
    expect(ServiceBindingSchema.safeParse(binding(path)).success).toBe(true);
  });
  test.each(refused)('%p is refused as an operation path and as an endpoint', (path) => {
    expect(OwnerRoutePathSchema.safeParse(path).success).toBe(false);
    expect(ServiceDescriptorSchema.safeParse(descriptor(path)).success).toBe(false);
    expect(ServiceBindingSchema.safeParse(binding(path)).success).toBe(false);
  });
  test('the one length bound holds for both', () => {
    const longest = `/${'a'.repeat(511)}`;
    expect(ServiceBindingSchema.safeParse(binding(longest)).success).toBe(true);
    expect(ServiceBindingSchema.safeParse(binding(`${longest}a`)).success).toBe(false);
  });
});

describe('a client builds nothing from a descriptor that would hide a write route', () => {
  const hidden = catalogDescriptor([
    catalogOperation('peek', '/catalog/x/../erase', 'read'),
    catalogOperation('erase', '/catalog/erase', 'write'),
  ]);
  test('the owner door and the caller fetch both refuse it', () => {
    expect(() => createServiceIngress({ descriptor: hidden, handler: () => new Response() })).toThrow();
    expect(() =>
      createServiceFetch(createWireClient({ socketPath: '/nonexistent/wire.sock' }), {
        to: 'worker',
        baseUrl: 'https://owner.invalid',
        descriptor: hidden,
      }),
    ).toThrow();
  });
});

describe('a node does not route through a descriptor that hides a write route', () => {
  test('the read never reaches the owner, and the same stand serves once the path is honest', async () => {
    const stand = await startServiceStand();
    try {
      stand.writeDescriptor(
        catalogDescriptor([
          catalogOperation('peek', '/catalog/x/../erase', 'read'),
          catalogOperation('erase', '/catalog/erase', 'write'),
        ]),
      );
      stand.writeDeclaration();
      // The grant is in place once the broker stops answering `denied`; the descriptor then refuses.
      let outcome = await stand.invoke('peek');
      const declared = async () => {
        outcome = await stand.invoke('peek');
        return outcome.status === 'failure' && outcome.code !== 'denied';
      };
      expect(await until(declared, 12_000, CALL_POLL_MS)).toBe(true);
      expect(outcome).toMatchObject({ status: 'failure', code: 'invalid-response' });
      expect(stand.reached).toEqual([]);

      stand.writeDescriptor(
        catalogDescriptor([
          catalogOperation('peek', '/catalog/peek', 'read'),
          catalogOperation('erase', '/catalog/erase', 'write'),
        ]),
      );
      expect(await stand.served('peek')).toBe(true);
      expect(stand.reached.at(-1)).toBe('/invoke:peek');
    } finally {
      await stand.stop();
    }
  }, 60_000);
});

describe('a descriptor file is bounded and must be a regular file', () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-descriptor-file-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const bindingFor = (descriptorPath: string) =>
    ServiceBindingSchema.parse({ ...binding('/invoke'), descriptorPath });
  const valid = JSON.stringify(descriptor('/catalog/peek'));
  const store = new ServiceDescriptorStore();

  test('a valid descriptor loads, so the refusals below are about the file and not the content', async () => {
    const path = join(root, 'valid.json');
    writeFileSync(path, valid);
    expect((await store.load(bindingFor(path))).state).toBe('loaded');
  });
  test('a file above the limit is refused with its size, though its JSON is valid', async () => {
    const path = join(root, 'large.json');
    writeFileSync(path, valid + ' '.repeat(SERVICE_MAX_DESCRIPTOR_BYTES));
    const loaded = await store.load(bindingFor(path));
    expect(loaded.state).toBe('invalid');
    if (loaded.state === 'loaded') throw new Error('an oversized descriptor was loaded');
    expect(loaded.detail).toContain(`exceeds ${SERVICE_MAX_DESCRIPTOR_BYTES}-byte limit`);
  });
  test('a directory at the descriptor path is refused as not a regular file', async () => {
    const path = join(root, 'directory.json');
    mkdirSync(path);
    const loaded = await store.load(bindingFor(path));
    expect(loaded).toMatchObject({
      state: 'invalid',
      detail: expect.stringContaining('Not a regular file'),
    });
  });
  test('bytes that are not UTF-8 are refused, not decoded with replacements', async () => {
    const path = join(root, 'latin1.json');
    writeFileSync(path, Buffer.concat([Buffer.from('{"service":"'), Buffer.from([0xff]), Buffer.from('"}')]));
    const loaded = await store.load(bindingFor(path));
    expect(loaded.state).toBe('invalid');
    if (loaded.state === 'loaded') throw new Error('a non-UTF-8 descriptor was loaded');
    // The refusal names the bytes and keeps what the decoder said.
    expect(loaded.detail).toContain('descriptor Not strict UTF-8: ');
    expect(loaded.detail).toContain('utf-8');
  });
});

describe('a polled declaration file is read as strict UTF-8', () => {
  test('a stray byte is refused even where the lossy decoding would still be JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'wire-strict-utf8-'));
    try {
      const path = join(root, 'declaration.json');
      writeFileSync(path, Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]));
      expect(new PolledJsonFile(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES }).read()).toMatchObject({
        state: 'invalid',
        reason: 'encoding',
        detail: expect.stringContaining('Not strict UTF-8'),
      });
      writeFileSync(path, '{"note":"é"}');
      expect(new PolledJsonFile(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES }).read()).toMatchObject({
        state: 'read',
        value: { note: 'é' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
