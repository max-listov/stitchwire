import { FleetPublishAckSchema, FleetSyncAckSchema } from '../../../contracts/src/fleet/bundle.ts';
import { EventErrorSchema, EventFrameSchema, EventGapSchema } from '../../../contracts/src/protocol/event.ts';
import type { Failure, Refusal, TransportCause } from '../../../contracts/src/protocol/failure.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import { type Presence, PresenceSchema } from '../../../contracts/src/protocol/presence.ts';
import { type Invocation, InvocationSchema } from '../../../contracts/src/protocol/rpc.ts';
import { ServiceDeclareAckSchema } from '../../../contracts/src/service/declaration.ts';
import { observeLaneVolume } from '../transport/lane-volume.ts';
import type { Audit } from './audit.ts';
import * as eventPlane from './handlers/events.ts';
import * as rpcPlane from './handlers/rpc.ts';
import * as streamPlane from './handlers/streams.ts';
import type { Registry } from './registry.ts';
import type { WireRealtime } from './sinks.ts';
import type { BrokerTransportObservation } from './transport-observation.ts';
import type { WireParts } from './wire-parts.ts';

function auditCall(
  audit: Audit,
  invocation: Invocation,
  accepted: boolean,
  failure: Failure,
  refusal: Refusal,
  transportCause: TransportCause | null,
  detail: string,
): void {
  const [command = ''] = invocation.argv;
  audit.write({
    kind: 'call',
    id: invocation.id,
    from: invocation.from,
    to: invocation.to,
    command,
    argc: invocation.argv.length - 1,
    argvBytes: Buffer.byteLength(invocation.argv.join('\0')),
    stdinBytes: invocation.stdin === null ? 0 : Buffer.byteLength(invocation.stdin),
    accepted,
    failure,
    refusal,
    transportCause,
    detail,
  });
}

/**
 * What happens when a node connects: it is registered and announced, each frame it sends is handed
 * to the plane that decides it, and when it leaves everything it held is released in one place.
 * The plane's decision lives in `handlers/`; the socket, and the contract that types each payload,
 * stay here.
 */
export function bindConnections(input: {
  realtime: WireRealtime;
  registry: Registry;
  audit: Audit;
  parts: WireParts;
  transportObservation: BrokerTransportObservation;
  presence: () => Presence[];
}): void {
  const { realtime, registry, audit, parts, transportObservation, presence } = input;
  const { calls, peers, streams, eventTargets, eventsRouter, commands, fleet, serviceGrants, serviceRouter } =
    parts;

  const rpcPlaneDeps: rpcPlane.RpcPlaneDeps = {
    audit,
    registry,
    calls,
    commands,
    dispatch: (socketId, invocation) =>
      realtime.to(socketId).emit('rpc:invoke', InvocationSchema.parse(invocation)),
    auditCall,
  };
  const eventPlaneDeps: eventPlane.EventPlaneDeps = { audit, registry, eventsRouter };
  const streamPlaneDeps: streamPlane.StreamPlaneDeps = {
    audit,
    registry,
    streams,
    // Configured grants plus owner-declared ones, exactly what unary calls read.
    serviceGrants: () => serviceGrants.grants(),
  };

  /**
   * One node's presence, sent live — built from the same row the roster answers with.
   *
   * Both notices, connect and disconnect, carry the version the roster reports. A consumer keeping
   * its own roster from the event stream would otherwise drift from the one it can ask for —
   * "three views that agree until they do not", which the fold exists to prevent.
   */
  const announce = (nodeId: string): void => {
    const row = presence().find((entry) => entry.nodeId === nodeId);
    if (row !== undefined) realtime.emit('node:presence', PresenceSchema.parse(row));
  };

  realtime.onConnection(({ raw, events }) => {
    const { nodeId, serves, version } = raw.data;
    const stopVolume = observeLaneVolume(raw.id, nodeId, raw.conn, transportObservation.volume);
    const since = nowIso();
    events.on('service:call', (call) => serviceRouter.call(raw.id, nodeId, call));
    events.on('service:result', (result) => serviceRouter.result(raw.id, result));
    events.on('service:cancel', (cancel) => serviceRouter.cancel(raw.id, cancel.id, cancel.origin));

    registry.attach(raw.id, { socketId: raw.id, nodeId, serves, version, since });
    eventTargets.set(raw.id, (delivery, acknowledge) => {
      if (delivery.kind === 'event') {
        events.emit('event:event', EventFrameSchema.parse(delivery.value), acknowledge);
      } else if (delivery.kind === 'gap') {
        events.emit('event:gap', EventGapSchema.parse(delivery.value), acknowledge);
      } else {
        events.emit('event:error', EventErrorSchema.parse(delivery.value), acknowledge);
      }
    });
    audit.write({ kind: 'connect', nodeId, serves, version });
    announce(nodeId);

    events.on('peer:probe', (request) => {
      peers.open(
        raw.id,
        nodeId,
        registry.serverFor(request.to)?.socketId,
        registry.mayPerform('peer', nodeId, request.to),
        request.id,
      );
    });
    events.on('peer:echo', (reply) => peers.answer(raw.id, reply.id));

    events.on('rpc:call', (invocation, acknowledge) =>
      rpcPlane.call(rpcPlaneDeps, nodeId, raw.id, invocation, acknowledge),
    );
    // A caller withdrawing: stop the work on the target, and settle this side as cancelled.
    events.on('rpc:cancel', (cancel) => commands.cancel(raw.id, cancel));
    events.on('rpc:result', (result, acknowledge) => acknowledge({ ok: commands.answer(nodeId, result) }));

    events.on('nodes:list', (acknowledge) => {
      acknowledge(presence().map((p) => PresenceSchema.parse(p)));
    });

    // The opening decision lives in `handlers/streams.ts`; the five frame handlers below are
    // one-line delegations and stay where the contract types them.
    events.on('stream:open', (request, acknowledge) =>
      streamPlane.open(streamPlaneDeps, nodeId, raw.id, request, acknowledge),
    );
    events.on('stream:window', (window, acknowledge) => {
      acknowledge(streams.window(nodeId, window));
    });
    events.on('stream:chunk', (chunk, acknowledge) => {
      acknowledge(streams.chunk(nodeId, chunk));
    });
    events.on('stream:cancel', (cancel, acknowledge) => {
      acknowledge(streams.cancel(nodeId, cancel));
    });
    events.on('stream:end', (end, acknowledge) => {
      acknowledge(streams.end(nodeId, end));
    });
    events.on('stream:error', (error, acknowledge) => {
      acknowledge(streams.error(nodeId, error));
    });

    events.on('event:subscribe', (request, acknowledge) =>
      eventPlane.subscribe(eventPlaneDeps, nodeId, raw.id, request, acknowledge),
    );
    events.on('event:unsubscribe', (request, acknowledge) =>
      eventPlane.unsubscribe(eventPlaneDeps, nodeId, request, acknowledge),
    );
    events.on('event:publish', (event, acknowledge) =>
      eventPlane.publish(eventPlaneDeps, nodeId, raw.id, event, acknowledge),
    );
    events.on('event:declare', (request, acknowledge) =>
      eventPlane.declare(eventPlaneDeps, nodeId, request, acknowledge),
    );
    // A serving node states who may call its owners' services; each grant gets its verdict.
    events.on('service:declare', (request, acknowledge) => {
      const ack = serviceGrants.declare(nodeId, request);
      audit.write({
        kind: 'service-declare',
        target: nodeId,
        accepted: ack.accepted,
        refused: ack.refused.length,
        detail: ack.refused
          .slice(0, 8)
          .map((refusal) => `${refusal.service} ← ${refusal.caller}: ${refusal.detail}`)
          .join('; '),
      });
      acknowledge(ServiceDeclareAckSchema.parse(ack));
    });
    // The fleet bundle: any node may ask for the part it may hold, and hand on a newer one.
    events.on('fleet:sync', (request, acknowledge) =>
      acknowledge(FleetSyncAckSchema.parse(fleet.sync(nodeId, request))),
    );
    events.on('fleet:publish', (request, acknowledge) =>
      acknowledge(FleetPublishAckSchema.parse(fleet.publish(nodeId, request))),
    );

    raw.on('disconnect', (reason: string) => {
      stopVolume();
      serviceRouter.disconnect(raw.id);
      // Recorded before `detach`, and for every disconnect including this broker's own shutdown:
      // a reader asking "why is that node not here" is otherwise left to infer it from silence.
      const observedAt = nowIso();
      registry.recordDeparture(nodeId, reason, observedAt);
      transportObservation.recordDisconnect(nodeId, reason, observedAt);
      registry.detach(raw.id);
      peers.disconnect(raw.id);
      eventTargets.delete(raw.id);
      streams.disconnect(raw.id);
      eventsRouter.disconnect(raw.id, nodeId);
      commands.disconnect(raw.id);
      announce(nodeId);
    });
  });
}
