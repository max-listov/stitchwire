import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ExclusiveLockError, withExclusiveLock } from 'stitchkit/files';
import {
  ENROLLMENT_OPERATIONS,
  type EnrollmentOperation,
  type EnrollmentRequest,
  EnrollmentRequestSchema,
} from '../../../contracts/src/enrollment/request.ts';
import {
  type EnrollmentFailure,
  type EnrollmentPhase,
  type EnrollmentResult,
  EnrollmentResultSchema,
} from '../../../contracts/src/enrollment/result.ts';
import { configIdentity } from '../config/identity.ts';
import { RELEASE_VERSION } from '../release-version.ts';
import { admissionFlow } from './admission.ts';
import { canonicalBindings } from './bindings.ts';
import { EnrollmentError, failureOf } from './failure.ts';
import { RequestJournal } from './journal.ts';
import { nodeFlow } from './node.ts';
import { checkProofTarget } from './observe.ts';
import { type Outcome, Steps } from './steps.ts';

/** One spelling of the request's files, so two requests for one object are one resource. */
function canonical(request: EnrollmentRequest): EnrollmentRequest {
  const config = configIdentity(request.config);
  if (request.kind === 'admission') return { ...request, config };
  return {
    ...request,
    config,
    owner: { ...request.owner, descriptors: canonicalBindings(request.owner.descriptors) },
  };
}

/**
 * What can be refused from the request and the operation alone is refused here, before any wait,
 * record or lock: a refusal that depends on nothing measured must leave nothing behind.
 */
function admissible(request: EnrollmentRequest, operation: EnrollmentOperation): void {
  if (!ENROLLMENT_OPERATIONS[request.kind].some((allowed) => allowed === operation))
    throw new EnrollmentError('invalid-request');
  if (request.kind === 'node') checkProofTarget(request);
  // Admitting a credential needs its digest; the request alone says whether it brought one.
  else if (operation === 'apply' && request.tokenSha256 === undefined)
    throw new EnrollmentError('invalid-request');
  if (request.expectedVersion !== RELEASE_VERSION) throw new EnrollmentError('version-mismatch');
}

/** A refusal under the request lock, with the journal as that lock left it. */
class Refusal extends Error {
  constructor(
    readonly reason: unknown,
    readonly journal: RequestJournal,
  ) {
    super('enrollment refused', { cause: reason });
  }
}

/** The effects of one requestId happen one at a time, and its journal is read under that lock. */
async function mutate(
  request: EnrollmentRequest,
  commit: (journal: RequestJournal) => Promise<Outcome>,
  steps: Steps,
  opened: RequestJournal,
): Promise<{ outcome: Outcome; journal: RequestJournal }> {
  mkdirSync(dirname(request.config), { recursive: true, mode: 0o700 });
  mkdirSync(opened.root, { recursive: true, mode: 0o700 });
  return withExclusiveLock(
    `${opened.file}.lock`,
    async () => {
      const journal = RequestJournal.open(request);
      steps.recordInto((phase) => journal.checkpoint(phase));
      try {
        return { outcome: await commit(journal), journal };
      } catch (error) {
        // A busy configuration refused before the mutation began; it is not the request's failure.
        if (!(error instanceof ExclusiveLockError)) journal.fail(failureOf(error, steps.phase));
        throw new Refusal(error, journal);
      }
    },
    { timeoutMs: 0 },
  );
}

async function run(
  request: EnrollmentRequest,
  operation: EnrollmentOperation,
  steps: Steps,
  journal: RequestJournal,
): Promise<{ outcome: Outcome; journal: RequestJournal | null }> {
  if (request.kind === 'admission') {
    if (operation === 'plan' || operation === 'status')
      return { outcome: await admissionFlow.inspect(request, operation, steps), journal: null };
    // Refused in `admissible` already; here the type learns what that check established.
    if (request.tokenSha256 === undefined) throw new EnrollmentError('invalid-request');
    return mutate(request, await admissionFlow.mutation(request, request.tokenSha256, steps), steps, journal);
  }
  if (operation === 'plan' || operation === 'status')
    return { outcome: await nodeFlow.inspect(request, operation, steps), journal: null };
  return mutate(request, await nodeFlow.mutation(request, operation, steps), steps, journal);
}

/** What a result says about the question itself, known before anything is measured. */
type Asked = Pick<EnrollmentResult, 'v' | 'requestId' | 'nodeId' | 'operation'>;

/**
 * The one result of an operation. An outcome outside the contract is this program's defect: it is
 * named on stderr and still answered as a `state-invalid` refusal that keeps what the journal
 * recorded, so a caller always reads one JSON result.
 */
export function resultOf(
  asked: Asked,
  outcome: Outcome | { status: 'failed'; failure: EnrollmentFailure },
  phase: EnrollmentPhase,
  completed: EnrollmentPhase[],
  firstFailure: EnrollmentFailure | null,
): EnrollmentResult {
  const observedAt = new Date().toISOString();
  const result = EnrollmentResultSchema.safeParse({
    ...asked,
    ...outcome,
    observedAt,
    completed,
    firstFailure,
  });
  if (result.success) return result.data;
  process.stderr.write(`enrollment result outside its contract: ${result.error.message}\n`);
  return {
    ...asked,
    status: 'failed',
    failure: failureOf(new EnrollmentError('state-invalid', { cause: result.error }), phase),
    observedAt,
    completed,
    firstFailure,
  };
}

/**
 * Local-only API; the orchestrator owns transport of requests and material between OS principals.
 * Every outcome, a refusal included, is one result: nothing an operation meets leaves as an exception.
 */
export async function executeEnrollment(
  value: unknown,
  operation: EnrollmentOperation | null,
): Promise<EnrollmentResult> {
  const parsed = EnrollmentRequestSchema.safeParse(value);
  const steps = new Steps();
  const asked: Asked = {
    v: 1,
    requestId: parsed.success ? parsed.data.requestId : null,
    nodeId: parsed.success ? parsed.data.nodeId : null,
    operation,
  };
  let journal: RequestJournal | null = null;
  let recorded = false;
  let outcome: Outcome | { status: 'failed'; failure: EnrollmentFailure };
  try {
    if (!parsed.success || operation === null) throw new EnrollmentError('invalid-request');
    admissible(parsed.data, operation);
    const request = canonical(parsed.data);
    journal = RequestJournal.open(request);
    const finished = await run(request, operation, steps, journal);
    outcome = finished.outcome;
    if (finished.journal !== null) {
      journal = finished.journal;
      recorded = true;
    }
  } catch (error) {
    const refused = error instanceof Refusal;
    if (refused) {
      journal = error.journal;
      recorded = true;
    }
    outcome = { status: 'failed', failure: failureOf(refused ? error.reason : error, steps.phase) };
  }
  return resultOf(
    asked,
    outcome,
    steps.last,
    // The journal is recovery evidence, not a claim about a read-only inspection.
    recorded && journal !== null ? journal.completed : [],
    journal?.firstFailure ?? null,
  );
}
