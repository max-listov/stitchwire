import { writeFile } from 'node:fs/promises';
import { parseJsonBytes, readJsonFileSync, readRegularFileSync } from 'stitchkit/files';
import { z } from 'zod';
import { serviceOperationTimeout } from '../packages/contracts/src/service/budgets.ts';
import { SERVICE_MAX_DESCRIPTOR_BYTES } from '../packages/contracts/src/service/contracts.ts';
import {
  ServiceDescriptorSchema,
  ServiceGrantSchema,
} from '../packages/contracts/src/service/policy-schema.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { MAX_CONFIG_FILE_BYTES, sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { updateConfig } from '../packages/runtime/src/config/update.ts';

const args = process.argv.slice(2);
const flags = new Map<string, string[]>();
for (let i = 0; i < args.length; i += 2) {
  const key = args[i],
    value = args[i + 1];
  if (
    !key ||
    !value ||
    ![
      '--kind',
      '--config',
      '--descriptor',
      '--caller',
      '--read',
      '--grant',
      '--socket',
      '--endpoint',
      '--apply',
      '--out',
    ].includes(key)
  )
    throw Error('Invalid policy activation arguments');
  flags.set(key, [...(flags.get(key) ?? []), value]);
}
function one(key: string): string {
  const values = flags.get(key);
  if (values?.length !== 1 || !values[0]) throw Error(`Exactly one ${key} required`);
  return values[0];
}
const path = one('--config');
const apply = z.enum(['yes', 'no']).parse(one('--apply'));
const output = flags.has('--out') ? one('--out') : undefined;
if (output && apply === 'yes')
  throw Error('--out requires --apply no; review the candidate before activation');
const caller = one('--caller');
const readFlags = flags.get('--read') ?? [];
const grantFlags = flags.get('--grant') ?? [];
if (!readFlags.length && !grantFlags.length) throw Error('At least one --read or --grant is required');
const requested = [
  ...readFlags.map((target) => ({ target, scope: { kind: 'service-read' as const } })),
  ...grantFlags.map((grant) => {
    const separator = grant.indexOf(':');
    if (separator <= 0 || separator !== grant.lastIndexOf(':') || separator === grant.length - 1)
      throw Error(`Invalid grant pair: ${grant}`);
    return {
      target: grant.slice(0, separator),
      scope: { kind: 'operation' as const, operation: grant.slice(separator + 1) },
    };
  }),
];
const targets = [...new Set(requested.map((grant) => grant.target))];
const operations = [
  ...new Set(requested.flatMap((grant) => (grant.scope.kind === 'operation' ? [grant.scope.operation] : []))),
];
const before = readRegularFileSync(path, { limit: MAX_CONFIG_FILE_BYTES });
const raw = z.record(z.string(), z.unknown()).parse(parseJsonBytes(before));
const descriptor = readJsonFileSync(one('--descriptor'), ServiceDescriptorSchema, {
  limit: SERVICE_MAX_DESCRIPTOR_BYTES,
});
const grants = requested.map(({ target, scope }) => {
  if (scope.kind === 'operation' && !descriptor.operations.some((entry) => entry.id === scope.operation))
    throw Error(`Operation not declared: ${scope.operation}`);
  return ServiceGrantSchema.parse({
    caller,
    target,
    service: descriptor.service,
    scope,
  });
});
let next: Record<string, unknown>;
if (one('--kind') === 'node') {
  const config = NodeConfigSchema.parse(raw);
  if (targets.length !== 1 || targets[0] !== config.nodeId)
    throw Error('Target does not match node identity');
  const limits = descriptor.operations.map((op) => op.limits);
  const binding = {
    service: descriptor.service,
    descriptorPath: one('--descriptor'),
    socketPath: one('--socket'),
    endpointPath: one('--endpoint'),
    maxInflight: descriptor.maxInflight,
    limits: {
      requestBytes: Math.max(...limits.map((x) => x.requestBytes)),
      responseBytes: Math.max(...limits.map((x) => x.responseBytes)),
      timeoutMs: Math.max(
        ...limits.map((limit) => limit.timeoutMs),
        ...descriptor.operations.map(serviceOperationTimeout),
      ),
    },
  };
  next = {
    ...raw,
    services: {
      ...config.services,
      bindings: [...config.services.bindings.filter((x) => x.service !== descriptor.service), binding],
      grants: [
        ...config.services.grants.filter((x) => x.service !== descriptor.service || x.caller !== caller),
        ...grants,
      ],
    },
  };
  NodeConfigSchema.parse(next);
} else if (one('--kind') === 'broker') {
  const config = BrokerConfigSchema.parse(raw);
  if (
    !config.nodes.some((x) => x.id === caller) ||
    targets.some((id) => !config.nodes.some((x) => x.id === id))
  )
    throw Error('Unknown policy participant');
  next = {
    ...raw,
    serviceGrants: [
      ...config.serviceGrants.filter((x) => x.service !== descriptor.service || x.caller !== caller),
      ...grants,
    ],
  };
  BrokerConfigSchema.parse(next);
} else throw Error('Unknown config kind');
const body = `${JSON.stringify(next, null, 2)}\n`;
if (output) await writeFile(output, body, { mode: 0o600, flag: 'wx' });
if (apply === 'yes') {
  await updateConfig(one('--kind') === 'node' ? 'node' : 'broker', path, {
    operation: 'replace',
    expectedSha256: sha256(before),
    value: next,
  });
}
console.log(
  JSON.stringify({
    kind: one('--kind'),
    service: descriptor.service,
    caller,
    targets,
    operations,
    grants: requested,
    before: sha256(before),
    after: sha256(body),
    applied: apply === 'yes',
  }),
);
