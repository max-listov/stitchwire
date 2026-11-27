import { createRevisionSignal } from 'stitchkit/application';
import type { LocalCall, LocalStreamRequest } from '../../../contracts/src/door/requests.ts';
import type { PeerObservation, PeerRequest } from '../../../contracts/src/peer-contract.ts';
import {
  type Refused,
  transportFailure,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import type { Presence } from '../../../contracts/src/protocol/presence.ts';
import { bestKnownRelease } from '../../../contracts/src/protocol/release.ts';
import { type Result, syntheticResult } from '../../../contracts/src/protocol/rpc.ts';
import { serviceFailure } from '../../../contracts/src/service/contracts.ts';
import { dropInDirs } from '../config/drop-in.ts';
import type { BrokerEndpoint, NodeConfig } from '../config/node.ts';
import type { SelfReload } from '../fleet/reconcile.ts';
import { RELEASE_VERSION } from '../release-version.ts';
import { serviceAbortOrigin } from '../service/cancellation.ts';
import { ServiceExecutor } from '../service/executor.ts';
import type { TraceService } from '../service/trace.ts';
import { ExecutionAdmission, streamExecutionAdmission } from './admission.ts';
import type { Agent, AgentStatus, ConfigOrigin, LaneAgent, LaneHealth } from './agent-contract.ts';
import { createLaneAgent } from './broker-lane.ts';
import { topicAllowance } from './event-policy.ts';
import { EventSubscriptions } from './event-subscriptions.ts';
import { FleetFollower } from './fleet-follower.ts';
import type { LaneRetryPolicy } from './lane-event-iterator.ts';
import { TargetLaneSelector } from './lane-routing.ts';
import { LocalEventBus } from './local-events.ts';
import { MultiHomePublisher } from './multi-home-publisher.ts';
import { PeerObserver } from './peer-observation.ts';
import { mergePresence } from './presence.ts';
import type { TracePublication } from './publication-trace.ts';
import { RequestDeadline } from './request-deadline.ts';
import { RoutedStream } from './routed-stream.ts';
import { ServiceDeclarer } from './service-declarations.ts';
import type { StreamConsumerEvent } from './stream-consumer.ts';
import { TopicDeclarer } from './topic-declarations.ts';

/** Intervals a test shortens so it waits for the condition rather than for a production timer. */
interface AgentTiming {
  /** How often owners' declaration files are re-read. */
  declarationPollMs?: number;
  /** The pause policy of an event subscription that lost its lane. */
  subscriptionRetry?: LaneRetryPolicy;
}
/** Why nothing could be dispatched: no lane was connected, or presence never became authoritative. */
function noLaneFailure(cause: 'no-connected-lane' | 'presence-pending-timeout'): Refused {
  return transportFailure(
    cause,
    cause === 'presence-pending-timeout'
      ? 'broker presence did not become authoritative before dispatch deadline'
      : 'no broker lane connected before dispatch deadline',
  );
}

interface BrokerLane {
  endpoint: BrokerEndpoint;
  agent: LaneAgent;
}

/** The node's side of the wire: one lane per configured broker, merged behind a single agent handle. */
export function createAgent(
  config: NodeConfig,
  origin?: ConfigOrigin,
  onLaneHealth: (health: LaneHealth) => void = () => {},
  trace?: TracePublication,
  /** Restart this agent from its configuration file. Absent, a rewritten file waits for a restart. */
  reload?: SelfReload,
  traceService?: TraceService,
  timing: AgentTiming = {},
): Agent {
  const dropIn = dropInDirs(config, origin?.path);
  /** The fleet bundle this node keeps, and the configuration it projects. */
  const fleet = new FleetFollower(config.nodeId, config.fleet, config, origin?.path, reload);
  const serviceExecutor = new ServiceExecutor(config.services, config.nodeId, undefined, traceService);
  const executionAdmission = new ExecutionAdmission(config.admission, config.allow);
  const streamAdmission = streamExecutionAdmission(config, dropIn.services !== undefined);
  const availability = createRevisionSignal({ maxWaiters: 4_096 });
  const report = (): void =>
    onLaneHealth({ connected: lanes.filter((lane) => lane.agent.connected).length, total: lanes.length });
  /** Topics this node's owners declare, told to every broker lane as it connects. */
  const declarer = new TopicDeclarer(config.nodeId, config.events, timing.declarationPollMs, dropIn.events);
  /** Services this node's owners declare: served here, and their callers told to every broker lane. */
  const serviceDeclarer = new ServiceDeclarer(
    config.nodeId,
    config.services,
    (policy) => serviceExecutor.usePolicy(policy),
    timing.declarationPollMs,
    dropIn.services,
  );
  const lanes: BrokerLane[] = config.brokers.map((endpoint) => ({
    endpoint,
    agent: createLaneAgent(
      { ...config, ...endpoint },
      executionAdmission,
      streamAdmission,
      origin,
      () => {
        report();
        availability.advance();
        declarer.laneChanged(endpoint.id);
        serviceDeclarer.laneChanged(endpoint.id);
        fleet.laneChanged(endpoint.id);
      },
      serviceExecutor,
      trace,
      traceService,
    ),
  }));
  for (const lane of lanes) {
    declarer.attach(lane.endpoint.id, lane.agent);
    serviceDeclarer.attach(lane.endpoint.id, lane.agent);
    fleet.attach(lane.endpoint.id, lane.agent);
    lane.agent.onFleetOffer((serial) => fleet.offered(lane.endpoint.id, serial));
  }
  declarer.start();
  serviceDeclarer.start();
  fleet.start();
  // Stated once at construction: a lane that never manages to connect never fires a connection
  // change either, so without this a node that reached nothing would have nothing to report.
  report();
  const selector = new TargetLaneSelector(
    lanes.map((lane) => lane.agent),
    availability,
  );
  const peerObserver = new PeerObserver(config.nodeId);
  const observePeer = async (request: PeerRequest): Promise<PeerObservation> => {
    const candidates = lanes.filter(
      (lane) => request.route === undefined || lane.endpoint.id === request.route,
    );
    if (candidates.length === 0) return peerObserver.unavailable(request.to, 'unsupported');
    // Stable declared order keeps cache hits on one route. Explicit route never retries elsewhere.
    const lane =
      candidates.find((lane) => lane.agent.connected && lane.agent.presence.serves(request.to)) ??
      candidates.find((lane) => lane.agent.connected);
    if (!lane) return peerObserver.unavailable(request.to, 'offline');
    return peerObserver.read(request, {
      id: lane.endpoint.id,
      url: lane.endpoint.url,
      epoch: (target) => lane.agent.presence.epoch(target),
      probe: (target) => lane.agent.probePeer(target),
    });
  };
  /** Delivery that never leaves the machine, sitting beside the broker lanes rather than instead of
   *  them. See `local-events.ts` for why it is a source and not a second path. */
  const localBus = new LocalEventBus();
  const subscriptions = new EventSubscriptions(config, lanes, localBus, timing.subscriptionRetry);
  const publisher = new MultiHomePublisher(
    config.nodeId,
    selector,
    localBus,
    config.admission,
    topicAllowance(config.events, 'publish'),
  );

  const call = async (request: LocalCall, signal?: AbortSignal): Promise<Result> => {
    const budgetMs = request.timeoutMs ?? config.defaultTimeoutMs;
    const deadline = new RequestDeadline(budgetMs);
    const selected = await selector.select(request.to, budgetMs, signal);
    if (selected.state === 'aborted' || signal?.aborted === true)
      return syntheticResult(
        crypto.randomUUID(),
        unclassifiedFailure('cancelled', 'the caller withdrew before dispatch'),
      );
    if (selected.state === 'selected') {
      const timeoutMs = deadline.remaining();
      if (timeoutMs <= 0)
        return syntheticResult(
          crypto.randomUUID(),
          unclassifiedFailure('timeout', 'the request deadline elapsed before dispatch'),
        );
      return selected.lane.call({ ...request, timeoutMs }, signal);
    }
    return syntheticResult(crypto.randomUUID(), noLaneFailure(selected.cause));
  };

  async function* failedStream(
    refused: Refused,
    reason: 'cancelled' | 'timeout' | 'disconnect',
  ): AsyncIterableIterator<StreamConsumerEvent> {
    yield {
      streamId: crypto.randomUUID(),
      from: 'broker',
      reason,
      ...refused,
    };
  }
  const openStream = (request: LocalStreamRequest): AsyncIterableIterator<StreamConsumerEvent> => {
    const budgetMs = request.timeoutMs ?? config.defaultTimeoutMs;
    const deadline = new RequestDeadline(budgetMs);
    const controller = new AbortController();
    return new RoutedStream(
      selector.select(request.to, budgetMs, controller.signal),
      (selected) => {
        if (selected.state === 'aborted')
          return failedStream(
            unclassifiedFailure('cancelled', 'the caller withdrew before stream dispatch'),
            'cancelled',
          );
        if (selected.state === 'unavailable')
          return failedStream(noLaneFailure(selected.cause), 'disconnect');
        const timeoutMs = deadline.remaining();
        if (timeoutMs <= 0)
          return failedStream(
            unclassifiedFailure('timeout', 'the stream deadline elapsed before dispatch'),
            'timeout',
          );
        return selected.lane.openStream({ ...request, timeoutMs });
      },
      () => controller.abort(),
    );
  };

  const status = async (): Promise<AgentStatus> => {
    const statuses = await Promise.all(lanes.map((lane) => lane.agent.status()));
    const first = statuses[0];
    if (first === undefined) throw new Error('parsed node config has no broker lanes');
    const nodes = new Map<string, Presence>();
    for (const laneStatus of statuses) {
      for (const presence of laneStatus.nodes) {
        const current = nodes.get(presence.nodeId);
        if (current === undefined) {
          nodes.set(presence.nodeId, presence);
          continue;
        }
        nodes.set(presence.nodeId, mergePresence(current, presence));
      }
    }
    /**
     * One release standing out of several lanes, and `checkedAt`/`ok` must describe the SAME
     * attempt.
     *
     * Taking the newest timestamp from one lane and the optimistic `ok` from another produced a
     * steady-state lie on a multi-homed node: lane A connected once and went quiet, lane B keeps
     * failing every few seconds, and the pair read as "confirmed, seconds ago" — a failure's
     * freshness attached to a success. So the most recent attempt wins whole, and `latest` is the
     * best any lane actually confirmed, which is a different question and legitimately separate.
     */
    const checks = statuses.map((laneStatus) => laneStatus.release).filter((r) => r !== undefined);
    const attempted = checks.filter((check) => check.checkedAt !== null);
    const newest = attempted
      .sort((left, right) => ((left.checkedAt ?? '') < (right.checkedAt ?? '') ? -1 : 1))
      .at(-1);
    const release = {
      current: RELEASE_VERSION,
      latest: bestKnownRelease(checks.map((check) => check.latest)),
      latestAt: null,
      checkedAt: newest?.checkedAt ?? null,
      // No attempt has settled yet: nothing has succeeded, and saying otherwise is the reassuring
      // reading this whole record exists to refuse. `checkedAt: null` beside it is what says the
      // difference between "asked and failed" and "not asked yet".
      ok: newest?.ok ?? false,
    };
    return {
      ...first,
      connected: statuses.some((laneStatus) => laneStatus.connected),
      release,
      lanes: statuses.flatMap((laneStatus) => laneStatus.lanes),
      events: {
        ...first.events,
        ...subscriptions.snapshot(),
        declarations: declarer.snapshot(),
        pendingPublishes:
          publisher.pending +
          statuses.reduce((total, laneStatus) => total + laneStatus.events.pendingPublishes, 0),
      },
      services: { ...first.services, declarations: serviceDeclarer.snapshot() },
      bundle: fleet.snapshot(),
      nodes: [...nodes.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    };
  };

  const multiHome: Agent = {
    invokeService: async (request, signal) => {
      if (signal?.aborted)
        return serviceFailure(
          'cancelled',
          'not-dispatched',
          null,
          'none',
          undefined,
          serviceAbortOrigin(signal),
        );
      /**
       * A call this node addresses to ITSELF has no reason to cross the wire. The executor that
       * would run it lives here, and so does the grant table that authorises it: `resolveService`
       * reads the same caller/target/operation grant the broker would have read, and additionally
       * checks the binding, the descriptor revision and the limits — which the broker cannot,
       * because it never receives descriptors. So the broker's copy adds no independent authority
       * on this path; it adds distance.
       *
       * And distance is the whole cost. Measured 2026-09-10 on a deployment whose brokers answer
       * in 211 ms: one unary operation addressed to SELF took 422–431 ms through the broker, while
       * the same operation addressed to a REMOTE node — one whose broker runs on its own machine —
       * took 216–229 ms. Calling yourself costs twice as much as calling another continent, because
       * the request travels node → broker → node and the response travels back the same way.
       *
       * `serves: false` takes the broker path deliberately: such a node is not selectable as a target
       * at the broker (`registry.ts`), and a shortcut here would silently start serving what the
       * fleet was told this node does not serve.
       */
      if (request.to === config.nodeId && config.serves)
        return serviceExecutor.execute(
          { ...request, id: crypto.randomUUID(), from: config.nodeId },
          signal ?? new AbortController().signal,
        );
      const deadline = new RequestDeadline(request.timeoutMs);
      const selected = await selector.select(request.to, request.timeoutMs, signal);
      const timeoutMs = deadline.remaining();
      if (selected.state === 'aborted' || signal?.aborted)
        return serviceFailure(
          'cancelled',
          'not-dispatched',
          null,
          'none',
          undefined,
          serviceAbortOrigin(signal),
        );
      if (selected.state === 'unavailable')
        return serviceFailure('unavailable', 'not-dispatched', selected.cause);
      if (timeoutMs <= 0)
        return serviceFailure('timeout', 'not-dispatched', null, 'none', undefined, 'caller-deadline');
      return selected.lane.invokeService({ ...request, timeoutMs }, signal);
    },
    observePeer,
    call,
    openStream,
    publishEvent: (request, signal) => publisher.publish(request, signal),
    subscribeEvents: (request) => subscriptions.open(request),
    status,
    get connected() {
      return lanes.some((lane) => lane.agent.connected);
    },
    drainLocal: async () => {
      executionAdmission.stopAdmission();
      streamAdmission.stopAdmission();
      publisher.stopAdmission();
      declarer.stop();
      serviceDeclarer.stop();
      fleet.stop();
      availability.close();
      // Cancel every lane synchronously before yielding: executor completion must not
      // publish a result through a lane still waiting for unrelated subscription cleanup.
      const laneDrains = lanes.map((lane) => lane.agent.drainLocal());
      const serviceDrain = serviceExecutor.drain();
      await Promise.all([serviceDrain, ...laneDrains, subscriptions.drain()]);
    },
    stop: async () => {
      await multiHome.drainLocal();
      await Promise.all(lanes.map((lane) => lane.agent.stop()));
      await Promise.all([executionAdmission.drain(), streamAdmission.drain(), publisher.drain()]);
    },
  };
  return multiHome;
}
