import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServiceDeclaration } from '../packages/client/src/index.ts';

/** `stitchwire config validate service <path>` reads a declaration the way the node agent does. */

const root = mkdtempSync(join(tmpdir(), 'wire-validate-service-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const main = join(import.meta.dir, '../packages/runtime/src/cli/main.ts');
const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 };
const declaration = (endpointPath: string) => ({
  binding: {
    service: 'owner.catalog',
    descriptorPath: '/run/owner/descriptor.json',
    socketPath: '/run/owner/owner.sock',
    endpointPath,
    maxInflight: 4,
    limits,
  },
  callers: [{ caller: 'reader', scope: { kind: 'service-read' } }],
});

async function validate(path: string) {
  const child = Bun.spawn(['bun', main, 'config', 'validate', 'service', path], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe('config validate service', () => {
  test('a valid declaration passes and names its service and callers', async () => {
    const path = join(root, 'valid.json');
    writeFileSync(path, JSON.stringify(declaration('/wire')));
    const result = await validate(path);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('valid service declaration: owner.catalog, 1 caller scope(s)');
  });
  test('an endpoint of / fails with the one-line reason the node agent reports', async () => {
    const path = join(root, 'root.json');
    writeFileSync(path, JSON.stringify(declaration('/')));
    const parsed = parseServiceDeclaration(declaration('/'));
    if (parsed.ok) throw new Error('the control declaration was accepted');
    const result = await validate(path);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe(`invalid service declaration: ${parsed.detail}`);
  });
  test('a missing file and bytes that are not UTF-8 fail', async () => {
    expect((await validate(join(root, 'absent.json'))).code).toBe(1);
    const path = join(root, 'latin1.json');
    writeFileSync(path, Buffer.from([0x7b, 0xff, 0x7d]));
    const result = await validate(path);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Not strict UTF-8');
  });
});
