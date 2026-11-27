import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readRegularFileSync } from 'stitchkit/files';
import type { FleetSigned, FleetTrust } from '../../../contracts/src/fleet/bundle.ts';
import { sortedDeep } from '../json.ts';

/**
 * Ed25519, from the runtime's own crypto: no dependency, a 32-byte public key that fits on one line
 * of a configuration file, and a signature that does not depend on a random source at signing time.
 */

/** Keys sorted at every depth: the signed bytes must not depend on how a manifest was typed. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortedDeep(value));
}

export function generateSigningKey(): { privateKeyPem: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('the runtime produced an Ed25519 key without its public half');
  return { privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey: x };
}

export function publicKeyOf(privateKeyPem: string): string {
  const x = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('not an Ed25519 private key');
  return x;
}

/** A PEM-encoded Ed25519 key is a few hundred bytes; the bound keeps a wrong path from being read whole. */
const MAX_SIGNING_KEY_BYTES = 64 * 1024;

/**
 * The private key, refused when anyone but its owner can read it: a signing key readable by a
 * second account is a second person who can rewrite every machine's permissions.
 */
export function readSigningKey(path: string): string {
  const key = readRegularFileSync(path, {
    limit: MAX_SIGNING_KEY_BYTES,
    accept: (info) => {
      const mode = info.mode & 0o777;
      if ((mode & 0o077) !== 0)
        throw new Error(
          `${path} is mode ${mode.toString(8)}; a signing key must be readable by its owner only (600)`,
        );
      return true;
    },
  });
  return new TextDecoder('utf-8', { fatal: true }).decode(key);
}

export function signDocument(document: unknown, keyId: string, privateKeyPem: string): FleetSigned {
  const payload = canonicalJson(document);
  const signature = sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(privateKeyPem)).toString(
    'base64url',
  );
  return { keyId, payload, signature };
}

type OpenedDocument = { ok: true; document: unknown; keyId: string } | { ok: false; detail: string };

/** The document inside, only when a trusted key signed exactly these bytes. */
export function openDocument(signed: FleetSigned, trust: FleetTrust): OpenedDocument {
  const key = trust.find((entry) => entry.id === signed.keyId);
  if (key === undefined)
    return { ok: false, detail: `signed by '${signed.keyId}', which is not a trusted key here` };
  let valid = false;
  try {
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey },
      format: 'jwk',
    });
    valid = verify(
      null,
      Buffer.from(signed.payload, 'utf8'),
      publicKey,
      Buffer.from(signed.signature, 'base64url'),
    );
  } catch (error) {
    return { ok: false, detail: `signature could not be checked: ${String(error).slice(0, 200)}` };
  }
  if (!valid) return { ok: false, detail: `the signature by '${signed.keyId}' does not match its payload` };
  try {
    return { ok: true, document: JSON.parse(signed.payload), keyId: signed.keyId };
  } catch {
    return { ok: false, detail: 'the signed payload is not JSON' };
  }
}
