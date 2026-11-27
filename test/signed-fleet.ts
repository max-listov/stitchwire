import type { FleetBundle, FleetTrust } from '../packages/contracts/src/fleet/bundle.ts';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { buildBundle } from '../packages/runtime/src/fleet/bundle.ts';
import { generateSigningKey } from '../packages/runtime/src/fleet/signature.ts';

/**
 * A fleet's signer for a test: one fresh key under one id, the trust list that accepts it, and the
 * editions it signs. A manifest is held to the product's schema before it is signed.
 */
export function fleetSigner(keyId: string) {
  const { privateKeyPem, publicKey } = generateSigningKey();
  const trust: FleetTrust = [{ id: keyId, publicKey }];
  return {
    keyId,
    privateKeyPem,
    publicKey,
    trust,
    edition(manifest: unknown, serial: number, issuedAt: string = new Date().toISOString()): FleetBundle {
      return buildBundle({
        manifest: FleetManifestSchema.parse(manifest),
        serial,
        issuedAt,
        keyId,
        privateKeyPem,
      });
    },
  };
}
