import { heapStats } from 'bun:jsc';
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A diagnostic attachment, not a runtime feature. It holds no earlier sample or snapshot in memory. */
export function createMemoryProbe(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const epoch = {
    pid: process.pid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    bun: Bun.version,
    revision: Bun.revision,
  };
  const write = (name: string, value: unknown) => {
    const path = join(directory, name);
    writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(`${path}.tmp`, path);
  };
  write('epoch.json', epoch);

  function sample() {
    // These two collections match the existing memory soak. Values describe live objects, not
    // an uncollected allocation peak; GC changes the workload and is stated in every sample.
    const started = performance.now();
    Bun.gc(true);
    Bun.gc(true);
    const heap = heapStats();
    const record = {
      ...epoch,
      at: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      forcedGc: true,
      heap,
      processMemory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      collectionMs: performance.now() - started,
    };
    writeFileSync(join(directory, 'samples.jsonl'), `${JSON.stringify(record)}\n`, {
      mode: 0o600,
      flag: 'a',
    });
    return record;
  }

  function snapshot() {
    const before = sample();
    const started = performance.now();
    const heap = Bun.generateHeapSnapshot();
    const id = `${Date.now()}-${crypto.randomUUID()}`;
    write(`${id}.heap.json`, heap);
    const types: Record<string, { count: number; bytes: number }> = {};
    // Inspector format v3: id, shallow size, class index, flags. Payload values are never
    // copied to this summary. The complete graph is a private 0600 diagnostic file.
    if (heap.version !== 3 || heap.type !== 'Inspector' || heap.nodes.length % 4 !== 0)
      throw new Error('unsupported JavaScriptCore heap snapshot format');
    for (let offset = 0; offset < heap.nodes.length; offset += 4) {
      const classIndex = heap.nodes[offset + 2];
      const bytes = heap.nodes[offset + 1];
      const name = classIndex === undefined ? undefined : heap.nodeClassNames[classIndex];
      if (name === undefined || bytes === undefined) throw new Error('incomplete heap node');
      types[name] ??= { count: 0, bytes: 0 };
      const type = types[name];
      type.count += 1;
      type.bytes += bytes;
    }
    const summary = {
      ...epoch,
      at: new Date().toISOString(),
      snapshot: `${id}.heap.json`,
      sha256: new Bun.CryptoHasher('sha256').update(JSON.stringify(heap)).digest('hex'),
      captureMs: performance.now() - started,
      before,
      types,
    };
    write(`${id}.summary.json`, summary);
    return summary;
  }

  return { directory, sample, snapshot };
}

export type MemoryProbe = ReturnType<typeof createMemoryProbe>;

/**
 * Run a diagnostic step inside the supervised process. A full disk or a removed directory must
 * cost one record, never the process under diagnosis: outside a handler the error would be uncaught.
 */
export function guarded(step: () => void, report: (error: unknown) => void): void {
  try {
    step();
  } catch (error) {
    report(error);
  }
}

/**
 * Attach to the running process. Every step that touches the disk is guarded, so a probe that cannot
 * start, sample or capture costs its records and never the process. Five minutes matches the memory
 * soak's cadence closely enough to compare series and keeps forced collections rare.
 */
export function attachMemoryProbe(
  directory: string,
  report: (phase: string, error: unknown) => void,
  periodMs = 300_000,
) {
  let probe: MemoryProbe;
  try {
    probe = createMemoryProbe(directory);
  } catch (error) {
    report('start', error);
    return null;
  }
  const timer = setInterval(
    () =>
      guarded(
        () => probe.sample(),
        (error) => report('sample', error),
      ),
    periodMs,
  );
  // Unref'd: a probe never keeps its process alive.
  timer.unref();
  const capture = () =>
    guarded(
      () => {
        const summary = probe.snapshot();
        console.error('[memory-probe] captured', summary.snapshot, `in ${summary.captureMs.toFixed(1)}ms`);
      },
      (error) => report('capture', error),
    );
  process.on('SIGUSR2', capture);
  return () => {
    clearInterval(timer);
    process.off('SIGUSR2', capture);
  };
}
