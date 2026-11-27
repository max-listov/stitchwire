import { z } from 'zod';
import { FleetBundleSchema, FleetTrustSchema } from '../fleet/bundle.ts';
import { MAX_NODE_BROKERS, NodeIdSchema } from '../protocol/identity.ts';
import { LaneUrlSchema } from '../protocol/lane-url.ts';
import { AbsoluteFilePathSchema, Sha256Schema, UnixSocketPathSchema } from '../protocol/paths.ts';
import { compareVersions, SEMVER } from '../protocol/release.ts';
import { MAX_TOPIC_DESCRIPTOR_FILES } from '../protocol/topic.ts';
import { ServiceCallSchema } from '../service/contracts.ts';
import { MAX_DECLARED_SERVICES } from '../service/declaration.ts';

/** A source runtime is a bounded regular artifact, never a stream or device. */
export const MAX_ENROLLMENT_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** The oldest Bun an installed runtime runs under. */
export const MINIMUM_BUN_VERSION = '1.4.4';

/** Whether a `bun --version` answer is exactly three numbers and at least the minimum. */
export function supportsBun(version: string): boolean {
  return SEMVER.test(version) && compareVersions(version, MINIMUM_BUN_VERSION) >= 0;
}

/** A path that enters a node configuration, whose entries hold at most 1024 characters. */
export const EnrollmentPathSchema = AbsoluteFilePathSchema.max(1024);

/** Bootstrap carries only the addressed node's signed slice and independently trusted public keys. */
export const EnrollmentMaterialSchema = z.strictObject({
  trust: FleetTrustSchema,
  bundle: FleetBundleSchema.refine((bundle) => bundle.full === null, 'only an own slice may be delivered'),
});
export type EnrollmentMaterial = z.infer<typeof EnrollmentMaterialSchema>;

const EnrollmentEndpointSchema = z.strictObject({
  id: NodeIdSchema,
  url: LaneUrlSchema,
});
export type EnrollmentEndpoint = z.infer<typeof EnrollmentEndpointSchema>;
/** The brokers a node dials: each named once and reached at its own address. */
export const EnrollmentBrokersSchema = z
  .array(EnrollmentEndpointSchema)
  .min(1)
  .max(MAX_NODE_BROKERS)
  .refine(
    (brokers) =>
      new Set(brokers.map((broker) => broker.id)).size === brokers.length &&
      new Set(brokers.map((broker) => broker.url)).size === brokers.length,
    'broker ids and URLs must be unique',
  );

/** The digest of the token a node presents to one broker; the token itself never leaves the node. */
export const EnrollmentCredentialSchema = z.strictObject({ broker: NodeIdSchema, sha256: Sha256Schema });
export type EnrollmentCredential = z.infer<typeof EnrollmentCredentialSchema>;

/** Where an installed runtime lives and which bytes it is. */
const EnrollmentInstalledArtifactSchema = z.strictObject({
  destination: EnrollmentPathSchema,
  sha256: Sha256Schema,
});
/** An installed runtime together with the delivered file it is copied from. */
const EnrollmentArtifactSchema = EnrollmentInstalledArtifactSchema.extend({
  source: EnrollmentPathSchema,
});
export type EnrollmentArtifact = z.infer<typeof EnrollmentArtifactSchema>;

/** A plain systemd service name: no path separator, template instance or specifier. */
export const EnrollmentUnitSchema = z
  .string()
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*\.service$/);
/** A supervised installation as its layout: everything but where the runtime is delivered from. */
export const EnrollmentSystemdLayoutSchema = z.strictObject({
  kind: z.literal('systemd'),
  scope: z.enum(['system', 'user']),
  bun: EnrollmentPathSchema,
  /** Absent means the canonical `stitchwire-agent.service`; a second agent on a host names its own. */
  unit: EnrollmentUnitSchema.optional(),
  artifact: EnrollmentInstalledArtifactSchema,
});
/** A new supervised installation always names its runtime; an existing agent never does. */
const EnrollmentSystemdSupervisorSchema = EnrollmentSystemdLayoutSchema.extend({
  artifact: EnrollmentArtifactSchema,
});
export type EnrollmentSystemdSupervisor = z.infer<typeof EnrollmentSystemdSupervisorSchema>;
const EnrollmentSupervisorSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing') }),
  EnrollmentSystemdSupervisorSchema,
]);
export type EnrollmentSupervisor = z.infer<typeof EnrollmentSupervisorSchema>;

/** One owner binding; its kind chooses the file parser and the node configuration table. */
export const EnrollmentDescriptorSchema = z.strictObject({
  kind: z.enum(['service', 'topic']),
  path: EnrollmentPathSchema,
});
export type EnrollmentDescriptor = z.infer<typeof EnrollmentDescriptorSchema>;
const ofKind = (bindings: readonly EnrollmentDescriptor[], kind: EnrollmentDescriptor['kind']) =>
  bindings.filter((binding) => binding.kind === kind).length;
const EnrollmentOwnerSchema = z.strictObject({
  id: NodeIdSchema,
  /**
   * Take over the paths of `descriptors` that the configuration already binds, under the same kind,
   * with no recorded owner — bindings written before enrollment existed. They become this owner's as
   * they are: the configuration does not change. A path another owner holds is still refused.
   */
  adopt: z.boolean().optional(),
  descriptors: z
    .array(EnrollmentDescriptorSchema)
    .max(MAX_DECLARED_SERVICES + MAX_TOPIC_DESCRIPTOR_FILES)
    .refine((bindings) => new Set(bindings.map(({ path }) => path)).size === bindings.length)
    .refine((bindings) => ofKind(bindings, 'service') <= MAX_DECLARED_SERVICES)
    .refine((bindings) => ofKind(bindings, 'topic') <= MAX_TOPIC_DESCRIPTOR_FILES),
});
export type EnrollmentOwner = z.infer<typeof EnrollmentOwnerSchema>;
const EnrollmentProofSchema = z.strictObject({
  descriptor: EnrollmentPathSchema,
  call: ServiceCallSchema,
  responseSha256: Sha256Schema,
});
export type EnrollmentProof = z.infer<typeof EnrollmentProofSchema>;

export const EnrollmentVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
const requestFields = {
  v: z.literal(1),
  requestId: z.uuid(),
  nodeId: NodeIdSchema,
  expectedVersion: EnrollmentVersionSchema,
  config: EnrollmentPathSchema,
};
export const EnrollmentNodeRequestSchema = z.strictObject({
  ...requestFields,
  kind: z.literal('node'),
  /** Broker material for a node without a kept signed copy; later operations read that copy. */
  material: EnrollmentPathSchema.optional(),
  brokers: EnrollmentBrokersSchema,
  agentSocket: UnixSocketPathSchema,
  supervisor: EnrollmentSupervisorSchema,
  owner: EnrollmentOwnerSchema,
  /** Without a proof `ready` certifies transport and declarations; the service route is unchecked. */
  proof: EnrollmentProofSchema.optional(),
});
export type EnrollmentNodeRequest = z.infer<typeof EnrollmentNodeRequestSchema>;
export const EnrollmentAdmissionRequestSchema = z.strictObject({
  ...requestFields,
  kind: z.literal('admission'),
  /** Required by `apply`; `plan` runs before the node has prepared its credential. */
  tokenSha256: Sha256Schema.optional(),
});
export type EnrollmentAdmissionRequest = z.infer<typeof EnrollmentAdmissionRequestSchema>;
export const EnrollmentRequestSchema = z.discriminatedUnion('kind', [
  EnrollmentNodeRequestSchema,
  EnrollmentAdmissionRequestSchema,
]);
export type EnrollmentRequest = z.infer<typeof EnrollmentRequestSchema>;

export const EnrollmentOperationSchema = z.enum(['plan', 'prepare', 'apply', 'status', 'detach']);
export type EnrollmentOperation = z.infer<typeof EnrollmentOperationSchema>;
/** A broker admits or reads; credential preparation and owner detach are a node's operations. */
export const ENROLLMENT_OPERATIONS = {
  node: EnrollmentOperationSchema.options,
  admission: ['plan', 'apply', 'status'],
} satisfies Record<EnrollmentRequest['kind'], readonly EnrollmentOperation[]>;
