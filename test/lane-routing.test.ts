import { expect, test } from 'bun:test';
import { createRevisionSignal } from 'stitchkit/application';
import { type Presence, PresenceSchema } from '../packages/contracts/src/protocol/presence.ts';
import { LanePresence, TargetLaneSelector } from '../packages/runtime/src/node/lane-routing.ts';
import { RequestDeadline } from '../packages/runtime/src/node/request-deadline.ts';
import { RoutedStream } from '../packages/runtime/src/node/routed-stream.ts';
import { StreamConsumer } from '../packages/runtime/src/node/stream-consumer.ts';

function row(serves = true): Presence {
  return PresenceSchema.parse({
    nodeId: 'target',
    online: true,
    serves,
    connections: 1,
    since: new Date().toISOString(),
    version: '0.25.0',
    behind: null,
    versionSeenAt: null,
    departure: null,
    observingSince: new Date().toISOString(),
  });
}
function lane(nodes: Presence[]) {
  const presence = new LanePresence();
  presence.connect((accept) => {
    accept(nodes);
    return true;
  });
  return { connected: true, presence };
}

async function selected(
  selector: TargetLaneSelector<ReturnType<typeof lane>>,
  target: string,
  timeoutMs?: number,
) {
  const result = await selector.select(target, timeoutMs);
  return result.state === 'selected' ? result.lane : undefined;
}

test('selection uses per-lane serving presence, not connected or non-serving online', async () => {
  const left = lane([row(false)]);
  const right = lane([row()]);
  const selector = new TargetLaneSelector([left, right]);
  for (let i = 0; i < 8; i += 1) expect(await selected(selector, 'target')).toBe(right);
  left.presence.update(row());
  expect(await selected(selector, 'target')).toBe(left);
  expect(await selected(selector, 'target')).toBe(right);
  right.connected = false;
  expect(await selected(selector, 'target')).toBe(left);
});

test('one presence transition publishes one selector change', () => {
  const presence = new LanePresence();
  let changes = 0;
  presence.subscribe(() => {
    changes += 1;
  });
  presence.connect((accept) => {
    accept([]);
    return true;
  });
  changes = 0;

  presence.update(row());

  expect(changes).toBe(1);
});

test('presence exposes the same authoritative snapshot status routing already owns', () => {
  const presence = new LanePresence();
  const expected = row();
  presence.connect((accept) => {
    accept([expected]);
    return true;
  });
  expect(presence.list()).toEqual([expected]);
  const snapshot = presence.list();
  snapshot.length = 0;
  expect(presence.list()).toHaveLength(1);
});

test('one revision wakes every current route waiter but not a later waiter', async () => {
  const availability = createRevisionSignal({ maxWaiters: 2 });
  const left = availability.wait(0, { timeoutMs: 100 });
  const right = availability.wait(0, { timeoutMs: 100 });
  expect(availability.getSnapshot().pending).toBe(2);

  expect(availability.advance()).toEqual({ outcome: 'advanced', revision: 1 });
  expect(await Promise.all([left, right])).toEqual([
    { outcome: 'changed', revision: 1 },
    { outcome: 'changed', revision: 1 },
  ]);
  expect(await availability.wait(1, { timeoutMs: 5 })).toEqual({
    outcome: 'timed-out',
    revision: 1,
  });
  expect(availability.getSnapshot().pending).toBe(0);
});

test('initial unknown waits for snapshot; a known route never waits on another lane', async () => {
  const unknown = lane([]);
  let acknowledge: (nodes: Presence[]) => void = () => {
    throw new Error('snapshot not requested');
  };
  unknown.presence.connect((accept) => {
    acknowledge = accept;
    return true;
  }, 100);
  const selector = new TargetLaneSelector([lane([]), unknown]);
  const pendingSelection = selector.select('target');
  acknowledge([row()]);
  expect(await pendingSelection).toEqual({ state: 'selected', lane: unknown });
  const ready = lane([row()]);
  unknown.presence.connect(() => true, 100);
  expect(await selected(new TargetLaneSelector([unknown, ready]), 'target', 1)).toBe(ready);
  unknown.presence.disconnect();
});

test('snapshot timeout is unknown, never absence; request wait is bounded', async () => {
  const unknown = lane([]);
  unknown.presence.connect(() => true, 100);
  const selector = new TargetLaneSelector([lane([]), unknown]);
  expect(await selector.select('target', 5)).toEqual({
    state: 'unavailable',
    cause: 'presence-pending-timeout',
  });
  expect(unknown.presence.ready).toBe(false);
  unknown.presence.disconnect();
  unknown.presence.connect(() => true, 5);
  expect(await selector.select('target')).toEqual({
    state: 'unavailable',
    cause: 'presence-pending-timeout',
  });
  expect(unknown.presence.ready).toBe(false);
  unknown.presence.disconnect();
});

test('a route learned during initialization does not wait for an unrelated silent broker', async () => {
  const silent = lane([]);
  const target = lane([]);
  silent.presence.connect(() => true, 100);
  target.presence.connect((accept) => {
    queueMicrotask(() => accept([row()]));
    return true;
  });
  try {
    expect(await selected(new TargetLaneSelector([silent, target]), 'target', 20)).toBe(target);
  } finally {
    silent.presence.disconnect();
    target.presence.disconnect();
  }
});

test('disconnect clears stale presence and old snapshot callbacks cannot resurrect it', async () => {
  const target = lane([row()]);
  let stale: (nodes: Presence[]) => void = () => {
    throw new Error('snapshot not requested');
  };
  target.presence.connect((accept) => {
    stale = accept;
    return true;
  });
  const waiting = target.presence.wait();
  target.presence.disconnect();
  await waiting;
  target.presence.connect((accept) => {
    accept([]);
    return true;
  });
  stale([row()]);
  expect(target.presence.ready).toBe(true);
  expect(target.presence.serves('target')).toBe(false);
  target.presence.update(row());
  expect(target.presence.serves('target')).toBe(true);
  target.presence.disconnect();
  expect(target.presence.serves('target')).toBe(false);
  expect(target.presence.ready).toBe(false);
});

test('confirmed absence keeps broker admission; disconnected lanes are never selected', async () => {
  const left = lane([]);
  const right = lane([]);
  const selector = new TargetLaneSelector([left, right]);
  expect(await selected(selector, 'missing')).toBe(left);
  expect(await selected(selector, 'missing')).toBe(right);
  left.connected = false;
  right.connected = false;
  expect(await selector.select('target', 5)).toEqual({
    state: 'unavailable',
    cause: 'no-connected-lane',
  });
});

test('a disconnected lane is admitted once when it reconnects inside grace', async () => {
  const target = lane([row()]);
  target.connected = false;
  const selector = new TargetLaneSelector([target]);
  const pending = selector.select('target', 100);
  target.connected = true;
  target.presence.update(row());
  expect(await pending).toEqual({ state: 'selected', lane: target });
  expect(selector.selectConnected(5)).resolves.toEqual({ state: 'selected', lanes: [target] });
});

test('all terminal handshake refusals fail immediately because reconnect cannot repair them', async () => {
  const refused = lane([]);
  refused.connected = false;
  const terminal = { ...refused, terminal: true };
  const started = performance.now();
  expect(await new TargetLaneSelector([terminal]).select('target', 1000)).toEqual({
    state: 'unavailable',
    cause: 'no-connected-lane',
  });
  expect(performance.now() - started).toBeLessThan(50);
});

test('caller abort is distinct from route unavailability and removes the waiter immediately', async () => {
  const availability = createRevisionSignal({ maxWaiters: 8 });
  const target = lane([row()]);
  target.connected = false;
  const selector = new TargetLaneSelector([target], availability);
  const controller = new AbortController();
  const pending = selector.select('target', 1_000, controller.signal);
  await Promise.resolve();
  expect(availability.getSnapshot().pending).toBe(1);
  controller.abort();
  expect(await pending).toEqual({ state: 'aborted' });
  expect(availability.getSnapshot().pending).toBe(0);
});

test('publish lane selection observes caller abort and removes its waiter', async () => {
  const availability = createRevisionSignal({ maxWaiters: 8 });
  const target = lane([]);
  target.connected = false;
  const selector = new TargetLaneSelector([target], availability);
  const controller = new AbortController();
  const pending = selector.selectConnected(1_000, controller.signal);
  await Promise.resolve();
  expect(availability.getSnapshot().pending).toBe(1);
  controller.abort();
  expect(await pending).toEqual({ state: 'aborted' });
  expect(availability.getSnapshot().pending).toBe(0);
});

test('one monotonic deadline gives dispatch only the routing remainder', () => {
  const deadline = new RequestDeadline(1_000, 100);
  expect(deadline.remaining(350)).toBe(750);
  expect(deadline.remaining(1_100)).toBe(0);
  expect(deadline.remaining(1_500)).toBe(0);
});

test('stream open is eager, and return cancels a quiet pending next without waiting for a frame', async () => {
  let cancelled = false;
  const ack = {
    ok: true,
    detail: '',
  };
  const source = new StreamConsumer(
    crypto.randomUUID(),
    'caller',
    1024,
    {
      window: async () => ack,
      cancel: async () => {
        cancelled = true;
        return ack;
      },
    },
    () => {},
  );
  let opened = false;
  const stream = new RoutedStream(Promise.resolve(true), () => {
    opened = true;
    return source;
  });
  await Promise.resolve();
  expect(opened).toBe(true);
  const pending = stream.next();
  await Promise.resolve();
  await stream.return();
  expect(await pending).toMatchObject({ done: true });
  expect(cancelled).toBe(true);
});

test('closing a stream while its route initializes prevents later dispatch', async () => {
  let resolve: (route: boolean) => void = () => {
    throw new Error('missing resolver');
  };
  const route = new Promise<boolean>((accept) => {
    resolve = accept;
  });
  let opened = false;
  const stream = new RoutedStream(route, () => {
    opened = true;
    return (async function* () {
      yield 1;
    })();
  });
  const next = stream.next();
  await stream.return();
  resolve(true);
  expect(await next).toMatchObject({ done: true });
  expect(opened).toBe(false);
});

test('closing a stream cancels its pending route selection instead of waiting for route grace', async () => {
  const availability = createRevisionSignal({ maxWaiters: 8 });
  const target = lane([row()]);
  target.connected = false;
  const selector = new TargetLaneSelector([target], availability);
  const controller = new AbortController();
  const stream = new RoutedStream(
    selector.select('target', 1_000, controller.signal),
    () =>
      (async function* () {
        yield 1;
      })(),
    () => controller.abort(),
  );
  const next = stream.next();
  await Promise.resolve();
  expect(availability.getSnapshot().pending).toBe(1);
  await stream.return();
  expect(await next).toMatchObject({ done: true });
  expect(availability.getSnapshot().pending).toBe(0);
});
