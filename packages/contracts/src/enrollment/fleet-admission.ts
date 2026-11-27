import { z } from 'zod';
import { FleetMemberSchema, FleetTopicGrantSchema, FleetTopicNamespaceSchema } from '../fleet/manifest.ts';
import { MAX_NODE_BROKERS, NodeIdSchema } from '../protocol/identity.ts';
import { UnixSocketPathSchema } from '../protocol/paths.ts';
import { TopicNamespaceSchema } from '../protocol/topic.ts';
import { ServiceNamespaceSchema } from '../service/declaration.ts';
import { EnrollmentCommonCodeSchema, resultShell } from './outcome.ts';
import {
  EnrollmentBrokersSchema,
  EnrollmentCredentialSchema,
  EnrollmentMaterialSchema,
  EnrollmentPathSchema,
  EnrollmentSystemdLayoutSchema,
  EnrollmentVersionSchema,
} from './request.ts';

/*
 * The operator half of enrollment: what a fleet's operator gives an orchestrator so that a new node
 * can run `enroll` without knowing the fleet's conventions. Membership in the signed manifest, the
 * operator's own records of its runtimes, and admission on every broker are the operator's; the
 * orchestrator keeps its reach to the target, file delivery and the node's own `enroll` operations.
 * Stitchwire defines the contract; a deployment implements it next to its manifest, signing key and
 * inventory, so the product carries no remote shell and no fleet's names.
 */

/**
 * `plan` and `status` read; `apply` also makes the operator's moves towards a member of the fleet;
 * `withdraw` makes them backwards for an admission that was given up before the node was activated.
 */
export const FleetAdmissionOperationSchema = z.enum(['plan', 'apply', 'status', 'withdraw']);
export type FleetAdmissionOperation = z.infer<typeof FleetAdmissionOperationSchema>;

/** How the operator reaches the machine, in the operator's own words (for example an SSH alias). */
const FleetAdmissionTargetSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/);

const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

const FleetAdmissionTopicGrantSchema = FleetTopicGrantSchema.extend({
  namespace: TopicNamespaceSchema,
});
/** The rights the node asks for: its own service namespaces and the topic namespaces it produces. */
const FleetAdmissionGrantsSchema = z.strictObject({
  services: z.array(ServiceNamespaceSchema).max(16).refine(unique, 'service namespaces are unique'),
  topics: z
    .array(FleetAdmissionTopicGrantSchema)
    .max(16)
    .refine((grants) => unique(grants.map((grant) => grant.namespace)), 'topic namespaces are unique'),
});
export type FleetAdmissionGrants = z.infer<typeof FleetAdmissionGrantsSchema>;

export const FleetAdmissionRequestSchema = z.strictObject({
  v: z.literal(1),
  requestId: z.uuid(),
  nodeId: NodeIdSchema,
  target: FleetAdmissionTargetSchema,
  grants: FleetAdmissionGrantsSchema,
  /** The digests of the node's `enroll prepare`, one per broker the node dials; never a token. */
  credentials: z
    .array(EnrollmentCredentialSchema)
    .min(1)
    .max(MAX_NODE_BROKERS)
    .refine((rows) => unique(rows.map((row) => row.broker)), 'one digest per broker')
    .optional(),
});
export type FleetAdmissionRequest = z.infer<typeof FleetAdmissionRequestSchema>;

export const FleetAdmissionPhaseSchema = z.enum([
  'preflight',
  'inventory',
  'membership',
  'admission',
  'activation',
]);
export type FleetAdmissionPhase = z.infer<typeof FleetAdmissionPhaseSchema>;

/**
 * Whose move the admission waits for.
 *
 *   awaiting-operator     an operator `apply` would act now
 *   awaiting-credentials  the node is a member; run node `enroll prepare`, then apply with its digests
 *   awaiting-node         every broker admits it; run node `enroll apply`, then apply again. In a
 *                         withdrawal: the node is still connected; stop its agent, then withdraw again
 *   ready                 the node is an ordinary member of the fleet
 *   withdrawn             nothing of this admission is left: no admission on a broker, no membership
 *                         it added, no row of the operator's inventory
 */
export const FleetAdmissionStatusSchema = z.enum([
  'awaiting-operator',
  'awaiting-credentials',
  'awaiting-node',
  'ready',
  'withdrawn',
]);
export type FleetAdmissionStatus = z.infer<typeof FleetAdmissionStatusSchema>;

export const FleetAdmissionCodeSchema = z.enum([
  ...EnrollmentCommonCodeSchema.options,
  'manifest-unpublished',
  'release-unfinished',
  'grant-conflict',
  'namespace-conflict',
  'platform-unsupported',
  'reach-failed',
  'artifact-unpublished',
  'publication-failed',
  'record-failed',
  'policy-unaligned',
  'admission-failed',
  /** The node is activated: an admission is withdrawn, a member of the fleet is removed by the operator. */
  'node-active',
]);
export type FleetAdmissionCode = z.infer<typeof FleetAdmissionCodeSchema>;

export const FleetAdmissionFailureSchema = z.strictObject({
  code: FleetAdmissionCodeSchema,
  phase: FleetAdmissionPhaseSchema,
  /** The broker the failure belongs to, when it belongs to one. */
  broker: NodeIdSchema.nullable(),
  at: z.iso.datetime(),
});
export type FleetAdmissionFailure = z.infer<typeof FleetAdmissionFailureSchema>;

/**
 * Exactly what the operation changes: the manifest entries it adds, or in a withdrawal takes back,
 * and the operator's own records by name.
 */
export const FleetAdmissionDeltaSchema = z.strictObject({
  manifest: z.strictObject({
    members: z.record(NodeIdSchema, FleetMemberSchema),
    serviceNamespaces: z.record(NodeIdSchema, z.array(ServiceNamespaceSchema)),
    topicNamespaces: z.record(TopicNamespaceSchema, FleetTopicNamespaceSchema),
  }),
  records: z.array(
    z.strictObject({
      record: z.string().min(1).max(256),
      change: z.enum(['add', 'replace', 'remove']),
      value: z.unknown(),
    }),
  ),
});
export type FleetAdmissionDelta = z.infer<typeof FleetAdmissionDeltaSchema>;

/** The node request fields the operator owns; the orchestrator adds the delivered source, owner and proof. */
export const FleetAdmissionNodeRequestSchema = z.strictObject({
  nodeId: NodeIdSchema,
  expectedVersion: EnrollmentVersionSchema,
  config: EnrollmentPathSchema,
  brokers: EnrollmentBrokersSchema,
  agentSocket: UnixSocketPathSchema,
  supervisor: EnrollmentSystemdLayoutSchema,
});
export type FleetAdmissionNodeRequest = z.infer<typeof FleetAdmissionNodeRequestSchema>;

const shell = {
  ...resultShell(FleetAdmissionOperationSchema, FleetAdmissionPhaseSchema, FleetAdmissionFailureSchema),
  /** Operator records this admission changed that the operator has not recorded yet. */
  unrecorded: z.array(z.string().min(1).max(256)),
};

export const FleetAdmissionResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ ...shell, status: z.literal('failed'), failure: FleetAdmissionFailureSchema }),
  z.strictObject({
    ...shell,
    status: FleetAdmissionStatusSchema,
    /** The first phase that is not complete; null when the node is ready or the admission withdrawn. */
    phase: FleetAdmissionPhaseSchema.nullable(),
    /** What that phase waits for, named: a broker that has not admitted, a reading the node fails. */
    waiting: z.array(z.string().min(1).max(256)),
    delta: FleetAdmissionDeltaSchema,
    /**
     * Everything the node's `enroll` request needs, from the signed edition naming the node until
     * its activation; null before that, and for a member that answers as one. A member that no
     * longer answers is admitted again and carries it until it answers again.
     */
    node: z
      .strictObject({
        request: FleetAdmissionNodeRequestSchema,
        delivery: z.strictObject({
          /** Written by the orchestrator to a private file on the target; its path is `material`. */
          material: EnrollmentMaterialSchema,
          /**
           * The release runtime on the operator's machine, delivered as `supervisor.artifact.source`;
           * its digest is `request.supervisor.artifact.sha256`.
           */
          runtime: EnrollmentPathSchema,
        }),
      })
      .nullable(),
  }),
]);
export type FleetAdmissionResult = z.infer<typeof FleetAdmissionResultSchema>;
