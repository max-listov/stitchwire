import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { startAgent } from '../packages/runtime/src/node/agent-application.ts';
import { freePort } from './support.ts';

/**
 * A socket's mode is judged at the moment it appears, by a separate process that looks without pausing:
 * the mode after a start returns is right even for a socket that was wider for a while, so it proves
 * nothing about who could have found it wider.
 */
const OBSERVER = join(import.meta.dir, 'socket-birth-observer.ts');
/** Enough starts that a socket narrowed after creation is caught: a `chmod` right after `listen` loses most of them. */
const RUNS = 12;
const root = mkdtempSync(join(tmpdir(), 'wire-birth-'));
afterAll(() => rm(root, { recursive: true, force: true }));
let run = 0;
const socketPath = () => join(root, `${run++}.sock`);

/** Runs `bind` once the observer is watching `socket`, and returns the socket mode it first saw. */
async function birth(socket: string, bind: () => Promise<unknown> | unknown): Promise<string> {
  const observer = Bun.spawn([process.execPath, OBSERVER, root, socket], {
    stdout: 'pipe',
    stderr: 'inherit',
  });
  try {
    const reader = observer.stdout.getReader();
    let text = '';
    while (!text.includes('ready\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`observer ended before it was ready: ${text}`);
      text += new TextDecoder().decode(chunk.value);
    }
    await bind();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    // The observer prints `<directory> <socket>`; the directory is this file's own and already existed.
    return text.replace('ready\n', '').trim().split(' ').at(-1) ?? '';
  } finally {
    observer.kill();
  }
}

/** The tests set a wide process umask themselves, so a socket left to it is visibly wider than 0600. */
function withUmask<T>(mask: number, body: () => Promise<T>): Promise<T> {
  const previous = process.umask(mask);
  return body().finally(() => process.umask(previous));
}

describe('a Unix socket Wire binds is 0600 from the moment it exists', () => {
  test('the observer sees a plainly bound socket with the mode the process umask gives it', () =>
    withUmask(0o022, async () => {
      const socket = socketPath();
      let server: ReturnType<typeof Bun.serve> | undefined;
      expect(
        await birth(socket, () => (server = Bun.serve({ unix: socket, fetch: () => new Response() }))),
      ).toBe('755');
      server?.stop(true);
    }));

  test('the agent door', () =>
    withUmask(0o022, async () => {
      const seen: string[] = [];
      for (let index = 0; index < RUNS; index++) {
        const agentSocket = socketPath();
        // Nothing listens on the broker port: the door starts whether or not a lane connects.
        const config = NodeConfigSchema.parse({
          nodeId: 'worker',
          brokers: [{ id: 'primary', url: `http://127.0.0.1:${freePort()}`, token: 'b'.repeat(40) }],
          agentSocket,
        });
        let agent: Awaited<ReturnType<typeof startAgent>> | undefined;
        seen.push(
          await birth(agentSocket, async () => {
            agent = await startAgent(config);
          }),
        );
        await agent?.stop();
      }
      expect(seen).toEqual(Array.from({ length: RUNS }, () => '600'));
    }));
});
