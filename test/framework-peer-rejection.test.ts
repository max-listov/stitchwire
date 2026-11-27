import { expect, test } from 'bun:test';
import { createRealtimeClient, defineRealtimeContract, type RealtimeRejectedEventHook } from 'stitchkit';
import { bindRealtimeServer, createServer, createSocketIOServer } from 'stitchkit/server';
import { createRealtimeProbeDriver, defineRealtimeProbe, runSurfaceProbes } from 'stitchkit/testing';
import { z } from 'zod';
import { PresenceSchema } from '../packages/contracts/src/protocol/presence.ts';
import { wireContract } from '../packages/contracts/src/realtime-contract.ts';

test('production contract rejects peer schema skew before handler dispatch and remains usable', async () => {
  const socket = await createSocketIOServer({});
  const realtime = bindRealtimeServer(wireContract, socket, { onRejected: () => undefined });
  let calls = 0;
  realtime.onConnection(({ events }) => {
    events.on('nodes:list', (ack) => {
      calls += 1;
      ack([]);
    });
  });
  const server = createServer({ port: 0, socket });
  const skew = defineRealtimeContract({
    serverToClient: {},
    clientToServer: {
      'nodes:list': { args: z.tuple([z.string()]), ack: z.array(PresenceSchema) },
    },
  });
  let observe: RealtimeRejectedEventHook = () => undefined;
  const client = createRealtimeClient(skew, {
    url: `http://localhost:${server.port}`,
    transports: ['websocket'],
    onRejected: (event) => observe(event),
  });
  const positive = createRealtimeClient(wireContract, {
    url: `http://localhost:${server.port}`,
    transports: ['websocket'],
  });
  async function connect(peer: Pick<typeof client, 'connect' | 'onConnectionChange'>) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('connection deadline'));
      }, 2000);
      const off = peer.onConnectionChange((ready) => {
        if (!ready) return;
        clearTimeout(timer);
        off();
        resolve();
      });
      peer.connect();
    });
  }
  try {
    await connect(client);
    const driver = createRealtimeProbeDriver<string>({
      bind: (onRejected) => {
        observe = onRejected;
        return {
          connected: () => client.connected,
          invoke: () => client.request('nodes:list', 'unexpected argument', { timeoutMs: 1000 }),
          dispose: () => client.disconnect(),
        };
      },
      handlerCalls: () => calls,
    });
    await runSurfaceProbes({
      probes: [
        defineRealtimeProbe({
          name: 'wire peer contract refusal',
          scenario: 'peer_rejection',
          fixture: 'extra-argument',
          expected: {
            outcome: 'realtime_rejected',
            code: 'REALTIME_CONTRACT_VIOLATION',
            rejection: {
              direction: 'client-inbound',
              phase: 'arguments',
              reason: 'rejected-by-peer',
              fault: 'local',
            },
            handlerCalls: 0,
          },
        }),
      ],
      drivers: { REALTIME: driver },
    });
    expect(calls).toBe(0);
    await connect(positive);
    expect(await positive.request('nodes:list', { timeoutMs: 1000 })).toEqual([]);
    expect(calls).toBe(1);
  } finally {
    client.disconnect();
    positive.disconnect();
    await server.shutdown({ gracePeriodMs: 1000 });
  }
});
