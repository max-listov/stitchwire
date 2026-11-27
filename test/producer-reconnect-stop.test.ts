import { expect, spyOn, test } from 'bun:test';
import { StreamInvokeSchema } from '../packages/contracts/src/protocol/stream.ts';
import { streamExecutionAdmission } from '../packages/runtime/src/node/admission.ts';
import { StreamProducerManager } from '../packages/runtime/src/node/stream-producer.ts';
import { ProducerSession } from '../packages/runtime/src/node/stream-producer-session.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';

const limits = { maxWindowBytes: 64, maxChunkBytes: 32, maxStreamBytes: 1024, slowConsumerTimeoutMs: 1000 };

test('an old reconnect stop cannot erase a new producer; final stop closes admission', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const sessions: ProducerSession[] = [];
  const cancelled: ProducerSession[] = [],
    credited: ProducerSession[] = [];
  const run = spyOn(ProducerSession.prototype, 'run').mockImplementation(async function (
    this: ProducerSession,
  ) {
    sessions.push(this);
  });
  const cancel = spyOn(ProducerSession.prototype, 'cancel').mockImplementation(async function (
    this: ProducerSession,
  ) {
    cancelled.push(this);
    if (this === sessions[0]) {
      entered.resolve();
      await release.promise;
    }
  });
  const credit = spyOn(ProducerSession.prototype, 'addCredit').mockImplementation(function (
    this: ProducerSession,
  ) {
    credited.push(this);
  });
  const config = NodeConfigSchema.parse({
    nodeId: 'worker',
    brokers: [{ id: 'primary', url: 'http://127.0.0.1:9999', token: 'x'.repeat(40) }],
    streams: { quiet: { bin: '/bin/cat', concurrency: 3 } },
  });
  const ack = async () => ({ ok: true, detail: '' });
  const manager = new StreamProducerManager(
    config,
    { chunk: ack, end: ack, error: ack },
    streamExecutionAdmission(config, false),
  );
  const invoke = () =>
    StreamInvokeSchema.parse({
      open: {
        streamId: crypto.randomUUID(),
        ts: new Date().toISOString(),
        from: 'reader',
        to: 'worker',
        source: { kind: 'profile', profile: 'quiet', args: [], stdin: null, cursor: null },
        timeoutMs: 1000,
        requestedWindowBytes: 64,
      },
      limits,
    });
  try {
    const old = invoke(),
      fresh = invoke();
    manager.start(old);
    const stopping = manager.stop();
    await entered.promise;
    manager.start(fresh);
    release.resolve();
    await stopping;
    const freshSession = sessions[1];
    if (!freshSession) throw new Error('new producer did not start');
    manager.addCredit(fresh.open.streamId, 1);
    expect(credited).toEqual([freshSession]);
    manager.cancel({ streamId: fresh.open.streamId, from: 'reader', reason: 'test' });
    expect(cancelled).toContain(freshSession);
    await manager.stop(true);
    const count = sessions.length;
    manager.start(invoke());
    expect(sessions).toHaveLength(count);
  } finally {
    release.resolve();
    run.mockRestore();
    cancel.mockRestore();
    credit.mockRestore();
  }
});
