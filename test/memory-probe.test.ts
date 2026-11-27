import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareMemory, MemorySummarySchema } from '../scripts/memory/comparison.ts';
import { retainingPaths } from '../scripts/memory/graph.ts';
import { attachMemoryProbe, guarded } from '../scripts/memory/probe.ts';
import { until } from './support.ts';

test('live signal capture detects retained objects and their release without exposing payloads in summaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-memory-probe-'));
  const child = Bun.spawn([process.execPath, 'test/fixtures/memory-probe.ts', root], {
    cwd: join(import.meta.dir, '..'),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stdout.getReader();
  const ready = async () => {
    const result = await reader.read();
    if (result.done) throw new Error(`probe exited: ${await new Response(child.stderr).text()}`);
  };
  const capture = async (n: number) => {
    child.kill('SIGUSR2');
    expect(
      await until(
        async () => (await readdir(root)).filter((name) => name.endsWith('.summary.json')).length === n,
      ),
    ).toBe(true);
    const files = (await readdir(root)).filter((name) => name.endsWith('.summary.json')).sort();
    const latest = files.at(-1);
    if (latest === undefined) throw new Error('snapshot summary did not arrive');
    const text = await Bun.file(join(root, latest)).text();
    expect(text).not.toContain('fixture-private-payload');
    expect(text).not.toContain('fixturePrivateProperty');
    expect((await stat(join(root, latest))).mode & 0o777).toBe(0o600);
    const summary = MemorySummarySchema.parse(JSON.parse(text));
    expect(summary.pid).toBe(child.pid);
    expect((await stat(join(root, summary.snapshot))).mode & 0o777).toBe(0o600);
    const graph = await Bun.file(join(root, summary.snapshot)).text();
    expect(new Bun.CryptoHasher('sha256').update(graph).digest('hex')).toBe(summary.sha256);
    // The retained objects hang off a named property, so the path to them crosses an edge with that
    // name and the private graph holds it: both checks that it stays out can fail.
    if ((summary.types.ProbeRetained?.count ?? 0) > 0) expect(graph).toContain('fixturePrivateProperty');
    const paths = retainingPaths(JSON.parse(graph), 'ProbeRetained');
    expect(JSON.stringify(paths)).not.toContain('fixture-private-payload');
    expect(JSON.stringify(paths)).not.toContain('fixturePrivateProperty');
    expect(paths.length > 0).toBe((summary.types.ProbeRetained?.count ?? 0) > 0);
    return summary;
  };
  try {
    await ready();
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    const first = await capture(1);
    expect(first.types.ProbeRetained?.count ?? 0).toBe(0);
    await ready();
    child.stdin.write('retain\n');
    await child.stdin.flush();
    await ready();
    const retained = await capture(2);
    expect(retained.types.ProbeRetained?.count).toBe(4000);
    expect(compareMemory(first, retained, 0).types.find((type) => type.type === 'ProbeRetained')?.count).toBe(
      4000,
    );
    expect(() => compareMemory(first, retained, 24)).toThrow('shorter than 24h');
    expect(() => compareMemory(first, { ...retained, pid: retained.pid + 1 }, 0)).toThrow('process epochs');
    await ready();
    child.stdin.write('release\n');
    await child.stdin.flush();
    await ready();
    const released = await capture(3);
    expect(released.types.ProbeRetained?.count ?? 0).toBe(0);
    expect(
      compareMemory(retained, released, 0).types.find((type) => type.type === 'ProbeRetained')?.count,
    ).toBe(-4000);
  } finally {
    child.kill('SIGTERM');
    await child.exited;
    reader.releaseLock();
    await rm(root, { recursive: true, force: true });
  }
});

test('a probe that cannot start, sample or capture reports it and never reaches the process under diagnosis', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-memory-attach-'));
  const reports: string[] = [];
  const report = (phase: string) => reports.push(phase);
  try {
    await Bun.write(join(root, 'file'), 'not a directory');
    expect(attachMemoryProbe(join(root, 'file', 'memory'), report)).toBeNull();
    expect(reports).toEqual(['start']);

    const directory = join(root, 'memory');
    const detach = attachMemoryProbe(directory, report, 1);
    if (detach === null) throw new Error('probe did not attach');
    await rm(directory, { recursive: true });
    process.emit('SIGUSR2', 'SIGUSR2');
    expect(await until(() => reports.includes('sample') && reports.includes('capture'))).toBe(true);
    detach();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  const failure = new Error('disk full');
  const seen: unknown[] = [];
  guarded(
    () => {
      throw failure;
    },
    (error) => seen.push(error),
  );
  expect(seen).toEqual([failure]);
});
