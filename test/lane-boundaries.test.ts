import { expect, test } from 'bun:test';
import { createRealtimeClient } from 'stitchkit';
import { bindRealtimeServer, createServer, createSocketIOServer } from 'stitchkit/server';
import { FleetBundleSchema } from '../packages/contracts/src/fleet/bundle.ts';
import { StreamAckSchema, type StreamAck } from '../packages/contracts/src/protocol/stream.ts';
import { wireContract } from '../packages/contracts/src/realtime-contract.ts';
import { laneStreamAck } from '../packages/runtime/src/node/lane-ack.ts';
import { createLaneControl } from '../packages/runtime/src/node/lane-control.ts';
import { LanePeerProbes } from '../packages/runtime/src/node/lane-probes.ts';

// The production acknowledgement bound is seconds; these tests inject a short one so the timeout
// path is exercised without waiting it out (ADR 0012: wait on conditions, never on durations).
const ACK_TIMEOUT_MS = 50;

test('stream acknowledgement settles on offline, success or timeout and ignores late acknowledgements', async () => {
  expect(await laneStreamAck(() => false)).toMatchObject({
    ok: false,
    detail: 'not connected to the broker',
  });
  expect(
    await laneStreamAck((ack) => {
      ack(StreamAckSchema.parse({ ok: true, detail: '' }));
      return true;
    }),
  ).toMatchObject({ ok: true });
  let late: (ack: StreamAck) => void = () => {
    throw new Error('emit callback was not bound');
  };
  const started = performance.now();
  const pending = laneStreamAck((ack) => {
    late = ack;
    return true;
  }, ACK_TIMEOUT_MS);
  const answer = await pending;
  expect(answer).toMatchObject({ ok: false, detail: 'broker stream acknowledgement timed out' });
  // A lower bound only: the timeout must not fire early. Load can make it later, never earlier.
  expect(performance.now() - started).toBeGreaterThanOrEqual(ACK_TIMEOUT_MS - 5);
  late(StreamAckSchema.parse({ ok: true, detail: '' }));
  expect(await pending).toEqual(answer);
});

test('control requests preserve typed acknowledgements, offline/timeout refusal and bounded peer drain', async () => {
  const socket = await createSocketIOServer({});
  const realtime = bindRealtimeServer(wireContract, socket);
  let syncCalls = 0;
  let probeCalls = 0;
  const allProbed = Promise.withResolvers<void>();
  let offer: () => void = () => {};
  let lateReply: () => void = () => {};
  realtime.onConnection(({ events }) => {
    events.on('event:declare', (_request, ack) => ack({ accepted: [], refused: [] }));
    events.on('service:declare', (_request, ack) => ack({ accepted: 0, refused: [] }));
    events.on('fleet:sync', (_request, ack) => {
      syncCalls++;
      if (syncCalls === 1) ack({ serial: null, bundle: null });
    });
    events.on('fleet:publish', (_request, ack) =>
      ack({ accepted: false, serial: null, detail: 'unconfigured' }),
    );
    events.on('peer:probe', (request) => {
      probeCalls++;
      if (probeCalls === 8) allProbed.resolve();
      lateReply = () => {
        events.emit('peer:result', { id: request.id, outcome: 'ok' });
      };
    });
    offer = () => {
      events.emit('fleet:offer', { serial: 3 });
    };
  });
  const server = createServer({ port: 0, socket });
  const client = createRealtimeClient(wireContract, {
    url: `http://localhost:${server.port}`,
    transports: ['websocket'],
  });
  const control = createLaneControl(client, 'test', ACK_TIMEOUT_MS);
  const probes = new LanePeerProbes(client);
  const bundle = FleetBundleSchema.parse({
    format: 'stitchwire.fleet-bundle',
    serial: 1,
    full: null,
    slices: {},
  });
  try {
    expect(await control.declareTopics({ producer: 'node', topics: {} })).toBeNull();
    expect(await control.declareServices({ target: 'node', grants: [] })).toBeNull();
    expect(await control.syncFleet(null)).toBeNull();
    expect(await control.publishFleet(bundle)).toBeNull();
    expect(await probes.probe('target')).toBe('offline');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('connection deadline'));
      }, 2000);
      const off = client.onConnectionChange((ready) => {
        if (!ready) return;
        clearTimeout(timer);
        off();
        resolve();
      });
      client.connect();
    });
    expect(await control.declareTopics({ producer: 'node', topics: {} })).toEqual({
      accepted: [],
      refused: [],
    });
    expect(await control.declareServices({ target: 'node', grants: [] })).toEqual({
      accepted: 0,
      refused: [],
    });
    expect(await control.syncFleet(null)).toEqual({ serial: null, bundle: null });
    expect(await control.publishFleet(bundle)).toEqual({
      accepted: false,
      serial: null,
      detail: 'unconfigured',
    });
    const offered = Promise.withResolvers<number>();
    control.onFleetOffer(() => {
      throw new Error('replaced listener ran');
    });
    control.onFleetOffer(offered.resolve);
    offer();
    expect(await offered.promise).toBe(3);
    const pending = Array.from({ length: 8 }, () => probes.probe('target'));
    expect(await probes.probe('target')).toBe('capacity');
    await allProbed.promise;
    expect(probeCalls).toBe(8);
    probes.disconnect();
    expect(await Promise.all(pending)).toEqual(Array(8).fill('offline'));
    lateReply();
    expect(await control.syncFleet(1)).toBeNull();
    expect(syncCalls).toBe(2);
  } finally {
    probes.disconnect();
    client.disconnect();
    await server.shutdown({ gracePeriodMs: 1000 });
  }
});
