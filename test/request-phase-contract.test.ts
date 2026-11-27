import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { Server } from 'socket.io';
import { createRealtimeClient, defineRealtimeContract, type RealtimeRequestPhaseEvent } from 'stitchkit';
import { z } from 'zod';
import {
  publicationRequestObserver,
  type TracePublication,
} from '../packages/runtime/src/node/publication-trace.ts';
import { listenLoopback } from './support.ts';

const input = z.object({ key: z.string() });
const reply = z.object({ ok: z.boolean() });
const contract = defineRealtimeContract({
  serverToClient: {},
  clientToServer: { inspect: { args: z.tuple([input]), ack: reply } },
});

test('request-scoped phases bind exact transport tuples under reordered identical ACKs', async () => {
  const http = createServer();
  const sockets = new Set<Socket>();
  http.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const io = new Server(http);
  const acknowledgements = new Map<string, (value: z.infer<typeof reply>) => void>();
  io.on('connection', (socket) => {
    socket.on('inspect', (raw: unknown, ack: (value: z.infer<typeof reply>) => void) => {
      acknowledgements.set(input.parse(raw).key, ack);
      if (acknowledgements.size === 2) {
        acknowledgements.get('second')?.({ ok: true });
        acknowledgements.get('first')?.({ ok: true });
      }
    });
  });
  const port = await listenLoopback(http);
  const phases: RealtimeRequestPhaseEvent[] = [];
  const bound: Array<{ seq: number; phase: string; requestId?: string }> = [];
  const trace: TracePublication = (tuple, phase, fields) => {
    bound.push({ seq: tuple.seq, phase, requestId: fields?.requestId });
  };
  const tuple = { topic: 'example.feed', bootId: crypto.randomUUID(), seq: 1 };
  const client = createRealtimeClient(contract, {
    url: `http://127.0.0.1:${port}`,
    transports: ['websocket'],
    peers: { client: () => import('socket.io-client') },
    onRequestPhase: (phase) => {
      phases.push(phase);
    },
  });
  try {
    const connected = new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('connection deadline')), 2000);
      client.onConnectionChange((ready) => {
        if (ready) {
          clearTimeout(deadline);
          resolve();
        }
      });
    });
    client.connect();
    await connected;
    const first = client.request(
      'inspect',
      { key: 'first' },
      {
        timeoutMs: 1000,
        onPhase: publicationRequestObserver(trace, tuple, 'primary'),
      },
    );
    tuple.seq = 2;
    const second = client.request(
      'inspect',
      { key: 'second' },
      {
        timeoutMs: 1000,
        onPhase: publicationRequestObserver(trace, tuple, 'primary'),
      },
    );
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    const handoffs = phases.filter((p) => p.phase === 'engine-handoff').map((p) => p.requestId);
    const receipts = phases.filter((p) => p.phase === 'engine-ack-received').map((p) => p.requestId);
    expect(handoffs).toHaveLength(2);
    expect(new Set(handoffs).size).toBe(2);
    expect(receipts).toEqual([...handoffs].reverse());
    expect(phases.filter((p) => p.phase === 'settled')).toHaveLength(2);
    for (const phase of phases) {
      expect(Object.keys(phase).sort()).toEqual(['elapsedMs', 'event', 'phase', 'requestId']);
      expect(phase.elapsedMs).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(phases)).not.toMatch(/first|second/);
    expect(bound.filter((p) => p.phase === 'engine-ack-received').map((p) => p.seq)).toEqual([2, 1]);
    for (const seq of [1, 2]) {
      const own = bound.filter((p) => p.seq === seq);
      expect(own.map((p) => p.phase)).toEqual(['engine-handoff', 'engine-ack-received', 'settled']);
      expect(new Set(own.map((p) => p.requestId)).size).toBe(1);
    }
  } finally {
    client.disconnect();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => io.close(() => resolve()));
  }
});
