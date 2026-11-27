/**
 * The stream and event planes through the CLI, because until now they were reachable only by
 * hand-writing JSON at the socket with `curl` — on a machine that already has a binary which knows
 * how to do it. An operator diagnosing a stalled flow should not have to decode base64 themselves.
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
import { brokerConfig, freePort, waitConnected } from './support.ts';

const CLI = join(import.meta.dir, '..', 'packages', 'runtime', 'src', 'cli', 'main.ts');
const PORT = freePort();
const TOKEN = 'c'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'stitchwire-cli-planes-'));
const socket = join(root, 'agent.sock');

let broker: Awaited<ReturnType<typeof startBroker>>;
let agent: AgentHandle;

async function cli(args: string[], stdin?: string) {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    env: { ...process.env, STITCHWIRE_AGENT_SOCKET: socket },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig(
      { worker: TOKEN },
      {
        port: PORT,
        capabilities: {
          worker: [
            { operation: 'stream', targets: ['worker'] },
            { operation: 'publish', targets: ['worker'] },
            { operation: 'subscribe', targets: ['worker'] },
          ],
        },
        topics: {
          'generic.events': {
            producer: 'worker',
            subscribers: ['worker'],
            delivery: 'ordered',
            maxSubscribers: 1,
          },
        },
        auditPath: join(root, 'audit.jsonl'),
      },
    ),
  );
  agent = await startAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token: TOKEN }],
      nodeId: 'worker',
      streams: {
        greet: { bin: '/bin/echo', argv: ['live-frame'] },
        // A producer that reads its opening request from stdin — the shape a live profile actually
        // has, and the one that was unreachable from the CLI because `stream` sent `null` always.
        parrot: { bin: '/bin/cat', stdin: { mode: 'text', maxBytes: 1024 } },
      },
      events: { publish: ['generic.events'], subscribe: ['generic.events'] },
      agentSocket: socket,
    }),
  );
  await waitConnected(agent);
});

afterAll(async () => {
  await agent?.stop();
  await broker?.stop();
});

test('a live stream reaches stdout decoded, and its terminal reason is not mixed into it', async () => {
  const result = await cli(['stream', 'worker', 'greet']);
  // The payload and only the payload goes to stdout, so the command can sit in a pipe.
  expect(result.stdout).toContain('live-frame');
  expect(result.stdout).not.toContain('stream ended');
  expect(result.stderr).toContain('stream ended: completed');
  expect(result.code).toBe(0);
});

test('--json hands over the frames unchanged, for a machine downstream', async () => {
  const result = await cli(['stream', 'worker', 'greet', '--json']);
  const frames = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { v: number; channel?: string; reason?: string });
  expect(frames.length).toBeGreaterThan(1);
  // The door's own version, which is the only one a local reader ever sees.
  expect(frames.every((frame) => frame.v === LOCAL_API_VERSION)).toBe(true);
  expect(frames.at(-1)?.reason).toBe('completed');
});

test('a stream refused by policy prints the class, not raw JSON', async () => {
  const result = await cli(['stream', 'worker', 'not-a-profile']);
  expect(result.stderr).toContain('denied/policy');
  expect(result.code).toBe(1);
});

test('an event published from stdin is accepted, and a refusal names its class', async () => {
  const accepted = await cli(['events', 'publish', 'generic.events'], 'hello from the CLI');
  expect(accepted.stderr).toContain('event accepted');
  expect(accepted.code).toBe(0);

  const undeclared = await cli(['events', 'publish', 'generic.other'], 'nope');
  expect(undeclared.code).toBe(1);
  expect(undeclared.stderr.length).toBeGreaterThan(0);
});

test('publishing with nothing on stdin is refused before it reaches the wire', async () => {
  const result = await cli(['events', 'publish', 'generic.events']);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('nothing on stdin');
});

test('--stdin reaches the producer, so a profile that takes an opening request is usable', async () => {
  // Without the flag the door received `stdin: null` no matter what, and a producer expecting a
  // request line ended its stream on the first read. The door always accepted stdin; only the
  // command-line surface did not offer it.
  const result = await cli(['stream', 'worker', 'parrot', '--stdin'], '{"selector":"live"}\n');
  expect(result.stdout).toContain('{"selector":"live"}');
  expect(result.stderr).toContain('stream ended: completed');
  expect(result.code).toBe(0);
});

test('without --stdin the same profile gets nothing, which is the previous behaviour exactly', async () => {
  const result = await cli(['stream', 'worker', 'parrot'], '{"selector":"live"}\n');
  expect(result.stdout).not.toContain('selector');
  expect(result.code).toBe(0);
});
