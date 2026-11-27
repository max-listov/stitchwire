import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  StreamChunkSchema,
  type StreamEnd,
  type StreamError,
  type StreamOpen,
} from '../packages/contracts/src/protocol/stream.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { StreamRouter, type StreamSink } from '../packages/runtime/src/broker/streams.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';

const TOKEN_A = 's'.repeat(40);
const TOKEN_B = 'p'.repeat(40);
const PORT = freePort();

import { stillRunning } from '../packages/runtime/src/node/process-state.ts';
import { freePort, until, waitConnected } from './support.ts';
import { temporaryFile } from './temporary.ts';

const SOCKET = temporaryFile('stream-test.sock');

const open = (streamId = crypto.randomUUID()): StreamOpen => ({
  streamId,
  ts: new Date().toISOString(),
  from: 'caller',
  to: 'producer',
  source: { kind: 'profile', profile: 'logs', args: [], stdin: null, cursor: null },
  timeoutMs: 5_000,
  requestedWindowBytes: 1_024,
});

function routerFixture(slowConsumerTimeoutMs = 30_000) {
  const events: Array<{ kind: string; socket: string; payload: unknown }> = [];
  const sink: StreamSink = {
    invoke: (socket, payload) => events.push({ kind: 'invoke', socket, payload }),
    chunk: (socket, payload) => events.push({ kind: 'chunk', socket, payload }),
    window: (socket, payload) => events.push({ kind: 'window', socket, payload }),
    cancel: (socket, payload) => events.push({ kind: 'cancel', socket, payload }),
    end: (socket, payload) => events.push({ kind: 'end', socket, payload }),
    error: (socket, payload) => events.push({ kind: 'error', socket, payload }),
  };
  const config = BrokerConfigSchema.parse({
    nodes: [
      { id: 'caller', tokenSha256s: [sha256(TOKEN_A)] },
      { id: 'producer', tokenSha256s: [sha256(TOKEN_B)] },
    ],
    admission: { streamSlowConsumerTimeoutMs: slowConsumerTimeoutMs },
  });
  return { router: new StreamRouter(config.admission, sink), events };
}

function chunk(streamId: string, seq: number, data = 'test') {
  const bytes = Buffer.byteLength(data);
  return StreamChunkSchema.parse({
    streamId,
    from: 'producer',
    seq,
    channel: 'data',
    encoding: 'base64',
    data: Buffer.from(data).toString('base64'),
    bytes,
    cursor: null,
  });
}

describe('bounded broker stream state', () => {
  test('routes monotonic chunks and rejects a duplicate without retaining the stream', () => {
    const { router, events } = routerFixture();
    const request = open();
    expect(router.open(request, 'caller-socket', 'producer-socket').accepted).toBe(true);
    expect(
      router.window('caller', {
        streamId: request.streamId,
        from: 'caller',
        creditBytes: 8,
      }).ok,
    ).toBe(true);
    expect(router.chunk('producer', chunk(request.streamId, 0)).ok).toBe(true);
    expect(router.chunk('producer', chunk(request.streamId, 0)).ok).toBe(false);
    expect(router.status().active).toBe(0);
    expect(events.map((event) => event.kind)).toEqual(['invoke', 'window', 'chunk', 'error', 'cancel']);
  });

  test('a node that is neither end of a stream cannot fail it, and the stream goes on', () => {
    const { router, events } = routerFixture();
    const request = open();
    router.open(request, 'caller-socket', 'producer-socket');
    router.window('caller', { streamId: request.streamId, from: 'caller', creditBytes: 8 });
    const end: StreamEnd = {
      streamId: request.streamId,
      from: 'stranger',
      lastSeq: -1,
      code: 0,
      reason: 'completed',
      cursor: null,
    };
    const failure: StreamError = {
      streamId: request.streamId,
      from: 'stranger',
      failure: 'rejected',
      refusal: 'none',
      retryAfterMs: null,
      transportCause: null,
      reason: 'error',
      detail: 'not mine to fail',
    };
    expect(router.chunk('stranger', { ...chunk(request.streamId, 0), from: 'stranger' }).ok).toBe(false);
    expect(router.end('stranger', end).ok).toBe(false);
    expect(router.error('stranger', failure).ok).toBe(false);
    expect(router.status().active).toBe(1);
    expect(events.map((event) => event.kind)).toEqual(['invoke', 'window']);
    // The producer is unaffected and still delivers.
    expect(router.chunk('producer', chunk(request.streamId, 0)).ok).toBe(true);
  });

  test('credit exhaustion is fail-closed and never buffers an uncredited chunk', () => {
    const { router, events } = routerFixture();
    const request = open();
    router.open(request, 'caller-socket', 'producer-socket');
    router.window('caller', {
      streamId: request.streamId,
      from: 'caller',
      creditBytes: 4,
    });
    expect(router.chunk('producer', chunk(request.streamId, 0)).ok).toBe(true);
    expect(router.chunk('producer', chunk(request.streamId, 1)).detail).toContain('credit');
    expect(events.filter((event) => event.kind === 'chunk')).toHaveLength(1);
  });

  test('a replenished window resumes an exhausted stream at the next sequence', () => {
    const { router, events } = routerFixture();
    const request = open();
    router.open(request, 'caller-socket', 'producer-socket');
    const grant = () =>
      router.window('caller', {
        streamId: request.streamId,
        from: 'caller',
        creditBytes: 4,
      });
    expect(grant().ok).toBe(true);
    expect(router.chunk('producer', chunk(request.streamId, 0)).ok).toBe(true);
    expect(grant().ok).toBe(true);
    expect(router.chunk('producer', chunk(request.streamId, 1)).ok).toBe(true);
    expect(events.filter((event) => event.kind === 'chunk')).toHaveLength(2);
  });

  test('consumer and producer disconnects clean their exact live state', () => {
    const first = routerFixture();
    const firstOpen = open();
    first.router.open(firstOpen, 'caller-socket', 'producer-socket');
    first.router.disconnect('caller-socket');
    expect(first.router.status().active).toBe(0);
    expect(first.events.at(-1)?.kind).toBe('cancel');

    const second = routerFixture();
    second.router.open(open(), 'caller-socket', 'producer-socket');
    second.router.disconnect('producer-socket');
    expect(second.router.status().active).toBe(0);
    expect(second.events.at(-1)?.kind).toBe('error');
  });

  test('zero-credit slow consumer is terminated on the bounded timer', async () => {
    const { router, events } = routerFixture(1_000);
    router.open(open(), 'caller-socket', 'producer-socket');
    await Bun.sleep(1_050);
    expect(router.status().active).toBe(0);
    const error = events.find((event) => event.kind === 'error')?.payload as StreamError;
    expect(error.reason).toBe('slow-consumer');
  });

  test('frame schema rejects a forged decoded byte count and oversized payload', () => {
    const request = open();
    expect(() => StreamChunkSchema.parse({ ...chunk(request.streamId, 0), bytes: 99 })).toThrow();
    expect(() =>
      StreamChunkSchema.parse({
        ...chunk(request.streamId, 0),
        data: Buffer.alloc(32 * 1024 + 1).toString('base64'),
        bytes: 32 * 1024 + 1,
      }),
    ).toThrow();
  });
});

describe('end-to-end stream transport', () => {
  let broker: Awaited<ReturnType<typeof startBroker>>;
  let caller: Awaited<ReturnType<typeof startAgent>>;
  let producer: Agent;

  beforeAll(async () => {
    rmSync(SOCKET, { force: true });
    broker = await startBroker(
      BrokerConfigSchema.parse({
        host: '127.0.0.1',
        port: PORT,
        nodes: [
          { id: 'caller', tokenSha256s: [sha256(TOKEN_A)] },
          { id: 'producer', tokenSha256s: [sha256(TOKEN_B)] },
        ],
        capabilities: {
          caller: [
            { operation: 'peer', targets: ['producer'] },
            { operation: 'stream', targets: ['producer'] },
          ],
        },
        commandGrants: [{ caller: 'caller', targets: ['producer'], command: 'echo' }],
        auditPath: temporaryFile('stream-audit.jsonl'),
      }),
    );
    const lane = (token: string) => ({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token }],
      defaultTimeoutMs: 5_000,
    });
    caller = await startAgent(
      NodeConfigSchema.parse({
        ...lane(TOKEN_A),
        nodeId: 'caller',
        allow: {},
        agentSocket: SOCKET,
      }),
    );
    producer = await startAgent(
      NodeConfigSchema.parse({
        ...lane(TOKEN_B),
        nodeId: 'producer',
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
        agentSocket: temporaryFile('stream-producer.sock'),
        streams: {
          fixed: {
            bin: '/usr/bin/printf',
            argv: ['hello-stream'],
            callerArgs: { mode: 'none' },
            stdin: { mode: 'none' },
            maxBytes: 16_384,
          },
          resumable: {
            bin: '/usr/bin/printf',
            argv: ['{"data":"one","cursor":"cursor-1"}\\n'],
            format: { mode: 'ndjson', stableCursor: true },
            maxBytes: 16_384,
          },
          tree: {
            bin: process.execPath,
            argv: [resolve(import.meta.dir, 'fixtures/stream-process-tree.ts')],
            maxBytes: 16_384,
          },
          missing: { bin: '/nonexistent/stream-binary', maxBytes: 16_384 },
          // A follow-style feed: it never ends on its own, so the only way it can finish is a
          // deadline. `concurrency: 2` because a reconnecting consumer holds the old stream for a
          // moment while opening the new one, and a ceiling of one would refuse the new one.
          endless: {
            bin: '/bin/sleep',
            argv: ['30'],
            callerArgs: { mode: 'none' },
            stdin: { mode: 'none' },
            timeoutMs: 1_500,
            concurrency: 2,
            maxBytes: 16_384,
          },
        },
      }),
    );
    await waitConnected(caller, producer);
  });

  afterAll(async () => {
    await caller?.stop();
    await producer?.stop();
    await broker?.stop();
    rmSync(SOCKET, { force: true });
    rmSync(temporaryFile('stream-producer.sock'), { force: true });
  });

  test('Unix NDJSON door carries ordered chunks and an explicit terminal reason', async () => {
    const response = await fetch('http://localhost/wire/stream', {
      unix: SOCKET,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'producer', profile: 'fixed' }),
    });
    expect(response.status).toBe(200);
    const lines = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    const payload = lines[0] as { seq: number; data: string };
    const terminal = lines.at(-1) as StreamEnd;
    expect(payload.seq).toBe(0);
    expect(Buffer.from(payload.data, 'base64').toString()).toBe('hello-stream');
    expect(terminal.reason).toBe('completed');
    expect(terminal.lastSeq).toBe(0);
  });

  test('a profile whose executable is missing is refused as an exec failure that names it and why', async () => {
    const opened = caller.openStream({
      to: 'producer',
      profile: 'missing',
      args: [],
      stdin: null,
      cursor: null,
    });
    const event = await opened.next();
    expect(event.done).toBe(false);
    const error = event.value as StreamError;
    expect(error.failure).toBe('exec');
    expect(error.detail).toContain('/nonexistent/stream-binary');
    expect(error.detail).toContain('ENOENT');
  });

  test('resume is explicit: stable cursor profiles accept it, raw profiles reject it', async () => {
    const denied = caller.openStream({
      to: 'producer',
      profile: 'fixed',
      args: [],
      stdin: null,
      cursor: 'cursor-0',
    });
    const deniedEvent = await denied.next();
    expect(deniedEvent.done).toBe(false);
    expect((deniedEvent.value as StreamError).reason).toBe('unsupported');

    const resumed = caller.openStream({
      to: 'producer',
      profile: 'resumable',
      args: [],
      stdin: null,
      cursor: 'cursor-0',
    });
    const first = await resumed.next();
    expect(first.done).toBe(false);
    expect('cursor' in first.value && first.value.cursor).toBe('cursor-1');
    const end = await resumed.next();
    expect(end.done).toBe(false);
    expect((end.value as StreamEnd).reason).toBe('completed');
  });

  test('a feed that runs out of time ends, and does not look like one that failed', async () => {
    // The distinction a follow-style consumer acts on: "the deadline expired, reopen" and "the
    // producer broke, do not hammer it" need opposite reactions and would be indistinguishable if
    // the transport reported both the same way. They are two different frames AND two different
    // reasons — an END with `timeout`, never an ERROR.
    const feed = caller.openStream({
      to: 'producer',
      profile: 'endless',
      args: [],
      stdin: null,
      cursor: null,
      // Inside the profile's ceiling on purpose. Asking for MORE than the profile allows is a
      // refused request, not a timed-out stream, and it arrives as such — `failure: 'denied'`,
      // `refusal: 'request'` — which is a third outcome a consumer must not confuse with either.
      timeoutMs: 1_200,
    });
    let terminal: StreamEnd | StreamError | undefined;
    for (;;) {
      const next = await feed.next();
      if (next.done) break;
      if ('reason' in next.value) {
        terminal = next.value as StreamEnd | StreamError;
        break;
      }
    }
    expect(terminal?.reason).toBe('timeout');
    // An END carries an exit code; an ERROR carries a failure class. Reading which one arrived is
    // what tells a consumer whether anything is wrong at all.
    expect(terminal !== undefined && 'code' in terminal).toBe(true);
    expect(terminal !== undefined && 'failure' in terminal).toBe(false);
  }, 15_000);

  test('stream policy denial is terminal while an independently granted command remains available', async () => {
    const denied = producer.openStream({
      to: 'caller',
      profile: 'fixed',
      args: [],
      stdin: null,
      cursor: null,
    });
    const event = await denied.next();
    expect(event.done).toBe(false);
    expect((event.value as StreamError).failure).toBe('denied');

    const rpc = await caller.call({ to: 'producer', argv: ['echo', 'command-plane'], stdin: null });
    expect(rpc.failure).toBe('none');
    expect(rpc.stdout).toBe('command-plane\n');
  });

  test('local consumer close cancels the exact producer process group including descendants', async () => {
    const stream = caller.openStream({
      to: 'producer',
      profile: 'tree',
      args: [],
      stdin: null,
      cursor: null,
    });
    const first = await stream.next();
    expect(first.done).toBe(false);
    if (first.done || !('data' in first.value)) throw new Error('process tree did not emit its pid frame');
    const [parentText, childText] = Buffer.from(first.value.data, 'base64').toString().trim().split(':');
    const parentPid = Number(parentText);
    const childPid = Number(childText);
    expect(parentPid).toBeGreaterThan(1);
    expect(childPid).toBeGreaterThan(1);
    await stream.return?.();

    // `stillRunning`, not a bare signal probe: a zombie answers the probe and would keep this wait
    // spinning to its ceiling over a process that has already exited.
    expect(await until(() => !stillRunning(parentPid) && !stillRunning(childPid))).toBe(true);
  });
});
