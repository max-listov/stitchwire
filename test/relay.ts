import { connect, createServer, type Socket } from 'node:net';
import { listenLoopback } from './support.ts';

/**
 * A TCP relay between a node and its broker that a test can interfere with without stopping either:
 * `cut` ends every connection, and `hold` keeps back what the broker sends to the node until
 * `release`, so the node sees a broker that is late in answering while the byte stream stays whole.
 */
export async function relay(upstreamPort: number) {
  const open = new Set<Socket>();
  let held = false;
  const toNode: Array<{ node: Socket; chunk: Buffer }> = [];
  const server = createServer((node) => {
    const upstream = connect(upstreamPort, '127.0.0.1');
    for (const socket of [node, upstream]) {
      open.add(socket);
      socket.on('close', () => open.delete(socket));
      socket.on('error', () => socket.destroy());
    }
    node.pipe(upstream);
    upstream.on('data', (chunk: Buffer) => {
      if (held) toNode.push({ node, chunk });
      else node.write(chunk);
    });
    upstream.on('end', () => node.end());
  });
  const port = await listenLoopback(server);
  return {
    port,
    hold: (): void => {
      held = true;
    },
    release: (): void => {
      held = false;
      for (const { node, chunk } of toNode.splice(0)) node.write(chunk);
    },
    cut: (): void => {
      for (const socket of open) socket.destroy();
    },
    close: (): void => {
      for (const socket of open) socket.destroy();
      server.close();
    },
  };
}
