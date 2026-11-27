import { describe, expect, test } from 'bun:test';
import {
  extractWireClientError,
  extractWireServiceError,
  WireClientError,
  WireServiceError,
  wireErrorCode,
} from '../packages/client/src/index.ts';

describe('error chain extraction (extractWireServiceError, extractWireClientError, wireErrorCode)', () => {
  const deniedService = new WireServiceError({
    status: 'failure',
    code: 'denied',
    delivery: 'not-dispatched',
    retryAfterMs: null,
    refusal: 'policy',
    transportCause: null,
    detail: 'no grant',
  });
  const unavailableClient = new WireClientError('unavailable', 'agent down', 'not-sent');

  test('unwraps nested cause chains, picks outermost Wire error and guards against cycles/non-Errors', () => {
    const deep = new Error('layer 3', {
      cause: new Error('layer 2', { cause: new Error('layer 1', { cause: deniedService }) }),
    });
    expect(extractWireServiceError(deep)).toBe(deniedService);
    expect(extractWireClientError(deep)).toBeUndefined();
    expect(wireErrorCode(deep)).toEqual({ source: 'service', code: 'denied' });

    const wrappedClient = new Error('outer', { cause: unavailableClient });
    expect(extractWireClientError(wrappedClient)).toBe(unavailableClient);
    expect(wireErrorCode(wrappedClient)).toEqual({ source: 'client', code: 'unavailable' });

    const mixed = new WireClientError('timeout', 'outer timeout', 'unknown', { cause: deniedService });
    expect(wireErrorCode(mixed)).toEqual({ source: 'client', code: 'timeout' });
    expect(extractWireServiceError(mixed)).toBe(deniedService);

    // Cycle protection
    const cyclicA: { cause?: unknown } = {};
    const cyclicB = { cause: cyclicA };
    cyclicA.cause = cyclicB;
    expect(wireErrorCode(cyclicA)).toBeUndefined();

    // Throwing getter protection
    const hostile = {};
    Object.defineProperty(hostile, 'cause', {
      get() {
        throw new Error('boom');
      },
    });
    expect(wireErrorCode(hostile)).toBeUndefined();
    expect(wireErrorCode(null)).toBeUndefined();
    expect(wireErrorCode('string')).toBeUndefined();

    // Negative control: AggregateError.errors is NOT traversed; only .cause is walked.
    const agg = new AggregateError([deniedService, unavailableClient], 'multiple failures');
    expect(extractWireServiceError(agg)).toBeUndefined();
    expect(extractWireClientError(agg)).toBeUndefined();
    expect(wireErrorCode(agg)).toBeUndefined();
    const aggWithCause = new AggregateError([unavailableClient], 'wrapped', { cause: deniedService });
    expect(wireErrorCode(aggWithCause)).toEqual({ source: 'service', code: 'denied' });

    // maxDepth cutoff: chain deeper than maxDepth returns undefined
    expect(wireErrorCode(deep, 2)).toBeUndefined();
    expect(extractWireServiceError(deep, 2)).toBeUndefined();
    expect(wireErrorCode(deep, 4)).toEqual({ source: 'service', code: 'denied' });
    expect(() => wireErrorCode(deep, 0)).toThrow(RangeError);
    expect(() => extractWireServiceError(deep, Number.NaN)).toThrow(RangeError);
  });

  test('the same code from the service and from the local client is told apart by its source', () => {
    const serviceTimeout = new WireServiceError({
      status: 'failure',
      code: 'timeout',
      delivery: 'unknown',
      retryAfterMs: null,
      refusal: 'none',
      transportCause: null,
      detail: 'owner deadline',
    });
    const clientTimeout = new WireClientError('timeout', 'local socket deadline', 'unknown');
    const fromService = wireErrorCode(new Error('call failed', { cause: serviceTimeout }));
    const fromClient = wireErrorCode(new Error('call failed', { cause: clientTimeout }));
    expect(fromService?.code).toBe('timeout');
    expect(fromClient?.code).toBe('timeout');
    expect(fromService).toEqual({ source: 'service', code: 'timeout' });
    expect(fromClient).toEqual({ source: 'client', code: 'timeout' });
    expect(fromService).not.toEqual(fromClient);
  });

  test('a value whose every trap throws, at the root or inside the chain, is no Wire failure', () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('trap');
        },
        get() {
          throw new Error('trap');
        },
        has() {
          throw new Error('trap');
        },
      },
    );
    for (const error of [hostile, new Error('wrapped', { cause: hostile })]) {
      expect(wireErrorCode(error)).toBeUndefined();
      expect(extractWireServiceError(error)).toBeUndefined();
      expect(extractWireClientError(error)).toBeUndefined();
    }
    // Control: a Wire failure before the hostile link is still found.
    expect(
      wireErrorCode(
        new Error('wrapped', { cause: new WireClientError('timeout', 'x', 'unknown', { cause: hostile }) }),
      ),
    ).toEqual({
      source: 'client',
      code: 'timeout',
    });
  });

  test('the cause chain is walked sixteen links deep by default', () => {
    const service = new WireServiceError({
      status: 'failure',
      code: 'denied',
      delivery: 'not-dispatched',
      retryAfterMs: null,
      refusal: 'none',
      transportCause: null,
      detail: 'x',
    });
    const wrap = (depth: number): unknown =>
      Array.from({ length: depth }).reduce<unknown>((cause) => new Error('wrap', { cause }), service);
    expect(wireErrorCode(wrap(15))).toEqual({ source: 'service', code: 'denied' });
    expect(wireErrorCode(wrap(16))).toBeUndefined();
  });
});
