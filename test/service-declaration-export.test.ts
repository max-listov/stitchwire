import { describe, expect, test } from 'bun:test';
import {
  parseServiceDeclaration,
  SERVICE_DEFAULT_REQUEST_BYTES,
  SERVICE_MAX_DECLARATION_BYTES,
  SERVICE_MAX_INFLIGHT,
  SERVICE_MAX_REQUEST_BYTES,
  SERVICE_MAX_RESPONSE_BYTES,
  SERVICE_MAX_TIMEOUT_MS,
  ServiceBindingSchema,
  ServiceDeclarationSchema,
  ServiceDescriptorSchema,
  ServiceLimitsSchema,
} from '../packages/client/src/index.ts';
import { catalogDescriptor, catalogOperation, startServiceStand } from './service-stand.ts';
import { CALL_POLL_MS, until } from './support.ts';

/**
 * An owner checks its declaration before writing it with the function the node agent runs on every
 * file it polls, taken from the published client: the same verdict and the same words, with no copy
 * of the contract on the owner's side.
 */

const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 };
const declaration = (binding: Record<string, unknown> = {}, callers: unknown[] = []) => ({
  binding: {
    service: 'owner.catalog',
    descriptorPath: '/run/owner/descriptor.json',
    socketPath: '/run/owner/owner.sock',
    endpointPath: '/wire',
    maxInflight: 4,
    limits,
    ...binding,
  },
  callers,
});
const reader = { caller: 'reader', scope: { kind: 'service-read' } };

describe('the client publishes the declaration contract under the names the runtime uses', () => {
  test('schemas and limits are the runtime ones, not copies', () => {
    for (const exported of [
      ServiceDeclarationSchema,
      ServiceBindingSchema,
      ServiceDescriptorSchema,
      ServiceLimitsSchema,
    ])
      expect(typeof exported.safeParse).toBe('function');
    expect(SERVICE_MAX_REQUEST_BYTES).toBe(1_048_576);
    expect(SERVICE_DEFAULT_REQUEST_BYTES).toBeLessThan(SERVICE_MAX_REQUEST_BYTES);
    expect(SERVICE_MAX_DECLARATION_BYTES).toBe(65_536);
    const over = (field: string, value: number) =>
      ServiceLimitsSchema.safeParse({ ...limits, [field]: value }).success;
    expect(over('requestBytes', SERVICE_MAX_REQUEST_BYTES)).toBe(true);
    expect(over('requestBytes', SERVICE_MAX_REQUEST_BYTES + 1)).toBe(false);
    expect(over('responseBytes', SERVICE_MAX_RESPONSE_BYTES + 1)).toBe(false);
    expect(over('timeoutMs', SERVICE_MAX_TIMEOUT_MS + 1)).toBe(false);
    expect(
      ServiceBindingSchema.safeParse(declaration({ maxInflight: SERVICE_MAX_INFLIGHT }).binding).success,
    ).toBe(true);
    expect(
      ServiceBindingSchema.safeParse(declaration({ maxInflight: SERVICE_MAX_INFLIGHT + 1 }).binding).success,
    ).toBe(false);
  });
});

describe('parseServiceDeclaration gives the verdict the node agent gives', () => {
  test('a declaration with an endpoint of /wire is accepted, with its callers', () => {
    const parsed = parseServiceDeclaration(declaration({}, [reader]));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.callers).toHaveLength(1);
  });
  test('a declaration without callers is accepted with an empty list', () => {
    const { binding } = declaration();
    const parsed = parseServiceDeclaration({ binding });
    expect(parsed.ok && parsed.value.callers).toEqual([]);
  });
  const refused: Array<[string, unknown, string]> = [
    [
      'an endpoint of /',
      declaration({ endpointPath: '/' }),
      'binding.endpointPath: Invalid string: must match pattern',
    ],
    ['an endpoint with an empty segment', declaration({ endpointPath: '/a//b' }), 'binding.endpointPath'],
    ['an endpoint with a parent segment', declaration({ endpointPath: '/a/../b' }), 'binding.endpointPath'],
    ['an endpoint with a trailing slash', declaration({ endpointPath: '/wire/' }), 'binding.endpointPath'],
    ['a relative socket path', declaration({ socketPath: 'owner.sock' }), 'binding.socketPath'],
    ['more in flight than a node serves', declaration({ maxInflight: 40 }), 'binding.maxInflight'],
    [
      'a timeout above the ceiling',
      declaration({ limits: { ...limits, timeoutMs: 60_000 } }),
      'binding.limits.timeoutMs',
    ],
    [
      'a caller name of forty characters',
      declaration({}, [{ ...reader, caller: 'c'.repeat(40) }]),
      'callers.0.caller',
    ],
    ['a repeated caller scope', declaration({}, [reader, reader]), 'callers.1: duplicate caller scope'],
    ['a field the contract does not name', { ...declaration(), extra: 1 }, '(root): Unrecognized key'],
  ];
  test.each(refused)('%s is refused with one line naming the field', (_name, value, expected) => {
    const parsed = parseServiceDeclaration(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.detail).toContain(expected);
  });
  test('an endpoint with a dot inside a segment is accepted, as it is for an operation path', () => {
    expect(parseServiceDeclaration(declaration({ endpointPath: '/a.b' })).ok).toBe(true);
  });
});

describe('a node reading a declaration says what the owner tooling says', () => {
  test('an endpoint of / is invalid with the same detail, and /wire loads and is called', async () => {
    const stand = await startServiceStand();
    try {
      stand.writeDescriptor(catalogDescriptor([catalogOperation('peek', '/catalog/peek', 'read')]));
      stand.writeDeclaration({ endpointPath: '/' });
      const bad = declaration({
        descriptorPath: stand.descriptorPath,
        endpointPath: '/',
        socketPath: `${stand.dir}/owner.sock`,
      });
      const expected = parseServiceDeclaration({ ...bad, callers: [reader] });
      expect(expected.ok).toBe(false);
      const reading = async () => (await stand.server.status()).services.declarations.descriptors[0];
      expect(await until(async () => (await reading())?.state === 'invalid', 12_000, CALL_POLL_MS)).toBe(
        true,
      );
      expect((await reading())?.detail).toBe(expected.ok ? '' : expected.detail);
      expect((await stand.invoke('peek')).status).toBe('failure');
      expect(stand.reached).toEqual([]);

      stand.writeDeclaration({ endpointPath: '/wire' });
      expect(await stand.served('peek')).toBe(true);
      expect(stand.reached.at(-1)).toBe('/wire:peek');
      expect(await reading()).toMatchObject({ state: 'loaded', service: 'owner.catalog', detail: null });
    } finally {
      await stand.stop();
    }
  }, 60_000);
});
