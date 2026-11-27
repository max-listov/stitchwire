import type { StatusResult } from '../../../local-client/src/contracts.ts';
import { RELEASE_VERSION } from '../release-version.ts';
import { auditChecks, type DiagnosticCheck } from './doctor-report.ts';
import { declarationChecks, serviceDeclarationChecks } from './declaration-checks.ts';
import { subscriptionChecks } from './subscription-checks.ts';
import { bundleChecks } from './bundle-checks.ts';

export function nodeChecks(status: StatusResult, expectedConfig: string): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [
    {
      code: 'link',
      level: status.connected ? 'ok' : 'fail',
      detail: status.connected ? 'Connected' : 'Disconnected',
    },
  ];
  if (status.lanes.length === 0)
    checks.push({ code: 'lanes', level: 'unknown', detail: 'No lane observations' });
  for (const lane of status.lanes)
    checks.push({
      code: 'lane',
      level: lane.connected ? 'ok' : 'fail',
      // `down` on its own names the symptom and hides the one fact the reader came for. The lane
      // already knows whether it was refused, dropped or never answered; say so here.
      detail: lane.connected
        ? `${lane.id}: connected`
        : lane.lastFailure === null
          ? `${lane.id}: down, no failure recorded yet`
          : lane.lastFailure.reason === 'websocket error'
            ? // The transport gives this one string for a closed port AND for a host that does not
              // resolve — measured on both, byte for byte, and its `description` carries nothing
              // but an untyped ErrorEvent. Naming one of them would send an operator to fix the
              // wrong thing with a confident voice, which is worse than the vague text. So both are
              // named, and the third cause — a dropped packet — is excluded because it produces no
              // error here at all.
              `${lane.id}: down — connection refused or host did not resolve, since ${lane.lastFailure.at}`
            : `${lane.id}: down — ${lane.lastFailure.reason}${
                lane.lastFailure.refused ? ' (refused by the broker, retrying)' : ''
              } since ${lane.lastFailure.at}`,
    });
  for (const [kind, profiles] of [
    ['command', status.allow],
    ['stream', status.streams],
  ] satisfies Array<[string, typeof status.allow | typeof status.streams]>) {
    for (const profile of profiles) {
      checks.push({
        code: `${kind}.endpoint`,
        level: profile.present ? 'ok' : 'fail',
        detail: `${profile.name}: endpoint ${profile.present ? 'present' : 'missing'}`,
      });
      checks.push({
        code: `${kind}.cwd`,
        level: profile.cwdPresent ? 'ok' : 'fail',
        detail: `${profile.name}: working directory ${profile.cwdPresent ? 'present' : 'missing'}`,
      });
    }
  }
  const config = status.config;
  checks.push({
    code: 'config',
    level: !config ? 'unknown' : config.path !== expectedConfig || config.mode !== '600' ? 'fail' : 'ok',
    detail: !config
      ? 'Loaded configuration identity unavailable'
      : config.path !== expectedConfig
        ? 'Loaded configuration differs from the selected configuration'
        : config.mode !== '600'
          ? 'Configuration is absent or has unsafe permissions'
          : 'Configuration identity and permissions match',
  });
  checks.push(...subscriptionChecks(status));
  checks.push(...declarationChecks(status));
  checks.push(...serviceDeclarationChecks(status));
  checks.push(...bundleChecks(status));
  const app = status.application;
  checks.push({
    code: 'application',
    level: !app
      ? 'unknown'
      : !app.ready || app.resources.failed > 0
        ? 'fail'
        : app.health !== 'healthy' || app.resources.degraded > 0
          ? 'warn'
          : 'ok',
    detail: app ? `ready=${app.ready}, health=${app.health}` : 'Lifecycle observation unavailable',
  });
  checks.push(...auditChecks(status.publicationAudit));
  if (status.serviceAudit) checks.push(...auditChecks(status.serviceAudit, 'service-audit'));
  checks.push({
    code: 'version',
    level: status.version === RELEASE_VERSION ? 'ok' : 'fail',
    detail: `agent=${status.version}, inspector=${RELEASE_VERSION}`,
  });
  checks.push({
    code: 'release',
    level:
      status.release?.latest == null || !status.release.ok
        ? 'unknown'
        : status.release.latest === status.version
          ? 'ok'
          : 'fail',
    detail:
      status.release?.latest == null || !status.release.ok
        ? 'Current fleet release is not confirmed'
        : `observed fleet=${status.release.latest}`,
  });
  if (status.serves && status.connected)
    checks.push({
      code: 'serving',
      level: status.nodes.some((node) => node.nodeId === status.nodeId && node.online && node.serves)
        ? 'ok'
        : 'fail',
      detail: 'Serving identity must be visible at the broker',
    });
  return checks;
}
