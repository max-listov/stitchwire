import { z } from 'zod';

const FindingSchema = z.object({
  path: z.string(),
  label: z.string(),
  offset: z.number().int().nonnegative(),
});
/** The report of an audit that looked at everything: the inventory, the history and credentials. */
export const CompleteReportSchema = z.object({
  kind: z.literal('content-inventory'),
  inventoryNamed: z.literal(true),
  rules: z.number().int().positive(),
  findings: z.array(FindingSchema),
  historyReviewed: z.literal(true),
  history: z.object({
    findings: z.array(FindingSchema.extend({ blob: z.string() })),
    blobs: z.number().int().nonnegative(),
  }),
  secretAudit: z.literal(true),
  secrets: z.object({
    findings: z.array(
      FindingSchema.extend({ where: z.enum(['tree', 'history']), blob: z.string().optional() }),
    ),
    envFiles: z.array(z.string()),
    blobs: z.number().int().nonnegative(),
  }),
});

/** A crashed/partial audit cannot become zero findings. Exit1 is valid only for a complete red report. */
export function completedContentAudit(value: unknown, exitCode: number | null) {
  const report = CompleteReportSchema.parse(value);
  const bad =
    report.findings.length +
    report.history.findings.length +
    report.secrets.findings.length +
    report.secrets.envFiles.length;
  if (exitCode !== (bad > 0 ? 1 : 0)) throw new Error('content audit exit and complete report disagree');
  return report;
}
