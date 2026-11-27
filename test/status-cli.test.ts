import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { AgentHandle } from '../packages/runtime/src/node/agent-contract.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { brokerConfig, freePort, waitConnected } from './support.ts';
import { temporaryFile } from './temporary.ts';

/**
 * `stitchwire status` as an operator reads it: the real command against a real agent whose allowlist
 * names a command and a stream profile whose programs are not on the machine.
 */

const CLI = join(import.meta.dir, '..', 'packages', 'runtime', 'src', 'cli', 'main.ts');
const TOKEN = 's'.repeat(40);
const socket = temporaryFile('status-cli.sock');
let broker: Awaited<ReturnType<typeof startBroker>>;
let agent: AgentHandle;

beforeAll(async () => {
  const port = freePort();
  broker = await startBroker(brokerConfig({ worker: TOKEN }, { port }));
  agent = await startAgent(
    NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token: TOKEN }],
      agentSocket: socket,
      allow: {
        present: { bin: '/bin/echo' },
        absent: { bin: '/nonexistent/command-binary' },
      },
      streams: {
        present: { bin: '/bin/echo', maxBytes: 1024 },
        absent: { bin: '/nonexistent/stream-binary', maxBytes: 1024 },
      },
    }),
  );
  await waitConnected(agent);
});

afterAll(async () => {
  await agent?.stop();
  await broker?.stop();
});

async function status(): Promise<{ code: number; lines: string[] }> {
  const child = Bun.spawn(['bun', CLI, 'status'], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, STITCHWIRE_AGENT_SOCKET: socket },
  });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, lines: stdout.split('\n') };
}

test('a command whose endpoint is missing and a stream whose binary is missing are named as such', async () => {
  const { code, lines } = await status();
  expect(code).toBe(0);
  const row = (name: string) => lines.find((line) => line.startsWith(name)) ?? '';
  expect(row('allowed')).toContain('absent (NO ENDPOINT)');
  expect(row('allowed')).not.toContain('present (NO ENDPOINT)');
  expect(row('streams')).toContain('absent (NO BINARY)');
  expect(row('streams')).not.toContain('present (NO BINARY)');
  // The words are English: the report is read by whoever is on the machine.
  expect(lines.join('\n')).not.toMatch(/[\u0400-\u04FF]/);
});
