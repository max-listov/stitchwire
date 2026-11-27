import {
  MAX_SERVICE_AUDIT_ROWS,
  SERVICE_AUDIT_FLUSH_MS,
  type ServiceAuditBatch,
  type ServiceAuditRecord,
} from '../service/audit-schema.ts';

const MAX_PENDING_ROWS = 1024;
const MAX_PENDING_BYTES = 1024 * 1024;
const MAX_GROUPS = 128;

/** Logical records, not counts: request identity and exact time survive compaction. */
export function serviceAuditRecords(batch: ServiceAuditBatch): ServiceAuditRecord[] {
  const { kind: _kind, rows, calls, ...common } = batch;
  return rows.map(({ call: index, ...row }) => {
    const identity = calls[index];
    if (identity === undefined) throw new Error('unknown service audit call identity');
    return { kind: 'service', ...common, ...identity, ...row };
  });
}

/** Lossless factoring, never semantic read/write inference from an operation name or grant.
 * Failures/cancellations remain individual. Successes still retain every per-call fact, including
 * side effects: only repeated route fields move out of their bounded rows. */
export class ServiceAuditBatcher {
  private readonly groups = new Map<string, ServiceAuditBatch>();
  private rows = 0;
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly write: (record: ServiceAuditRecord | ServiceAuditBatch) => void) {}
  get pendingRows(): number {
    return this.rows;
  }

  record(record: ServiceAuditRecord): void {
    const successful =
      ((record.phase === 'dispatch' && record.outcome === 'admitted' && record.delivery === null) ||
        (record.phase === 'result' && record.outcome === 'received' && record.delivery === 'delivered')) &&
      record.transportCause === null &&
      record.cancellationOrigin === undefined;
    if (!successful) {
      this.flush();
      this.write(record);
      return;
    }
    const { kind: _kind, from, to, service, operation, id, traceId, requestBytes, ...row } = record;
    const common = { from, to, service, operation };
    const key = JSON.stringify(common);
    const bytes = Buffer.byteLength(JSON.stringify(record));
    if (bytes > MAX_PENDING_BYTES) {
      this.flush();
      this.write(record);
      return;
    }
    if (
      this.rows >= MAX_PENDING_ROWS ||
      this.bytes + bytes > MAX_PENDING_BYTES ||
      (!this.groups.has(key) && this.groups.size >= MAX_GROUPS)
    )
      this.flush();
    let batch = this.groups.get(key);
    if (batch === undefined) {
      batch = { kind: 'service-batch', ...common, calls: [], rows: [] };
      this.groups.set(key, batch);
    }
    let index = batch.calls.findIndex(
      (call) => call.id === id && call.traceId === traceId && call.requestBytes === requestBytes,
    );
    if (index < 0) {
      index = batch.calls.length;
      batch.calls.push({ id, requestBytes, ...(traceId === undefined ? {} : { traceId }) });
    }
    batch.rows.push({ ...row, call: index });
    this.rows++;
    this.bytes += bytes;
    if (batch.rows.length === MAX_SERVICE_AUDIT_ROWS) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), SERVICE_AUDIT_FLUSH_MS).unref();
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batches = [...this.groups.values()];
    this.groups.clear();
    this.rows = 0;
    this.bytes = 0;
    for (const batch of batches) {
      const only = batch.rows.length === 1 ? serviceAuditRecords(batch)[0] : undefined;
      this.write(only ?? batch);
    }
  }
}
