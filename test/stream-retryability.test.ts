/**
 * `limit` and `error` differ not in their text but in the flag by which retrying is decided.
 *
 * The producer already distinguished two outcomes: a line did not fit into the parser buffer (`limit`)
 * and the producer emitted garbage (`error`). Both left outward the same way — `refusal: 'none'` — and
 * the consumer treated them the same: by reconnecting. For `error` that is right. For `limit` it is a
 * loop that cannot converge: a line does not get shorter by retrying. A measurement sent by a consumer
 * (2026-09-02): 130 consecutive "reconnecting" entries on a single thread and a conversation that sat
 * "in the queue" for 22 hours.
 *
 * The pair of tests below is a positive and a negative control of the same spot: if a change makes
 * EVERYTHING unrecoverable, the second one goes red, and that matters more than the first — a transient
 * error that became permanent is worse than the original defect.
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
const TOKEN = 'r'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'stitchwire-stream-retryability-'));
const socket = join(root, 'agent.sock');

let broker: Awaited<ReturnType<typeof startBroker>>;
let agent: AgentHandle;

function profile(fixture: string) {
  return {
    bin: process.execPath,
    argv: [resolve(import.meta.dir, `fixtures/${fixture}`)],
    format: { mode: 'ndjson', stableCursor: true },
    callerArgs: { mode: 'none' },
    stdin: { mode: 'none' },
    maxBytes: 4 * 1024 * 1024,
    timeoutMs: 900_000,
    concurrency: 2,
    env: { inherit: ['HOME', 'PATH', 'LANG', 'TMPDIR'] },
  };
}

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
        'endless-line': profile('framed-endless-line.ts'),
        garbage: profile('framed-garbage.ts'),
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

async function terminalFrame(name: string): Promise<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  for await (const frame of agent.openStream({
    to: 'worker',
    profile: name,
    args: [],
    stdin: null,
    cursor: null,
  } as never)) {
    frames.push(frame as Record<string, unknown>);
  }
  const failed = frames.filter((f) => 'failure' in f && f.failure !== 'none');
  expect(failed.length).toBeGreaterThan(0);
  return failed[0] as Record<string, unknown>;
}

test('a line past the parser bound is unrecoverable: the consumer is told not to retry it', async () => {
  const frame = await terminalFrame('endless-line');

  expect(frame.reason).toBe('limit');
  // `request` — this is the "retrying will not help": the same thing will arrive again, the same way.
  expect(frame.refusal).toBe('request');
  // The layer does not change: the producer started and emitted something that cannot be read within
  // the bounds.
  expect(frame.failure).toBe('exec');
  // An unrecoverable outcome cannot have a "try again in N" hint — it would imply that
  // waiting makes sense.
  expect(frame.retryAfterMs).toBe(null);
  expect(String(frame.detail)).toContain('line exceeds the bounded parser buffer');
});

test('a producer that merely broke stays retryable — the distinction did not collapse', async () => {
  const frame = await terminalFrame('garbage');

  expect(frame.reason).toBe('error');
  // Exactly what must stay as it was: an unclassified refusal, for which retrying is legitimate.
  expect(frame.refusal).toBe('none');
  expect(frame.failure).toBe('exec');
  expect(String(frame.detail)).toContain('invalid bounded NDJSON');
});
