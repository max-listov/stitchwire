import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createWireClient } from '../packages/local-client/src/client.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';

/**
 * A node's id as a consumer learns it without reading `node.json`, which holds the node's tokens:
 * on the machine through the SDK, and from another machine through the CLI run there (over SSH, the
 * same command). Neither answer carries a token.
 */

const CLI = join(import.meta.dir, '..', 'packages', 'runtime', 'src', 'cli', 'main.ts');
const TOKEN = 'identitytoken'.padEnd(40, 'i');
const root = mkdtempSync(join(tmpdir(), 'wire-node-identity-'));
const socket = join(root, 'agent.sock');
const configPath = join(root, 'node.json');
let broker: Awaited<ReturnType<typeof startBroker>>;
let agent: AgentHandle;

beforeAll(async () => {
  const port = freePort();
  broker = await startBroker(brokerConfig({ 'identity-node': TOKEN }, { port }));
  const config = NodeConfigSchema.parse({
    nodeId: 'identity-node',
    brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token: TOKEN }],
    agentSocket: socket,
  });
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  agent = await startAgent(config);
  await waitConnected(agent);
});

afterAll(async () => {
  await agent?.stop();
  await broker?.stop();
  rmSync(root, { recursive: true, force: true });
});

async function cli(...args: string[]): Promise<{ code: number; stdout: string }> {
  const child = Bun.spawn(['bun', CLI, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, STITCHWIRE_AGENT_SOCKET: socket },
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

const NodeIdAnswerSchema = z.object({ nodeId: z.string() });

test('on the machine, the SDK status names the node', async () => {
  const client = createWireClient({ socketPath: socket });
  try {
    expect((await client.status()).nodeId).toBe('identity-node');
  } finally {
    client.close();
  }
});

test('from another machine, `stitchwire status --json` run there names the node, without a token', async () => {
  const { code, stdout } = await cli('status', '--json');
  expect(code).toBe(0);
  expect(NodeIdAnswerSchema.parse(JSON.parse(stdout)).nodeId).toBe('identity-node');
  expect(stdout).not.toContain(TOKEN);
});

test('with the agent stopped, `stitchwire config inspect node` names it from the file, without a token', async () => {
  const { code, stdout } = await cli('config', 'inspect', 'node', configPath);
  expect(code).toBe(0);
  expect(NodeIdAnswerSchema.parse(JSON.parse(stdout)).nodeId).toBe('identity-node');
  expect(stdout).not.toContain(TOKEN);
  // Control: the file itself holds the token, so its absence above is a property of the answer.
  expect(readFileSync(configPath, 'utf8')).toContain(TOKEN);
});
