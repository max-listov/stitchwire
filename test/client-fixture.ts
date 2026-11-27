import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function withDoor(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'wire-client-test-'));
  const socketPath = join(root, 'agent.sock');
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    await run(socketPath);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

export function result(fields: Record<string, unknown> = {}) {
  return {
    v: LOCAL_API_VERSION,
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: 'worker',
    code: 0,
    stdout: 'hello\n',
    stderr: '',
    failure: 'none',
    refusal: 'none',
    retryAfterMs: null,
    transportCause: null,
    detail: '',
    truncated: false,
    ...fields,
  };
}

export function chunk(streamId = crypto.randomUUID(), seq = 0) {
  return {
    v: LOCAL_API_VERSION,
    streamId,
    from: 'worker',
    seq,
    channel: 'stdout',
    encoding: 'base64',
    data: Buffer.from('hello').toString('base64'),
    bytes: 5,
    cursor: null,
  };
}

export function end(streamId: string, lastSeq = 0) {
  return {
    v: LOCAL_API_VERSION,
    streamId,
    from: 'worker',
    lastSeq,
    code: 0,
    reason: 'completed',
    cursor: null,
  };
}

export function deferred() {
  let done = (): void => {};
  const promise = new Promise<void>((resolve) => {
    done = resolve;
  });
  return { promise, done };
}
