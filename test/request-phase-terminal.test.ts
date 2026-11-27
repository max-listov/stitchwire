import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { Server } from 'socket.io';
import { createRealtimeClient, defineRealtimeContract, type RealtimeRequestPhaseEvent } from 'stitchkit';
import { z } from 'zod';
import { listenLoopback, until } from './support.ts';

const input = z.enum(['ok', 'invalid', 'late', 'disconnect']);
const reply = z.object({ ok: z.boolean() });
const contract = defineRealtimeContract({
  serverToClient: {},
  clientToServer: { inspect: { args: z.tuple([input]), ack: reply } },
});

test('request-only observation isolates failures and closes timeout, disconnect and invalid ACK paths', async () => {
  const http = createServer();
  const sockets = new Set<Socket>();
  http.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const io = new Server(http);
  let late: (() => void) | undefined;
  io.on('connection', (socket) => {
    socket.on('inspect', (raw: unknown, ack: (value: unknown) => void) => {
      const operation = input.parse(raw);
      if (operation === 'late') late = () => ack({ ok: true });
      else if (operation === 'disconnect') socket.disconnect(true);
      else ack(operation === 'invalid' ? { ok: 'invalid' } : { ok: true });
    });
  });
  const port = await listenLoopback(http);
  const client = createRealtimeClient(contract, {
    url: `http://127.0.0.1:${port}`,
    transports: ['websocket'],
    peers: { client: () => import('socket.io-client') },
  });
  const phases = new Map<string, RealtimeRequestPhaseEvent[]>();
  const observe = (key: string) => (phase: RealtimeRequestPhaseEvent) => {
    const own = phases.get(key) ?? [];
    own.push(phase);
    phases.set(key, own);
  };
  try {
    await expect(
      client.request('inspect', 'ok', { timeoutMs: 100, onPhase: observe('offline') }),
    ).rejects.toThrow();
    expect(phases.get('offline')?.map((p) => p.phase)).toEqual(['disconnected']);
    const connected = Promise.withResolvers<void>();
    const unsubscribe = client.onConnectionChange((ready) => {
      if (ready) connected.resolve();
    });
    client.connect();
    await connected.promise;
    unsubscribe();
    await expect(
      client.request('inspect', 'ok', {
        timeoutMs: 1000,
        onPhase: () => {
          throw new Error('observer');
        },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      client.request('inspect', 'ok', {
        timeoutMs: 1000,
        onPhase: async () => {
          throw new Error('observer');
        },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      client.request('inspect', 'invalid', { timeoutMs: 1000, onPhase: observe('invalid') }),
    ).rejects.toThrow();
    expect(phases.get('invalid')?.map((p) => p.phase)).toEqual([
      'engine-handoff',
      'engine-ack-received',
      'settled',
    ]);
    await expect(
      client.request('inspect', 'late', { timeoutMs: 30, onPhase: observe('late') }),
    ).rejects.toThrow();
    const terminal = [...(phases.get('late') ?? [])];
    expect(terminal.map((p) => p.phase)).toEqual(['engine-handoff', 'timeout']);
    late?.();
    await expect(
      client.request('inspect', 'ok', { timeoutMs: 1000, onPhase: observe('next') }),
    ).resolves.toEqual({ ok: true });
    expect(phases.get('late')).toEqual(terminal);
    expect(phases.get('next')?.map((p) => p.phase)).toEqual([
      'engine-handoff',
      'engine-ack-received',
      'settled',
    ]);
    await expect(
      client.request('inspect', 'disconnect', { timeoutMs: 1000, onPhase: observe('disconnect') }),
    ).rejects.toThrow();
    expect(phases.get('disconnect')?.map((p) => p.phase)).toEqual(['engine-handoff', 'disconnected']);
    expect(new Set([...phases.values()].flatMap((rows) => rows.map((p) => p.requestId))).size).toBe(5);
  } finally {
    client.disconnect();
    for (const socket of sockets) socket.destroy();
    // Socket.IO's callback waits for upgraded peers already disconnected by this fixture.
    // Explicit socket destruction and the listener state prove local resource shutdown.
    io.close();
    http.closeAllConnections();
    expect(await until(() => !http.listening)).toBe(true);
  }
});
