import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiagnosticJournalFrameSchema } from 'stitchkit/application';
import type { WireClient } from '../../packages/local-client/src/client.ts';
import { serviceAuditRecords } from '../../packages/runtime/src/broker/service-audit.ts';
import { withFixtureConfigLock } from '../enrollment-lock.ts';
import { brokerObservation } from '../../packages/runtime/src/enrollment/observe.ts';
import {
  ServiceAuditBatchSchema,
  ServiceAuditRecordSchema,
} from '../../packages/runtime/src/service/audit-schema.ts';
import type { enrollmentStand, ProvenRequest } from '../enrollment-stand.ts';
import { until } from '../support.ts';

/** Read complete physical rows and expand successful batches by the broker's owning decoder. */
export function auditRecords(path: string) {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  return text
    .slice(0, text.lastIndexOf('\n') + 1)
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const value = DiagnosticJournalFrameSchema.parse(JSON.parse(line)).event;
      const direct = ServiceAuditRecordSchema.safeParse(value);
      if (direct.success) return [direct.data];
      const batch = ServiceAuditBatchSchema.safeParse(value);
      return batch.success ? serviceAuditRecords(batch.data) : [];
    });
}

export async function remoteProofControls(
  stand: Awaited<ReturnType<typeof enrollmentStand>>,
  request: ProvenRequest,
  client: WireClient,
  check: (condition: unknown, label: string) => void,
) {
  const audit = join(stand.root, 'audit.jsonl');
  const positive = {
    ...request,
    requestId: crypto.randomUUID(),
    proof: { ...request.proof, call: { ...request.proof.call, traceId: crypto.randomUUID() } },
  };
  check((await stand.cli(positive, 'status')).result.status === 'ready', 'remote enrollment proof succeeds');
  check(
    await until(() => {
      const rows = auditRecords(audit).filter((row) => row.traceId === positive.proof.call.traceId);
      return (
        rows.some(
          (row) =>
            row.from === request.nodeId &&
            row.to === request.proof.call.to &&
            row.phase === 'dispatch' &&
            row.outcome === 'admitted',
        ) &&
        rows.some(
          (row) => row.phase === 'result' && row.outcome === 'received' && row.delivery === 'delivered',
        )
      );
    }, 5000),
    'positive proof traverses broker dispatch and result audit with its exact traceId',
  );
  check(
    stand.ingressTraces.includes(positive.proof.call.traceId),
    'positive proof reaches the real target ingress',
  );
  const original = readFileSync(stand.brokerConfig);
  const target = readFileSync(stand.observer.config);
  const before = (await brokerObservation(stand.url, request.expectedVersion)).observingSince;
  await withFixtureConfigLock(stand.brokerConfig, async () => {
    try {
      // Deliberately drift only this disposable broker. The held shared lock prevents its signed
      // fleet reconciler repairing the negative control before the real CLI proof observes it.
      stand.write(stand.brokerConfig, { ...JSON.parse(original.toString()), serviceGrants: [] });
      check(
        await until(async () => {
          try {
            const health = await brokerObservation(stand.url, request.expectedVersion);
            return (
              health.observingSince !== before &&
              health.nodes.some((node) => node.nodeId === request.nodeId && node.online) &&
              health.nodes.some((node) => node.nodeId === request.proof.call.to && node.online) &&
              (await client.status()).connected
            );
          } catch {
            return false;
          }
        }, 12_000),
        'disposable broker reloads with its proof grant removed',
      );
      const negative = {
        ...request,
        requestId: crypto.randomUUID(),
        proof: { ...request.proof, call: { ...request.proof.call, traceId: crypto.randomUUID() } },
      };
      const reached = stand.reached.length;
      const failure = (await stand.cli(negative, 'status')).result;
      check(
        failure.status === 'failed' && failure.failure.code === 'proof-failed',
        'missing broker grant cannot become successful enrollment proof',
      );
      check(
        await until(() => {
          const rows = auditRecords(audit).filter((row) => row.traceId === negative.proof.call.traceId);
          return (
            rows.some(
              (row) =>
                row.phase === 'result' && row.outcome === 'denied' && row.delivery === 'not-dispatched',
            ) && !rows.some((row) => row.phase === 'dispatch')
          );
        }, 5000),
        'the enrollment proof itself is denied at the broker before dispatch',
      );
      check(
        target.equals(readFileSync(stand.observer.config)) &&
          stand.reached.length === reached &&
          !stand.ingressTraces.includes(negative.proof.call.traceId),
        'target local grant stays intact and denied proof never reaches its ingress',
      );
    } finally {
      writeFileSync(stand.brokerConfig, original);
    }
  });
  check(
    await until(
      async () =>
        (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'status')).result.status === 'ready',
      15_000,
    ),
    'remote proof succeeds again after broker grant restoration',
  );
}
