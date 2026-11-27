import { createRealtimeClient } from 'stitchkit';
import { createBoundedAdmission } from 'stitchkit/application';
import type { LocalEventSubscribe, LocalStreamRequest } from '../../../contracts/src/door/requests.ts';
import { type EventAck, type EventPublish, rejectedEventAck } from '../../../contracts/src/protocol/event.ts';
import { transportFailure } from '../../../contracts/src/protocol/failure.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import {
  StreamCancelSchema,
  StreamChunkSchema,
  StreamEndSchema,
  StreamErrorSchema,
  StreamWindowSchema,
} from '../../../contracts/src/protocol/stream.ts';
import { wireContract } from '../../../contracts/src/realtime-contract.ts';
import { wireLogger } from '../logger.ts';
import { RELEASE_VERSION } from '../release-version.ts';
import type { ServiceExecutor } from '../service/executor.ts';
import { ServiceLane } from '../service/lane.ts';
import type { TraceService } from '../service/trace.ts';
import { loadLanePeer } from '../transport/lane-peer.ts';
import { type ExecutionAdmission, PublishAdmission } from './admission.ts';
import type { AgentStatus, ConfigOrigin, LaneAgent } from './agent-contract.ts';
import type { EventConsumer, EventDelivery } from './event-consumer.ts';
import { eventTopicRefusal, topicAllowance } from './event-policy.ts';
import { HandshakeRedial } from './handshake-redial.ts';
import { laneStreamAck } from './lane-ack.ts';
import type { LaneConfig } from './lane-contract.ts';
import { createLaneControl } from './lane-control.ts';
import { bindLaneEventDelivery, openLaneEventSubscription } from './lane-event-subscription.ts';
import { LanePeerProbes } from './lane-probes.ts';
import { LanePresence } from './lane-routing.ts';
import { LaneRpc } from './lane-rpc.ts';
import { laneStatus } from './lane-status.ts';
import { bindLaneStreams, openLaneStream } from './lane-stream.ts';
import { publicationRequestObserver, type TracePublication } from './publication-trace.ts';
import type { StreamConsumer, StreamConsumerEvent } from './stream-consumer.ts';
import { StreamProducerManager } from './stream-producer.ts';

export function createLaneAgent(
  config: LaneConfig,
  executionAdmission: ExecutionAdmission,
  streamAdmission: ExecutionAdmission,
  origin: ConfigOrigin | undefined,
  onConnectionChange: () => void,
  serviceExecutor: ServiceExecutor,
  trace?: TracePublication,
  traceService?: TraceService,
): LaneAgent {
  const presence = new LanePresence();
  const consumers = new Map<string, StreamConsumer>();
  const eventConsumers = new Map<string, EventConsumer>();
  const streamSlots = createBoundedAdmission({
    policy: { global: { maxConcurrent: config.admission.maxStreamConsumers } },
  });
  const eventSlots = createBoundedAdmission({
    policy: { global: { maxConcurrent: config.admission.maxEventSubscriptions } },
  });
  const publishAdmission = new PublishAdmission(config.admission);
  /** Null until the first connection attempt settles. */
  let lastCheck: { at: string; ok: boolean; latest: string | null } | null = null;
  let lastFailure: { at: string; reason: string; refused: boolean } | null = null;
  // Refusal can be transient during a version cutover, so it uses the same configured
  // backoff bounds as transport recovery rather than permanently disabling the lane.
  const reconnectMinMs = config.reconnect?.minDelayMs ?? 1_000;
  const reconnectMaxMs = config.reconnect?.maxDelayMs ?? 10_000;
  const redial = new HandshakeRedial(reconnectMinMs, reconnectMaxMs, () => {
    if (!client.connected) client.connect();
  });
  // A never-connected lane has been down since construction.
  let notConnectedSince: string | null = nowIso();

  const client = createRealtimeClient(wireContract, {
    url: config.url,
    peers: { client: loadLanePeer },
    auth: () => ({
      nodeId: config.nodeId,
      token: config.token,
      serves: config.serves,
      version: RELEASE_VERSION,
    }),
    withCredentials: false,
    transports: ['websocket', 'polling'],
    reconnectionDelay: reconnectMinMs,
    reconnectionDelayMax: reconnectMaxMs,
    onRejected: (event) => {
      wireLogger.error('[wire] realtime event rejected', {
        lane: config.id,
        direction: event.direction,
        event: event.event,
        error: event.error,
      });
    },
    onConnectError: (error) => {
      // A failed dial is a settled release check, not an unobserved state.
      lastCheck = { at: nowIso(), ok: false, latest: null };
      // A dial that never lands produces no disconnect event, so its reason is recorded here.
      lastFailure = { at: nowIso(), reason: error.message, refused: error.terminal };
      onConnectionChange();
      wireLogger.error('[wire] connection failed', { lane: config.id, refused: error.terminal, error });
      // Socket.IO stops dialling after a handshake refusal; this lane does not.
      if (error.terminal) redial.refused();
    },
    onDroppedEmit: ({ event }) => {
      wireLogger.error(`[wire:${config.id}] dropped '${event}' — not connected to the broker`);
    },
  });

  const services = new ServiceLane(
    config.nodeId,
    serviceExecutor,
    {
      call: (request) => client.emit('service:call', request),
      cancel: (id, to, origin) => {
        client.emit('service:cancel', { id, to, origin });
      },
      result: (result) => {
        client.emit('service:result', result);
      },
    },
    traceService,
  );
  client.on('service:invoke', (call) => services.invoke(call));
  client.on('service:result', (result) => services.result(result));
  client.on('service:cancel', (cancel) => {
    if (cancel.to === config.nodeId) services.cancel(cancel.id, cancel.origin);
  });
  const producers = new StreamProducerManager(
    config,
    {
      chunk: (chunk) =>
        laneStreamAck((resolve) => client.emit('stream:chunk', StreamChunkSchema.parse(chunk), resolve)),
      end: (end) =>
        laneStreamAck((resolve) => client.emit('stream:end', StreamEndSchema.parse(end), resolve)),
      error: (error) =>
        laneStreamAck((resolve) => client.emit('stream:error', StreamErrorSchema.parse(error), resolve)),
    },
    streamAdmission,
    serviceExecutor,
  );

  client.on('node:presence', (node) => presence.update(node));
  const probes = new LanePeerProbes(client);
  const rpc = new LaneRpc(config, client, executionAdmission);
  const control = createLaneControl(client, config.id);
  bindLaneStreams(client, consumers, producers);
  bindLaneEventDelivery(client, eventConsumers);
  client.onConnectionChange((connected, reason) => {
    if (connected) presence.connect((accept) => client.emit('nodes:list', accept));
    else presence.disconnect();
    // Every attempt is stamped, success or failure. `latest` is set only on success, and it is the
    // one thing an admitted node may conclude: a broker admits nothing but its own version, so
    // being let in IS confirmation of what the fleet runs. A refusal teaches nothing — the
    // handshake gives an unauthenticated peer no text — so the knowledge stays null.
    lastCheck = { at: nowIso(), ok: connected, latest: connected ? RELEASE_VERSION : null };
    // A lost connection is never a refusal: socket.io keeps dialing. `refused` belongs to a handshake,
    // which arrives through `onConnectError` and not here.
    lastFailure = connected ? null : { at: nowIso(), reason: reason ?? 'unknown', refused: false };
    if (connected) redial.connected();
    notConnectedSince = connected ? null : nowIso();
    wireLogger.info('[wire] lane connection changed', {
      lane: config.id,
      connected,
      url: config.url,
      node: config.nodeId,
      reason: reason ?? null,
    });
    // The lifecycle kernel learns about a lane the moment the lane does. Deriving it from a poll
    // would put a timer between the fact and the report, and the fact is already an event here.
    onConnectionChange();
    if (connected) return;
    probes.disconnect();
    rpc.disconnect();
    for (const consumer of consumers.values()) {
      consumer.pushFailure({
        streamId: consumer.streamId,
        from: 'broker',
        ...transportFailure('lane-lost-after-dispatch', 'lost the broker connection while streaming'),
        reason: 'disconnect',
      });
    }
    consumers.clear();
    for (const consumer of eventConsumers.values()) {
      consumer.push({
        subscriptionId: consumer.subscriptionId,
        topic: consumer.topic,
        from: 'broker',
        ...transportFailure('lane-lost-after-dispatch', 'lost the broker connection while subscribed'),
      });
    }
    eventConsumers.clear();
    publishAdmission.disconnect();
    services.disconnect();
    void producers.stop();
  });

  const openStream = (request: LocalStreamRequest): AsyncIterableIterator<StreamConsumerEvent> =>
    openLaneStream(
      {
        nodeId: config.nodeId,
        defaultTimeoutMs: config.defaultTimeoutMs,
        maxBufferedBytes: config.admission.maxStreamBufferedBytes,
      },
      consumers,
      streamSlots,
      {
        window: (window) =>
          laneStreamAck((resolve) => client.emit('stream:window', StreamWindowSchema.parse(window), resolve)),
        cancel: (cancel) =>
          laneStreamAck((resolve) => client.emit('stream:cancel', StreamCancelSchema.parse(cancel), resolve)),
        open: (message, acknowledge) => client.emit('stream:open', message, acknowledge),
      },
      request,
    );

  const publishEvent = (req: EventPublish, signal?: AbortSignal): Promise<EventAck> => {
    const denied = eventTopicRefusal(topicAllowance(config.events, 'publish'), req.topic, 'publish');
    if (denied !== null) return Promise.resolve(rejectedEventAck(denied));
    const start = performance.now();
    // Zero because this IS the start of the measurement, stated rather than defaulted — the same
    // truthful zero `door-received` passes. A default would have made this indistinguishable from
    // a phase whose measurement went missing.
    trace?.(req, 'lane-dispatch', { lane: config.id, elapsedMs: 0 });
    return publishAdmission
      .dispatch(
        () =>
          client.request('event:publish', req, {
            timeoutMs: config.admission.publishAckTimeoutMs,
            onPhase: publicationRequestObserver(trace, req, config.id),
          }),
        signal,
      )
      .then((ack) => {
        trace?.(req, 'lane-result', {
          lane: config.id,
          elapsedMs: performance.now() - start,
          outcome: ack.ok ? 'accepted' : ack.refusal !== 'none' ? 'refused' : 'failed',
        });
        return ack;
      });
  };

  const subscribeEvents = (request: LocalEventSubscribe): AsyncIterableIterator<EventDelivery> =>
    openLaneEventSubscription(
      {
        nodeId: config.nodeId,
        allowance: topicAllowance(config.events, 'subscribe'),
        maxBuffered: config.admission.maxEventBufferedPerSubscription,
      },
      eventConsumers,
      eventSlots,
      {
        subscribe: (message, acknowledge) => client.emit('event:subscribe', message, acknowledge),
        unsubscribe: (message, acknowledge) => client.emit('event:unsubscribe', message, acknowledge),
      },
      request,
    );

  const status = async (): Promise<AgentStatus> =>
    laneStatus({
      config,
      origin,
      connected: client.connected,
      lastCheck,
      lastFailure,
      notConnectedSince,
      eventConsumers: eventConsumers.values(),
      pendingPublishes: publishAdmission.status().pending,
      nodes: presence.list(),
      presenceReady: presence.ready,
      presencePending: presence.pending,
    });

  client.connect();

  const agent: LaneAgent = {
    invokeService: (request, signal) => services.call(request, signal),
    presence,
    probePeer: (to) => probes.probe(to),
    call: (request, signal) => rpc.call(request, signal),
    openStream,
    publishEvent,
    subscribeEvents,
    ...control,
    status,
    get connected() {
      return client.connected;
    },
    get terminal() {
      return lastFailure?.refused === true;
    },
    drainLocal: async () => {
      streamSlots.stopAdmission();
      eventSlots.stopAdmission();
      services.disconnect('agent-shutdown');
      await serviceExecutor.drain();
      probes.disconnect();
      await rpc.drain();
      await Promise.all([...consumers.values()].map((consumer) => consumer.return()));
      consumers.clear();
      await Promise.all([...eventConsumers.values()].map((consumer) => consumer.return()));
      eventConsumers.clear();
    },
    stop: async () => {
      redial.stop();
      await agent.drainLocal();
      await producers.stop(true);
      publishAdmission.disconnect();
      client.disconnect();
    },
  };
  return agent;
}
