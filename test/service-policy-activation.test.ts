import { expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';

const script = join(import.meta.dir, '..', 'scripts', 'activate-service-policy.ts');
const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 };
const descriptor = {
  service: 'example.observation',
  revision: '1',
  maxInflight: 4,
  operations: [
    { id: 'summary.read', path: '/observation/summary', effect: 'read', limits, response: { kind: 'unary' } },
    {
      id: 'incident.act',
      path: '/observation/incident',
      effect: 'write',
      limits,
      response: { kind: 'unary' },
    },
  ],
};

async function run(args: string[]) {
  const proc = Bun.spawn(['bun', script, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

test('operator activation writes service-read and exact-operation scopes idempotently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-service-policy-'));
  const configPath = join(root, 'broker.json');
  const descriptorPath = join(root, 'descriptor.json');
  const candidatePath = join(root, 'broker.candidate.json');
  const config = BrokerConfigSchema.parse({
    nodes: ['caller', 'other', 'alpha', 'bravo'].map((id, index) => ({
      id,
      tokenSha256s: [sha256(String(index).repeat(40))],
    })),
    serviceGrants: [
      {
        caller: 'other',
        target: 'alpha',
        service: descriptor.service,
        scope: { kind: 'service-read' },
      },
    ],
  });
  await Promise.all([
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`),
    writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`),
  ]);
  await chmod(configPath, 0o600);
  const args = [
    '--kind',
    'broker',
    '--config',
    configPath,
    '--descriptor',
    descriptorPath,
    '--caller',
    'caller',
    '--read',
    'alpha',
    '--grant',
    'bravo:incident.act',
    '--apply',
    'yes',
  ];
  const beforeDryRun = await readFile(configPath, 'utf8');
  const dryRun = await run([...args.slice(0, -1), 'no', '--out', candidatePath]);
  expect(dryRun).toMatchObject({ code: 0, stderr: '' });
  expect(await readFile(configPath, 'utf8')).toBe(beforeDryRun);
  const candidate = await readFile(candidatePath, 'utf8');
  expect(JSON.parse(dryRun.stdout).after).toBe(sha256(candidate));
  const first = await run(args);
  expect(first).toMatchObject({ code: 0, stderr: '' });
  expect(await readFile(configPath, 'utf8')).toBe(candidate);
  const updated = BrokerConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  expect(updated.serviceGrants).toContainEqual({
    caller: 'caller',
    target: 'alpha',
    service: descriptor.service,
    scope: { kind: 'service-read' },
  });
  expect(updated.serviceGrants).toContainEqual({
    caller: 'caller',
    target: 'bravo',
    service: descriptor.service,
    scope: { kind: 'operation', operation: 'incident.act' },
  });
  const second = await run(args);
  expect(second.code).toBe(0);
  expect(JSON.parse(second.stdout).before).toBe(JSON.parse(second.stdout).after);
});

test('node activation stores descriptorPath and never embeds owner descriptor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wire-service-node-policy-'));
  const configPath = join(root, 'node.json');
  const descriptorPath = join(root, 'descriptor.json');
  const config = NodeConfigSchema.parse({
    nodeId: 'alpha',
    brokers: [{ id: 'main', url: 'https://wire.invalid', token: 'x'.repeat(40) }],
  });
  await Promise.all([
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`),
    writeFile(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`),
  ]);
  const result = await run([
    '--kind',
    'node',
    '--config',
    configPath,
    '--descriptor',
    descriptorPath,
    '--caller',
    'caller',
    '--read',
    'alpha',
    '--socket',
    '/tmp/owner.sock',
    '--endpoint',
    '/v1/service',
    '--apply',
    'yes',
  ]);
  expect(result.code).toBe(0);
  const updated = NodeConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
  expect(updated.services.bindings[0]).toMatchObject({
    service: descriptor.service,
    descriptorPath,
  });
  expect('descriptor' in (updated.services.bindings[0] ?? {})).toBe(false);
});

test('activation refuses undeclared exact operations', async () => {
  const result = await run([
    '--kind',
    'broker',
    '--config',
    '/unused',
    '--descriptor',
    '/unused',
    '--caller',
    'caller',
    '--grant',
    'alpha:missing',
    '--apply',
    'no',
  ]);
  expect(result.code).not.toBe(0);
});
