import { expect, test } from 'bun:test';
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_POLLED_JSON_CACHE_BYTES,
  PolledJsonFile,
  readRegularFile,
  readRegularFileSync,
} from 'stitchkit/files';
import { z } from 'zod';
import type { EventDeclare } from '../packages/contracts/src/protocol/topic.ts';
import type { ServiceDeclare } from '../packages/contracts/src/service/declaration.ts';
import type { ServicePolicy } from '../packages/contracts/src/service/policy-schema.ts';
import { MAX_CONFIG_FILE_BYTES } from '../packages/runtime/src/config/io.ts';
import { reconcile } from '../packages/runtime/src/fleet/reconcile.ts';
import { ServiceDeclarer } from '../packages/runtime/src/node/service-declarations.ts';
import { TopicDeclarer } from '../packages/runtime/src/node/topic-declarations.ts';

const schema = z.strictObject({ grant: z.string() });
test('cache budget limits retained editions without refusing larger valid input', () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-large-json-'));
  const path = join(root, 'file.json');
  let parses = 0;
  const file = new PolledJsonFile(
    path,
    {
      safeParse: (data) => {
        parses++;
        return { success: true, data };
      },
    },
    { limit: MAX_CONFIG_FILE_BYTES, maxCacheBytes: MAX_POLLED_JSON_CACHE_BYTES },
  );
  try {
    writeFileSync(path, JSON.stringify({ value: 'x'.repeat(MAX_POLLED_JSON_CACHE_BYTES) }));
    expect(file.read().state).toBe('read');
    expect(file.read().state).toBe('read');
    expect(parses).toBe(2);
    writeFileSync(path, '{}');
    expect(file.read()).toBe(file.read());
    expect(parses).toBe(3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('unchanged bytes reuse validation, same-size same-mtime edits do not; deletion and corruption fail closed', () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-polled-json-'));
  const path = join(root, 'file.json');
  let parses = 0;
  const file = new PolledJsonFile(
    path,
    {
      safeParse: (value) => {
        parses++;
        const parsed = schema.safeParse(value);
        return parsed.success ? { success: true, data: parsed.data } : { success: false, error: 'bad grant' };
      },
    },
    { limit: 64 },
  );
  try {
    writeFileSync(path, '{"grant":"a"}');
    const at = statSync(path);
    const first = file.read();
    expect(file.read()).toBe(first);
    expect(parses).toBe(1);
    writeFileSync(path, '{"grant":"b"}');
    utimesSync(path, at.atime, at.mtime);
    expect(file.read()).toMatchObject({ state: 'read', value: { grant: 'b' } });
    expect(parses).toBe(2);
    writeFileSync(path, '{"grant":123}');
    const invalid = file.read();
    expect(invalid.state).toBe('invalid');
    if (invalid.state !== 'invalid') throw new Error('expected invalid reading');
    expect(invalid.reason).toBe('schema');
    expect(invalid.detail).toContain('bad grant');
    expect(parses).toBe(3);
    // Repeated poll of the same invalid file reports no change (`readChanged() === null`).
    expect(file.readChanged()).toBeNull();
    expect(file.read().state).toBe('invalid');
    writeFileSync(path, '{ not json');
    expect(file.read()).toMatchObject({ state: 'invalid', reason: 'syntax' });
    unlinkSync(path);
    expect(file.read().state).toBe('missing');
    const beforeRecreate = parses;
    writeFileSync(path, '{"grant":"b"}');
    expect(file.read()).toMatchObject({ state: 'read', value: { grant: 'b' } });
    expect(parses).toBe(beforeRecreate + 1);
    writeFileSync(path, JSON.stringify({ grant: 'x'.repeat(70) }));
    expect(file.read()).toMatchObject({
      state: 'unreadable',
      reason: 'too-large',
      detail: expect.stringContaining('64-byte limit'),
    });
    expect(file.read().state).toBe('unreadable');
    writeFileSync(path, '{"grant":"b"}');
    expect(file.read().state).toBe('read');
    expect(parses).toBe(beforeRecreate + 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a symlink retargeted during regular-file accept retries and returns the new target bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-symlink-retarget-'));
  const oldTarget = join(root, 'old.json');
  const newTarget = join(root, 'new.json');
  const link = join(root, 'current.json');
  const staging = join(root, 'next.json');
  const decode = new TextDecoder();
  try {
    writeFileSync(oldTarget, 'old');
    writeFileSync(newTarget, 'new');
    symlinkSync(oldTarget, link);
    let syncChecks = 0;
    const syncBytes = readRegularFileSync(link, {
      limit: 64,
      accept: () => {
        syncChecks++;
        if (syncChecks === 1) {
          symlinkSync(newTarget, staging);
          renameSync(staging, link);
        }
        return true;
      },
    });
    expect(decode.decode(syncBytes)).toBe('new');
    expect(syncChecks).toBe(2);

    rmSync(link);
    symlinkSync(oldTarget, link);
    let asyncChecks = 0;
    const asyncBytes = await readRegularFile(link, {
      limit: 64,
      accept: () => {
        asyncChecks++;
        if (asyncChecks === 1) {
          symlinkSync(newTarget, staging);
          renameSync(staging, link);
        }
        return true;
      },
    });
    expect(decode.decode(asyncBytes)).toBe('new');
    expect(asyncChecks).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('configuration reconciliation verifies every repair', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-reconcile-cache-'));
  const path = join(root, 'config.json');
  const running = { grant: 'a' };
  const input = (grant: string, current = running) => ({
    path,
    running: current,
    project: () => ({ grant }),
    tablesOf: (value: Record<string, unknown>) => value.grant,
    parse: (value: unknown) => {
      const parsed = schema.safeParse(value);
      return parsed.success
        ? ({ ok: true, value: parsed.data } satisfies { ok: true; value: typeof running })
        : ({ ok: false, detail: 'bad config' } satisfies { ok: false; detail: string });
    },
  });
  try {
    writeFileSync(path, JSON.stringify(running));
    expect(await reconcile(input('a'))).toEqual({ state: 'aligned', wrote: false });
    // A new edition's tables revoke a grant even though the file bytes have not changed yet.
    expect(await reconcile(input('b'))).toEqual({ state: 'reload', wrote: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ grant: 'b' });
    expect(await reconcile(input('b', { grant: 'b' }))).toEqual({ state: 'aligned', wrote: false });
    writeFileSync(path, '{ not json');
    expect((await reconcile(input('b'))).state).toBe('drifted');
    unlinkSync(path);
    expect((await reconcile(input('b'))).state).toBe('drifted');
    writeFileSync(path, '{"grant":"a"}');
    expect((await reconcile(input('b'))).state).toBe('reload');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('service/topic poll caches revoke invalid and missing declarations and reconnect sends the current set', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-declaration-cache-'));
  const servicePath = join(root, 'service.json');
  const topicPath = join(root, 'topic.json');
  const service = {
    binding: {
      service: 'example.data',
      descriptorPath: join(root, 'descriptor.json'),
      socketPath: join(root, 'service.sock'),
      endpointPath: '/invoke',
      maxInflight: 4,
      limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 },
    },
    callers: [{ caller: 'reader', scope: { kind: 'service-read' } }],
  };
  const topic = { topics: { 'example.data': { delivery: 'ordered' } } };
  const policies: ServicePolicy[] = [];
  const serviceRequests: ServiceDeclare[] = [];
  const topicRequests: EventDeclare[] = [];
  const services = new ServiceDeclarer(
    'worker',
    { bindings: [], grants: [], namespaces: ['example.'], descriptors: [servicePath] },
    (value) => policies.push(value),
  );
  const topics = new TopicDeclarer('worker', {
    descriptors: [topicPath],
    namespaces: { publish: ['example.'] },
  });
  services.attach('lane', {
    connected: true,
    declareServices: async (request) => {
      serviceRequests.push(request);
      return { accepted: request.grants.length, refused: [] };
    },
  });
  topics.attach('lane', {
    connected: true,
    declareTopics: async (request) => {
      topicRequests.push(request);
      return { accepted: Object.keys(request.topics), refused: [] };
    },
  });
  const refresh = async () => {
    await services.refresh();
    await topics.refresh();
  };
  try {
    writeFileSync(servicePath, JSON.stringify(service));
    writeFileSync(topicPath, JSON.stringify(topic));
    await refresh();
    await refresh();
    expect(policies).toHaveLength(1);
    expect(serviceRequests.at(-1)?.grants).toHaveLength(1);
    expect(Object.keys(topicRequests.at(-1)?.topics ?? {})).toEqual(['example.data']);
    services.laneChanged('lane');
    topics.laneChanged('lane');
    expect(serviceRequests).toHaveLength(2);
    expect(topicRequests).toHaveLength(2);
    writeFileSync(servicePath, JSON.stringify({ ...service, callers: [] }));
    writeFileSync(topicPath, '{"topics":{}}');
    await refresh();
    expect(serviceRequests.at(-1)?.grants).toEqual([]);
    expect(topicRequests.at(-1)?.topics).toEqual({});
    writeFileSync(servicePath, '{ broken');
    writeFileSync(topicPath, '{"topics":123}');
    await refresh();
    expect(policies.at(-1)?.bindings).toEqual([]);
    expect(services.snapshot().descriptors[0]?.state).toBe('invalid');
    expect(topics.snapshot().descriptors[0]?.state).toBe('invalid');
    unlinkSync(servicePath);
    unlinkSync(topicPath);
    await refresh();
    expect(services.snapshot().descriptors[0]?.state).toBe('missing');
    expect(topics.snapshot().descriptors[0]?.state).toBe('missing');
    writeFileSync(servicePath, JSON.stringify(service));
    writeFileSync(topicPath, JSON.stringify(topic));
    await refresh();
    expect(serviceRequests.at(-1)?.grants).toHaveLength(1);
    expect(Object.keys(topicRequests.at(-1)?.topics ?? {})).toEqual(['example.data']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
