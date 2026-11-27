import { existsSync } from 'node:fs';
import { LOCAL_API_VERSION } from '../../../contracts/src/door/common.ts';
import type { Presence } from '../../../contracts/src/protocol/presence.ts';
import type { NodeConfig } from '../config/node.ts';
import { RELEASE_VERSION } from '../release-version.ts';
import type { AgentStatus, ConfigOrigin } from './agent-contract.ts';
import { configReport } from './config-report.ts';
import { subscriptionSnapshot } from './event-subscriptions.ts';

/**
 * What this node can say about itself, as a projection rather than a closure.
 *
 * It lived inside `createLaneAgent`, reading six of that function's locals. Reading state and
 * returning a shape is not connection work, and keeping it there is part of why the lane could
 * not be opened without reading all of it.
 */
interface LaneStatusInputs {
  readonly config: NodeConfig & { url: string; id: string; serves: boolean };
  readonly origin: ConfigOrigin | undefined;
  readonly connected: boolean;
  readonly lastCheck: { at: string; ok: boolean; latest: string | null } | null;
  readonly lastFailure: { at: string; reason: string; refused: boolean } | null;
  readonly notConnectedSince: string | null;
  readonly eventConsumers: Iterable<{ subscriptionId: string; topic: string }>;
  readonly pendingPublishes: number;
  readonly nodes: Presence[];
  readonly presenceReady: boolean;
  readonly presencePending: boolean;
}

export function laneStatus(inputs: LaneStatusInputs): AgentStatus {
  const {
    config,
    origin,
    connected,
    lastCheck,
    lastFailure,
    notConnectedSince,
    eventConsumers,
    pendingPublishes,
    nodes,
    presenceReady,
    presencePending,
  } = inputs;
  /**
   * Silence is a diagnosis of its own.
   *
   * A refused dial answers in milliseconds — `websocket error`, which the transport gives for a
   * closed port and an unresolvable host alike, so the text cannot separate those two and must not
   * pretend to. What it CAN separate is refusal from silence: a firewall that DROPS packets, which
   * is what a fail2ban ban does, produces no error at all — the dial simply stays open. Measured
   * 2026-09-01: without a name that case showed `down` with no reason for hours, and it is exactly
   * the case an operator needs named, because the two have different repairs.
   *
   * Three seconds: a broker that is merely restarting is back well inside that, so this does not
   * shout at an ordinary rollout.
   */
  const silentFor = notConnectedSince === null ? 0 : Date.now() - Date.parse(notConnectedSince);
  const subscriptions = subscriptionSnapshot(eventConsumers);
  const failure =
    lastFailure ??
    (silentFor >= 3_000 && notConnectedSince !== null
      ? {
          at: notConnectedSince,
          reason: `no answer from the broker for ${Math.round(silentFor / 1000)}s — the dial is open and nothing has refused it, which is what a dropped packet looks like`,
          refused: false,
        }
      : null);
  return {
    v: LOCAL_API_VERSION,
    nodeId: config.nodeId,
    connected,
    lanes: [
      {
        id: config.id,
        url: config.url,
        connected,
        eventSubscriptions: {
          observedAt: subscriptions.observedAt,
          activeSubscriptions: subscriptions.activeSubscriptions,
        },
        serves: config.serves,
        nodesVisible: nodes.length,
        presence: !connected
          ? 'disconnected'
          : presenceReady
            ? 'ready'
            : presencePending
              ? 'pending'
              : 'unavailable',
        // A connected lane reports no failure even if one is still remembered: the question the
        // field answers is "why is this lane not up", and an up lane has no answer to give.
        lastFailure: connected ? null : failure,
      },
    ],
    serves: config.serves,
    version: RELEASE_VERSION,
    release: {
      current: RELEASE_VERSION,
      latest: lastCheck?.ok === true ? lastCheck.latest : null,
      // Ours does not carry a publication date, and inventing one would be worse than the gap.
      latestAt: null,
      checkedAt: lastCheck?.at ?? null,
      // Never asked is not "the last attempt succeeded". The pair `checkedAt: null, ok: false`
      // says "nothing has confirmed this yet" without ever claiming a success that did not
      // happen, and it agrees with what the broker's aggregate says about the same machine.
      ok: lastCheck?.ok ?? false,
    },
    allow: Object.entries(config.allow)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, profile]) => ({
        name,
        path: profile.bin,
        present: existsSync(profile.bin),
        cwd: profile.cwd ?? null,
        cwdPresent: profile.cwd === undefined || existsSync(profile.cwd),
        callerArgs: profile.callerArgs.mode,
        stdin: profile.stdin.mode,
        timeoutMs: profile.timeoutMs,
        outputBytes: profile.outputBytes,
        concurrency: profile.concurrency,
      })),
    streams: Object.entries(config.streams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, profile]) => ({
        name,
        path: profile.bin,
        present: existsSync(profile.bin),
        cwd: profile.cwd ?? null,
        cwdPresent: profile.cwd === undefined || existsSync(profile.cwd),
        format: profile.format.mode,
        stableCursor: profile.format.mode === 'ndjson' && profile.format.stableCursor,
        timeoutMs: profile.timeoutMs,
        maxBytes: profile.maxBytes,
        concurrency: profile.concurrency,
      })),
    events: {
      publish: [...config.events.publish].sort(),
      subscribe: [...config.events.subscribe].sort(),
      namespaces: {
        publish: [...config.events.namespaces.publish].sort(),
        subscribe: [...config.events.namespaces.subscribe].sort(),
      },
      // Declarations belong to the node, not to one lane; the multi-homed agent fills them in.
      declarations: { descriptors: [], refused: [], lanes: [] },
      ...subscriptions,
      pendingPublishes,
    },
    services: {
      namespaces: [...config.services.namespaces].sort(),
      // Like topic declarations, these belong to the node; the multi-homed agent fills them in.
      declarations: { descriptors: [], refused: [], lanes: [] },
    },
    // Like declarations, the bundle belongs to the node; the multi-homed agent fills it in.
    bundle: {
      copy: 'none',
      serial: null,
      issuedAt: null,
      signer: null,
      config: 'unconfigured',
      detail: null,
      checkedAt: null,
      lanes: [],
    },
    config: configReport(origin),
    admission: {
      maxInflight: config.admission.maxInflight,
      maxCallsPerMinute: config.admission.maxCallsPerMinute,
      maxStreamProducers: config.admission.maxStreamProducers,
      maxStreamConsumers: config.admission.maxStreamConsumers,
      maxStreamBufferedBytes: config.admission.maxStreamBufferedBytes,
      maxEventSubscriptions: config.admission.maxEventSubscriptions,
      maxPendingPublishes: config.admission.maxPendingPublishes,
      maxPublishesPerMinute: config.admission.maxPublishesPerMinute,
    },
    nodes,
  };
}
