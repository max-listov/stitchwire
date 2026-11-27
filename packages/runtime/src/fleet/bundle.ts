import {
  FLEET_BUNDLE_FORMAT,
  type FleetBundle,
  FleetBundleSchema,
  FleetFullPayloadSchema,
  type FleetNodeTables,
  FleetSlicePayloadSchema,
  type FleetTrust,
  MAX_FLEET_BUNDLE_BYTES,
} from '../../../contracts/src/fleet/bundle.ts';
import type { FleetManifest } from '../../../contracts/src/fleet/manifest.ts';
import { firstIssue } from '../../../contracts/src/protocol/schema-parse.ts';
import { sortedDeep, ownEntry } from '../json.ts';
import { nodeTables, sameTables } from './projection.ts';
import { openDocument, signDocument } from './signature.ts';

/** A bundle whose every part has been verified, with what the parts say. */
export interface OpenedBundle {
  bundle: FleetBundle;
  serial: number;
  issuedAt: string;
  signer: string;
  /** Null in a copy reduced to one node's slice. */
  manifest: FleetManifest | null;
  slices: ReadonlyMap<string, FleetNodeTables>;
}

type BundleOpening = { ok: true; opened: OpenedBundle } | { ok: false; detail: string };

export function buildBundle(input: {
  manifest: FleetManifest;
  serial: number;
  issuedAt: string;
  keyId: string;
  privateKeyPem: string;
}): FleetBundle {
  const { manifest, serial, issuedAt, keyId, privateKeyPem } = input;
  const slices: Record<string, FleetBundle['full'] & object> = {};
  for (const [node, member] of Object.entries(manifest.members).sort(([a], [b]) => a.localeCompare(b)))
    if (member.copy === 'own')
      slices[node] = signDocument(
        { kind: 'slice', serial, issuedAt, node, tables: nodeTables(manifest, node) },
        keyId,
        privateKeyPem,
      );
  return {
    format: FLEET_BUNDLE_FORMAT,
    serial,
    full: signDocument({ kind: 'full', serial, issuedAt, manifest }, keyId, privateKeyPem),
    slices,
  };
}

/**
 * Verify every part, and refuse the whole bundle at the first part that does not hold.
 *
 * A full bundle must also be internally consistent: its slices are exactly one per `own` member,
 * and each equals the projection of the full manifest for that node. A signer that got that wrong
 * would hand one node a different configuration from the one the fleet declared, signed and
 * therefore believed — so the check lives at every receiver, not only at the signer.
 */
export function openBundle(
  value: unknown,
  trust: FleetTrust,
  options: { requireFull: boolean },
): BundleOpening {
  const refuse = (detail: string): BundleOpening => ({ ok: false, detail });
  const parsed = FleetBundleSchema.safeParse(value);
  if (!parsed.success) return refuse(`not a fleet bundle — ${firstIssue(parsed.error)}`);
  const bundle = parsed.data;
  if (JSON.stringify(bundle).length > MAX_FLEET_BUNDLE_BYTES)
    return refuse(`bundle exceeds ${MAX_FLEET_BUNDLE_BYTES} bytes`);
  if (bundle.full === null && options.requireFull) return refuse('the bundle carries no full part');

  let manifest: FleetManifest | null = null;
  let issuedAt: string | null = null;
  let signer: string | null = null;
  if (bundle.full !== null) {
    const opened = openDocument(bundle.full, trust);
    if (!opened.ok) return refuse(`full part: ${opened.detail}`);
    const payload = FleetFullPayloadSchema.safeParse(opened.document);
    if (!payload.success) return refuse(`full part: ${firstIssue(payload.error)}`);
    if (payload.data.serial !== bundle.serial)
      return refuse(`full part is edition ${payload.data.serial}, the bundle says ${bundle.serial}`);
    manifest = payload.data.manifest;
    issuedAt = payload.data.issuedAt;
    signer = opened.keyId;
  }

  const slices = new Map<string, FleetNodeTables>();
  for (const [node, signed] of Object.entries(bundle.slices)) {
    const opened = openDocument(signed, trust);
    if (!opened.ok) return refuse(`slice ${node}: ${opened.detail}`);
    const payload = FleetSlicePayloadSchema.safeParse(opened.document);
    if (!payload.success) return refuse(`slice ${node}: ${firstIssue(payload.error)}`);
    if (payload.data.node !== node)
      return refuse(`slice filed under ${node} is signed for ${payload.data.node}`);
    if (payload.data.serial !== bundle.serial)
      return refuse(`slice ${node} is edition ${payload.data.serial}, the bundle says ${bundle.serial}`);
    slices.set(node, payload.data.tables);
    issuedAt ??= payload.data.issuedAt;
    signer ??= opened.keyId;
  }

  if (manifest !== null) {
    const own = Object.entries(manifest.members)
      .filter(([, member]) => member.copy === 'own')
      .map(([node]) => node)
      .sort();
    const carried = [...slices.keys()].sort();
    if (JSON.stringify(own) !== JSON.stringify(carried))
      return refuse(
        `slices for [${carried.join(', ')}] do not match the own-copy members [${own.join(', ')}]`,
      );
    for (const [node, tables] of slices)
      if (!sameTables(tables, nodeTables(manifest, node)))
        return refuse(`slice ${node} differs from the full manifest's projection for that node`);
  }
  if (issuedAt === null || signer === null)
    return refuse('the bundle carries neither a full part nor a slice');
  return { ok: true, opened: { bundle, serial: bundle.serial, issuedAt, signer, manifest, slices } };
}

/**
 * What one node may hold of this edition: the whole bundle for a `full` member, its own slice for an
 * `own` member, nothing for a node that is not a member at all.
 */
export function reduceBundle(opened: OpenedBundle, node: string): FleetBundle | null {
  const copy =
    opened.manifest === null
      ? opened.slices.has(node)
        ? 'own'
        : null
      : ownEntry(opened.manifest.members, node)?.copy;
  if (copy === undefined || copy === null) return null;
  if (copy === 'full') return opened.bundle.full === null ? null : opened.bundle;
  const slice = ownEntry(opened.bundle.slices, node);
  return slice === undefined
    ? null
    : { format: FLEET_BUNDLE_FORMAT, serial: opened.serial, full: null, slices: { [node]: slice } };
}

/** This node's fleet tables in this edition; null when the edition says nothing about the node. */
export function tablesFor(opened: OpenedBundle, node: string): FleetNodeTables | null {
  if (opened.manifest !== null)
    return ownEntry(opened.manifest.members, node) === undefined ? null : nodeTables(opened.manifest, node);
  return opened.slices.get(node) ?? null;
}

/**
 * The next edition number: one past the newest known, and never behind the clock in seconds.
 *
 * The clock is what keeps two signers from colliding when neither has seen the other's latest
 * edition; the `+1` is what keeps a signer whose clock runs slow from issuing an edition every node
 * would refuse as older.
 */
export function nextSerial(current: number | null, nowMs = Date.now()): number {
  return Math.max((current ?? 0) + 1, Math.floor(nowMs / 1000));
}

/** Equal serials name one exact signed edition, independent of object key rendering. */
export function sameEdition(left: FleetBundle, right: FleetBundle): boolean {
  return JSON.stringify(sortedDeep(left)) === JSON.stringify(sortedDeep(right));
}
