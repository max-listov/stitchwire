import type { BrokerHealth } from '../../../local-client/src/contracts.ts';
import { EVENT_LOOP_DELAY_WARN_MS } from '../broker/event-loop-delay.ts';
import { topicSilenceState } from '../topic-silence.ts';
import { auditChecks, type DiagnosticCheck } from './doctor-report.ts';

/** A rejection within this window still describes the topic now; an older one is history. */
const RECENT_REJECTION_MS = 15 * 60_000;

/** A block a broker of another release does not write is not measured here: the check is unknown. */
function unwritten(code: string, block: string): DiagnosticCheck {
  return { code, level: 'unknown', detail: `this broker writes no ${block} block` };
}

function applicationCheck(application: BrokerHealth['application']): DiagnosticCheck {
  if (application === undefined) return unwritten('broker.application', 'application');
  return {
    code: 'broker.application',
    level:
      !application.ready || application.resources.failed > 0
        ? 'fail'
        : application.health !== 'healthy' || application.resources.degraded > 0
          ? 'warn'
          : 'ok',
    detail: `ready=${application.ready}, health=${application.health}`,
  };
}

function transportChecks(transport: BrokerHealth['transport']): DiagnosticCheck[] {
  if (transport === undefined)
    return [
      unwritten('broker.event-loop-delay', 'transport'),
      unwritten('broker.last-disconnect', 'transport'),
    ];
  return [
    delayCheck(transport.broker, transport.eventLoopDelay),
    {
      code: 'broker.last-disconnect',
      // Null is a measured fact within `observingSince`, not a failed read. The horizon below keeps
      // it from making any claim about time before this broker process started.
      level: 'ok',
      detail:
        transport.lastDisconnect === null
          ? `${transport.broker}: no disconnect observed since broker start`
          : `${transport.broker}: ${transport.lastDisconnect.nodeId} at ${transport.lastDisconnect.observedAt}, reason=${transport.lastDisconnect.reason}`,
    },
  ];
}

function delayCheck(
  broker: string,
  delay: NonNullable<BrokerHealth['transport']>['eventLoopDelay'],
): DiagnosticCheck {
  const code = 'broker.event-loop-delay';
  switch (delay.state) {
    case 'unknown':
      return { code, level: 'unknown', detail: `${broker}: event-loop delay has not been sampled` };
    case 'unrecognized':
      return {
        code,
        level: 'unknown',
        detail: `${broker}: event-loop delay in a state this release does not know`,
      };
    case 'measured':
      return {
        code,
        level: delay.maxMs >= EVENT_LOOP_DELAY_WARN_MS ? 'warn' : 'ok',
        detail: `${broker}: lastMs=${delay.lastMs.toFixed(1)}, maxMs=${delay.maxMs.toFixed(1)} over the last ${Math.round(delay.windowMs / 1000)}s, sampledAt=${delay.sampledAt}`,
      };
    default:
      return delay satisfies never;
  }
}

function bundleChecks(bundle: BrokerHealth['bundle']): DiagnosticCheck[] {
  if (bundle === undefined) return [unwritten('broker.bundle', 'bundle')];
  const check = (level: DiagnosticCheck['level'], detail: string): DiagnosticCheck[] => [
    { code: 'broker.bundle', level, detail },
  ];
  const detail = bundle.detail ?? bundle.config;
  switch (bundle.config) {
    // Silent when this broker keeps no bundle: its tables are edited by hand.
    case 'unconfigured':
      return [];
    case 'aligned':
      return check(
        bundle.serial === null ? 'unknown' : 'ok',
        `edition ${bundle.serial} signed by ${bundle.signer}; the tables this broker runs match it`,
      );
    case 'drifted':
      return check(bundle.serial === null ? 'unknown' : 'fail', detail);
    case 'unknown':
      return check('unknown', detail);
    case 'unrecognized':
      return check(
        'unknown',
        `bundle state this release does not know${bundle.detail === null ? '' : `: ${bundle.detail}`}`,
      );
    default:
      return bundle.config satisfies never;
  }
}

function topicChecks(topic: BrokerHealth['topics'][number]): DiagnosticCheck[] {
  const silence = topicSilenceState(topic);
  return [
    {
      code: 'topic.publication',
      level: silence === 'unknown-policy' ? 'unknown' : silence === 'silent' ? 'warn' : 'ok',
      detail: `${topic.topic}: ${silence}`,
    },
    {
      code: 'topic.rejections',
      level:
        topic.rejectedPublishes > 0 && topic.sinceLastRejectionMs === null
          ? 'unknown'
          : topic.sinceLastRejectionMs !== null && topic.sinceLastRejectionMs < RECENT_REJECTION_MS
            ? 'warn'
            : 'ok',
      detail: `${topic.topic}: lifetimeRejected=${topic.rejectedPublishes}, sinceLastRejectionMs=${topic.sinceLastRejectionMs ?? 'none'}`,
    },
    {
      code: 'topic.capacity',
      level: topic.subscribers >= topic.limits.maxSubscribers ? 'warn' : 'ok',
      detail: `${topic.topic}: subscribers=${topic.subscribers}/${topic.limits.maxSubscribers}`,
    },
  ];
}

export function brokerChecks(health: BrokerHealth): DiagnosticCheck[] {
  return [
    { code: 'broker.audit-health', level: health.ok ? 'ok' : 'fail', detail: `ok=${health.ok}` },
    applicationCheck(health.application),
    ...auditChecks(health.audit),
    ...transportChecks(health.transport),
    {
      // Not a verdict: nothing here is wrong. It states how far back "no departure recorded" is
      // worth anything, so a reader does not take a null on a freshly restarted broker as proof
      // that a node has been steadily present.
      code: 'departures.horizon',
      level: 'ok',
      detail: `this broker remembers departures since ${health.observingSince}; a node with none recorded before that is unobserved, not proven present`,
    },
    {
      code: 'subscriptions.recent',
      level: health.events.recent.windowMs > 0 ? 'ok' : 'unknown',
      detail: `admissions=${health.events.recent.count}, measuredWindowMs=${health.events.recent.windowMs}, live=${health.events.subscriptions}; alert threshold belongs to the operator`,
    },
    ...bundleChecks(health.bundle),
    ...health.fleet.machines.map(
      (machine): DiagnosticCheck => ({
        code: 'fleet.version',
        level:
          machine.release.current === null
            ? 'unknown'
            : machine.release.current !== health.fleet.latest
              ? 'fail'
              : 'ok',
        detail: `${machine.nodeId}: online=${machine.online}, version=${machine.release.current ?? 'unknown'}, expected=${health.fleet.latest}; required uptime belongs to the operator`,
      }),
    ),
    ...health.topics.flatMap(topicChecks),
  ];
}
