import { parseJsonBytes, readJsonOnce, readRegularFileSync, writeFileAtomicSync } from 'stitchkit/files';
import { z } from 'zod';
import { FleetTrustSchema, MAX_FLEET_BUNDLE_BYTES } from '../../../contracts/src/fleet/bundle.ts';
import { Sha256Schema } from '../../../contracts/src/protocol/paths.ts';
import { openBundle, tablesFor } from '../fleet/bundle.ts';
import { sameTables } from '../fleet/projection.ts';
import { asJson } from '../json.ts';
import { BrokerConfigSchema } from './broker.ts';
import { configIdentity } from './identity.ts';
import { anyJson, MAX_CONFIG_FILE_BYTES, sha256 } from './io.ts';
import { NodeConfigSchema } from './node.ts';
import { withConfigLock } from './transaction.ts';

export const ConfigUpdateResultSchema = z.strictObject({
  state: z.enum(['checked', 'written', 'unchanged']),
  beforeSha256: Sha256Schema,
  afterSha256: Sha256Schema,
});
const NodesSchema = BrokerConfigSchema.in.shape.nodes;
export const ConfigUpdateSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('replace'), expectedSha256: Sha256Schema, value: z.unknown() }),
  z.strictObject({ operation: z.literal('trust'), trust: FleetTrustSchema }),
  z.strictObject({ operation: z.literal('roster'), expectedNodes: NodesSchema, nodes: NodesSchema }),
]);
export type ConfigUpdate = z.infer<typeof ConfigUpdateSchema>;

/** Every administrative writer shares the runtime lock and validates a fresh raw snapshot.
 * Replacement is compare-and-swap; narrow table operations preserve all unrelated raw fields. */
export async function updateConfig(
  kind: 'node' | 'broker',
  path: string,
  request: ConfigUpdate,
  check = false,
) {
  request = ConfigUpdateSchema.parse(request);
  const target = configIdentity(path);
  return withConfigLock(target, () => {
    const before = readRegularFileSync(target, { limit: MAX_CONFIG_FILE_BYTES });
    const raw = parseJsonBytes(before);
    const schema = kind === 'node' ? NodeConfigSchema : BrokerConfigSchema;
    const config = schema.parse(raw);
    const value = asJson(raw);
    let next: unknown;
    if (request.operation === 'replace') {
      if (sha256(before) !== request.expectedSha256)
        throw new Error('configuration changed since preparation');
      next = request.value;
    } else if (request.operation === 'roster') {
      if (kind !== 'broker') throw new Error('roster updates require a broker');
      const broker = BrokerConfigSchema.parse(raw);
      if (!sameTables(broker.nodes, request.expectedNodes))
        throw new Error('broker roster changed since preparation');
      next = { ...value, nodes: request.nodes };
    } else {
      if (config.fleet === undefined) throw new Error('configuration has no fleet trust');
      const kept = readJsonOnce(config.fleet.copy, anyJson, { limit: MAX_FLEET_BUNDLE_BYTES });
      if (kept.state !== 'read') throw new Error(`retained fleet bundle is ${kept.state}`);
      const opening = openBundle(kept.value, request.trust, { requireFull: kind === 'broker' });
      if (!opening.ok) throw new Error(`proposed trust rejects retained fleet bundle: ${opening.detail}`);
      if (kind === 'node' && tablesFor(opening.opened, NodeConfigSchema.parse(raw).nodeId) === null)
        throw new Error('retained fleet bundle has no tables for this node');
      next = { ...value, fleet: { ...asJson(value.fleet), trust: request.trust } };
    }
    schema.parse(next);
    const body = `${JSON.stringify(next, null, 2)}\n`;
    const changed = !Buffer.from(before).equals(Buffer.from(body));
    if (!check && changed) writeFileAtomicSync(target, body, { mode: 0o600 });
    return ConfigUpdateResultSchema.parse({
      state: check ? 'checked' : changed ? 'written' : 'unchanged',
      beforeSha256: sha256(before),
      afterSha256: sha256(body),
    });
  });
}
