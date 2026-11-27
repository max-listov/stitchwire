/**
 * The fake agent door every packed-client fixture talks to: an HTTP server on a Unix socket in its
 * own temporary directory, with the NDJSON framing and request reading the real door uses.
 *
 * Copied next to each fixture by `scripts/client-package/consumer-runtimes.ts`, so it imports only Node
 * built-ins and runs unchanged on Bun and Node.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** The runtime a fixture's verdict line names. */
export const runtime = process.versions.bun ? 'bun' : 'node';

/** One NDJSON frame, newline-terminated as the door writes it. */
export const line = (frame) => `${JSON.stringify(frame)}\n`;

/** The whole request body parsed as JSON, as the door reads a request. */
export async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

/**
 * Serve `handler` on a fresh Unix socket. `close` ends every open response, stops the server and
 * removes the directory, so a fixture's `finally` is one call.
 */
export async function openDoor(name, handler) {
  const root = await mkdtemp(join(tmpdir(), `wire-${name}-`));
  const socketPath = join(root, 'door.sock');
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  return {
    root,
    socketPath,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
