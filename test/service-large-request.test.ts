import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { defineContract } from 'stitchkit';
import { z } from 'zod';
import { createServiceFetch, createWireClient } from '../packages/client/src/index.ts';
import { bindUnixSocket } from 'stitchkit/files';
import {
  ServiceIngressSchema,
  ServiceRequestPayloadSchema,
} from '../packages/contracts/src/service/contracts.ts';
import { serviceDescriptorFromContract } from '../packages/contracts/src/service/contract-descriptor.ts';
import { type ServiceGrant, ServicePolicySchema } from '../packages/contracts/src/service/policy-schema.ts';
import { jsonEnvelopeBytes } from '../packages/contracts/src/protocol/json-bounds.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { ServiceExecutor } from '../packages/runtime/src/service/executor.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';

const InputSchema = z.strictObject({ text: z.string() });
const OutputSchema = z.strictObject({ digest: z.string() });
const contract = defineContract(
  { prefix: 'documents' },
  {
    write: {
      method: 'POST',
      effect: 'read',
      path: '/write',
      desc: 'Bounded document',
      input: InputSchema,
      output: OutputSchema,
      maxJsonBodyBytes: 1048576,
    },
    follow: {
      method: 'POST',
      effect: 'read',
      path: '/follow',
      desc: 'Bounded document stream',
      input: InputSchema,
      maxJsonBodyBytes: 1048576,
      stream: { item: OutputSchema, lifetimeMs: 30000 },
    },
    small: {
      method: 'POST',
      effect: 'read',
      path: '/small',
      desc: 'Implicit small document',
      input: InputSchema,
      output: OutputSchema,
    },
  },
);
const descriptor = serviceDescriptorFromContract(contract, {
  service: 'example.documents',
  revision: '1',
  maxInflight: 2,
  responseBytes: {
    write: 4096,
    follow: 4096,
    small: 4096,
  },
});

test('explicit document budgets keep the implicit default and UTF-8 ceiling', () => {
  expect(descriptor.operations.find((op) => op.id === 'small')?.limits.requestBytes).toBe(65536);
  expect(ServiceRequestPayloadSchema.safeParse(`"${'a'.repeat(1048574)}"`).success).toBe(true);
  expect(ServiceRequestPayloadSchema.safeParse(`"${'a'.repeat(1048575)}"`).success).toBe(false);
  expect(ServiceRequestPayloadSchema.safeParse(`"${'я'.repeat(524288)}"`).success).toBe(false);
  for (const text of ['\t', '\r', '\n', '"', '\\', '\u0000', 'я', '😀']) {
    const payload = JSON.stringify({ text: text.repeat(50000) });
    const envelope = {
      v: 1,
      id: crypto.randomUUID(),
      caller: 'a'.repeat(32),
      service: 's'.repeat(128),
      revision: 'r'.repeat(64),
      operation: 'o'.repeat(64),
      payload,
    };
    expect(ServiceIngressSchema.safeParse(envelope).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(
      jsonEnvelopeBytes(Buffer.byteLength(payload)),
    );
  }
});

test('large unary and stream requests cross both doors and broker without widening grants', async () => {
  const root = await mkdtemp('/tmp/wire-large-');
  const socket = `${root}/owner.sock`;
  const descriptorPath = `${root}/descriptor.json`;
  let dispatched = 0;
  const owner = bindUnixSocket({ path: socket, mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      maxRequestBodySize: 8 * 1024 * 1024,
      fetch: async (req) => {
        const call = ServiceIngressSchema.parse(await req.json());
        dispatched++;
        const result = { digest: sha256(call.payload) };
        if (call.operation === 'follow')
          return new Response(`${JSON.stringify({ type: 'data', data: result })}\n{"type":"end"}\n`, {
            headers: { 'content-type': 'application/x-ndjson' },
          });
        return Response.json(result);
      },
    }),
  );
  await writeFile(descriptorPath, JSON.stringify(descriptor));
  const grants: ServiceGrant[] = [
    { caller: 'reader', target: 'worker', service: descriptor.service, scope: { kind: 'service-read' } },
  ];
  const policy = ServicePolicySchema.parse({
    bindings: [
      {
        service: descriptor.service,
        descriptorPath,
        socketPath: socket,
        endpointPath: '/ingress',
        maxInflight: 2,
        limits: { requestBytes: 1048576, responseBytes: 4096, timeoutMs: 30000 },
      },
    ],
    grants,
  });
  const token = 'large-request-fixture-token'.padEnd(40, 'x');
  const port = freePort();
  const broker = await startBroker(
    brokerConfig({ reader: token, worker: token }, { port, serviceGrants: grants }),
  );
  const brokers = [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }];
  const worker = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers,
      services: policy,
      agentSocket: `${root}/worker.sock`,
    }),
  );
  const reader = await startAgent(
    NodeConfigSchema.parse({ nodeId: 'reader', brokers, agentSocket: `${root}/reader.sock` }),
  );
  const wire = createWireClient({ socketPath: `${root}/reader.sock` });
  const fetchOwner = createServiceFetch(wire, { to: 'worker', descriptor, baseUrl: 'http://owner.invalid' });
  try {
    await waitConnected(reader, worker);
    const payloads = [
      JSON.stringify({ text: 'a'.repeat(93 * 1024 - 11) }),
      JSON.stringify({ text: 'a'.repeat(1048576 - 11) }),
      // Valid JSON whitespace expands in the outer envelope, exceeding the former stream body cap.
      `${'\t'.repeat(1048574)}{}`,
      JSON.stringify({ text: '\\"я\u0000'.repeat(50000) }),
    ];
    for (const body of payloads) {
      for (const operation of ['write', 'follow']) {
        const before = dispatched;
        const response = await fetchOwner(`http://owner.invalid/documents/${operation}`, {
          method: 'POST',
          body,
        });
        const text = await response.text();
        expect(text).toContain(sha256(body));
        expect(dispatched).toBe(before + 1);
      }
    }
    const before = dispatched;
    await expect(
      fetchOwner('http://owner.invalid/documents/write', {
        method: 'POST',
        body: `${' '.repeat(1048575)}{}`,
      }),
    ).rejects.toMatchObject({
      outcome: { code: 'invalid-request', delivery: 'not-dispatched', refusal: 'request' },
    });
    // Bypass SDK descriptor checks to exercise target operation/binding enforcement.
    const call = {
      to: 'worker',
      service: descriptor.service,
      revision: '1',
      operation: 'small',
      payload: `${' '.repeat(65535)}{}`,
      timeoutMs: 5000,
    };
    expect((await wire.invokeService(call)).outcome).toMatchObject({
      code: 'invalid-request',
      delivery: 'not-dispatched',
    });
    expect((await wire.invokeService({ ...call, service: 'example.undeclared' })).outcome).toMatchObject({
      code: 'denied',
      delivery: 'not-dispatched',
      refusal: 'policy',
    });
    const restricted = new ServiceExecutor(
      {
        ...policy,
        bindings: policy.bindings.map((binding) => ({
          ...binding,
          limits: { ...binding.limits, requestBytes: 65536 },
        })),
      },
      'worker',
    );
    expect(
      await restricted.execute(
        { ...call, operation: 'write', id: crypto.randomUUID(), from: 'reader' },
        new AbortController().signal,
      ),
    ).toMatchObject({ code: 'invalid-request', delivery: 'not-dispatched' });
    expect(dispatched).toBe(before);
  } finally {
    wire.close();
    await reader.stop();
    await worker.stop();
    await broker.stop();
    owner.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
