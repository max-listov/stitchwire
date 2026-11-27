import type { StatusResult } from '../../../local-client/src/contracts.ts';
import type { DiagnosticCheck } from './doctor-report.ts';

/**
 * What this node knows about the fleet bundle: the edition it keeps, whether the configuration it
 * runs matches it, and which edition each broker answered with. Silent when no fleet trust is
 * configured — that node's configuration is edited by hand, and there is no bundle to measure.
 */
/** Aligned is fine, drifted fails; not yet compared, or a state this release does not recognize, is unknown. */
function configLevel(config: StatusResult['bundle']['config']): DiagnosticCheck['level'] {
  switch (config) {
    case 'aligned':
      return 'ok';
    case 'drifted':
      return 'fail';
    case 'unconfigured':
    case 'unknown':
    case 'unrecognized':
      return 'unknown';
    default:
      return config satisfies never;
  }
}

export function bundleChecks(status: StatusResult): DiagnosticCheck[] {
  const bundle = status.bundle;
  if (bundle.config === 'unconfigured') return [];
  const checks: DiagnosticCheck[] = [
    {
      code: 'bundle.copy',
      level: bundle.serial === null ? 'unknown' : 'ok',
      detail:
        bundle.serial === null
          ? (bundle.detail ?? 'no verified fleet bundle is kept yet')
          : `edition ${bundle.serial} (${bundle.copy}) signed by ${bundle.signer} at ${bundle.issuedAt}`,
    },
    {
      code: 'bundle.config',
      level: configLevel(bundle.config),
      detail:
        bundle.config === 'aligned'
          ? `the fleet tables this node runs match edition ${bundle.serial}`
          : (bundle.detail ?? bundle.config),
    },
  ];
  for (const lane of status.lanes) {
    const answer = bundle.lanes.find((entry) => entry.lane === lane.id);
    if (answer === undefined) {
      checks.push({ code: 'bundle.lane', level: 'unknown', detail: `${lane.id}: not asked yet` });
      continue;
    }
    const behind = (answer.serial ?? 0) < (bundle.serial ?? 0);
    checks.push({
      code: 'bundle.lane',
      level: answer.detail !== null || behind ? 'warn' : 'ok',
      detail:
        answer.detail !== null
          ? `${lane.id}: ${answer.detail}`
          : behind
            ? `${lane.id}: the broker keeps edition ${answer.serial ?? 'none'}, behind this node's ${bundle.serial}`
            : `${lane.id}: the broker keeps edition ${answer.serial ?? 'none'}, answered at ${answer.syncedAt}`,
    });
  }
  return checks;
}
