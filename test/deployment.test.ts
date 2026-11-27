/**
 * Install-time behaviour, which is where this project's security posture is actually decided: a
 * token per node, a digest on the broker, one file readable by one user. A generator that produces
 * a file the agent refuses at boot, or that silently replaces the only copy of a token, would be
 * worse than the manual procedure it replaces.
 */

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { loadBrokerConfig, loadNodeConfig, sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { brokerConfig, freePort } from './support.ts';

const CLI = join(import.meta.dir, '..', 'packages', 'runtime', 'src', 'cli', 'main.ts');

async function cli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

test('init writes a node config the agent will actually accept, with the mode a token needs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-init-'));
  const path = join(root, 'node.json');
  const result = await cli(['init', 'node', '--id', 'worker', '--broker', 'https://wire.example.com', path]);
  expect(result.code).toBe(0);

  // Validated by loading it the way the agent does, not by reading the JSON back.
  const config = loadNodeConfig(path);
  expect(config.nodeId).toBe('worker');
  expect(config.brokers).toHaveLength(1);
  expect(config.brokers[0]?.url).toBe('https://wire.example.com');
  expect((statSync(path).mode & 0o777).toString(8)).toBe('600');

  // The digest is what leaves the machine; the token stays in the file.
  const token = config.brokers[0]?.token ?? '';
  expect(result.stdout).toContain(sha256(token));
  expect(result.stdout).not.toContain(token);
});

test('init refuses to replace an existing config instead of regenerating a token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-init-guard-'));
  const path = join(root, 'node.json');
  expect(
    (await cli(['init', 'node', '--id', 'worker', '--broker', 'https://wire.example.com', path])).code,
  ).toBe(0);
  const before = readFileSync(path, 'utf8');

  const second = await cli(['init', 'node', '--id', 'worker', '--broker', 'https://wire.example.com', path]);
  expect(second.code).toBe(1);
  expect(second.stderr).toContain('already exists');
  // A regenerated node is a node the broker no longer recognises — the file must be untouched.
  expect(readFileSync(path, 'utf8')).toBe(before);
});

test('init writes a broker config that admits the named node and grants nobody anything', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-init-broker-'));
  const path = join(root, 'broker.json');
  const digest = sha256('t'.repeat(40));
  const result = await cli(['init', 'broker', '--node', `worker=${digest}`, '--port', '18901', path]);
  expect(result.code).toBe(0);

  const config = loadBrokerConfig(path);
  expect(config.nodes).toHaveLength(1);
  // Parsing normalises a single digest into the rotation list the registry actually compares against.
  expect(config.nodes[0]?.tokenSha256s).toEqual([digest]);
  expect(config.port).toBe(18_901);
  // Default-deny is the point: a fresh broker admits the node's connection and authorises nothing.
  expect(Object.keys(config.capabilities)).toHaveLength(0);
  expect((statSync(path).mode & 0o777).toString(8)).toBe('600');
});

test('init rejects a broker with no registered node and a malformed digest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-init-bad-'));
  const empty = await cli(['init', 'broker', join(root, 'a.json')]);
  expect(empty.code).toBe(1);
  expect(empty.stderr).toContain('--node');

  const malformed = await cli(['init', 'broker', '--node', 'worker=short', join(root, 'b.json')]);
  expect(malformed.code).toBe(1);
  expect(malformed.stderr).toContain('<digest>');
});

test('a running agent reports which config file it read, and its mode', async () => {
  const port = freePort();
  const token = 'd'.repeat(40);
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-origin-'));
  const configPath = join(root, 'node.json');
  const socket = join(root, 'agent.sock');
  const broker = await startBroker(
    brokerConfig(
      { worker: token },
      {
        port,
        auditPath: join(root, 'audit.jsonl'),
      },
    ),
  );
  writeFileSync(
    configPath,
    `${JSON.stringify({
      nodeId: 'worker',
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }],
      agentSocket: socket,
    })}\n`,
    { mode: 0o600 },
  );
  let agent: AgentHandle | undefined;
  try {
    agent = await startAgent(loadNodeConfig(configPath), { path: configPath });
    const status = await agent.status();
    expect(status.config?.path).toBe(configPath);
    expect(status.config?.mode).toBe('600');
  } finally {
    await agent?.stop();
    await broker.stop();
  }
});

test('an agent built in-process reports no config origin instead of inventing one', async () => {
  const port = freePort();
  const token = 'e'.repeat(40);
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-origin-none-'));
  const broker = await startBroker(
    brokerConfig(
      { worker: token },
      {
        port,
        auditPath: join(root, 'audit.jsonl'),
      },
    ),
  );
  let agent: AgentHandle | undefined;
  try {
    agent = await startAgent(
      NodeConfigSchema.parse({
        brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }],
        nodeId: 'worker',
        agentSocket: join(root, 'agent.sock'),
      }),
    );
    const status = await agent.status();
    expect(status.config).toBeNull();
  } finally {
    await agent?.stop();
    await broker.stop();
  }
});

test('prune-rollbacks keeps the newest roots and never removes the freshest', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-prune-'));
  const rollback = join(root, 'rollback');
  for (const stamp of ['20260101-0000', '20260102-0000', '20260103-0000', '20260104-0000']) {
    mkdirSync(join(rollback, stamp), { recursive: true });
    writeFileSync(join(rollback, stamp, 'stitchwire.prev'), stamp);
  }
  const result = await cli(['prune-rollbacks', '--keep', '2'], { STITCHWIRE_STATE_DIR: root });
  expect(result.code).toBe(0);

  const left = readdirSync(rollback).sort();
  expect(left).toEqual(['20260103-0000', '20260104-0000']);
  // The point of a rollback root is the most recent one; a prune that can touch it is a trap.
  expect(readFileSync(join(rollback, '20260104-0000', 'stitchwire.prev'), 'utf8')).toBe('20260104-0000');
});

test('prune-rollbacks orders version roots by number, after the timestamp roots that preceded them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-prune-order-'));
  const rollback = join(root, 'rollback');
  for (const name of ['20260827T093625Z', 'v0.43.9', 'v0.43.10', 'v0.43.8'])
    mkdirSync(join(rollback, name), { recursive: true });
  const result = await cli(['prune-rollbacks', '--keep', '2'], { STITCHWIRE_STATE_DIR: root });
  expect(result.code).toBe(0);
  expect(readdirSync(rollback).sort()).toEqual(['v0.43.10', 'v0.43.9']);
});

test('prune-rollbacks refuses a keep count that would leave nothing to roll back to', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-prune-guard-'));
  mkdirSync(join(root, 'rollback', '20260101-0000'), { recursive: true });
  const result = await cli(['prune-rollbacks', '--keep', '0'], { STITCHWIRE_STATE_DIR: root });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('at least 1');
  expect(readdirSync(join(root, 'rollback'))).toHaveLength(1);
});
