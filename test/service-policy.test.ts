import { expect, test } from 'bun:test';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineContract } from 'stitchkit';
import { z } from 'zod';
import {
  SERVICE_MAX_RESPONSE_BYTES,
  ServiceCallSchema,
  ServiceIngressSchema,
  ServiceRequestPayloadSchema,
  ServiceResponsePayloadSchema,
  ServiceRouteSchema,
} from '../packages/contracts/src/service/contracts.ts';
import { serviceDescriptorFromContract } from '../packages/contracts/src/service/contract-descriptor.ts';
import {
  ServiceBindingSchema,
  ServiceDescriptorSchema,
  ServiceGrantSchema,
  ServiceGrantsSchema,
  ServicePolicySchema,
} from '../packages/contracts/src/service/policy-schema.ts';
import { ServiceDescriptorStore } from '../packages/runtime/src/service/descriptor-store.ts';
import { authorizeServiceRoute, resolveService } from '../packages/runtime/src/service/policy.ts';

const limits = { requestBytes: 1024, responseBytes: 262144, timeoutMs: 2000 };
const descriptor = () =>
  ServiceDescriptorSchema.parse({
    service: 'example.catalog',
    revision: '1',
    maxInflight: 8,
    operations: [
      { id: 'query', path: '/catalog/query', effect: 'read', limits, response: { kind: 'unary' } },
      {
        id: 'request-work',
        path: '/catalog/request-work',
        effect: 'write',
        limits,
        response: { kind: 'unary' },
      },
    ],
  });
const binding = (descriptorPath = '/tmp/example-descriptor.json') =>
  ServiceBindingSchema.parse({
    service: 'example.catalog',
    descriptorPath,
    socketPath: '/tmp/example.sock',
    endpointPath: '/v1/service',
    maxInflight: 5,
    limits: { ...limits, requestBytes: 512, responseBytes: 65536 },
  });
const readGrant = () =>
  ServiceGrantSchema.parse({
    caller: 'reader',
    target: 'worker',
    service: 'example.catalog',
    scope: { kind: 'service-read' },
  });
const actGrant = () =>
  ServiceGrantSchema.parse({
    caller: 'actor',
    target: 'worker',
    service: 'example.catalog',
    scope: { kind: 'operation', operation: 'request-work' },
  });
const policy = () => ServicePolicySchema.parse({ bindings: [binding()], grants: [readGrant(), actGrant()] });
const request = () =>
  ServiceCallSchema.parse({
    to: 'worker',
    service: 'example.catalog',
    revision: '1',
    operation: 'query',
    payload: '{"key":"hello"}',
    timeoutMs: 1000,
  });
const route = () => ServiceRouteSchema.parse({ ...request(), id: crypto.randomUUID(), from: 'reader' });

test('opaque unary replies enforce JSON and UTF-8 byte limits', () => {
  const maximum = JSON.stringify('x'.repeat(SERVICE_MAX_RESPONSE_BYTES - 2));
  expect(ServiceResponsePayloadSchema.parse(maximum)).toBe(maximum);
  for (const payload of [`${maximum} `, '', '{', '{}{}', '\uFEFF{}'])
    expect(ServiceResponsePayloadSchema.safeParse(payload).success).toBe(false);
});

test('generic service requests still require one explicit JSON document', () => {
  expect(ServiceRequestPayloadSchema.parse('{}')).toBe('{}');
  expect(ServiceRequestPayloadSchema.safeParse('').success).toBe(false);
});

test('Stitchkit contract is the single operation catalogue for a Wire descriptor', () => {
  const contract = defineContract(
    { prefix: '/catalog' },
    {
      query: {
        method: 'POST',
        effect: 'read',
        path: '/query',
        desc: 'query',
        input: z.object({ q: z.string() }),
        output: z.object({ ok: z.boolean() }),
        maxJsonBodyBytes: 2048,
        timeout: 1500,
      },
      follow: {
        method: 'POST',
        effect: 'read',
        path: '/follow',
        desc: 'follow',
        input: z.object({}),
        stream: {
          item: z.object({ value: z.string() }),
          lifetimeMs: 5000,
          idleTimeoutSeconds: 2,
        },
      },
    },
  );
  const projected = serviceDescriptorFromContract(contract, {
    service: 'example.catalog',
    revision: '2',
    maxInflight: 3,
    responseBytes: {
      query: 8192,
      follow: 65536,
    },
  });
  expect(projected.operations.map((operation) => operation.id)).toEqual(['query', 'follow']);
  expect(projected.operations[0]).toMatchObject({
    path: '/catalog/query',
    limits: { requestBytes: 2048, timeoutMs: 1500 },
    response: { kind: 'unary' },
  });
  expect(projected.operations[1]?.response).toEqual({
    kind: 'stream',
    lifetimeMs: 5000,
    idleTimeoutMs: 2000,
  });
  const settings = { service: 'example.catalog', revision: '2', maxInflight: 3 };
  const partial = serviceDescriptorFromContract(contract, { ...settings, responseBytes: { query: 8192 } });
  expect(JSON.stringify(partial)).toBe(
    JSON.stringify({
      ...projected,
      operations: projected.operations.map((op) =>
        op.id === 'query' ? op : { ...op, limits: { ...op.limits, responseBytes: 262144 } },
      ),
    }),
  );
  const { effect: _effect, ...unclassified } = contract.endpoints.query;
  expect(() =>
    serviceDescriptorFromContract(defineContract({ prefix: '/catalog' }, { query: unclassified }), settings),
  ).toThrow(/effect/i);
  expect(() =>
    serviceDescriptorFromContract(contract, {
      service: 'example.catalog',
      revision: '2',
      maxInflight: 3,
      responseBytes: { unknown: 8192 } as never,
    }),
  ).toThrow('Unknown responseBytes endpoint');

  const unsupported = defineContract(
    { prefix: '/catalog' },
    {
      query: {
        method: 'GET',
        effect: 'read',
        path: '/query/:id',
        desc: 'query',
        params: z.object({ id: z.string() }),
        output: z.object({ ok: z.boolean() }),
      },
    },
  );
  expect(() =>
    serviceDescriptorFromContract(unsupported, {
      service: 'example.catalog',
      revision: '2',
      maxInflight: 3,
      responseBytes: { query: 8192 },
    }),
  ).toThrow('static JSON route');
});

test('broker admission is coarse and target effect admission is authoritative', () => {
  const readRoute = route();
  expect(authorizeServiceRoute([], readRoute)).toBeNull();
  expect(authorizeServiceRoute([readGrant()], readRoute)).toEqual(readRoute);
  expect(resolveService(policy(), 'worker', readRoute, descriptor()).accepted).toBe(true);

  const readToAct = { ...readRoute, operation: 'request-work' };
  expect(authorizeServiceRoute([readGrant()], readToAct)).not.toBeNull();
  expect(resolveService(policy(), 'worker', readToAct, descriptor())).toEqual({
    accepted: false,
    code: 'denied',
  });

  const exactAct = { ...readToAct, from: 'actor' };
  expect(resolveService(policy(), 'worker', exactAct, descriptor()).accepted).toBe(true);
  expect(
    resolveService({ ...policy(), grants: [actGrant()] }, 'worker', exactAct, descriptor()).accepted,
  ).toBe(true);
});

test('target resolution uses current descriptor revision and minimum budgets', () => {
  const resolved = resolveService(policy(), 'worker', route(), descriptor());
  if (!resolved.accepted) throw new Error('fixture must resolve');
  expect(resolved.limits).toEqual({
    requestBytes: 512,
    responseBytes: 65536,
    timeoutMs: 1000,
    maxInflight: 5,
  });
  expect(ServiceIngressSchema.parse(resolved.ingress)).toMatchObject({
    caller: 'reader',
    operation: 'query',
  });
  expect(resolveService(policy(), 'worker', { ...route(), revision: '2' }, descriptor())).toEqual({
    accepted: false,
    code: 'unsupported',
  });
});

test('descriptor store observes atomic replacement and fails closed without stale fallback', async () => {
  const root = await mkdtemp('/tmp/wire-descriptor-');
  const descriptorPath = join(root, 'service.json');
  const store = new ServiceDescriptorStore();
  const bound = binding(descriptorPath);
  try {
    expect((await store.load(bound)).state).toBe('unavailable');
    await writeFile(descriptorPath, JSON.stringify(descriptor()));
    const first = await store.load(bound);
    expect(first.state).toBe('loaded');
    const next = descriptor();
    next.revision = '2';
    next.operations.push({
      id: 'new-read',
      path: '/catalog/new-read',
      effect: 'read',
      limits,
      response: { kind: 'unary' },
    });
    const temporary = join(root, 'next.json');
    await writeFile(temporary, JSON.stringify(next));
    await rename(temporary, descriptorPath);
    const replaced = await store.load(bound);
    expect(replaced).toMatchObject({ state: 'loaded', descriptor: { revision: '2' } });
    await writeFile(descriptorPath, '{');
    expect(await store.load(bound)).toMatchObject({ state: 'invalid' });
    await writeFile(descriptorPath, JSON.stringify({ ...descriptor(), service: 'other' }));
    expect(await store.load(bound)).toMatchObject({ state: 'invalid' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('configuration rejects duplicate grants, inline descriptors and ambiguous paths', () => {
  expect(ServiceGrantsSchema.safeParse([readGrant(), readGrant()]).success).toBe(false);
  expect(ServiceBindingSchema.safeParse({ ...binding(), descriptor: descriptor() }).success).toBe(false);
  for (const descriptorPath of ['relative.json', '/tmp/../service.json', '/tmp/', '/tmp//service.json'])
    expect(ServiceBindingSchema.safeParse({ ...binding(), descriptorPath }).success).toBe(false);
  expect(
    ServiceGrantSchema.safeParse({
      caller: 'reader',
      target: 'worker',
      service: 'example.catalog',
      scope: { kind: 'operation', operation: '*' },
    }).success,
  ).toBe(false);
});

test('the request limit counts the payload in UTF-8 bytes, not in string units', () => {
  // The binding's 512 bytes are the tighter limit; each é is two bytes and one string unit.
  const call = (letters: number) => ({ ...route(), payload: JSON.stringify('é'.repeat(letters)) });
  expect(resolveService(policy(), 'worker', call(255), descriptor()).accepted).toBe(true);
  expect(resolveService(policy(), 'worker', call(256), descriptor())).toEqual({
    accepted: false,
    code: 'invalid-request',
  });
});

test('stream lifetime is independent of opening timeout and never silently clamped by policy', () => {
  const streamDescriptor = descriptor();
  const operation = streamDescriptor.operations[0];
  if (!operation) throw new Error('missing fixture operation');
  operation.response = { kind: 'stream', lifetimeMs: 30000 };
  const streamPolicy = policy();
  const bound = streamPolicy.bindings[0];
  if (!bound) throw new Error('missing fixture binding');
  bound.limits.timeoutMs = 30000;
  const call = { ...route(), timeoutMs: 30000 };
  expect(resolveService(streamPolicy, 'worker', call, streamDescriptor)).toMatchObject({
    accepted: true,
    limits: { timeoutMs: 30000 },
  });
  bound.limits.timeoutMs = 20000;
  expect(resolveService(streamPolicy, 'worker', call, streamDescriptor)).toEqual({
    accepted: false,
    code: 'invalid-request',
  });
  bound.limits.timeoutMs = 40000;
  expect(resolveService(streamPolicy, 'worker', { ...call, timeoutMs: 30001 }, streamDescriptor)).toEqual({
    accepted: false,
    code: 'invalid-request',
  });
  operation.response = { kind: 'unary' };
  expect(resolveService(streamPolicy, 'worker', call, streamDescriptor).accepted).toBe(false);
});

test('the effect vocabulary is closed, because service-read delegates classification to the owner', () => {
  // `service-read` admits every operation the OWNER marked as reading, without the fleet naming
  // one. That delegation is only sound while both sides spell the word identically, so a
  // descriptor that invents a third word is refused at the boundary rather than routed and
  // silently treated as "not a read".
  const withEffect = (effect: string) => ({
    ...descriptor(),
    operations: [{ id: 'probe', path: '/catalog/probe', effect, limits, response: { kind: 'unary' } }],
  });
  expect(ServiceDescriptorSchema.safeParse(withEffect('read')).success).toBe(true);
  expect(ServiceDescriptorSchema.safeParse(withEffect('write')).success).toBe(true);
  for (const invented of ['act', 'demand', 'mutate', 'Read', '']) {
    const refused = ServiceDescriptorSchema.safeParse(withEffect(invented));
    expect(refused.success).toBe(false);
    if (refused.success) throw new Error('unreachable');
    expect(refused.error.issues.some((issue) => issue.path.join('.').endsWith('effect'))).toBe(true);
  }
});

test('a service-read grant covers reads and never a write, at both the broker and the target', () => {
  const readOnly = ServicePolicySchema.parse({
    bindings: [ServiceBindingSchema.parse(binding())],
    grants: [
      ServiceGrantSchema.parse({
        caller: 'reader',
        target: 'worker',
        service: 'example.catalog',
        scope: { kind: 'service-read' },
      }),
    ],
  });
  const loaded = descriptor();
  const read = { ...route(), operation: 'query' };
  const write = { ...route(), operation: 'request-work' };
  // The broker routes by pair and service; it never receives descriptors, so it cannot and does
  // not judge effect. The target holds the descriptor and is where a write is stopped.
  expect(authorizeServiceRoute(readOnly.grants, read)).not.toBeNull();
  expect(authorizeServiceRoute(readOnly.grants, write)).not.toBeNull();
  expect(resolveService(readOnly, 'worker', read, loaded)).toMatchObject({ accepted: true });
  expect(resolveService(readOnly, 'worker', write, loaded)).toEqual({ accepted: false, code: 'denied' });
});
