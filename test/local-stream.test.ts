import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'stitchkit/server';
import type { StreamConsumerFrame } from '../packages/contracts/src/door/local-contract.ts';
import { createStreamDoorService } from '../packages/runtime/src/node/stream-local.ts';

describe('local stream HTTP lifecycle', () => {
  test('keeps a quiet bounded stream alive beyond Bun HTTP idle timeout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'stitchwire-idle-stream-'));
    const socket = join(root, 'agent.sock');
    const route = createStreamDoorService({
      async *openStream(): AsyncIterableIterator<StreamConsumerFrame> {
        yield {
          streamId: crypto.randomUUID(),
          from: 'producer',
          seq: 0,
          channel: 'data',
          encoding: 'base64',
          data: 'eA==',
          bytes: 1,
          cursor: null,
        };
        await Bun.sleep(10_500);
        yield {
          streamId: crypto.randomUUID(),
          from: 'producer',
          lastSeq: 0,
          code: 0,
          reason: 'completed',
          cursor: null,
        };
      },
    });
    const server = createServer({
      unix: socket,
      services: [route],
    });
    try {
      const response = await fetch('http://localhost/wire/stream', {
        unix: socket,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ to: 'producer', profile: 'logs' }),
      });
      expect(response.status).toBe(200);
      if (response.body === null) throw new Error('stream response body is missing');
      let body = '';
      for await (const chunk of response.body) body += new TextDecoder().decode(chunk);
      expect(body.includes('\n\n')).toBeTrue();
      const frames = body
        .trim()
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line));
      expect(frames).toHaveLength(2);
      expect(frames[1]?.reason).toBe('completed');
    } finally {
      await server.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);
});
