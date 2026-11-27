import { expect, test } from 'bun:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

test('policy candidate is private, default-dry and cannot overwrite an existing file', async () => {
  const root = await mkdtemp('/tmp/wire-policy-review-');
  try {
    const config = join(root, 'broker.json');
    const descriptor = join(root, 'descriptor.json');
    const candidate = join(root, 'candidate.json');
    await writeFile(
      config,
      JSON.stringify({
        nodes: [
          { id: 'caller', tokenSha256s: ['a'.repeat(64)] },
          { id: 'worker', tokenSha256s: ['b'.repeat(64)] },
        ],
      }),
      { mode: 0o600 },
    );
    await writeFile(
      descriptor,
      JSON.stringify({
        service: 'example.catalog',
        revision: '1',
        maxInflight: 1,
        operations: [
          {
            id: 'read',
            path: '/catalog/read',
            effect: 'read',
            limits: { requestBytes: 1024, responseBytes: 1024, timeoutMs: 1000 },
            response: { kind: 'unary' },
          },
        ],
      }),
    );
    const before = await Bun.file(config).text();
    async function run(apply = 'no') {
      const child = Bun.spawn(
        [
          'bun',
          resolve(import.meta.dir, '../scripts/activate-service-policy.ts'),
          '--kind',
          'broker',
          '--config',
          config,
          '--descriptor',
          descriptor,
          '--caller',
          'caller',
          '--read',
          'worker',
          '--apply',
          apply,
          '--out',
          candidate,
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const [code] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return code;
    }
    expect(await run('unexpected')).not.toBe(0);
    expect(await Bun.file(candidate).exists()).toBe(false);
    expect(await run()).toBe(0);
    expect((await stat(candidate)).mode & 0o777).toBe(0o600);
    const proposed = await Bun.file(candidate).text();
    expect(await run()).not.toBe(0);
    expect(await run('yes')).not.toBe(0);
    expect(await Bun.file(candidate).text()).toBe(proposed);
    expect(await Bun.file(config).text()).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
