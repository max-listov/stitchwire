import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `config validate service <path> --node <node.json>` adds the node's own refusals (namespace and
 * collision with a fleet binding) to the schema verdict, through the function the agent asks.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-validate-service-node-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const main = join(import.meta.dir, '../packages/runtime/src/cli/main.ts');
const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 5000 };
const binding = (service: string, socketPath: string) => ({
  service,
  descriptorPath: '/run/owner/descriptor.json',
  socketPath,
  endpointPath: '/wire',
  maxInflight: 4,
  limits,
});
const declaration = (service: string, socketPath: string) => ({
  binding: binding(service, socketPath),
  callers: [{ caller: 'reader', scope: { kind: 'service-read' } }],
});

async function run(...args: string[]) {
  const child = Bun.spawn(['bun', main, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

async function nodeConfig(services: object): Promise<string> {
  const path = join(root, `node-${Math.random().toString(36).slice(2)}.json`);
  const made = await run('init', 'node', '--id', 'worker', '--broker', 'http://127.0.0.1:9', path);
  if (made.code !== 0) throw new Error(made.stderr);
  const config = JSON.parse(await Bun.file(path).text());
  writeFileSync(path, JSON.stringify({ ...config, services }));
  return path;
}

function declarationFile(name: string, service: string, socketPath: string): string {
  const path = join(root, `${name}.json`);
  writeFileSync(path, JSON.stringify(declaration(service, socketPath)));
  return path;
}

describe('config validate service --node', () => {
  test('a service inside a granted namespace passes', async () => {
    const node = await nodeConfig({ bindings: [], grants: [], namespaces: ['owner.'], descriptors: [] });
    const file = declarationFile('inside', 'owner.catalog', '/run/owner/a.sock');
    const result = await run('config', 'validate', 'service', file, '--node', node);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('accepted by the node configuration');
  });
  test('a service outside the namespaces is refused with the node reason', async () => {
    const node = await nodeConfig({ bindings: [], grants: [], namespaces: ['other.'], descriptors: [] });
    const file = declarationFile('outside', 'owner.catalog', '/run/owner/b.sock');
    const result = await run('config', 'validate', 'service', file, '--node', node);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('outside the service namespaces this node may serve (other.)');
    // Without --node the same file is a valid declaration: the schema alone does not know the node.
    expect((await run('config', 'validate', 'service', file)).code).toBe(0);
  });
  test('a socket already bound by the fleet is refused', async () => {
    const node = await nodeConfig({
      bindings: [binding('owner.fleet', '/run/owner/c.sock')],
      grants: [],
      namespaces: ['owner.'],
      descriptors: [],
    });
    const file = declarationFile('collide', 'owner.catalog', '/run/owner/c.sock');
    const result = await run('config', 'validate', 'service', file, '--node', node);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('socket /run/owner/c.sock already serves another service');
  });
});
