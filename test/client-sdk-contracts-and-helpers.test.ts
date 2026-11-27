import { describe, expect, test } from 'bun:test';
import {
  brokerHealthUrl,
  isTopicAuthorized,
  isTopicInNamespace,
  parseTopicDescriptor,
  readBrokerHealth,
  TopicProfileSchema,
} from '../packages/client/src/index.ts';
import * as browserContracts from '../packages/client/src/contracts.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { brokerConfig, freePort } from './support.ts';

describe('brokerHealthUrl and readBrokerHealth', () => {
  test('normalizes ws/wss/http/https lane URLs to /health and rejects unsafe inputs', () => {
    expect(brokerHealthUrl('ws://127.0.0.1:8790')).toBe('http://127.0.0.1:8790/health');
    expect(brokerHealthUrl('wss://broker.example.test:8443/')).toBe(
      'https://broker.example.test:8443/health',
    );
    expect(brokerHealthUrl('https://broker.example.test/wire/')).toBe(
      'https://broker.example.test/wire/health',
    );
    expect(brokerHealthUrl('http://127.0.0.1:8790/health')).toBe('http://127.0.0.1:8790/health');

    for (const invalid of [
      'not a url',
      'file:///etc/passwd',
      'ftp://broker.example.test',
      'https://user:pass@broker.example.test',
      'https://broker.example.test?token=secret',
      'https://broker.example.test?',
      'https://broker.example.test#frag',
      'https://broker.example.test#',
    ]) {
      expect(() => brokerHealthUrl(invalid)).toThrow(TypeError);
    }
    expect(brokerHealthUrl('ws://127.0.0.1:8790/edge')).toBe('http://127.0.0.1:8790/edge/health');
  });

  test('reads live broker /health over ws:// lane URL and tolerates additive fields', async () => {
    const port = freePort();
    const broker = await startBroker(brokerConfig({ worker: 'worker-secret-token-health' }, { port }));
    try {
      const health = await readBrokerHealth(`ws://127.0.0.1:${port}`);
      expect(health.ok).toBe(true);
      expect(health.application?.ready).toBe(true);
      expect(Array.isArray(health.nodes)).toBe(true);

      // Additive field on broker response and inside departure must be stripped cleanly.
      const withAdditive = await readBrokerHealth(`http://127.0.0.1:${port}`, {
        fetch: async () =>
          Response.json({
            ...health,
            futureField: 'ignored',
            nodes: [
              {
                nodeId: 'worker',
                online: false,
                serves: true,
                connections: 0,
                since: null,
                version: health.fleet.latest,
                behind: null,
                versionSeenAt: null,
                departure: {
                  at: '2026-11-23T00:00:00.000Z',
                  reason: 'ping timeout',
                  kind: 'lost',
                  futureDepartureField: true,
                },
                observingSince: health.observingSince,
              },
            ],
          }),
      });
      expect(withAdditive.ok).toBe(true);
      expect('futureField' in withAdditive).toBe(false);
      expect(withAdditive.nodes[0]?.departure?.kind).toBe('lost');
    } finally {
      await broker.stop();
    }
  });

  test('maps HTTP, limit, invalid-response, timeout, cancelled and invalid-request failures explicitly', async () => {
    await expect(readBrokerHealth('ftp://bad')).rejects.toMatchObject({
      code: 'invalid-request',
      delivery: 'not-sent',
    });
    await expect(readBrokerHealth('http://127.0.0.1:9', { timeoutMs: 10 })).rejects.toMatchObject({
      code: 'invalid-request',
      delivery: 'not-sent',
    });
    await expect(readBrokerHealth('http://127.0.0.1:9', { maxResponseBytes: 0 })).rejects.toMatchObject({
      code: 'invalid-request',
      delivery: 'not-sent',
    });

    // HTTP 302 redirect is refused via redirect: 'error'
    const redirectServer = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/other' } }),
    });
    try {
      await expect(readBrokerHealth(`http://127.0.0.1:${redirectServer.port}`)).rejects.toMatchObject({
        code: 'transport',
      });
    } finally {
      await redirectServer.stop(true);
    }

    // Real refused connection maps to unavailable / not-sent (including Node/undici nested cause shapes)
    await expect(
      readBrokerHealth(`http://127.0.0.1:${freePort()}`, { timeoutMs: 2000 }),
    ).rejects.toMatchObject({
      code: 'unavailable',
      delivery: 'not-sent',
    });
    await expect(
      readBrokerHealth('http://127.0.0.1:9', {
        fetch: async () => {
          const inner = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
          throw new TypeError('fetch failed', { cause: new AggregateError([inner], 'dual-stack') });
        },
      }),
    ).rejects.toMatchObject({ code: 'unavailable', delivery: 'not-sent' });

    // Content-Length pre-check refuses oversized responses and cancels unread body
    let bodyCancelled = false;
    await expect(
      readBrokerHealth('http://127.0.0.1:9', {
        maxResponseBytes: 32,
        fetch: async () =>
          new Response(
            new ReadableStream({
              cancel() {
                bodyCancelled = true;
              },
            }),
            { status: 200, headers: { 'content-length': '9999' } },
          ),
      }),
    ).rejects.toMatchObject({ code: 'limit' });
    expect(bodyCancelled).toBe(true);

    // Invalid UTF-8 bytes map to invalid-response
    await expect(
      readBrokerHealth('http://127.0.0.1:9', {
        fetch: async () => new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-response' });

    await expect(
      readBrokerHealth('http://127.0.0.1:9', {
        fetch: async () => new Response('down', { status: 503 }),
      }),
    ).rejects.toMatchObject({ code: 'http', metadata: { status: 503 } });

    await expect(
      readBrokerHealth('http://127.0.0.1:9', {
        maxResponseBytes: 32,
        fetch: async () => new Response('x'.repeat(64), { status: 200 }),
      }),
    ).rejects.toMatchObject({ code: 'limit' });

    // A body that is not JSON is the broker answering badly, not the broker missing: the parse
    // error travels as the cause.
    const notJson = await readBrokerHealth('http://127.0.0.1:9', {
      fetch: async () => new Response('{not json', { status: 200 }),
    }).catch((error: unknown) => error);
    expect(notJson).toMatchObject({ code: 'invalid-response' });
    expect(Reflect.get(Object(Reflect.get(Object(notJson), 'metadata')), 'cause')).toBeInstanceOf(
      SyntaxError,
    );

    await expect(
      readBrokerHealth('http://127.0.0.1:9', {
        fetch: async () => Response.json({ ok: true }),
      }),
    ).rejects.toMatchObject({ code: 'invalid-response' });

    const aborted = new AbortController();
    aborted.abort(new Error('stop'));
    await expect(readBrokerHealth('http://127.0.0.1:9', { signal: aborted.signal })).rejects.toMatchObject({
      code: 'cancelled',
      delivery: 'not-sent',
    });

    await expect(
      readBrokerHealth('http://127.0.0.1:9', {
        timeoutMs: 500,
        fetch: (_input, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  /** A response whose body sends its first bytes, then stalls until cancelled. */
  function stalledBody(): { response: Response; started: Promise<void>; cancelled: () => boolean } {
    let cancelled = false;
    let markStarted = () => {};
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return new Promise<void>(() => {});
        sent = true;
        controller.enqueue(new TextEncoder().encode('{"ok":'));
        markStarted();
      },
      cancel() {
        cancelled = true;
      },
    });
    return { response: new Response(body, { status: 200 }), started, cancelled: () => cancelled };
  }

  test('a body that stalls after its first bytes ends as timeout, not as cancelled', async () => {
    const stalled = stalledBody();
    const reading = readBrokerHealth('http://127.0.0.1:9', {
      timeoutMs: 500,
      fetch: async () => stalled.response,
    });
    await stalled.started;
    await expect(reading).rejects.toMatchObject({ code: 'timeout', delivery: 'unknown' });
    expect(stalled.cancelled()).toBe(true);
  });

  test('a caller abort while the body is being read ends as cancelled, not as timeout', async () => {
    const stalled = stalledBody();
    const caller = new AbortController();
    const reading = readBrokerHealth('http://127.0.0.1:9', {
      timeoutMs: 30_000,
      signal: caller.signal,
      fetch: async () => stalled.response,
    });
    await stalled.started;
    caller.abort(new Error('operator stopped'));
    await expect(reading).rejects.toMatchObject({ code: 'cancelled', delivery: 'unknown' });
    expect(stalled.cancelled()).toBe(true);
  });

  test('a caller abort while the request is in flight, before headers, ends as cancelled', async () => {
    const caller = new AbortController();
    let dispatched = () => {};
    const inFlight = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const reading = readBrokerHealth('http://127.0.0.1:9', {
      timeoutMs: 30_000,
      signal: caller.signal,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          dispatched();
        }),
    });
    await inFlight;
    caller.abort(new Error('operator stopped'));
    await expect(reading).rejects.toMatchObject({ code: 'cancelled', delivery: 'unknown' });
  });
});

describe('topic descriptor contracts and namespace authorization helpers', () => {
  test('TopicProfileSchema and parseTopicDescriptor enforce defaults and reject contradictions', () => {
    const valid = parseTopicDescriptor({
      topics: {
        'owner.node.checks': { delivery: 'ordered', publicationMode: 'on-change' },
        'owner.node.fast': { delivery: 'latest-wins', publicationMode: 'periodic', maxEventBytes: 8192 },
      },
    });
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.topics['owner.node.checks']?.retain).toEqual({ maxAgeMs: 0, maxBytes: 0 });
    }

    const contradiction = TopicProfileSchema.safeParse({
      delivery: 'latest-wins',
      retain: { maxAgeMs: 1000, maxBytes: 1024 },
    });
    expect(contradiction.success).toBe(false);

    const bad = parseTopicDescriptor({ topics: { 'Invalid Topic!': { delivery: 'ordered' } } });
    expect(bad.ok).toBe(false);
  });

  test('isTopicInNamespace enforces segment boundary and isTopicAuthorized checks both exact and namespace grants', () => {
    expect(isTopicInNamespace('owner.node.', 'owner.node.checks')).toBe(true);
    expect(isTopicInNamespace('owner:node:', 'owner:node:checks')).toBe(true);
    expect(isTopicInNamespace('owner.node.', 'owner.node.')).toBe(false);
    expect(isTopicInNamespace('owner.node', 'owner.nodes.checks')).toBe(false);
    expect(isTopicInNamespace('', 'owner.node.checks')).toBe(false);
    expect(isTopicInNamespace('.', '.checks')).toBe(false);
    // One rule: a namespace the schema refuses covers nothing, whatever its last character.
    for (const namespace of ['A.', 'owner .', '-owner.', `${'a'.repeat(128)}.`, 'owner.', 'a:', 'x-y.z:'])
      expect(isTopicInNamespace(namespace, `${namespace}topic`)).toBe(
        browserContracts.TopicNamespaceSchema.safeParse(namespace).success,
      );

    const grants = {
      publish: ['exact.pub'],
      subscribe: ['exact.sub'],
      namespaces: { publish: ['owner.pub.'], subscribe: ['owner.sub.'] },
    };
    expect(isTopicAuthorized('exact.pub', grants, 'publish')).toBe(true);
    expect(isTopicAuthorized('owner.pub.metrics', grants, 'publish')).toBe(true);
    expect(isTopicAuthorized('owner.sub.metrics', grants, 'publish')).toBe(false);
    expect(isTopicAuthorized('exact.sub', grants, 'subscribe')).toBe(true);
    expect(isTopicAuthorized('owner.sub.metrics', grants, 'subscribe')).toBe(true);
    expect(isTopicAuthorized('owner.pub.metrics', grants, 'subscribe')).toBe(false);
  });

  test('browser-safe contracts entry re-exports schemas and pure helpers cleanly', () => {
    expect(browserContracts.isTopicInNamespace).toBe(isTopicInNamespace);
    expect(browserContracts.isTopicAuthorized).toBe(isTopicAuthorized);
    expect(browserContracts.parseTopicDescriptor).toBe(parseTopicDescriptor);
    expect(browserContracts.brokerHealthUrl).toBe(brokerHealthUrl);
    expect(browserContracts.ClientErrorCodeSchema.parse('unavailable')).toBe('unavailable');
    expect(browserContracts.ServiceFailureCodeSchema.parse('offline')).toBe('offline');
    expect(browserContracts.FleetConfigStateSchema.parse('aligned')).toBe('aligned');
  });
});
