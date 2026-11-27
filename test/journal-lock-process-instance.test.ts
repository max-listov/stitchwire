import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAudit } from '../packages/runtime/src/broker/audit.ts';

const OwnerSchema = z.object({
  pid: z.number().int().positive(),
  host: z.string(),
  machine: z.string().optional(),
  acquiredAt: z.string(),
  process: z.object({
    platform: z.enum(['linux', 'darwin']),
    bootId: z.string().min(1),
    namespace: z.string().min(1),
    startId: z.string().regex(/^\d+$/),
  }),
});
let directory: string;
let path: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'wire-process-lock-'));
  path = join(directory, 'audit.jsonl');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

async function ownerRecord() {
  const audit = await createAudit(path);
  try {
    return OwnerSchema.parse(JSON.parse(readFileSync(`${path}.lock`, 'utf8')));
  } finally {
    await audit.close();
  }
}

for (const mismatch of ['boot', 'start']) {
  test(`audit reclaims a ${mismatch} mismatch despite an existing PID and preserves history`, async () => {
    const owner = await ownerRecord();
    expect(() => process.kill(owner.pid, 0)).not.toThrow();
    const processIdentity =
      mismatch === 'boot'
        ? { ...owner.process, bootId: `${owner.process.bootId}-other` }
        : { ...owner.process, startId: String(BigInt(owner.process.startId) + 1n) };
    writeFileSync(path, 'historical-evidence\n');
    writeFileSync(`${path}.lock`, JSON.stringify({ ...owner, process: processIdentity }));
    const reclaimed = await createAudit(path);
    try {
      expect(OwnerSchema.parse(JSON.parse(readFileSync(`${path}.lock`, 'utf8'))).process).toEqual(
        owner.process,
      );
      await expect(createAudit(path)).rejects.toThrow('confirmed live owner');
    } finally {
      await reclaimed.close();
    }
    expect(readFileSync(path, 'utf8')).toBe('historical-evidence\n');
  });
}

test('unknown identity refuses reclamation and does not claim a confirmed owner', async () => {
  const owner = await ownerRecord();
  const record = JSON.stringify({ ...owner, process: null });
  writeFileSync(`${path}.lock`, record);
  await expect(createAudit(path)).rejects.toThrow('process identity is unavailable');
  expect(readFileSync(`${path}.lock`, 'utf8')).toBe(record);
});
