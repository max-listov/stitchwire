/**
 * The door is a separate contract from the wire, and these tests exist to keep it that way.
 *
 * A process that POSTs to the socket file is a neighbour on the same machine: it holds no token,
 * opens no lane, and cannot tell a broker from a node. When the wire's version leaked into its
 * answer, raising that version for reasons internal to the transport broke every local reader that
 * had checked it — while nothing about their side of the conversation had changed.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import { LocalResultSchema } from '../packages/contracts/src/door/results.ts';
import { LocalStatusSchema } from '../packages/contracts/src/door/status.ts';
import { toLocalResult } from '../packages/contracts/src/door/local-contract.ts';
import { RELEASE_VERSION } from '../packages/runtime/src/release-version.ts';
import { syntheticResult } from '../packages/contracts/src/protocol/rpc.ts';
import { unclassifiedFailure } from '../packages/contracts/src/protocol/failure.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';

const PORT = freePort();
const TOKEN = 'l'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'stitchwire-local-api-'));
const socket = join(root, 'agent.sock');

let broker: Awaited<ReturnType<typeof startBroker>>;
let agent: AgentHandle;

async function door(path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://localhost/wire${path}`, {
    unix: socket,
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  return await response.json();
}

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig(
      { worker: TOKEN },
      {
        port: PORT,
        capabilities: {
          worker: [
            { operation: 'peer', targets: ['worker'] },
            { operation: 'stream', targets: ['worker'] },
          ],
        },
        commandGrants: [{ caller: 'worker', targets: ['worker'], command: 'echo' }],
        auditPath: join(root, 'audit.jsonl'),
      },
    ),
  );
  agent = await startAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token: TOKEN }],
      nodeId: 'worker',
      allow: {
        echo: {
          bin: '/bin/echo',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
      },
      agentSocket: socket,
    }),
  );
  await waitConnected(agent);
});

afterAll(async () => {
  await agent?.stop();
  await broker?.stop();
});

test('the door adds its own version to a wire frame that carries none', () => {
  const wireFrame = syntheticResult(crypto.randomUUID(), unclassifiedFailure('offline', 'nobody is serving'));
  // The wire has no version at all now: homogeneity is settled at the handshake, so a frame that
  // reached a handler is the same build by construction.
  expect('v' in wireFrame).toBe(false);

  const local = toLocalResult(wireFrame);
  expect(local.v).toBe(LOCAL_API_VERSION);
});

test('an answer that arrived at the door carries the local version, not the wire one', async () => {
  const raw = await door('/call', { to: 'worker', argv: ['echo', 'hello'], stdin: null });
  const answer = LocalResultSchema.parse(raw);
  expect(answer.v).toBe(LOCAL_API_VERSION);
  expect(answer.failure).toBe('none');
  expect(answer.stdout).toBe('hello\n');

  // The door's number is the only one a local reader ever sees, and it moves for the door's own
  // reasons — which is why the wire losing its version cost these consumers nothing but this bump.
  expect((raw as { v: number }).v).toBe(LOCAL_API_VERSION);
});

test('a refusal keeps its classification when it crosses the door', async () => {
  const refused = LocalResultSchema.parse(
    await door('/call', { to: 'worker', argv: ['not-allowed'], stdin: null }),
  );
  expect(refused.v).toBe(LOCAL_API_VERSION);
  expect(refused.failure).toBe('denied');
  expect(refused.refusal).toBe('policy');
});

test('a live stream frame crosses the door as a local frame', async () => {
  const response = await fetch('http://localhost/wire/stream', {
    unix: socket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: 'worker', profile: 'nothing', args: [], stdin: null, cursor: null }),
  });
  const first = (await response.text()).trim().split('\n')[0];
  if (first === undefined) throw new Error('the door returned no stream frame');
  const frame = JSON.parse(first) as { v: number; failure?: string };
  expect(frame.v).toBe(LOCAL_API_VERSION);
});

test('status no longer reports a wire protocol, because there is not one', async () => {
  const status = LocalStatusSchema.parse(await door('/status'));
  expect(status.v).toBe(LOCAL_API_VERSION);
  expect('protocol' in status).toBe(false);
  expect('url' in status).toBe(false);
  expect(status.lanes[0]?.url).toBeDefined();
  expect(status.lanes[0]?.presence).toBe('ready');
  // What identifies the build is the release, and it is what the handshake matches on.
  expect(status.version).toBe(RELEASE_VERSION);
});
