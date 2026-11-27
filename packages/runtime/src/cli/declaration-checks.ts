import type { StatusResult } from '../../../local-client/src/contracts.ts';
import type { DiagnosticCheck } from './doctor-report.ts';

type DescriptorState = StatusResult['events']['declarations']['descriptors'][number]['state'];

/** A declaration file as the agent read it: loaded is fine, missing or invalid fails, and a state
 * this release does not recognize is unknown — never fine. */
function descriptorLevel(state: DescriptorState): DiagnosticCheck['level'] {
  switch (state) {
    case 'loaded':
      return 'ok';
    case 'missing':
    case 'invalid':
      return 'fail';
    case 'unrecognized':
      return 'unknown';
    default:
      return state satisfies never;
  }
}

/**
 * What became of the topics this node's owners declare.
 *
 * Silent when no descriptor is bound: a node that declares nothing has nothing to report here, and
 * a line saying so would read as a measurement of something that does not exist.
 */
export function declarationChecks(status: StatusResult): DiagnosticCheck[] {
  const { declarations } = status.events;
  if (declarations.descriptors.length === 0) return [];
  const checks: DiagnosticCheck[] = declarations.descriptors.map((descriptor) => ({
    code: 'topics.descriptor',
    level: descriptorLevel(descriptor.state),
    detail:
      descriptor.state === 'loaded'
        ? `${descriptor.path}: ${descriptor.topics} topic(s)`
        : `${descriptor.path}: ${descriptor.state} — ${descriptor.detail ?? 'no detail'}`,
  }));
  for (const refusal of declarations.refused)
    checks.push({
      code: 'topics.declared',
      level: 'warn',
      detail: `${refusal.topic}: not sent — ${refusal.detail}`,
    });
  for (const lane of status.lanes) {
    const answer = declarations.lanes.find((entry) => entry.lane === lane.id);
    if (answer === undefined) {
      checks.push({
        code: 'topics.declared',
        level: 'unknown',
        detail: `${lane.id}: no declaration answered yet`,
      });
      continue;
    }
    checks.push({
      code: 'topics.declared',
      level: answer.refused.length > 0 ? 'warn' : 'ok',
      detail:
        answer.refused.length > 0
          ? `${lane.id}: ${answer.accepted} accepted; refused ${answer.refused
              .map((refusal) => `${refusal.topic} (${refusal.detail})`)
              .join('; ')}`
          : `${lane.id}: ${answer.accepted} accepted at ${answer.declaredAt}`,
    });
  }
  return checks;
}

/**
 * What became of the services this node's owners declare: each declaration as read here, anything
 * refused before a broker saw it, and each broker's answer about who may call. Silent when no
 * declaration is bound, for the same reason as topics.
 */
export function serviceDeclarationChecks(status: StatusResult): DiagnosticCheck[] {
  const { declarations } = status.services;
  if (declarations.descriptors.length === 0) return [];
  const checks: DiagnosticCheck[] = declarations.descriptors.map((descriptor) => ({
    code: 'services.descriptor',
    level: descriptorLevel(descriptor.state),
    detail:
      descriptor.state === 'loaded'
        ? `${descriptor.path}: ${descriptor.service}, ${descriptor.callers} caller grant(s)`
        : `${descriptor.path}: ${descriptor.state} — ${descriptor.detail ?? 'no detail'}`,
  }));
  for (const refusal of declarations.refused)
    checks.push({
      code: 'services.declared',
      level: 'fail',
      detail: `${refusal.service}: not served — ${refusal.detail} (${refusal.path})`,
    });
  for (const lane of status.lanes) {
    const answer = declarations.lanes.find((entry) => entry.lane === lane.id);
    if (answer === undefined) {
      checks.push({
        code: 'services.declared',
        level: 'unknown',
        detail: `${lane.id}: no declaration answered yet`,
      });
      continue;
    }
    checks.push({
      code: 'services.declared',
      level: answer.refused.length > 0 ? 'warn' : 'ok',
      detail:
        answer.refused.length > 0
          ? `${lane.id}: ${answer.accepted} accepted; refused ${answer.refused
              .map((refusal) => `${refusal.service} ← ${refusal.caller} (${refusal.detail})`)
              .join('; ')}`
          : `${lane.id}: ${answer.accepted} accepted at ${answer.declaredAt}`,
    });
  }
  return checks;
}
