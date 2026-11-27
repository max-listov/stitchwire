import { existsSync } from 'node:fs';
import { z } from 'zod';
import {
  type EnrollmentMaterial,
  EnrollmentMaterialSchema,
  type EnrollmentNodeRequest,
} from '../../../contracts/src/enrollment/request.ts';
import type { FleetTrust } from '../../../contracts/src/fleet/bundle.ts';
import type { NodeConfig } from '../config/node.ts';
import { MAX_CONFIG_FILE_BYTES } from '../config/io.ts';
import { type OpenedBundle, openBundle, reduceBundle, tablesFor } from '../fleet/bundle.ts';
import { sameTables } from '../fleet/projection.ts';
import { EnrollmentError } from './failure.ts';
import { readValue } from './files.ts';

export function verifiedCopy(path: string, trust: FleetTrust, full: boolean): OpenedBundle {
  const opening = openBundle(readValue(path, z.unknown(), MAX_CONFIG_FILE_BYTES), trust, {
    requireFull: full,
  });
  if (!opening.ok) throw new EnrollmentError('bundle-invalid');
  return opening.opened;
}

/** The node's own signed slice and the public trust: all a broker hands to a node it admits. */
export function materialFor(opened: OpenedBundle, trust: FleetTrust, nodeId: string): EnrollmentMaterial {
  const reduced = reduceBundle(opened, nodeId);
  if (reduced === null || reduced.full !== null || Object.keys(reduced.slices).length !== 1)
    throw new EnrollmentError('admission-denied');
  return { trust, bundle: reduced };
}

function deliveredMaterial(
  path: string,
  nodeId: string,
): { material: EnrollmentMaterial; opened: OpenedBundle } {
  let material: EnrollmentMaterial;
  try {
    material = readValue(path, EnrollmentMaterialSchema, MAX_CONFIG_FILE_BYTES);
  } catch (cause) {
    throw new EnrollmentError('bundle-invalid', { cause });
  }
  const opening = openBundle(material.bundle, material.trust, { requireFull: false });
  if (!opening.ok || Object.keys(material.bundle.slices).length !== 1 || !opening.opened.slices.has(nodeId))
    throw new EnrollmentError('bundle-invalid');
  return { material, opened: opening.opened };
}

/**
 * The edition a node request is judged against. Delivered material is evidence for a node without
 * a kept copy; once the node keeps one, that copy is the edition and material may only be as new
 * as it (an older one is `bundle-stale`, other bytes at one serial `bundle-conflict`).
 */
export function offeredEdition(
  request: EnrollmentNodeRequest,
  config: NodeConfig | null,
): { material: EnrollmentMaterial; opened: OpenedBundle } {
  const fleet = config?.fleet;
  if (request.material !== undefined) {
    const delivered = deliveredMaterial(request.material, request.nodeId);
    if (fleet !== undefined) checkKept(fleet.copy, fleet.trust, delivered.opened, request.nodeId);
    return delivered;
  }
  if (config === null || fleet === undefined || !existsSync(fleet.copy))
    throw new EnrollmentError('material-required');
  let opened: OpenedBundle;
  try {
    opened = verifiedCopy(fleet.copy, fleet.trust, false);
  } catch (cause) {
    // An unreadable or unverifiable kept copy is a broken edition, not a broken request.
    if (cause instanceof EnrollmentError) throw new EnrollmentError('bundle-invalid', { cause });
    throw cause;
  }
  const bundle = reduceBundle(opened, request.nodeId);
  if (bundle === null || bundle.full !== null || !opened.slices.has(request.nodeId))
    throw new EnrollmentError('bundle-invalid');
  return { material: { trust: fleet.trust, bundle }, opened };
}

/** Never replace a newer edition or silently reinterpret different signed bytes at one serial. */
export function checkKept(path: string, trust: FleetTrust, offered: OpenedBundle, nodeId: string): void {
  if (!existsSync(path)) return;
  const kept = verifiedCopy(path, trust, false);
  if (kept.serial > offered.serial) throw new EnrollmentError('bundle-stale');
  if (
    kept.serial === offered.serial &&
    !sameTables(reduceBundle(kept, nodeId), reduceBundle(offered, nodeId))
  )
    throw new EnrollmentError('bundle-conflict');
  if (tablesFor(offered, nodeId) === null) throw new EnrollmentError('admission-denied');
}
