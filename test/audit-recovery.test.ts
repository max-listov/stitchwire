import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticJournalFrameSchema, DiagnosticJournalRecoveryStatusSchema } from 'stitchkit/application';
import { readDiagnosticJournal } from 'stitchkit/application/diagnostic-journal';
import {
  AuditStatusSchema,
  JournalRecoverySchema,
  LocalStatusSchema,
} from '../packages/contracts/src/door/status.ts';
import { createAudit } from '../packages/runtime/src/broker/audit.ts';
import { AuditRotationSchema } from '../packages/runtime/src/config/broker.ts';
import { AuditRecordSchema } from '../packages/runtime/src/broker/audit-schema.ts';
import { healthContract } from '../packages/runtime/src/broker/contracts.ts';
import { auditChecks, doctorReport } from '../packages/runtime/src/cli/doctor-report.ts';
import { status, cli } from './doctor-fixture.ts';
import { withDoor } from './client-fixture.ts';

const event = {
  kind: 'connect',
  nodeId: 'owner',
  serves: true,
  version: '0.0.0',
  ts: '2026-09-30T00:00:00.000Z',
};
const frame = `${JSON.stringify(
  DiagnosticJournalFrameSchema.parse({
    schemaVersion: 1,
    epoch: '00000000-0000-4000-8000-000000000001',
    sequence: 1,
    event,
  }),
)}\n`;
const read = (paths: string[], maxLineBytes = 4096) =>
  Array.fromAsync(
    readDiagnosticJournal({
      paths,
      eventSchema: AuditRecordSchema,
      maxLineBytes,
    }),
  );

test('active recovery preserves bytes, appends readable frames and survives restart in shared status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-recovery-'));
  const path = join(root, 'audit.jsonl');
  const damaged = Buffer.concat([Buffer.from(frame), Buffer.alloc(839)]);
  try {
    await writeFile(path, damaged);
    const audit = await createAudit(path);
    try {
      const observation = AuditStatusSchema.parse(audit.status());
      expect(observation).toMatchObject({
        dropped: 0,
        writeFailures: 0,
        lastFailure: null,
        recovery: { filesChecked: 2, anomalies: 1, skippedBytes: 839 },
      });
      expect(healthContract.endpoints.get.output.shape.audit.parse(observation)).toEqual(observation);
      expect(doctorReport('broker', auditChecks(observation))).toMatchObject({
        verdict: 'warn',
        exitCode: 1,
      });
      audit.write({ kind: 'connect', nodeId: 'new-owner', serves: true, version: '0.0.0' });
      await audit.flush();
      expect(await readFile(`${path}.1`)).toEqual(damaged);
      const results = await read([`${path}.1`, path]);
      expect(results.filter((row) => row.type === 'frame').map((row) => row.frame.event.kind)).toEqual([
        'connect',
        'connect',
      ]);
      expect(results.filter((row) => row.type === 'anomaly')).toEqual([
        {
          type: 'anomaly',
          anomaly: {
            file: `${path}.1`,
            offset: Buffer.byteLength(frame),
            line: 2,
            reason: 'nul-byte',
            position: 'tail',
            terminated: false,
            skippedBytes: 839,
          },
        },
      ]);
      expect(audit.status().dropped).toBe(0);
      expect(audit.status().writeFailures).toBe(0);
    } finally {
      await audit.close();
    }
    const restarted = await createAudit(path);
    try {
      expect(restarted.status().recovery).toMatchObject({ filesChecked: 2, anomalies: 1, skippedBytes: 839 });
      expect(await readFile(`${path}.1`)).toEqual(damaged);
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clean active and damaged retained generations project bounded recovery without write failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-retained-recovery-'));
  const path = join(root, 'audit.jsonl');
  try {
    await writeFile(path, frame);
    for (const index of [1, 7])
      await writeFile(`${path}.${index}`, Buffer.concat([Buffer.from(frame), Buffer.alloc(839)]));
    const audit = await createAudit(path);
    try {
      expect(AuditStatusSchema.parse(audit.status())).toMatchObject({
        dropped: 0,
        writeFailures: 0,
        lastFailure: null,
        recovery: { filesChecked: 3, anomalies: 2, skippedBytes: 1678 },
      });
      expect(
        (await read([`${path}.7`, `${path}.1`, path])).filter((row) => row.type === 'frame'),
      ).toHaveLength(3);
    } finally {
      await audit.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a torn append after a crash does not stop the broker at the smallest retention the schema accepts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-torn-tail-'));
  const path = join(root, 'audit.jsonl');
  // The smallest `keep` the config admits is the one most likely to leave recovery nowhere to go.
  const smallest = AuditRotationSchema.parse({ maxBytes: 64 * 1024, keep: 1 });
  expect(AuditRotationSchema.safeParse({ maxBytes: 64 * 1024, keep: smallest.keep - 1 }).success).toBe(false);
  try {
    await writeFile(path, `${frame}{"schemaVersion":1,"epoch":"x","seq`);
    const audit = await createAudit(path, 4, smallest);
    try {
      const recovery = audit.status().recovery;
      expect(recovery).toMatchObject({ anomalies: 1 });
      // The door's own recovery form accepts exactly what the framework reports, field for field.
      expect(JournalRecoverySchema.parse(DiagnosticJournalRecoveryStatusSchema.parse(recovery))).toEqual(
        DiagnosticJournalRecoveryStatusSchema.parse(recovery),
      );
    } finally {
      await audit.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a torn single slot is set aside, never deleted, and the broker starts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-single-recovery-'));
  const path = join(root, 'audit.jsonl');
  const damaged = Buffer.concat([Buffer.from(frame), Buffer.alloc(839)]);
  try {
    await writeFile(path, damaged);
    // `keep: 0` is below what the config accepts; it reaches the journal only through this direct call.
    const audit = await createAudit(path, 4, { maxBytes: 4096, keep: 0 });
    try {
      const quarantined = audit.status().recovery?.quarantined ?? [];
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]).toMatchObject({
        file: expect.stringMatching(/audit\.jsonl$/),
        reason: 'torn-without-retention-slot',
      });
      // The evidence moved, byte for byte; nothing was deleted.
      expect(await readFile(quarantined[0]?.quarantinedAs ?? '')).toEqual(damaged);
      expect(doctorReport('node', auditChecks(audit.status())).checks.map((check) => check.code)).toContain(
        'audit.quarantined',
      );
      expect(JournalRecoverySchema.safeParse(audit.status().recovery).success).toBe(true);
    } finally {
      await audit.close();
    }
    await expect(readFile(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('clean startup omits recovery; service and publication recovery reach both doctor renderers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-recovery-doctor-'));
  const path = join(root, 'audit.jsonl');
  try {
    const clean = await createAudit(path);
    try {
      expect('recovery' in AuditStatusSchema.parse(clean.status())).toBe(false);
      expect(doctorReport('node', auditChecks(clean.status())).verdict).toBe('ok');
    } finally {
      await clean.close();
    }
    await writeFile(path, Buffer.alloc(839));
    const audit = await createAudit(path);
    try {
      const baseline = status();
      baseline.config = { path: join(root, 'config/node.json'), mode: '600' };
      for (const field of ['publicationAudit', 'serviceAudit']) {
        const value = LocalStatusSchema.parse({ ...baseline, [field]: audit.status() });
        await withDoor(
          (_req, res) => res.end(JSON.stringify(value)),
          async (socket) => {
            const json = await cli(['--json'], socket, root);
            const text = await cli([], socket, root);
            const prefix = field === 'serviceAudit' ? 'service-audit' : 'audit';
            expect(json.code).toBe(1);
            expect(JSON.parse(json.stdout).checks).toContainEqual({
              code: `${prefix}.recovery`,
              level: 'warn',
              detail: auditChecks(audit.status(), prefix)[1]?.detail,
            });
            expect(text.code).toBe(1);
            expect(text.stdout).toContain(`WARN ${prefix}.recovery:`);
          },
        );
      }
    } finally {
      await audit.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test('bounded reader distinguishes malformed bytes and events, and continues with the next valid frame', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-reader-controls-'));
  const path = join(root, 'audit.jsonl');
  try {
    const invalidEvent = frame.replace('"kind":"connect"', '"kind":"unknown"');
    const corruptions = [
      { bytes: Buffer.from('{broken}\n'), reason: 'invalid-json' },
      { bytes: Buffer.from('{}\n'), reason: 'invalid-frame' },
      { bytes: Buffer.from(invalidEvent), reason: 'invalid-event' },
      { bytes: Buffer.from([0xff, 10]), reason: 'invalid-utf8' },
      { bytes: Buffer.from(`${'x'.repeat(5000)}\n`), reason: 'oversized-line' },
      { bytes: Buffer.from([0, 10]), reason: 'nul-byte' },
    ];
    for (const corruption of corruptions) {
      await writeFile(path, Buffer.concat([corruption.bytes, Buffer.from(frame)]));
      const results = await read([path]);
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        type: 'anomaly',
        anomaly: {
          offset: 0,
          reason: corruption.reason,
          position: 'interior',
          skippedBytes: corruption.bytes.length,
        },
      });
      expect(results[1]).toMatchObject({ type: 'frame', offset: corruption.bytes.length, frame: { event } });
    }
    await writeFile(path, '{"torn":');
    expect(await read([path])).toMatchObject([
      { type: 'anomaly', anomaly: { reason: 'unterminated-line', skippedBytes: 8 } },
    ]);
    await writeFile(path, frame.trimEnd());
    expect(await read([path])).toMatchObject([
      { type: 'anomaly', anomaly: { reason: 'unterminated-line', skippedBytes: 0 } },
      { type: 'frame', frame: { event } },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('chunk-spanning corruption remains bounded and truncation or abort is not downgraded to an anomaly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-reader-chunks-'));
  const path = join(root, 'audit.jsonl');
  try {
    await writeFile(path, `${'x'.repeat(200000)}\n${frame}`);
    expect(await read([path])).toMatchObject([
      { type: 'anomaly', anomaly: { reason: 'oversized-line', skippedBytes: 200001 } },
      { type: 'frame', offset: 200001, frame: { event } },
    ]);
    await writeFile(path, `${frame}${'x'.repeat(200000)}`);
    const interrupted = readDiagnosticJournal({
      paths: [path],
      eventSchema: AuditRecordSchema,
      maxLineBytes: 4096,
    });
    try {
      expect((await interrupted.next()).value).toMatchObject({ type: 'frame' });
      await truncate(path, 0);
      await expect(interrupted.next()).rejects.toThrow('truncated during read');
    } finally {
      await interrupted.return();
    }
    await writeFile(path, `${frame}${frame}`);
    const controller = new AbortController();
    const aborted = readDiagnosticJournal({
      paths: [path],
      eventSchema: AuditRecordSchema,
      maxLineBytes: 4096,
      signal: controller.signal,
    });
    try {
      expect((await aborted.next()).value).toMatchObject({ type: 'frame' });
      controller.abort(new Error('reader explicitly cancelled'));
      await expect(aborted.next()).rejects.toThrow('reader explicitly cancelled');
    } finally {
      await aborted.return();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('I/O and unsafe path failures throw separately; refusal does not chmod the symlink target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-reader-io-'));
  const path = join(root, 'audit.jsonl');
  const target = join(root, 'target.jsonl');
  try {
    await expect(read([path])).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(target, frame);
    await chmod(target, 0o640);
    await symlink(target, path);
    await expect(read([path])).rejects.toThrow();
    await expect(createAudit(path)).rejects.toThrow();
    expect((await stat(target)).mode & 0o777).toBe(0o640);
    expect(await readFile(target, 'utf8')).toBe(frame);
    await expect(readFile(`${path}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    await chmod(target, 0);
    if (process.getuid?.() !== 0) await expect(read([target])).rejects.toMatchObject({ code: 'EACCES' });
  } finally {
    await chmod(target, 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
