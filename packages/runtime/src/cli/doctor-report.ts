import { z } from 'zod';
import type { AuditStatus } from '../../../local-client/src/contracts.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';

const DiagnosticCheckSchema = z.object({
  code: z.string(),
  level: z.enum(['ok', 'warn', 'fail', 'unknown']),
  detail: z.string(),
});
export const DoctorReportSchema = z.object({
  v: z.literal(1),
  scope: z.enum(['node', 'broker']),
  capturedAt: z.iso.datetime(),
  verdict: z.enum(['ok', 'warn', 'fail', 'unknown']),
  exitCode: z.number().int().min(0).max(3),
  checks: z.array(DiagnosticCheckSchema),
});
export type DiagnosticCheck = z.infer<typeof DiagnosticCheckSchema>;
type DoctorReport = z.infer<typeof DoctorReportSchema>;

export function doctorReport(scope: DoctorReport['scope'], checks: DiagnosticCheck[]): DoctorReport {
  const verdict = checks.some((check) => check.level === 'fail')
    ? 'fail'
    : checks.length === 0 || checks.some((check) => check.level === 'unknown')
      ? 'unknown'
      : checks.some((check) => check.level === 'warn')
        ? 'warn'
        : 'ok';
  return DoctorReportSchema.parse({
    v: 1,
    scope,
    capturedAt: nowIso(),
    verdict,
    exitCode: { ok: 0, warn: 1, fail: 2, unknown: 3 }[verdict],
    checks,
  });
}

export function auditChecks(
  audit:
    | (Pick<AuditStatus, 'dropped' | 'writeFailures' | 'queued' | 'recovery'> & {
        journal: Pick<AuditStatus['journal'], 'bytes' | 'maxBytes'>;
      })
    | undefined,
  code = 'audit',
): DiagnosticCheck[] {
  if (!audit) return [{ code, level: 'unknown', detail: 'Audit observation is unavailable' }];
  const checks: DiagnosticCheck[] = [
    {
      code,
      level:
        audit.dropped > 0 || audit.writeFailures > 0 || audit.journal.bytes > audit.journal.maxBytes
          ? 'fail'
          : 'ok',
      detail: `dropped=${audit.dropped}, writeFailures=${audit.writeFailures}, queued=${audit.queued}, bytes=${audit.journal.bytes}/${audit.journal.maxBytes}`,
    },
  ];
  if (audit.recovery)
    checks.push({
      code: `${code}.recovery`,
      level: 'warn',
      detail: `startup filesChecked=${audit.recovery.filesChecked}, anomalies=${audit.recovery.anomalies}, skippedBytes=${audit.recovery.skippedBytes}, first=${audit.recovery.firstAnomaly?.reason ?? 'none'}, last=${audit.recovery.lastAnomaly?.reason ?? 'none'}; normal retention still applies`,
    });
  const quarantined = audit.recovery?.quarantined ?? [];
  const unlisted = audit.recovery?.quarantinedUnlisted ?? 0;
  if (quarantined.length > 0)
    checks.push({
      code: `${code}.quarantined`,
      level: 'warn',
      detail: `${quarantined.length + unlisted} file(s) set aside, never deleted: ${quarantined.map((item) => item.quarantinedAs).join(', ')}${unlisted > 0 ? `, and ${unlisted} more` : ''}; remove them once reviewed`,
    });
  return checks;
}
