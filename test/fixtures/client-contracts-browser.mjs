import assert from 'node:assert/strict';

/**
 * Prove that `@stitchwire/client/contracts` imports and executes cleanly when `globalThis.Buffer`
 * and `globalThis.process` are actually absent (`undefined`), and prove `readBrokerHealth` maps
 * refused connections consistently to `unavailable` / `not-sent` on both Bun and Node.
 */
const bufferDesc = Object.getOwnPropertyDescriptor(globalThis, 'Buffer');
const processDesc = Object.getOwnPropertyDescriptor(globalThis, 'process');
const isBun = typeof Bun !== 'undefined';

Object.defineProperty(globalThis, 'Buffer', { value: undefined, configurable: true, writable: true });
Object.defineProperty(globalThis, 'process', { value: undefined, configurable: true, writable: true });

try {
  assert.equal(typeof globalThis.Buffer, 'undefined', 'Buffer must be hidden before importing /contracts');
  assert.equal(typeof globalThis.process, 'undefined', 'process must be hidden before importing /contracts');

  const contracts = await import('@stitchwire/client/contracts');

  assert.equal(
    contracts.brokerHealthUrl('wss://broker.example.test:8443/'),
    'https://broker.example.test:8443/health',
  );
  assert.equal(contracts.brokerHealthUrl('ws://127.0.0.1:8790/health'), 'http://127.0.0.1:8790/health');

  assert.equal(contracts.isTopicInNamespace('owner.node.', 'owner.node.checks'), true);
  assert.equal(contracts.isTopicInNamespace('owner.node', 'owner.nodes.checks'), false);
  assert.equal(contracts.isTopicInNamespace('', 'owner.node.checks'), false);

  assert.equal(
    contracts.isTopicAuthorized(
      'owner.node.checks',
      { publish: [], subscribe: [], namespaces: { subscribe: ['owner.node.'] } },
      'subscribe',
    ),
    true,
  );
  assert.equal(
    contracts.isTopicAuthorized(
      'owner.node.checks',
      { publish: [], subscribe: [], namespaces: { subscribe: ['owner.node.'] } },
      'publish',
    ),
    false,
  );

  // Exercise TopicNameSchema (previously called Buffer.byteLength!) with Buffer actually undefined.
  const parsedTopics = contracts.parseTopicDescriptor({
    topics: { 'owner.node.checks': { delivery: 'ordered', publicationMode: 'on-change' } },
  });
  assert.equal(parsedTopics.ok, true);

  // Exercise CallResultSchema (previously called Buffer.byteLength in resultRefinement!) with Buffer undefined.
  const parsedCall = contracts.CallResultSchema.parse({
    v: contracts.LOCAL_API_VERSION,
    id: '11111111-1111-4111-8111-111111111111',
    ts: '2026-11-23T00:00:00.000Z',
    from: 'worker',
    code: 0,
    stdout: 'ok',
    stderr: '',
    failure: 'none',
    refusal: 'none',
    retryAfterMs: null,
    transportCause: null,
    detail: '',
    truncated: false,
  });
  assert.equal(parsedCall.code, 0);

  const parsedService = contracts.parseServiceDeclaration({
    binding: {
      service: 'owner.catalog',
      descriptorPath: '/opt/owner/descriptor.json',
      socketPath: '/run/owner/service.sock',
      endpointPath: '/wire',
      maxInflight: 4,
      limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 },
    },
    callers: [{ caller: 'reader', scope: { kind: 'service-read' } }],
  });
  assert.equal(parsedService.ok, true);

  const parsedHealth = contracts.BrokerHealthSchema.parse({
    ok: true,
    futureTopField: 'ignored',
    nodes: [
      {
        nodeId: 'worker',
        online: false,
        serves: true,
        connections: 0,
        since: null,
        version: '0.56.0',
        behind: null,
        versionSeenAt: null,
        departure: {
          at: '2026-11-23T00:00:00.000Z',
          reason: 'ping timeout',
          kind: 'lost',
          futureDepartureField: 1,
        },
        observingSince: '2026-11-23T00:00:00.000Z',
      },
    ],
    observingSince: '2026-11-23T00:00:00.000Z',
    transport: {
      broker: '127.0.0.1:8790',
      lastDisconnect: null,
      eventLoopDelay: { state: 'unknown', sampledAt: null, lastMs: null, maxMs: null, windowMs: 300000 },
    },
    audit: {
      queued: 0,
      dropped: 0,
      writeFailures: 0,
      lastFailure: null,
      journal: { path: '/tmp/audit.jsonl', bytes: 0, generations: 0, maxBytes: 1024, keep: 2, rotations: 0 },
    },
    fleet: { latest: '0.56.0', latestAt: null, machines: [] },
    application: {
      id: 'stitchwire-broker',
      lifecycle: 'ready',
      health: 'healthy',
      ready: true,
      capturedAt: '2026-11-23T00:00:00.000Z',
      resources: { total: 1, ready: 1, degraded: 0, failed: 0 },
    },
    bundle: {
      serial: null,
      issuedAt: null,
      signer: null,
      config: 'unconfigured',
      detail: null,
      checkedAt: null,
    },
    streams: { active: 0 },
    events: { subscriptions: 0, accepted: 0, topics: 0, recent: { count: 0, windowMs: 0 } },
    topics: [],
    admission: {
      maxInflightPerNode: 10,
      maxCallsPerMinutePerNode: 60,
      maxStreamsTotal: 10,
      maxStreamsPerCaller: 4,
      maxStreamsPerProducer: 4,
      maxStreamOpensPerMinute: 60,
      maxEventSubscriptionsTotal: 10,
      maxEventSubscribesPerMinute: 60,
    },
  });
  assert.equal(parsedHealth.ok, true);
  assert.equal('futureTopField' in parsedHealth, false);
  assert.equal(contracts.ClientErrorCodeSchema.parse('timeout'), 'timeout');
  assert.equal(contracts.ServiceFailureCodeSchema.parse('denied'), 'denied');
  assert.equal(contracts.FleetConfigStateSchema.parse('aligned'), 'aligned');
} finally {
  if (bufferDesc) Object.defineProperty(globalThis, 'Buffer', bufferDesc);
  if (processDesc) Object.defineProperty(globalThis, 'process', processDesc);
}

// Verify readBrokerHealth maps refused TCP connections identically on Bun and Node (undici cause chain).
// Use a real closed ephemeral port (not port 1, which WHATWG Fetch / Node undici rejects as a "bad port").
const { createServer } = await import('node:net');
const closedPort = await new Promise((resolve, reject) => {
  const srv = createServer();
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    srv.close((closeErr) => (closeErr ? reject(closeErr) : resolve(port)));
  });
});
const { readBrokerHealth, WireClientError } = await import('@stitchwire/client');
let refusedErr;
try {
  await readBrokerHealth(`http://127.0.0.1:${closedPort}`, { timeoutMs: 2000 });
} catch (err) {
  refusedErr = err;
}
assert.ok(refusedErr instanceof WireClientError, 'expected WireClientError on refused connection');
assert.equal(refusedErr.code, 'unavailable');
assert.equal(refusedErr.delivery, 'not-sent');

console.log(
  `${isBun ? 'bun' : 'node'}: @stitchwire/client/contracts browser-safe + readBrokerHealth unavailable verified`,
);
