import { openBundle, reduceBundle } from '../packages/runtime/src/fleet/bundle.ts';
import { fleetSigner } from './signed-fleet.ts';

const signing = fleetSigner('key');
const signed = signing.edition(
  {
    version: 1,
    members: { observer: { copy: 'full' }, worker: { copy: 'own' } },
    access: [],
  },
  3,
  '2026-11-16T16:00:00.000Z',
);
const trust = signing.trust;
const opening = openBundle(signed, trust, { requireFull: true });
if (!opening.ok) throw new Error('fixture bundle does not verify');

export const admissionRequestExample = {
  v: 1,
  requestId: '6f3c1d5e-0f8b-4c56-9d2a-2b1f5e7c9a10',
  nodeId: 'worker',
  target: 'worker-host',
  grants: {
    services: ['example.'],
    topics: [{ namespace: 'example.worker.', subscribers: ['observer'], maxTopics: 8 }],
  },
  credentials: [{ broker: 'primary', sha256: 'a'.repeat(64) }],
} as const;

export const admissionResultExample = {
  v: 1,
  requestId: admissionRequestExample.requestId,
  nodeId: 'worker',
  operation: 'apply',
  status: 'awaiting-node',
  phase: 'activation',
  waiting: ['node:worker is not connected to broker:primary'],
  observedAt: '2026-11-16T16:00:00.000Z',
  completed: ['inventory', 'membership', 'admission'],
  firstFailure: null,
  delta: {
    manifest: {
      members: { worker: { copy: 'own' } },
      serviceNamespaces: { worker: ['example.'] },
      topicNamespaces: { 'example.worker.': { producer: 'worker', subscribers: ['observer'], maxTopics: 8 } },
    },
    records: [{ record: 'inventory', change: 'add', value: { id: 'worker' } }],
  },
  unrecorded: ['inventory', 'manifest'],
  node: {
    request: {
      nodeId: 'worker',
      expectedVersion: '1.2.3',
      config: '/srv/stitchwire/config/node.json',
      brokers: [{ id: 'primary', url: 'https://broker.example' }],
      agentSocket: '/srv/stitchwire/state/agent.sock',
      supervisor: {
        kind: 'systemd',
        scope: 'system',
        bun: '/usr/local/bin/bun',
        unit: 'stitchwire-agent.service',
        artifact: { destination: '/srv/stitchwire/bin/stitchwire', sha256: 'b'.repeat(64) },
      },
    },
    delivery: {
      material: { trust, bundle: reduceBundle(opening.opened, 'worker') },
      runtime: '/opt/stitchwire/releases/stitchwire-1.2.3',
    },
  },
} as const;
