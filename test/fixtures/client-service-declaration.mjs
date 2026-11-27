import assert from 'node:assert/strict';
import {
  parseServiceDeclaration,
  SERVICE_DEFAULT_REQUEST_BYTES,
  SERVICE_MAX_DECLARATION_BYTES,
  SERVICE_MAX_DESCRIPTOR_BYTES,
  SERVICE_MAX_INFLIGHT,
  SERVICE_MAX_REQUEST_BYTES,
  SERVICE_MAX_RESPONSE_BYTES,
  SERVICE_MAX_TIMEOUT_MS,
  ServiceBindingSchema,
  ServiceDeclarationSchema,
  ServiceDescriptorSchema,
  ServiceLimitsSchema,
} from '@stitchwire/client';
import { runtime } from './_door.mjs';

// The installed package carries the declaration contract: an owner's tooling validates what it is
// about to write with the function the node agent runs, and needs no copy of the schema.
const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 };
const declaration = (binding = {}, callers = []) => ({
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

for (const schema of [
  ServiceDeclarationSchema,
  ServiceBindingSchema,
  ServiceDescriptorSchema,
  ServiceLimitsSchema,
])
  assert.equal(typeof schema.safeParse, 'function');
assert.equal(SERVICE_MAX_REQUEST_BYTES, 1_048_576);
assert.equal(SERVICE_MAX_RESPONSE_BYTES, 1_048_576);
assert.equal(SERVICE_MAX_TIMEOUT_MS, 30_000);
assert.equal(SERVICE_MAX_INFLIGHT, 32);
assert.equal(SERVICE_MAX_DECLARATION_BYTES, 65_536);
assert.equal(SERVICE_MAX_DESCRIPTOR_BYTES, 262_144);
assert.ok(SERVICE_DEFAULT_REQUEST_BYTES < SERVICE_MAX_REQUEST_BYTES);

const accepted = parseServiceDeclaration(
  declaration({}, [{ caller: 'reader', scope: { kind: 'service-read' } }]),
);
assert.equal(accepted.ok, true);
assert.equal(accepted.value.callers.length, 1);

const root = parseServiceDeclaration(declaration({ endpointPath: '/' }));
assert.equal(root.ok, false);
assert.match(root.detail, /^binding\.endpointPath: Invalid string: must match pattern/);
for (const [binding, field] of [
  [{ endpointPath: '/a//b' }, 'binding.endpointPath'],
  [{ endpointPath: '/a/../b' }, 'binding.endpointPath'],
  [{ socketPath: 'owner.sock' }, 'binding.socketPath'],
  [{ maxInflight: 40 }, 'binding.maxInflight'],
  [{ limits: { ...limits, timeoutMs: 60_000 } }, 'binding.limits.timeoutMs'],
]) {
  const refused = parseServiceDeclaration(declaration(binding));
  assert.equal(refused.ok, false, field);
  assert.ok(refused.detail.startsWith(`${field}:`), refused.detail);
}
const duplicate = { caller: 'reader', scope: { kind: 'service-read' } };
assert.equal(parseServiceDeclaration(declaration({}, [duplicate, duplicate])).ok, false);

console.log(
  JSON.stringify({
    serviceDeclarationExport: true,
    endpointRootRefused: true,
    detail: root.detail,
    runtime,
  }),
);
