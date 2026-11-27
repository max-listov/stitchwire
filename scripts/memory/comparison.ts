import { z } from 'zod';

export const MemorySummarySchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.iso.datetime(),
  bun: z.string(),
  revision: z.string(),
  at: z.iso.datetime(),
  snapshot: z.string(),
  sha256: z.string().length(64),
  captureMs: z.number().nonnegative(),
  before: z.object({
    heap: z.object({ heapSize: z.number(), heapCapacity: z.number(), objectCount: z.number() }),
    cpu: z.object({ user: z.number(), system: z.number() }),
  }),
  types: z.record(z.string(), z.object({ count: z.number().int(), bytes: z.number().int() })),
});

export function compareMemory(before: unknown, after: unknown, minimumHours: number) {
  const first = MemorySummarySchema.parse(before);
  const last = MemorySummarySchema.parse(after);
  if (
    first.pid !== last.pid ||
    first.startedAt !== last.startedAt ||
    first.bun !== last.bun ||
    first.revision !== last.revision
  )
    throw new Error('cannot compare different process epochs or Bun builds');
  const hours = (Date.parse(last.at) - Date.parse(first.at)) / 3_600_000;
  if (hours <= 0) throw new Error('snapshots must advance time');
  if (hours < minimumHours) throw new Error(`snapshot interval ${hours}h is shorter than ${minimumHours}h`);
  const types = new Set([...Object.keys(first.types), ...Object.keys(last.types)]);
  return {
    hours,
    heapDeltaBytes: last.before.heap.heapSize - first.before.heap.heapSize,
    capacityDeltaBytes: last.before.heap.heapCapacity - first.before.heap.heapCapacity,
    objectDelta: last.before.heap.objectCount - first.before.heap.objectCount,
    cpuPercentOneCore:
      (last.before.cpu.user + last.before.cpu.system - first.before.cpu.user - first.before.cpu.system) /
      (hours * 3_600_000 * 10),
    types: [...types]
      .map((type) => ({
        type,
        count: (last.types[type]?.count ?? 0) - (first.types[type]?.count ?? 0),
        bytes: (last.types[type]?.bytes ?? 0) - (first.types[type]?.bytes ?? 0),
      }))
      .sort((a, b) => b.bytes - a.bytes),
  };
}
