/** Deterministic synthetic observations, never a captured deployment payload. */
export function observationPayload(bytes = 326216): string {
  const rows = Array.from({ length: Math.floor(bytes / 330) }, (_, index) => ({
    id: `process-${index}`,
    executable: '/usr/bin/example-worker',
    arguments: ['--label', 'quoted "value"', '--directory', '/srv/example\\data'],
    status: index % 17 === 0 ? 'stopped' : 'running',
    observedAt: '2026-01-01T00:00:00.000Z',
    memoryBytes: 1000000 + ((index * 7919) % 2000000),
    cpuTicks: (index * 31) % 10000,
    tags: ['worker', 'application', 'synthetic'],
  }));
  const value = { rows, padding: '' };
  const size = Buffer.byteLength(JSON.stringify(value));
  if (size > bytes) throw new Error('synthetic fixture exceeds requested size');
  value.padding = ' '.repeat(bytes - size);
  return JSON.stringify(value);
}
