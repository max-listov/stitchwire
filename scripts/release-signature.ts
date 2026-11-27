import { createPublicKey, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const SIGNATURE_FILE = 'SHA256SUMS.sig';

/** The independently distributed bootstrap owns the trust root, including for the release tools. */
export function releasePublicKey(): string {
  const bootstrap = readFileSync(new URL('../contrib/install.sh', import.meta.url), 'utf8');
  const key = /^RELEASE_PUBLIC_KEY='([A-Za-z0-9_-]{43})'$/m.exec(bootstrap)?.[1];
  if (!key) throw new Error('standalone installer lacks the release verification key');
  return key;
}

export function signChecksums(checksums: Uint8Array, key: string): Buffer {
  return sign(null, checksums, key);
}

export function assertSignedChecksums(
  checksums: Uint8Array,
  signature: Uint8Array,
  key = releasePublicKey(),
): void {
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' });
  if (signature.byteLength !== 64 || !verify(null, checksums, publicKey, signature))
    throw new Error('release checksum signature does not match the installer trust root');
}
