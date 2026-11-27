/**
 * The candidate packet: one immutable directory holding two sealed sets.
 *
 * - `release/` is what a public release carries: the runtime, its native modules, the SDK archive and
 *   the license evidence, with a manifest and `SHA256SUMS` that name exactly those files.
 * - `rollback/` is the previous release's binary, kept byte for byte so smoke can run the candidate
 *   against it. Its historical build metadata may be unsuitable for public distribution, so it never
 *   shares a manifest or a checksum list with the release set. Its own manifest names the release
 *   manifest's digest, so a rollback packet cannot be paired with another candidate.
 *
 * Publication uploads the release set and nothing else; smoke and the conveyor read the rollback
 * binary out of the same verified packet.
 */
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseJsonBytes } from 'stitchkit/files';
import { z } from 'zod';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { assertSignedChecksums, SIGNATURE_FILE } from './release-signature.ts';
import { DARWIN_ARCHITECTURES, nativeSidecar } from './runtime-assets.ts';

const Name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const Version = z.string().regex(/^\d+\.\d+\.\d+$/);
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const CANDIDATE_NOTICES = [
  { role: 'license', file: 'LICENSE' },
  { role: 'third-party-notices', file: 'THIRD_PARTY_NOTICES.txt' },
  { role: 'dependency-inventory', file: 'dependency-inventory.json' },
] as const;
/** The two sets inside a candidate directory; a release is published from the first only. */
export const CANDIDATE_LAYOUT = { release: 'release', rollback: 'rollback' };

const Bytes = z
  .number()
  .int()
  .nonnegative()
  .max(256 * 1024 * 1024);
const ReleaseFileSchema = z.strictObject({
  role: z.enum([
    'candidate',
    'client',
    'runtime-package',
    'candidate-native',
    ...CANDIDATE_NOTICES.map((entry) => entry.role),
  ]),
  file: Name,
  bytes: Bytes,
  sha256: Sha256,
});
const RollbackFileSchema = z.strictObject({
  role: z.enum(['rollback', 'rollback-native']),
  file: Name,
  bytes: Bytes,
  sha256: Sha256,
});

export const CandidateManifestSchema = z.strictObject({
  schema: z.union([z.literal(2), z.literal(3), z.literal(4)]),
  candidate: z.strictObject({ version: Version, file: Name }),
  client: z.strictObject({
    package: z.literal('@stitchwire/client'),
    version: Version,
    file: Name,
    localDoor: z.number().int().positive(),
  }),
  flagDay: z.literal(true),
  runtimeContract: z.literal('exact release; operator acceptance is separate'),
  privacy: z.literal('strict-path-and-secret-scan'),
  files: z.array(ReleaseFileSchema).min(1).max(16),
});
export type CandidateManifest = z.infer<typeof CandidateManifestSchema>;
export type CandidateFile = z.infer<typeof ReleaseFileSchema>;

export const RollbackManifestSchema = z.strictObject({
  schema: z.literal(1),
  rollback: z.strictObject({ version: Version, file: Name }),
  /** The release set this rollback was packed with: its version and its manifest's digest. */
  candidate: z.strictObject({ version: Version, manifestSha256: Sha256 }),
  privacy: z.literal('exact-released-secret-scan'),
  files: z
    .array(RollbackFileSchema)
    .min(1)
    .max(1 + DARWIN_ARCHITECTURES.length),
});
export type RollbackManifest = z.infer<typeof RollbackManifestSchema>;
export type RollbackFile = z.infer<typeof RollbackFileSchema>;

/** The release manifest create-candidate writes; every other writer of one (fixtures included) calls this. */
export function releaseManifest(input: {
  candidate: CandidateManifest['candidate'];
  /** As the client package declares it; the schema refuses another package name. */
  client: { package: string; version: string; file: string; localDoor: number };
  files: CandidateFile[];
  signed?: boolean;
}): CandidateManifest {
  return CandidateManifestSchema.parse({
    schema: input.signed ? 4 : 3,
    // No protocol field. A release is fleet-wide by definition, so "which protocol does this
    // artifact speak" has exactly one answer — its own version.
    candidate: input.candidate,
    client: input.client,
    /** Always true, and stated rather than computed: a rollback restores every machine or none. */
    flagDay: true,
    runtimeContract: 'exact release; operator acceptance is separate',
    privacy: 'strict-path-and-secret-scan',
    files: input.files,
  });
}

export function rollbackManifest(input: {
  rollback: RollbackManifest['rollback'];
  candidate: RollbackManifest['candidate'];
  files: RollbackFile[];
}): RollbackManifest {
  return RollbackManifestSchema.parse({
    schema: 1,
    rollback: input.rollback,
    candidate: input.candidate,
    privacy: 'exact-released-secret-scan',
    files: input.files,
  });
}

/** The manifest file's text: what is hashed is exactly what is written. */
export function manifestText(manifest: CandidateManifest | RollbackManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** `SHA256SUMS` of one set: each file, then the manifest. */
export function checksumList(
  files: ReadonlyArray<{ file: string; sha256: string }>,
  manifestSha256: string,
): string {
  return [
    ...files.map((file) => `${file.sha256}  ${file.file}`),
    `${manifestSha256}  manifest.json`,
    '',
  ].join('\n');
}

function regularBytes(directory: string, name: string, max: number): Buffer {
  const path = join(directory, name),
    stat = lstatSync(path);
  if (!stat.isFile() || stat.size > max)
    throw new Error(`candidate file is not bounded and regular: ${name}`);
  return readFileSync(path);
}

type SealedSet<Manifest> = {
  directory: string;
  manifest: Manifest;
  digest: string;
  listed: Map<string, string>;
};

/**
 * One set's seal: the manifest parses, `SHA256SUMS` lists every manifest file and the manifest
 * itself, each file has its listed bytes and role, and the directory holds nothing else.
 */
function verifySet<
  Manifest extends { files: ReadonlyArray<{ role: string; file: string; bytes: number; sha256: string }> },
>(
  directory: string,
  parse: (value: unknown) => Manifest,
  roleOf: (manifest: Manifest, file: string) => string | undefined,
  required: (manifest: Manifest) => ReadonlyArray<{ role: string; file: string }>,
  authenticate?: (manifest: Manifest, sums: Buffer) => string[],
): SealedSet<Manifest> {
  const manifestBytes = regularBytes(directory, 'manifest.json', 1024 * 1024);
  const manifest = parse(parseJsonBytes(manifestBytes));
  const listed = new Map<string, string>();
  const checksumBytes = regularBytes(directory, 'SHA256SUMS', 16 * 1024);
  const proofs = authenticate?.(manifest, checksumBytes) ?? [];
  const sums = checksumBytes.toString();
  if (!sums.endsWith('\n')) throw new Error('truncated candidate SHA256SUMS');
  for (const line of sums.trimEnd().split('\n')) {
    const match = /^([a-f0-9]{64}) {2}([a-zA-Z0-9][a-zA-Z0-9._-]*)$/.exec(line);
    if (!match?.[1] || !match[2] || listed.has(match[2]))
      throw new Error('malformed or duplicate candidate checksum');
    listed.set(match[2], match[1]);
  }
  for (const entry of required(manifest))
    if (manifest.files.filter((file) => file.role === entry.role && file.file === entry.file).length !== 1)
      throw new Error(`candidate lacks unique ${entry.role}: ${entry.file}`);
  const names = new Set<string>();
  for (const entry of manifest.files) {
    const expectedRole = roleOf(manifest, entry.file);
    if (names.has(entry.file) || expectedRole === undefined)
      throw new Error(`unexpected or duplicate candidate file: ${entry.file}`);
    names.add(entry.file);
    if (entry.role !== expectedRole) throw new Error(`candidate role differs: ${entry.file}`);
    const bytes = regularBytes(directory, entry.file, 256 * 1024 * 1024);
    if (
      bytes.length !== entry.bytes ||
      sha256(bytes) !== entry.sha256 ||
      listed.get(entry.file) !== entry.sha256
    )
      throw new Error(`candidate bytes or checksum differ: ${entry.file}`);
  }
  const digest = sha256(manifestBytes);
  if (listed.get('manifest.json') !== digest || listed.size !== names.size + 1)
    throw new Error('candidate manifest/checksum inventory differs');
  const actual = readdirSync(directory).sort(),
    expected = [...names, 'manifest.json', 'SHA256SUMS', ...proofs].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('candidate directory inventory differs');
  return { directory, manifest, digest, listed };
}

function releaseRequired(manifest: CandidateManifest): Array<{ role: string; file: string }> {
  return [
    { role: 'candidate', file: manifest.candidate.file },
    { role: 'client', file: manifest.client.file },
    // A schema 2 receipt predates the npm runtime archive and still verifies its original release.
    ...(manifest.schema >= 3
      ? [{ role: 'runtime-package', file: `stitchwire-${manifest.candidate.version}.tgz` }]
      : []),
    ...CANDIDATE_NOTICES,
    ...DARWIN_ARCHITECTURES.map((arch) => ({
      role: 'candidate-native',
      file: nativeSidecar(manifest.candidate.file, arch),
    })),
  ];
}

/** The public half alone: the files a release carries. A rollback file here is unexpected by construction. */
export function verifyReleaseSet(directory: string, publicKey?: string): SealedSet<CandidateManifest> {
  return verifySet(
    directory,
    (value) => CandidateManifestSchema.parse(value),
    (manifest, file) => releaseRequired(manifest).find((entry) => entry.file === file)?.role,
    releaseRequired,
    (manifest, sums) => {
      if (manifest.schema !== 4) return [];
      assertSignedChecksums(sums, regularBytes(directory, SIGNATURE_FILE, 64), publicKey);
      return [SIGNATURE_FILE];
    },
  );
}

function verifyRollbackSet(directory: string): SealedSet<RollbackManifest> {
  return verifySet(
    directory,
    (value) => RollbackManifestSchema.parse(value),
    (manifest, file) => {
      if (file === manifest.rollback.file) return 'rollback';
      // Historical rollback releases had no native modules, so they are allowed, not required.
      return DARWIN_ARCHITECTURES.some((arch) => nativeSidecar(manifest.rollback.file, arch) === file)
        ? 'rollback-native'
        : undefined;
    },
    (manifest) => [{ role: 'rollback', file: manifest.rollback.file }],
  );
}

export type CandidatePacket = {
  release: SealedSet<CandidateManifest>;
  rollback: SealedSet<RollbackManifest> & { binary: string };
};

/** One certified packet contract shared by publication, SDK acceptance, certification and smoke receipts. */
export function verifyCandidate(root: string, publicKey?: string): CandidatePacket {
  const entries = readdirSync(root).sort();
  const layout = Object.values(CANDIDATE_LAYOUT).sort();
  if (JSON.stringify(entries) !== JSON.stringify(layout))
    throw new Error(`candidate directory holds ${entries.join(', ')}, not ${layout.join(', ')}`);
  for (const entry of layout)
    if (!lstatSync(join(root, entry)).isDirectory()) throw new Error(`candidate ${entry} is not a directory`);
  const release = verifyReleaseSet(join(root, CANDIDATE_LAYOUT.release), publicKey);
  const rollback = verifyRollbackSet(join(root, CANDIDATE_LAYOUT.rollback));
  if (
    rollback.manifest.candidate.version !== release.manifest.candidate.version ||
    rollback.manifest.candidate.manifestSha256 !== release.digest
  )
    throw new Error('the rollback packet was sealed for another release set');
  return {
    release,
    rollback: { ...rollback, binary: join(rollback.directory, rollback.manifest.rollback.file) },
  };
}

/** What a release uploads: the release set's listed files and its `SHA256SUMS`, never the rollback packet. */
export function publishedAssets(packet: CandidatePacket): string[] {
  const { directory, listed, manifest } = packet.release;
  const names = [...listed.keys(), 'SHA256SUMS'];
  if (manifest.schema === 4) names.push(SIGNATURE_FILE);
  return names.map((name) => join(directory, name));
}
