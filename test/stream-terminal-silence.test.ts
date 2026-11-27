/**
 * A cancellation that was promised to be reported must arrive — even when the producer was stuck
 * waiting.
 *
 * `cancel(reason, report = true)` is used by the stream timeout and by a credit-window violation. It
 * wakes the waiter in `waitForCredit`, which throws, the throw outruns `Promise.all` — and the branch
 * that sent the terminal frame was not executed at all, while the exception handler saw the already set
 * `cancelled` and stayed silent. The consumer deliberately waits WITHOUT a deadline here: the
 * boundaries of a stream must end with an explicit frame. Measured before the fix: not a single frame
 * in 4 s with a timeout of 1 s — neither `end` nor `error`.
 *
 * The tests come as a pair, and the second matters more than the first: a cancellation that was NOT
 * asked to be reported (the consumer closed the stream itself) must stay mute. Otherwise the fix for
 * the silence turns into an invented frame for a stream that nobody is listening to any more.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StreamInvoke } from '../packages/contracts/src/protocol/stream.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { streamExecutionAdmission } from '../packages/runtime/src/node/admission.ts';
import { StreamProducerManager } from '../packages/runtime/src/node/stream-producer.ts';
import { delivered } from './support.ts';

function harness(argv: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-terminal-silence-'));
  const config = NodeConfigSchema.parse({
    brokers: [{ id: 'primary', url: 'http://127.0.0.1:1', token: 'z'.repeat(40) }],
    nodeId: 'worker',
    agentSocket: join(root, 'agent.sock'),
    streams: {
      talker: {
        bin: process.execPath,
        argv,
        format: { mode: 'raw' },
        callerArgs: { mode: 'none' },
        stdin: { mode: 'none' },
        maxBytes: 4 * 1024 * 1024,
        timeoutMs: 900_000,
        concurrency: 2,
        env: { inherit: ['HOME', 'PATH', 'LANG', 'TMPDIR'] },
      },
    },
  });
  const seen: string[] = [];
  const manager = new StreamProducerManager(
    config,
    {
      chunk: async () => ({ ok: true, detail: '' }),
      end: async (end) => {
        seen.push(`end:${end.reason}`);
        return { ok: true, detail: '' };
      },
      error: async (error) => {
        seen.push(`error:${error.reason}`);
        return { ok: true, detail: '' };
      },
    },
    streamExecutionAdmission(config, false),
  );
  const streamId = crypto.randomUUID();
  const invoke: StreamInvoke = {
    open: {
      streamId,
      ts: new Date().toISOString(),
      from: 'caller',
      to: 'worker',
      source: { kind: 'profile', profile: 'talker', args: [], stdin: null, cursor: null },
      timeoutMs: 1_000,
      requestedWindowBytes: 1_024,
    },
    // We issue no credit at all — the producer must get stuck where the cancellation finds it.
    limits: {
      maxChunkBytes: 1_024,
      maxWindowBytes: 1_024,
      maxStreamBytes: 1_024 * 1_024,
      slowConsumerTimeoutMs: 60_000,
    },
  };
  return { manager, seen, invoke, streamId, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const WRITES_THEN_WAITS = [
  '-e',
  'process.stdout.write("x".repeat(4096)); await new Promise(r=>setTimeout(r,30000));',
];

test('a stream timeout reaches the consumer even when the producer was waiting for credit', async () => {
  const h = harness(WRITES_THEN_WAITS);
  h.manager.start(h.invoke);
  // The stream's own one-second timeout ends it; wait for the frame it owes, not for a duration.
  await delivered(h.seen, 1);
  h.cleanup();

  // Exactly what was missing: the terminal frame exists and names the reason.
  expect(h.seen).toEqual(['end:timeout']);
});

test('a cancellation nobody asked to be reported stays silent — no invented terminal frame', async () => {
  const h = harness(WRITES_THEN_WAITS);
  h.manager.start(h.invoke);
  // The producer must be inside its credit wait when the cancel lands; the manager exposes no state
  // to wait on, so this pause only lets the child start and fill its first window.
  await Bun.sleep(300);
  // Exactly the path by which a stream nobody is listening to any more is closed: report = false.
  h.manager.cancel({ streamId: h.streamId, from: 'caller', reason: 'local consumer closed' });
  // Absence: no terminal frame may follow, so the clock is the instrument here.
  await Bun.sleep(700);
  h.cleanup();

  expect(h.seen).toEqual([]);
}, 10_000);
