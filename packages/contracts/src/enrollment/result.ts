import { z } from 'zod';
import { Sha256Schema } from '../protocol/paths.ts';
import { EnrollmentCommonCodeSchema, resultShell } from './outcome.ts';
import {
  EnrollmentCredentialSchema,
  EnrollmentMaterialSchema,
  EnrollmentOperationSchema,
  EnrollmentPathSchema,
  EnrollmentUnitSchema,
} from './request.ts';

export const EnrollmentPhaseSchema = z.enum([
  'preflight',
  'credential',
  'admission',
  'configuration',
  'artifact',
  'supervisor-unit',
  'supervisor',
  'verification',
  'detach',
]);
export type EnrollmentPhase = z.infer<typeof EnrollmentPhaseSchema>;
export const EnrollmentCodeSchema = z.enum([
  ...EnrollmentCommonCodeSchema.options,
  /** The node has no kept signed copy and the request delivered none. */
  'material-required',
  'artifact-mismatch',
  /** The fleet does not admit this node: it is no member of the signed edition. */
  'admission-denied',
  /**
   * The operating system refused access to a local file and no step names that refusal more
   * exactly; under a step's own code the denial is still read in `systemCode`.
   */
  'permission-denied',
  'handshake-refused',
  'supervisor-failed',
  'runtime-unavailable',
  'runtime-conflict',
  'bundle-invalid',
  'bundle-stale',
  'bundle-conflict',
  'owner-conflict',
  /** A declaration file of the final set cannot be loaded here; no reload will change that. */
  'declaration-invalid',
  /** A broker has not accepted the node's declarations. */
  'declaration-refused',
  'proof-not-read',
  'proof-not-remote',
  'proof-failed',
]);
export type EnrollmentCode = z.infer<typeof EnrollmentCodeSchema>;
export const EnrollmentFailureSchema = z.strictObject({
  code: EnrollmentCodeSchema,
  /** The step that was running when the operation refused. */
  phase: EnrollmentPhaseSchema,
  at: z.iso.datetime(),
  /** The code of the refusal underneath, when one was measured: the operating system's, the runtime's or a lock's. */
  systemCode: z.string().max(64).nullable(),
});
export type EnrollmentFailure = z.infer<typeof EnrollmentFailureSchema>;

/** Measured, never echoed: the version the running agent reports and what manages it. */
const EnrollmentRuntimeSchema = z.strictObject({
  version: z.string().max(64),
  /** The installation enrollment made for this configuration; null when it made none. */
  installation: z
    .strictObject({
      path: EnrollmentPathSchema,
      sha256: Sha256Schema,
      service: z.strictObject({
        manager: z.literal('systemd'),
        scope: z.enum(['system', 'user']),
        unit: EnrollmentUnitSchema,
      }),
    })
    .nullable(),
});
export type EnrollmentRuntime = z.infer<typeof EnrollmentRuntimeSchema>;

const shell = resultShell(EnrollmentOperationSchema, EnrollmentPhaseSchema, EnrollmentFailureSchema);
/** A node's results name the digest of the credential it holds for each broker it dials. */
const node = { ...shell, kind: z.literal('node'), credentials: z.array(EnrollmentCredentialSchema) };
/** A broker's results carry the bootstrap material and the digests it admits the node under. */
const admission = {
  ...shell,
  kind: z.literal('admission'),
  material: EnrollmentMaterialSchema,
  admitted: z.array(Sha256Schema),
};

/**
 * One result per operation; `status` and `kind` choose its fields.
 *
 *   node       planned → prepared → ready, or detached
 *   admission  planned → admitted
 *
 * `ready` with `proof: null` certifies transport and declarations; the service route is unchecked.
 */
export const EnrollmentResultSchema = z.union([
  z.strictObject({ ...shell, status: z.literal('failed'), failure: EnrollmentFailureSchema }),
  z.strictObject({ ...node, status: z.literal('planned') }),
  z.strictObject({ ...node, status: z.literal('prepared') }),
  z.strictObject({
    ...node,
    status: z.literal('ready'),
    runtime: EnrollmentRuntimeSchema,
    /** The answer of the requested read through a broker; null when no proof was requested. */
    proof: z.strictObject({ httpStatus: z.number().int() }).nullable(),
  }),
  z.strictObject({ ...node, status: z.literal('detached'), runtime: EnrollmentRuntimeSchema }),
  z.strictObject({ ...admission, status: z.literal('planned') }),
  z.strictObject({ ...admission, status: z.literal('admitted') }),
]);
export type EnrollmentResult = z.infer<typeof EnrollmentResultSchema>;
