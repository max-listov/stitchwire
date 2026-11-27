/** Isolated SDK/Unix benchmark; no fleet traffic and no application domain fixture. */
import { strict as assert } from 'node:assert';
import { createWireClient } from '../packages/client/src/index.ts';
import { withDoor, result, chunk } from '../test/client-fixture.ts';
import manifest from '../package.json' with { type: 'json' };
import { setTimeout as delay } from 'node:timers/promises';

const count = 100;
const payload = 'x'.repeat(1024);
const times: number[] = [];
let requests = 0;
let writes = 0;
let stopped = false;
let peakRss = process.memoryUsage().rss;
const beforeRss = peakRss;
const cpu = process.cpuUsage();
const started = performance.now();
await withDoor(
  (_request, response) => {
    requests++;
    if (_request.url === '/wire/call') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result({ stdout: payload })));
      return;
    }
    const frame = chunk();
    const bytes = 32 * 1024;
    const data = Buffer.alloc(bytes, 120).toString('base64');
    response.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const pump = () => {
      while (!stopped && writes < 512) {
        if (!response.write(`${JSON.stringify({ ...frame, seq: writes++, bytes, data })}\n`)) return;
      }
    };
    response.on('drain', pump);
    pump();
  },
  async (socketPath) => {
    using client = createWireClient({ socketPath, maxConcurrentRequests: 1 });
    for (let index = 0; index < count; index++) {
      const at = performance.now();
      assert.equal((await client.call({ to: 'worker', argv: ['read'] })).stdout, payload);
      times.push(performance.now() - at);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    const feed = client.stream({ to: 'worker', profile: 'logs' });
    assert.equal((await feed.next()).value?.kind, 'chunk');
    await delay(100);
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    stopped = true;
    await feed.return?.();
    assert.equal(requests, count + 1);
  },
);
times.sort((a, b) => a - b);
const used = process.cpuUsage(cpu);
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    runtime: process.versions.bun ?? process.versions.node,
    platform: process.platform,
    arch: process.arch,
    version: manifest.version,
    stitchkit: manifest.dependencies.stitchkit,
    scenario: 'isolated SDK -> Unix HTTP fixture, no broker or subprocess',
    count,
    concurrency: 1,
    payloadBytes: payload.length,
    elapsedMs: performance.now() - started,
    latencyMs: { p50: times[49], p95: times[94], p99: times[98] },
    rss: { before: beforeRss, peakSample: peakRss, after: process.memoryUsage().rss },
    cpuMs: (used.user + used.system) / 1000,
    stalledReader: { pauseMs: 100, chunkBytes: 32768, offered: 512, written: writes },
    bounded: writes < 512,
    requests,
    caveat: 'RSS sampled, not high-water; CPU includes fixture. Not fleet latency or speedup evidence.',
  }),
);
if (writes === 512) process.exitCode = 1;
