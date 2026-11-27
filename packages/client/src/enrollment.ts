/**
 * The enrollment contract for orchestrators: request and result schemas of the local `enroll`
 * command and of a fleet operator's admission entry. Contract only — no runtime, credentials or
 * execution; the main entry stays as it is.
 *
 * The list is the public surface: the blocks these schemas are composed from stay internal, so the
 * contract can be rearranged without breaking a consumer that built on a part of it.
 */
export {
  ENROLLMENT_OPERATIONS,
  type EnrollmentAdmissionRequest,
  EnrollmentAdmissionRequestSchema,
  type EnrollmentArtifact,
  type EnrollmentCredential,
  EnrollmentCredentialSchema,
  type EnrollmentDescriptor,
  type EnrollmentMaterial,
  EnrollmentMaterialSchema,
  type EnrollmentNodeRequest,
  EnrollmentNodeRequestSchema,
  type EnrollmentOperation,
  EnrollmentOperationSchema,
  type EnrollmentOwner,
  type EnrollmentProof,
  type EnrollmentRequest,
  EnrollmentRequestSchema,
  type EnrollmentSupervisor,
  MINIMUM_BUN_VERSION,
  supportsBun,
} from '../../contracts/src/enrollment/request.ts';
export {
  type EnrollmentCode,
  EnrollmentCodeSchema,
  type EnrollmentFailure,
  EnrollmentFailureSchema,
  type EnrollmentPhase,
  EnrollmentPhaseSchema,
  type EnrollmentResult,
  EnrollmentResultSchema,
  type EnrollmentRuntime,
} from '../../contracts/src/enrollment/result.ts';
export {
  type FleetAdmissionCode,
  FleetAdmissionCodeSchema,
  type FleetAdmissionDelta,
  type FleetAdmissionFailure,
  type FleetAdmissionGrants,
  type FleetAdmissionNodeRequest,
  FleetAdmissionNodeRequestSchema,
  type FleetAdmissionOperation,
  FleetAdmissionOperationSchema,
  type FleetAdmissionPhase,
  FleetAdmissionPhaseSchema,
  type FleetAdmissionRequest,
  FleetAdmissionRequestSchema,
  type FleetAdmissionResult,
  FleetAdmissionResultSchema,
  type FleetAdmissionStatus,
  FleetAdmissionStatusSchema,
} from '../../contracts/src/enrollment/fleet-admission.ts';
