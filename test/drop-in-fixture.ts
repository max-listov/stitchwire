import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';

/** Files of the drop-in tests: declarations, descriptors and node configurations, all private. */
export const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 };

/** A temporary root with one fresh private directory per case; `remove` takes it all down. */
export function caseDirs(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  let serial = 0;
  return {
    next(): string {
      const dir = join(root, `case-${serial++}`);
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    },
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function privateFile(path: string, value: unknown): string {
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}

/** A service declaration and the descriptor it names, both written under `dir`. */
export function service(dir: string, file: string, name: string, socket: string): string {
  const descriptorPath = privateFile(join(dir, `${name}.descriptor.json`), {
    service: name,
    revision: '1',
    maxInflight: 4,
    operations: [{ id: 'ping', path: '/ping', effect: 'read', limits, response: { kind: 'unary' } }],
  });
  return privateFile(file, {
    binding: {
      service: name,
      descriptorPath,
      socketPath: join(dir, socket),
      endpointPath: '/wire',
      maxInflight: 4,
      limits,
    },
    callers: [],
  });
}

export const nodeConfig = NodeConfigSchema.parse({
  nodeId: 'worker',
  brokers: [{ id: 'primary', url: 'http://127.0.0.1:9', token: 'x'.repeat(40) }],
  services: { bindings: [], grants: [], namespaces: ['owner.'], descriptors: [] },
  events: { namespaces: { publish: ['owner.'], subscribe: [] } },
});
