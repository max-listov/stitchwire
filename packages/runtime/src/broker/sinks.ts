import type { RealtimeContract } from 'stitchkit';
import type { RealtimeServer } from 'stitchkit/server';
import {
  StreamCancelSchema,
  StreamChunkSchema,
  StreamEndSchema,
  StreamErrorSchema,
  StreamInvokeSchema,
  StreamWindowSchema,
} from '../../../contracts/src/protocol/stream.ts';
import type { wireContract } from '../../../contracts/src/realtime-contract.ts';
import type { ServiceSink } from '../service/broker.ts';
import type { Audit } from './audit.ts';
import type { WireIdentity } from './contracts.ts';
import type { Registry } from './registry.ts';
import type { StreamSink } from './streams.ts';

/** The broker's side of the socket: what the routers emit through. */
export type WireRealtime =
  typeof wireContract extends RealtimeContract<infer ToClient, infer ToServer>
    ? RealtimeServer<ToClient, ToServer, WireIdentity>
    : never;

/** Where a stream router's frames go: the socket of the node they are addressed to, and the journal. */
export function streamSink(realtime: WireRealtime, audit: Audit): StreamSink {
  return {
    invoke: (socketId, invocation) => {
      realtime.to(socketId).emit('stream:invoke', StreamInvokeSchema.parse(invocation));
    },
    chunk: (socketId, chunk) => {
      realtime.to(socketId).emit('stream:chunk', StreamChunkSchema.parse(chunk));
    },
    window: (socketId, window) => {
      realtime.to(socketId).emit('stream:window', StreamWindowSchema.parse(window));
    },
    cancel: (socketId, cancel) => {
      realtime.to(socketId).emit('stream:cancel', StreamCancelSchema.parse(cancel));
    },
    end: (socketId, end) => {
      realtime.to(socketId).emit('stream:end', StreamEndSchema.parse(end));
    },
    error: (socketId, error) => {
      realtime.to(socketId).emit('stream:error', StreamErrorSchema.parse(error));
    },
    terminal: (event) => audit.write({ kind: 'stream-terminal', ...event }),
  };
}

/** Where a service router's calls go: the serving node's socket, and the journal. */
export function serviceSink(realtime: WireRealtime, audit: Audit, registry: Registry): ServiceSink {
  return {
    audit: (call, phase, outcome, facts) =>
      audit.write({
        kind: 'service',
        id: call.id,
        ...(call.traceId === undefined ? {} : { traceId: call.traceId }),
        from: call.from,
        to: call.to,
        service: call.service,
        operation: call.operation,
        phase,
        outcome,
        ...facts,
      }),
    target: (node) => registry.serverFor(node)?.socketId,
    invoke: (socket, call) => {
      realtime.to(socket).emit('service:invoke', call);
    },
    result: (socket, result) => {
      realtime.to(socket).emit('service:result', result);
    },
    cancel: (socket, id, to, origin) => {
      realtime.to(socket).emit('service:cancel', { id, to, origin });
    },
  };
}
