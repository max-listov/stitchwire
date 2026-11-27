import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateConfig } from '../packages/runtime/src/config/update.ts';
import { until } from './support.ts';

const observerPath = join(import.meta.dir, 'config-birth-observer.ts');

test('a separate observer sees unsafe control and only private staging for credential-bearing transactions', async () => {
  const root = mkdtempSync('/tmp/wire-config-birth-');
  const observer = Bun.spawn([process.execPath, observerPath, root], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = observer.stdout.getReader();
    let output = '';
    while (!output.includes('ready\n')) {
      const part = await reader.read();
      if (part.done) throw new Error('observer ended before readiness');
      output += new TextDecoder().decode(part.value);
    }
    const pending = (async () => {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        output += new TextDecoder().decode(part.value);
      }
    })();
    // Deliberately unsafe, unrelated control remains visible while the real writer runs.
    const mask = process.umask(0o022);
    try {
      writeFileSync(join(root, 'unsafe-control'), '{}', { mode: 0o644 });
    } finally {
      process.umask(mask);
    }
    const path = join(root, 'node.json');
    const initial = {
      nodeId: 'worker',
      brokers: [{ id: 'primary', url: 'http://127.0.0.1:9999', token: 'x'.repeat(40) }],
    };
    writeFileSync(path, JSON.stringify(initial), { mode: 0o600 });
    let before = JSON.stringify(initial);
    for (let index = 0; index < 30; index++) {
      const value = { ...initial, serves: index % 2 === 0 };
      const result = await updateConfig('node', path, {
        operation: 'replace',
        expectedSha256: new Bun.CryptoHasher('sha256').update(before).digest('hex'),
        value,
      });
      expect(result.state).toBe('written');
      before = `${JSON.stringify(value, null, 2)}\n`;
    }
    writeFileSync(join(root, 'finished'), '');
    expect(await until(() => observer.exitCode !== null, 3000)).toBe(true);
    await pending;
    const observations = JSON.parse(output.replace('ready\n', '')) as Array<{
      staging: boolean;
      mode: number;
    }>;
    expect(observations).toContainEqual({ staging: false, mode: 0o644 });
    const stages = observations.filter((observation) => observation.staging);
    expect(stages.length).toBeGreaterThan(0);
    expect(stages.every((observation) => (observation.mode & 0o077) === 0)).toBe(true);
    expect(await observer.exited).toBe(0);
  } finally {
    observer.kill();
    await observer.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
