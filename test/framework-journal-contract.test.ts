import { expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticJournalFrameSchema } from 'stitchkit/application';
import { createDiagnosticJournal } from 'stitchkit/application/diagnostic-journal';
import { z } from 'zod';

const eventSchema = z.object({ phase: z.literal('settled'), seq: z.number().int().nonnegative() }).strict();

test('published journal bounds ordered envelopes, reports losses, and requires exclusive lock ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wire-kit-journal-'));
  const path = join(directory, 'audit.jsonl');
  const config = {
    path,
    eventSchema,
    limits: {
      maxEventBytes: 256,
      maxPendingItems: 2,
      maxPendingBytes: 512,
      maxFileBytes: 160,
      maxFiles: 2,
    },
  };
  const journal = await createDiagnosticJournal(config);
  try {
    expect(journal.submit({ phase: 'settled', seq: 1 }).outcome).toBe('accepted');
    expect(journal.submit({ phase: 'settled', seq: 2 }).outcome).toBe('accepted');
    expect(journal.submit({ phase: 'settled', seq: 3 })).toEqual({
      outcome: 'refused',
      reason: 'item-capacity',
    });
    expect(journal.getStatus().pendingBytes).toBeLessThanOrEqual(512);
    expect((await journal.flush()).outcome).toBe('settled');
    expect(journal.getStatus()).toMatchObject({
      accepted: 2,
      written: 2,
      refused: 1,
      pendingItems: 0,
      pendingBytes: 0,
      rotations: 1,
    });
    const frames = await Promise.all(
      [`${path}.1`, path].map(async (file) => {
        const metadata = await stat(file);
        expect(metadata.size).toBeLessThanOrEqual(160);
        expect(metadata.mode & 0o777).toBe(0o600);
        return DiagnosticJournalFrameSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      }),
    );
    expect(frames.map((frame) => frame.sequence)).toEqual([1, 2]);
    expect(frames.map((frame) => frame.event)).toEqual([
      { phase: 'settled', seq: 1 },
      { phase: 'settled', seq: 2 },
    ]);
    expect(new Set(frames.map((frame) => frame.epoch)).size).toBe(1);
    await expect(createDiagnosticJournal(config)).rejects.toThrow();
  } finally {
    await journal.close();
  }
  try {
    expect((await readdir(directory)).includes('audit.jsonl.lock')).toBe(false);
    // An abandoned lock represents abrupt process death; the manager must not steal it.
    await writeFile(`${path}.lock`, '', { flag: 'wx', mode: 0o600 });
    await expect(createDiagnosticJournal(config)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
