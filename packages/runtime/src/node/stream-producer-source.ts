import { parseNDJSON } from 'stitchkit';
import { z } from 'zod';
import { StreamChannelSchema, type StreamInvoke } from '../../../contracts/src/protocol/stream.ts';
import { ProducerFailure } from './stream-failure.ts';

const FramedChunkSchema = z
  .object({
    channel: StreamChannelSchema.default('data'),
    data: z.string(),
    cursor: z.string().min(1).max(512).nullable().default(null),
  })
  .strict();

export class ProducerSourceReader {
  constructor(
    private readonly invoke: StreamInvoke,
    private readonly send: (
      channel: 'stdout' | 'stderr' | 'data',
      bytes: Uint8Array,
      cursor: string | null,
    ) => Promise<void>,
  ) {}

  async readRaw(
    stream: ReadableStream<Uint8Array> | null,
    channel: 'stdout' | 'stderr' | 'data',
    idleTimeoutMs?: number,
  ): Promise<void> {
    if (stream === null) return;
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } =
          idleTimeoutMs === undefined || idleTimeoutMs === 0
            ? await reader.read()
            : await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
                const timer = setTimeout(
                  () => reject(new ProducerFailure('timeout', 'owner stream idle timeout')),
                  idleTimeoutMs,
                );
                reader.read().then(
                  (result) => {
                    clearTimeout(timer);
                    resolve(result);
                  },
                  (error) => {
                    clearTimeout(timer);
                    reject(error);
                  },
                );
              });
        if (done) return;
        if (value === undefined) continue;
        let offset = 0;
        while (offset < value.byteLength) {
          const size = Math.min(
            this.invoke.limits.maxChunkBytes,
            this.invoke.limits.maxWindowBytes,
            value.byteLength - offset,
          );
          await this.send(channel, value.subarray(offset, offset + size), null);
          offset += size;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async readFramed(stream: ReadableStream<Uint8Array> | null, stableCursor: boolean): Promise<void> {
    if (stream === null) return;
    try {
      for await (const raw of parseNDJSON<unknown>(new Response(stream), {
        maxLineBytes: this.invoke.limits.maxChunkBytes * 2,
        finalLine: 'allow',
      }))
        await this.sendFramedValue(raw, stableCursor);
    } catch (error) {
      if (error instanceof ProducerFailure) throw error;
      throw new ProducerFailure(
        error instanceof RangeError ? 'limit' : 'error',
        error instanceof RangeError
          ? 'framed producer line exceeds the bounded parser buffer'
          : 'producer emitted invalid bounded NDJSON',
      );
    }
  }

  private async sendFramedValue(raw: unknown, stableCursor: boolean): Promise<void> {
    const parsed = FramedChunkSchema.safeParse(raw);
    if (!parsed.success) {
      /**
       * Name what was wrong, not just that something was.
       *
       * A profile whose `argv` prints the event itself rather than the `{ channel?, data, cursor }`
       * envelope this mode expects is a one-word mistake in a config, and it cannot be caught before
       * the producer runs — nothing knows what a program will print until it prints. So the only
       * place it can be made cheap is here, in what the failure says. "invalid framed chunk" sent
       * the reader to the transport; the issue path sends them to the flag.
       */
      const issue = parsed.error.issues[0];
      const where = issue === undefined ? 'unknown field' : `'${issue.path.join('.') || '(root)'}'`;
      throw new ProducerFailure(
        'error',
        `producer emitted an invalid framed chunk at ${where}: ${issue?.message ?? 'does not match { channel?, data, cursor }'} — an ndjson profile expects the envelope, not the payload`,
      );
    }
    if (stableCursor && parsed.data.cursor === null) {
      throw new ProducerFailure('error', 'stable-cursor producer emitted a chunk without a cursor');
    }
    const bytes = new TextEncoder().encode(parsed.data.data);
    if (bytes.byteLength > Math.min(this.invoke.limits.maxChunkBytes, this.invoke.limits.maxWindowBytes)) {
      throw new ProducerFailure('limit', 'framed chunk exceeds the per-chunk byte ceiling');
    }
    await this.send(parsed.data.channel, bytes, parsed.data.cursor);
  }
}
