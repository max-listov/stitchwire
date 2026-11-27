import { readJsonOnce } from 'stitchkit/files';
import { z } from 'zod';
import { FleetTrustSchema, MAX_FLEET_BUNDLE_BYTES } from '../../../contracts/src/fleet/bundle.ts';
import { FleetKeyIdSchema, FleetSerialSchema } from '../../../contracts/src/fleet/identity.ts';
import { NodeIdSchema } from '../../../contracts/src/protocol/identity.ts';
import { Sha256Schema } from '../../../contracts/src/protocol/paths.ts';
import { openBundle, tablesFor } from '../fleet/bundle.ts';
import {
  applyBrokerTables,
  applyNodeTables,
  brokerTablesOf,
  nodeTablesOf,
  sameTables,
} from '../fleet/projection.ts';
import { asJson, type Json } from '../json.ts';
import { BrokerConfigSchema } from './broker.ts';
import { anyJson, MAX_CONFIG_FILE_BYTES, sha256 } from './io.ts';
import { NodeConfigSchema } from './node.ts';

const DialSchema = NodeConfigSchema.shape.brokers.element.pick({ id: true, url: true }).safeExtend({
  tokenSha256: Sha256Schema,
});
export const ConfigInspectionSchema = z.strictObject({
  kind: z.enum(['node', 'broker']),
  nodeId: NodeIdSchema.nullable(),
  brokers: z.array(DialSchema),
  nodes: z.array(BrokerConfigSchema.in.shape.nodes.element),
  fleet: z
    .strictObject({
      copy: z.string(),
      trust: FleetTrustSchema,
      serial: FleetSerialSchema.nullable(),
      signers: z.array(FleetKeyIdSchema),
      state: z.enum(['aligned', 'drifted', 'unknown']),
      detail: z.string(),
    })
    .nullable(),
});
export type ConfigInspection = z.infer<typeof ConfigInspectionSchema>;

/** Read-only administrative projection. Credentials stay local; the config owns its copy path,
 * and the same snapshot supplies both edition and table verdict. No running-process claim. */
export function inspectConfig(kind: 'node' | 'broker', path: string): ConfigInspection {
  const reading = readJsonOnce(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
  if (reading.state !== 'read') throw new Error(`configuration is ${reading.state}`);
  const raw = asJson(reading.value);
  const node = kind === 'node' ? NodeConfigSchema.parse(raw) : null;
  const broker = kind === 'broker' ? BrokerConfigSchema.parse(raw) : null;
  const config = node ?? broker;
  if (config === null) throw new Error('configuration kind missing');
  const fleet = config.fleet;
  const answer: ConfigInspection = {
    kind,
    nodeId: node?.nodeId ?? null,
    brokers: node?.brokers.map(({ id, url, token }) => ({ id, url, tokenSha256: sha256(token) })) ?? [],
    nodes: broker?.nodes ?? [],
    fleet:
      fleet === undefined
        ? null
        : {
            copy: fleet.copy,
            trust: fleet.trust,
            serial: null,
            signers: [],
            state: 'unknown',
            detail: 'no verified retained bundle',
          },
  };
  if (fleet === undefined || answer.fleet === null) return ConfigInspectionSchema.parse(answer);
  const kept = readJsonOnce(fleet.copy, anyJson, { limit: MAX_FLEET_BUNDLE_BYTES });
  if (kept.state !== 'read') {
    answer.fleet.detail = `retained bundle is ${kept.state}`;
    return ConfigInspectionSchema.parse(answer);
  }
  const opening = openBundle(kept.value, fleet.trust, { requireFull: kind === 'broker' });
  if (!opening.ok) {
    answer.fleet.detail = `retained bundle is refused: ${opening.detail}`;
    return ConfigInspectionSchema.parse(answer);
  }
  const opened = opening.opened;
  answer.fleet.serial = opened.serial;
  answer.fleet.signers = [
    ...new Set([
      ...(opened.bundle.full ? [opened.bundle.full.keyId] : []),
      ...Object.values(opened.bundle.slices).map((slice) => slice.keyId),
    ]),
  ];
  const tables = node === null ? null : tablesFor(opened, node.nodeId);
  let projected: Json;
  if (node !== null && tables !== null) projected = applyNodeTables(raw, tables);
  else if (broker !== null && opened.manifest !== null) projected = applyBrokerTables(raw, opened.manifest);
  else {
    answer.fleet.detail = 'retained edition has no applicable tables';
    return ConfigInspectionSchema.parse(answer);
  }
  const tablesOf = node === null ? brokerTablesOf : nodeTablesOf;
  const current = asJson(tablesOf(raw)),
    wanted = asJson(tablesOf(projected));
  const differences = Object.keys(wanted).filter((name) => !sameTables(current[name], wanted[name]));
  answer.fleet.state = differences.length === 0 ? 'aligned' : 'drifted';
  answer.fleet.detail =
    differences.length === 0
      ? 'configuration matches the retained bundle'
      : `configuration differs in ${differences.join(', ')}`;
  return ConfigInspectionSchema.parse(answer);
}
