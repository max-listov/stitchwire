import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StreamChunk, StreamEnd, StreamError } from '../packages/contracts/src/protocol/stream.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { stillRunning } from '../packages/runtime/src/node/process-state.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { RAW_REQUEST_TIMEOUT_MS, type RawLane, rawLane } from './raw-lane.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';
import { temporaryFile } from './temporary.ts';

/**
 * Streams between real agents through a real broker: who may end one, and what becomes of the
 * processes behind a profile stream when it is stopped, times out or its producer stops.
 */

const TOKENS = {
  caller: 'c'.repeat(40),
  producer: 'p'.repeat(40),
  stopper: 's'.repeat(40),
  stranger: 'x'.repeat(40),
};
const GATE = temporaryFile('stream-wire-gate');
const TREE = resolve(import.meta.dir, 'fixtures/stream-process-tree.ts');
const lane = (port: number, token: string) => ({
  brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }],
});
const treeProfile = { bin: process.execPath, argv: [TREE], maxBytes: 16_384, concurrency: 2 };

let port = 0;
let broker: Awaited<ReturnType<typeof startBroker>>;
let caller: Agent;
let producer: Agent;
let stranger: RawLane;
const agents: Agent[] = [];

beforeAll(async () => {
  port = freePort();
  broker = await startBroker(
    brokerConfig(TOKENS, {
      port,
      capabilities: {
        caller: [
          { operation: 'stream', targets: ['producer'] },
          { operation: 'stream', targets: ['stopper'] },
        ],
      },
    }),
  );
  caller = createAgent(NodeConfigSchema.parse({ ...lane(port, TOKENS.caller), nodeId: 'caller' }));
  producer = createAgent(
    NodeConfigSchema.parse({
      ...lane(port, TOKENS.producer),
      nodeId: 'producer',
      streams: {
        // `one`, then `two` once the gate file exists: the producer's own pace is the test's to release.
        gated: {
          bin: '/bin/sh',
          argv: ['-c', `echo one; while [ ! -e '${GATE}' ]; do /bin/sleep 0.05; done; echo two`],
          maxBytes: 1024,
        },
        tree: treeProfile,
      },
    }),
  );
  agents.push(caller, producer);
  await waitConnected(caller, producer);
  stranger = await rawLane(port, 'stranger', TOKENS.stranger);
});

afterAll(async () => {
  stranger?.close();
  await Promise.all(agents.map((agent) => agent.stop()));
  await broker?.stop();
});

const text = (frame: StreamChunk): string => Buffer.from(frame.data, 'base64').toString();

describe('a node that is neither end of a stream', () => {
  test('cannot fail, end or feed it, and the stream carries on to its own end', async () => {
    const stream = caller.openStream({
      to: 'producer',
      profile: 'gated',
      args: [],
      stdin: null,
      cursor: null,
    });
    const first = await stream.next();
    if (first.done || !('data' in first.value)) throw new Error('the producer sent no first frame');
    expect(text(first.value)).toBe('one\n');
    const { streamId } = first.value;

    const call = { timeoutMs: RAW_REQUEST_TIMEOUT_MS };
    const refusals = await Promise.all([
      stranger.client.request(
        'stream:error',
        {
          streamId,
          from: 'stranger',
          failure: 'rejected',
          refusal: 'none',
          retryAfterMs: null,
          transportCause: null,
          reason: 'error',
          detail: 'not mine to fail',
        },
        call,
      ),
      stranger.client.request(
        'stream:end',
        { streamId, from: 'stranger', lastSeq: 0, code: 0, reason: 'completed', cursor: null },
        call,
      ),
      stranger.client.request(
        'stream:chunk',
        {
          streamId,
          from: 'stranger',
          seq: 1,
          channel: 'stdout',
          encoding: 'base64',
          data: Buffer.from('forged').toString('base64'),
          bytes: 6,
          cursor: null,
        },
        call,
      ),
    ]);
    expect(refusals.map((ack) => ack.ok)).toEqual([false, false, false]);

    // Only now does the producer go on: had a stranger ended or failed the stream, it would be over.
    writeFileSync(GATE, '');
    const rest: Array<StreamChunk | StreamEnd | StreamError> = [];
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
      if ('data' in next.value || 'reason' in next.value) rest.push(next.value);
      if ('reason' in next.value) break;
    }
    expect(rest.map((frame) => ('data' in frame ? text(frame) : `end:${frame.reason}`))).toEqual([
      'two\n',
      'end:completed',
    ]);
    expect(existsSync(GATE)).toBe(true);
  }, 30_000);
});

/** Opens the process-tree profile and reports the leader and its child that ignores SIGTERM. */
async function openTree(
  from: Agent,
  to: string,
  timeoutMs?: number,
): Promise<{ pids: number[]; stream: ReturnType<Agent['openStream']> }> {
  const stream = from.openStream({
    to,
    profile: 'tree',
    args: [],
    stdin: null,
    cursor: null,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const first = await stream.next();
  if (first.done || !('data' in first.value)) throw new Error('the process tree did not report its pids');
  const pids = text(first.value).trim().split(':').map(Number);
  expect(pids).toHaveLength(2);
  for (const pid of pids) expect(stillRunning(pid)).toBe(true);
  return { pids, stream };
}

const allGone = (pids: number[]) => until(() => pids.every((pid) => !stillRunning(pid)));

describe('the processes behind a profile stream', () => {
  test('are all stopped when the stream times out, including a child that ignores SIGTERM', async () => {
    const { pids, stream } = await openTree(caller, 'producer', 1_200);
    let terminal: StreamEnd | StreamError | undefined;
    for (;;) {
      const next = await stream.next();
      if (next.done) break;
      if ('reason' in next.value) {
        terminal = next.value;
        break;
      }
    }
    expect(terminal?.reason).toBe('timeout');
    expect(await allGone(pids)).toBe(true);
  }, 30_000);

  test('are all stopped when the agent that runs them stops', async () => {
    const stopper = createAgent(
      NodeConfigSchema.parse({
        ...lane(port, TOKENS.stopper),
        nodeId: 'stopper',
        streams: { tree: treeProfile },
      }),
    );
    agents.push(stopper);
    await waitConnected(stopper);
    const { pids, stream } = await openTree(caller, 'stopper');
    await stopper.stop();
    expect(await allGone(pids)).toBe(true);
    await stream.return?.();
  }, 30_000);
});
