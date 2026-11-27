import { expect, test } from 'bun:test';
import type { BoundedOperationLease } from 'stitchkit/application';
import type { Cancel, Invocation, Result } from '../packages/contracts/src/protocol/rpc.ts';
import { CommandRouter } from '../packages/runtime/src/broker/commands.ts';
import { until } from './support.ts';

/**
 * A command call ends exactly once, wherever it ends: the lease is released, the journal gets a
 * result, the caller hears it, and a caller that leaves takes the work on its target with it.
 */

function fixture(graceMs?: number) {
  const audit: Array<Record<string, unknown>> = [];
  const cancels: Array<{ socketId: string; cancel: Cancel }> = [];
  const results: Array<{ socketId: string; result: Result }> = [];
  const released: string[] = [];
  const router = new CommandRouter(
    { write: (event) => audit.push(event as unknown as Record<string, unknown>) },
    {
      cancel: (socketId, cancel) => cancels.push({ socketId, cancel }),
      result: (socketId, result) => results.push({ socketId, result }),
    },
    graceMs,
  );
  const begin = (id: string, callerSocketId: string, targetSocketId: string, timeoutMs = 60_000) => {
    const invocation: Invocation = {
      id,
      ts: new Date().toISOString(),
      from: 'caller',
      to: 'target',
      argv: ['echo'],
      stdin: null,
      timeoutMs,
    };
    const lease: BoundedOperationLease = { release: () => void released.push(id) } as BoundedOperationLease;
    router.begin({ lease, invocation, callerSocketId, targetSocketId });
  };
  return { router, begin, audit, cancels, results, released };
}

const id = () => crypto.randomUUID();

test('a caller that disconnects takes its call with it: the target is told to stop and the journal records a cancellation', () => {
  const { router, begin, audit, cancels, released, results } = fixture();
  const call = id();
  begin(call, 'caller-socket', 'target-socket');
  router.disconnect('caller-socket');
  expect(cancels).toEqual([
    {
      socketId: 'target-socket',
      cancel: { id: call, from: 'caller', to: 'target', reason: 'the caller disconnected' },
    },
  ]);
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ kind: 'result', id: call, failure: 'cancelled' });
  expect(released).toEqual([call]);
  expect(router.has(call)).toBe(false);
  // The caller is gone; the result is addressed to its socket and reaches no one.
  expect(results).toHaveLength(1);
});

test('a target socket that is lost fails the calls dispatched to it, not those on its replacement', () => {
  const { router, begin, audit, results, cancels } = fixture();
  const lost = id();
  const kept = id();
  begin(lost, 'caller-socket', 'old-target-socket');
  begin(kept, 'caller-socket', 'new-target-socket');
  router.disconnect('old-target-socket');
  expect(router.has(lost)).toBe(false);
  expect(router.has(kept)).toBe(true);
  expect(results.map(({ result }) => [result.id, result.failure, result.transportCause])).toEqual([
    [lost, 'transport', 'lane-lost-after-dispatch'],
  ]);
  expect(audit[0]).toMatchObject({ id: lost, failure: 'transport' });
  expect(cancels).toEqual([]);
  router.stop();
});

test('only the placing caller may withdraw, only the dispatched node may answer, and a late answer is ignored', () => {
  const { router, begin, results, cancels, released } = fixture();
  const call = id();
  begin(call, 'caller-socket', 'target-socket');
  const cancel: Cancel = { id: call, from: 'caller', to: 'target', reason: 'no longer needed' };
  router.cancel('some-other-socket', cancel);
  expect(router.has(call)).toBe(true);
  expect(cancels).toEqual([]);

  const answer: Result = {
    id: call,
    ts: new Date().toISOString(),
    from: 'target',
    code: 0,
    stdout: 'ok',
    stderr: '',
    failure: 'none',
    refusal: 'none',
    retryAfterMs: null,
    transportCause: null,
    detail: '',
    truncated: false,
  };
  expect(router.answer('impostor', answer)).toBe(false);
  expect(router.has(call)).toBe(true);
  expect(router.answer('target', answer)).toBe(true);
  expect(results).toHaveLength(1);
  expect(released).toEqual([call]);
  expect(router.answer('target', answer)).toBe(false);
});

test('a silent target is answered for by the broker once the deadline and the grace have passed', async () => {
  const { router, begin, results, released, audit } = fixture(10);
  const call = id();
  begin(call, 'caller-socket', 'target-socket', 1);
  expect(router.has(call)).toBe(true);
  expect(await until(() => !router.has(call), 5_000)).toBe(true);
  expect(results.map(({ socketId, result }) => [socketId, result.failure])).toEqual([
    ['caller-socket', 'timeout'],
  ]);
  expect(audit[0]).toMatchObject({ kind: 'result', id: call, failure: 'timeout' });
  expect(released).toEqual([call]);
});
