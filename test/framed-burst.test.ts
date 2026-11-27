/**
 * The parser bound must measure the unfinished line, not the buffer.
 *
 * `readFramed` checked the size of the whole buffer BEFORE it extracted the ready lines from it. A
 * producer that handed over what it had accumulated in one batch was killed with the text `framed
 * producer line exceeds the bounded parser buffer` — even though not one line came anywhere near the
 * limit.
 *
 * The regression uses a synthetic burst: many valid lines in one read must not be
 * counted as one invalid line. The limit applies to the unfinished tail.
 *
 * The bound does remain: a line without an end must still kill the stream, because it is the one
 * that can grow without limit.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';

const PORT = freePort();
const TOKEN = 'b'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'stitchwire-framed-burst-'));
const socket = join(root, 'agent.sock');

let broker: Awaited<ReturnType<typeof startBroker>>;
let agent: AgentHandle;

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig(
      { worker: TOKEN },
      {
        port: PORT,
        capabilities: { worker: [{ operation: 'stream', targets: ['worker'] }] },
        auditPath: join(root, 'audit.jsonl'),
      },
    ),
  );
  agent = await startAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token: TOKEN }],
      nodeId: 'worker',
      agentSocket: socket,
      streams: {
        'endless-line': {
          bin: process.execPath,
          argv: [resolve(import.meta.dir, 'fixtures/framed-endless-line.ts')],
          format: { mode: 'ndjson', stableCursor: true },
          callerArgs: { mode: 'none' },
          stdin: { mode: 'none' },
          maxBytes: 4 * 1024 * 1024,
          timeoutMs: 900_000,
          concurrency: 2,
          env: { inherit: ['HOME', 'PATH', 'LANG', 'TMPDIR'] },
        },
        burst: {
          bin: process.execPath,
          argv: [resolve(import.meta.dir, 'fixtures/framed-burst.ts')],
          format: { mode: 'ndjson', stableCursor: true },
          callerArgs: { mode: 'none' },
          stdin: { mode: 'none' },
          maxBytes: 4 * 1024 * 1024,
          timeoutMs: 900_000,
          concurrency: 2,
          env: { inherit: ['HOME', 'PATH', 'LANG', 'TMPDIR'] },
        },
      },
    }),
  );
  await waitConnected(agent);
});

afterAll(async () => {
  await agent?.stop();
  await broker?.stop();
  rmSync(root, { recursive: true, force: true });
});

test('a burst of complete framed lines is delivered, not refused as one oversized line', async () => {
  const frames: Array<Record<string, unknown>> = [];
  for await (const frame of agent.openStream({
    to: 'worker',
    profile: 'burst',
    args: [],
    stdin: null,
    cursor: null,
  } as never)) {
    frames.push(frame as Record<string, unknown>);
  }

  const failed = frames.filter((f) => 'failure' in f && f.failure !== 'none');
  expect(failed.map((f) => f.detail ?? f.failure)).toEqual([]);

  // Every line of the batch must arrive: the batch consisted of ready lines, there was nothing to lose.
  const chunks = frames.filter((f) => typeof f.data === 'string');
  const payload = chunks.map((f) => Buffer.from(f.data as string, 'base64').toString('utf8')).join('');
  expect(payload.split('\n').filter((line) => line !== '').length).toBe(400);
  expect(payload).toContain('"seq":0');
  expect(payload).toContain('"seq":399');
});

test('a line that never ends still hits the bound — the guard was not removed', async () => {
  const frames: Array<Record<string, unknown>> = [];
  for await (const frame of agent.openStream({
    to: 'worker',
    profile: 'endless-line',
    args: [],
    stdin: null,
    cursor: null,
  } as never)) {
    frames.push(frame as Record<string, unknown>);
  }

  // Exactly the check without which the fix above would mean "I removed the bound": a single endless
  // line must kill the stream, and the text must speak specifically about the line — now it does.
  const refused = frames.filter((f) => 'failure' in f && f.failure !== 'none');
  expect(refused.length).toBeGreaterThan(0);
  expect(String(refused[0]?.detail ?? '')).toContain('line exceeds the bounded parser buffer');
});
