import type { ClientSession, Operation } from './operation.ts';
import { checkResponse, openDoor, type DoorPath } from './http.ts';
import { createClient, defineContract } from 'stitchkit';
import { z } from 'zod';
import { itemStream } from '../../contracts/src/door/streams.ts';
import { WireClientError } from './errors.ts';

export interface WireFeed<T> extends AsyncIterableIterator<T> {
  close(): void;
  return(): Promise<IteratorResult<T>>;
}

export function createFeed<T>(
  session: ClientSession,
  path: DoorPath,
  body: unknown,
  parse: (value: unknown) => T,
  terminal: z.ZodType,
  signal?: AbortSignal,
  durationMs?: number,
  confirmsOpen?: (item: T) => boolean,
): WireFeed<T> {
  let operation: Operation | undefined;
  let closed = false;
  let pending = false;
  const close = (): void => {
    closed = true;
    operation?.abort('cancelled');
    operation?.finish();
  };
  const source = (async function* () {
    if (closed) return;
    operation = session.begin(signal);
    operation.deadline(session.options.openTimeoutMs);
    const current = operation;
    try {
      const contract = defineContract(
        { prefix: path },
        {
          read: {
            method: 'POST',
            // The composed door path scopes this input-free stream contract.
            path: '',
            desc: 'Wire local feed',
            stream: itemStream(
              z.unknown().transform((value) => {
                const item = parse(value);
                if (confirmsOpen?.(item)) current.clearDeadline();
                return item;
              }),
              terminal,
              session.options.maxFrameBytes,
            ),
          },
        },
      );
      const client = createClient(contract, {
        baseUrl: 'http://wire.invalid',
        timeout: session.options.openTimeoutMs,
        fetch: async (_url, init) => {
          // Kit's terminal/return owns this signal, including cleanup before terminal yield.
          init?.signal?.addEventListener('abort', () => current.finish(), { once: true });
          const response = await openDoor(session, current, path, body, init?.signal ?? undefined);
          if (confirmsOpen === undefined) current.clearDeadline();
          if (durationMs !== undefined) current.deadline(durationMs);
          checkResponse(response, 'ndjson');
          return response;
        },
      });
      yield* await client.read.withOptions({ signal: current.controller.signal });
    } catch (error) {
      throw operation.error(error);
    } finally {
      operation.controller.abort();
      operation.finish();
    }
  })();
  const feed: WireFeed<T> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      if (pending)
        throw new WireClientError('capacity', 'Concurrent feed reads are not supported', 'not-sent');
      if (closed) return { done: true, value: undefined };
      pending = true;
      try {
        return await source.next();
      } finally {
        pending = false;
      }
    },
    async return() {
      close();
      return await source.return(undefined);
    },
    close,
  };
  return feed;
}
