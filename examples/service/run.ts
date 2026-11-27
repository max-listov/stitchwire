import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createClient, defineContract } from 'stitchkit';
import { bindUnixSocket } from 'stitchkit/files';
import { createHandler, implement } from 'stitchkit/server';
import { z } from 'zod';
import {
  createServiceFetch,
  createServiceIngress,
  createWireClient,
  serviceCaller,
  serviceDescriptorFromContract,
  WireClientError,
} from '../../packages/client/src/index.ts';
import type { ServiceGrant } from '../../packages/contracts/src/service/policy-schema.ts';
import type { BrokerHandle } from '../../packages/runtime/src/broker/contracts.ts';
import { startBroker } from '../../packages/runtime/src/broker/runtime.ts';
import { BrokerConfigSchema } from '../../packages/runtime/src/config/broker.ts';
import { sha256 } from '../../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../../packages/runtime/src/config/node.ts';
import { startAgent } from '../../packages/runtime/src/node/agent-application.ts';
import type { AgentHandle } from '../../packages/runtime/src/node/agent-contract.ts';

const Query = z.object({ key: z.literal('example') });
const Item = z.object({ key: z.string(), value: z.string() });
const catalog = defineContract(
  { prefix: '/catalog', scope: 'catalog' },
  {
    lookup: {
      method: 'POST',
      effect: 'read',
      path: '/lookup',
      desc: 'Read a synthetic catalog item',
      input: Query,
      output: Item,
      maxJsonBodyBytes: 1024,
      timeout: 2000,
    },
  },
);
const descriptor = serviceDescriptorFromContract(catalog, {
  service: 'example.catalog',
  revision: '1',
  maxInflight: 2,
  responseBytes: { lookup: 4096 },
});

/*
 * The example is read and copied on its own, so it keeps these two small helpers (a free port and the
 * wait for connected agents) instead of importing the test suite's `test/support.ts`.
 */
function unusedPort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (!port) throw new Error('no ephemeral port');
  return port;
}

/** What a run observed. The example reports it; the caller decides whether it is right. */
export type ExampleOutcome =
  | {
      example: 'typed-service';
      brokers: number;
      result: { key: string; value: string };
      caller: string | null;
      ownerDispatches: number;
      refusals: Array<{ case: string; status: string; delivery: string }>;
    }
  | {
      example: 'stream';
      brokers: number;
      boundedBytes: number;
      content: string;
      refused: boolean;
      quiet: string;
    }
  | {
      example: 'events';
      brokers: number;
      acknowledged: boolean[];
      retainedEvent: boolean;
      explicitGap: boolean;
      refused: boolean;
      quiet: string;
      durableResync: 'owner responsibility';
    };

/** How a read on a quiet source ended: `cancelled` is the expected answer to its abort signal. */
async function quietEnd(next: () => Promise<unknown>, close: () => void): Promise<string> {
  try {
    await next();
    return 'resolved';
  } catch (error) {
    if (error instanceof WireClientError) return error.code;
    throw error;
  } finally {
    close();
  }
}

/** Synthetic data and isolated resources: no fleet configuration or installed agent is read. */
export async function runExample(kind: 'service' | 'stream' | 'events' = 'service'): Promise<ExampleOutcome> {
  const outcome = await observe(kind);
  console.log(JSON.stringify(outcome));
  return outcome;
}

async function observe(kind: 'service' | 'stream' | 'events'): Promise<ExampleOutcome> {
  const root = await mkdtemp('/tmp/wire-example-');
  const brokers: BrokerHandle[] = [];
  const agents: AgentHandle[] = [];
  const client = createWireClient({ socketPath: `${root}/reader.sock` });
  const publisher = createWireClient({ socketPath: `${root}/worker.sock` });
  let owner: ReturnType<typeof Bun.serve> | undefined;
  let dispatches = 0;
  let seenCaller: string | undefined;
  try {
    const handler = createHandler({
      services: [
        implement(catalog, {
          lookup: (context) => {
            seenCaller = serviceCaller(context)?.caller;
            return { key: context.input.key, value: 'synthetic example' };
          },
        }),
      ],
    });
    const ingress = createServiceIngress({
      descriptor,
      handler: (request) => {
        dispatches++;
        return handler(request);
      },
    });
    // A socket takes the process umask at bind, so a chmod after listen leaves it on disk wider than 0600 until it runs.
    owner = bindUnixSocket({ path: `${root}/owner.sock`, mode: 0o600 }, (unix) =>
      Bun.serve({ unix, fetch: ingress }),
    );
    const descriptorPath = `${root}/descriptor.json`;
    await writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    const token = crypto.randomUUID() + crypto.randomUUID();
    const grant: ServiceGrant = {
      caller: 'reader',
      target: 'worker',
      service: descriptor.service,
      scope: { kind: 'service-read' },
    };
    const endpoints = [];
    for (const id of ['left', 'right']) {
      const port = unusedPort();
      brokers.push(
        await startBroker(
          BrokerConfigSchema.parse({
            host: '127.0.0.1',
            port,
            nodes: [
              { id: 'reader', tokenSha256s: [sha256(token)] },
              { id: 'worker', tokenSha256s: [sha256(token)] },
            ],
            serviceGrants: [grant],
            auditPath: `${root}/${id}.jsonl`,
            capabilities: {
              reader: [
                { operation: 'stream', targets: ['worker'] },
                { operation: 'subscribe', targets: ['worker'] },
              ],
              worker: [{ operation: 'publish', targets: ['worker'] }],
            },
            topics: {
              'example.state': {
                producer: 'worker',
                subscribers: ['reader'],
                delivery: 'ordered',
                retain: { maxAgeMs: 10000, maxBytes: 1024 },
              },
              'example.quiet': { producer: 'worker', subscribers: ['reader'], delivery: 'latest-wins' },
            },
          }),
        ),
      );
      endpoints.push({ id, url: `http://127.0.0.1:${port}`, token });
    }
    for (const nodeId of ['worker', 'reader']) {
      agents.push(
        await startAgent(
          NodeConfigSchema.parse({
            nodeId,
            brokers: endpoints,
            agentSocket: `${root}/${nodeId}.sock`,
            events:
              nodeId === 'worker'
                ? { publish: ['example.state', 'example.quiet'], subscribe: [] }
                : { publish: [], subscribe: ['example.state', 'example.quiet'] },
            streams:
              nodeId === 'worker'
                ? {
                    lines: {
                      bin: process.execPath,
                      argv: [resolve(import.meta.dir, '../stream/producer.ts')],
                      maxBytes: 4096,
                      timeoutMs: 2000,
                    },
                    quiet: {
                      bin: process.execPath,
                      argv: [resolve(import.meta.dir, '../stream/producer.ts'), '--quiet'],
                      maxBytes: 4096,
                      timeoutMs: 2000,
                    },
                  }
                : {},
            services:
              nodeId === 'worker'
                ? {
                    grants: [grant],
                    bindings: [
                      {
                        service: descriptor.service,
                        descriptorPath,
                        socketPath: `${root}/owner.sock`,
                        endpointPath: '/invoke',
                        maxInflight: 2,
                        limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 },
                      },
                    ],
                  }
                : undefined,
          }),
        ),
      );
    }
    const deadline = Date.now() + 3000;
    while (agents.some((agent) => !agent.connected) && Date.now() < deadline) await Bun.sleep(5);
    if (agents.some((agent) => !agent.connected)) throw new Error('example agents did not connect');
    if (kind === 'stream') {
      const chunks: Uint8Array[] = [];
      let refused = false;
      for await (const item of client.stream({ to: 'worker', profile: 'lines', timeoutMs: 2000 })) {
        if (item.kind === 'error') refused = true;
        if (item.kind === 'chunk') chunks.push(item.data);
      }
      const quiet = client.stream(
        { to: 'worker', profile: 'quiet', timeoutMs: 2000 },
        { signal: AbortSignal.timeout(100) },
      );
      return {
        example: 'stream',
        brokers: brokers.length,
        boundedBytes: 4096,
        content: Buffer.concat(chunks).toString(),
        refused,
        quiet: await quietEnd(
          () => quiet.next(),
          () => quiet.close(),
        ),
      };
    }
    if (kind === 'events') {
      const bootId = crypto.randomUUID();
      const data = 'synthetic state '.repeat(40);
      const acknowledged: boolean[] = [];
      for (let seq = 0; seq < 3; seq++)
        acknowledged.push((await publisher.publish({ topic: 'example.state', bootId, seq, data })).ok);
      const feed = client.subscribe(
        { topic: 'example.state', resume: { bootId, afterSeq: 0 } },
        { signal: AbortSignal.timeout(2000) },
      );
      let gap = false;
      let value = false;
      let refused = false;
      try {
        for await (const item of feed) {
          if (item.kind === 'error') {
            refused = true;
            break;
          }
          if (item.kind === 'gap') gap = item.frame.reason === 'retention';
          if (item.kind === 'event')
            value = new TextDecoder().decode(item.data) === data && item.frame.seq === 2;
          if (gap && value) break;
        }
      } finally {
        feed.close();
      }
      const quiet = client.subscribe({ topic: 'example.quiet' }, { signal: AbortSignal.timeout(100) });
      return {
        example: 'events',
        brokers: brokers.length,
        acknowledged,
        retainedEvent: value,
        explicitGap: gap,
        refused,
        quiet: await quietEnd(
          () => quiet.next(),
          () => quiet.close(),
        ),
        durableResync: 'owner responsibility',
      };
    }
    const api = createClient(catalog, {
      baseUrl: 'http://owner.invalid',
      fetch: createServiceFetch(client, {
        to: 'worker',
        descriptor,
        baseUrl: 'http://owner.invalid',
      }),
    });
    const result = await api.lookup({ key: 'example' });
    const refusals: Array<{ case: string; status: string; delivery: string }> = [];
    const refusal = (name: string, answer: Awaited<ReturnType<typeof client.invokeService>>) =>
      refusals.push({ case: name, status: answer.outcome.status, delivery: answer.outcome.delivery });
    const denied = await client.invokeService({
      to: 'worker',
      service: descriptor.service,
      revision: 'wrong',
      operation: 'lookup',
      payload: '{}',
      timeoutMs: 1000,
    });
    refusal('wrong revision', denied);
    const undeclared: Array<[string, { to?: string; operation?: string }]> = [
      ['undeclared target', { to: 'reader' }],
      ['undeclared operation', { operation: 'unknown' }],
    ];
    for (const [name, override] of undeclared) {
      const refused = await client.invokeService({
        to: 'worker',
        service: descriptor.service,
        revision: '1',
        operation: 'lookup',
        payload: '{}',
        timeoutMs: 1000,
        ...override,
      });
      refusal(name, refused);
    }
    const wrongCaller = await publisher.invokeService({
      to: 'worker',
      service: descriptor.service,
      revision: '1',
      operation: 'lookup',
      payload: '{}',
      timeoutMs: 1000,
    });
    refusal('undeclared caller', wrongCaller);
    return {
      example: 'typed-service',
      brokers: brokers.length,
      result,
      caller: seenCaller ?? null,
      ownerDispatches: dispatches,
      refusals,
    };
  } finally {
    client.close();
    publisher.close();
    for (const agent of agents.reverse()) await agent.stop();
    for (const broker of brokers.reverse()) await broker.stop();
    owner?.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await runExample();
