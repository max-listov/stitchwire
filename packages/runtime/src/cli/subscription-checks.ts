import type { StatusResult } from '../../../local-client/src/contracts.ts';
import type { DiagnosticCheck } from './doctor-report.ts';

export function subscriptionChecks(status: StatusResult): DiagnosticCheck[] {
  const limit = status.admission.maxEventSubscriptions;
  const used = status.events.activeSubscriptions;
  const threshold = Math.ceil(limit * 0.75);
  const checks: DiagnosticCheck[] = [
    {
      code: 'subscriptions',
      level: limit <= 0 || used >= limit ? 'fail' : used >= threshold ? 'warn' : 'ok',
      detail: `Logical subscription slots: ${used}/${limit}, free=${Math.max(0, limit - used)}, headroom threshold=75% (${threshold}), ${used >= limit ? 'exhausted' : 'not exhausted'}, observedAt=${status.events.observedAt}`,
    },
  ];
  for (const topic of status.events.topics)
    checks.push({
      code: 'subscriptions.topic',
      level: 'ok',
      detail: `${topic.topic}: ${topic.activeSubscriptions} logical readers`,
    });
  for (const lane of status.lanes)
    checks.push({
      code: 'subscriptions.lane',
      level: lane.connected ? 'ok' : 'unknown',
      detail: `${lane.id}: ${lane.eventSubscriptions.activeSubscriptions} local lane handles, broker ${lane.connected ? 'connected' : 'unavailable'}, observedAt=${lane.eventSubscriptions.observedAt}`,
    });
  return checks;
}
