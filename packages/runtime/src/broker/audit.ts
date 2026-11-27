import { chmodSync, existsSync, lstatSync } from 'node:fs';
import type { z } from 'zod';
import { createDiagnosticJournal } from 'stitchkit/application/diagnostic-journal';
import type { DiagnosticJournal, DiagnosticJournalConfig } from 'stitchkit/application';
import type { AuditStatus } from '../../../contracts/src/door/status.ts';
import type { AuditRotation } from '../config/broker.ts';
import { ensureStateDir } from '../config/io.ts';
import { wireLogger } from '../logger.ts';
import { describeLock } from './audit-lock.ts';
import { AuditRecordSchema, type AuditEvent } from './audit-schema.ts';
import { ServiceAuditBatchSchema } from '../service/audit-schema.ts';
import { ServiceAuditBatcher, serviceAuditRecords } from './service-audit.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';

/** Bounded append-only broker decisions. Stitchkit owns storage, queueing, rotation and locking. */
export interface Audit {
  write(event: AuditEvent): void;
  status(): AuditStatus;
  flush(): Promise<void>;
  /** Drain pending facts and release the exclusive writer lock. */
  close(): Promise<void>;
}

const DEFAULT_ROTATION: AuditRotation = { maxBytes: 64 * 1024 * 1024, keep: 7 };
/** Oversized decisions are explicitly refused and counted rather than written without a bound. */
const MAX_AUDIT_EVENT_BYTES = 256 * 1024;

async function openJournal<Schema extends z.ZodType>(
  path: string,
  config: DiagnosticJournalConfig<Schema>,
): Promise<DiagnosticJournal<z.input<Schema>>> {
  try {
    return await createDiagnosticJournal(config);
  } catch (error) {
    const detail = String(error);
    if (detail.includes('EEXIST') && detail.includes('.lock')) {
      throw new Error(describeLock(path, `${path}.lock`, error), { cause: error });
    }
    throw error;
  }
}

/**
 * Async because taking the journal's exclusive lock is I/O, and because that is the moment a
 * second live writer is refused. Both callers create this inside a managed resource's `start`,
 * which is where an awaited acquisition belongs.
 */
export async function createAudit(
  path: string,
  queueLimit = 4_096,
  rotation: AuditRotation = DEFAULT_ROTATION,
): Promise<Audit> {
  ensureStateDir(path);
  // Storage mode applies only when creating files; existing journals must also be private.
  if (existsSync(path)) {
    try {
      const file = lstatSync(path);
      if (file.isFile() && (file.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
    } catch (error) {
      wireLogger.error('[wire] could not tighten audit journal mode', { path, error });
    }
  }
  let lastFailure: string | null = null;
  const journal = await openJournal(path, {
    eventSchema: AuditRecordSchema,
    path,
    // `keep` counts ROLLED generations; `maxFiles` counts every retained file including the active
    // one. The schema keeps `keep` at one or more because tail recovery needs a generation to move
    // a torn active file into (`maxFiles >= 2`).
    limits: {
      maxEventBytes: MAX_AUDIT_EVENT_BYTES,
      maxPendingItems: queueLimit,
      maxPendingBytes: queueLimit * MAX_AUDIT_EVENT_BYTES,
      maxFileBytes: rotation.maxBytes,
      maxFiles: rotation.keep + 1,
    },
    mode: 0o600,
    // A broker that refuses to start over a damaged diagnostic file loses every later decision, so
    // the file is moved aside instead — never deleted — and listed in the status until the operator
    // removes it. Opening checks the last line of each file, not every row: a 64 MB generation
    // parsed on each restart would make the restart itself the cost.
    onStartupRefusal: 'quarantine',
    startupScan: 'tails',
    // Reclaim only a provably dead writer; age alone must never displace a live owner.
    lock: 'reclaim-stale',
    onFailure: (failure) => {
      lastFailure = `audit journal ${failure.phase} failed: ${String(failure.error)}`;
      wireLogger.error('[wire] audit journal failed', { phase: failure.phase, error: failure.error });
    },
  });
  let closed = false;
  let serviceOrdinal = 0;
  let extraDropped = 0;
  const submit = (record: Parameters<typeof journal.submit>[0]): void => {
    // Compaction must not turn individually admissible facts into an oversized frame. Reserve
    // bounded envelope headroom; the journal remains the authority on its own physical ceiling.
    if (
      record.kind === 'service-batch' &&
      Buffer.byteLength(JSON.stringify(record)) + 512 > Math.min(MAX_AUDIT_EVENT_BYTES, rotation.maxBytes)
    ) {
      const parsed = ServiceAuditBatchSchema.safeParse(record);
      if (parsed.success) {
        for (const fact of serviceAuditRecords(parsed.data)) submit(fact);
        return;
      }
    }
    const submitted = journal.submit(record);
    if (submitted.outcome === 'refused') {
      if (record.kind === 'service-batch') extraDropped += record.rows.length - 1;
      lastFailure = `audit record refused: ${submitted.reason}`;
      wireLogger.error('[wire] audit record refused', { reason: submitted.reason });
    }
  };
  const services = new ServiceAuditBatcher((record) =>
    submit(record.kind === 'service-batch' ? { ...record, ts: nowIso() } : record),
  );
  return {
    write(event) {
      // Observation time belongs to the writer, independently of caller-provided timestamps.
      const record = { ...event, ts: nowIso() };
      // Other kinds do not flush pending service facts: a live broker writes an event publication
      // between almost every two of them, and flushing on each left batches of about two rows.
      // Service facts are ordered by their ordinal and timestamp, not by journal position.
      if (record.kind === 'service' && !closed) services.record({ ...record, ordinal: ++serviceOrdinal });
      else submit(record.kind === 'service' ? { ...record, ordinal: ++serviceOrdinal } : record);
    },
    status() {
      const journalStatus = journal.getStatus();
      return {
        queued: journalStatus.pendingItems + services.pendingRows,
        dropped: journalStatus.refused + extraDropped,
        writeFailures: journalStatus.failedRecords + journalStatus.rotationFailures,
        lastFailure,
        ...(journalStatus.recovery === undefined ? {} : { recovery: journalStatus.recovery }),
        journal: {
          path,
          bytes: journalStatus.currentFileBytes,
          // Retained files include the active one; this status counts only rolled generations.
          generations: Math.max(0, journalStatus.retainedFiles - 1),
          maxBytes: journalStatus.limits.maxFileBytes,
          keep: rotation.keep,
          rotations: journalStatus.rotations,
        },
      };
    },
    async flush() {
      services.flush();
      await journal.flush();
    },
    async close() {
      closed = true;
      services.flush();
      await journal.close();
    },
  };
}
