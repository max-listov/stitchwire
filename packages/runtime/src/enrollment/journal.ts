import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { EnrollmentRequest } from '../../../contracts/src/enrollment/request.ts';
import {
  type EnrollmentFailure,
  EnrollmentFailureSchema,
  type EnrollmentPhase,
  EnrollmentPhaseSchema,
} from '../../../contracts/src/enrollment/result.ts';
import { Sha256Schema } from '../../../contracts/src/protocol/paths.ts';
import { sha256 } from '../config/io.ts';
import { configIdentity } from '../config/identity.ts';
import { sortedDeep } from '../json.ts';
import { EnrollmentError } from './failure.ts';
import { ENROLLMENT_REQUEST_BYTES, readValue, writePrivate } from './files.ts';

/** Enrollment keeps its records beside the configuration they are about. */
export function enrollmentRoot(config: string): string {
  return `${configIdentity(config)}.enrollment`;
}

const JournalSchema = z.strictObject({
  v: z.literal(1),
  fingerprint: Sha256Schema,
  completed: z.array(EnrollmentPhaseSchema),
  intent: z.enum(['attach', 'detach']).nullable(),
  firstFailure: EnrollmentFailureSchema.nullable(),
});
type Journal = z.infer<typeof JournalSchema>;

/**
 * What a requestId commits to. Delivered material is evidence of an edition, judged on every read,
 * so a later operation of the same request may omit it once the node keeps its own copy.
 */
function fingerprintOf(request: EnrollmentRequest): string {
  const desired = request.kind === 'node' ? { ...request, material: null } : request;
  return sha256(JSON.stringify(sortedDeep({ ...desired, config: configIdentity(request.config) })));
}

/**
 * The record of one requestId: what it asked for, how far it got and the first refusal it met.
 * It is recovery evidence, read by every operation and written only under the request's own lock.
 */
export class RequestJournal {
  private constructor(
    readonly root: string,
    readonly file: string,
    private record: Journal,
  ) {}

  /** A requestId that once asked for something else is a conflict, before any effect. */
  static open(request: EnrollmentRequest): RequestJournal {
    const root = enrollmentRoot(request.config);
    const file = join(root, `${request.requestId}.json`);
    const fingerprint = fingerprintOf(request);
    const fresh: Journal = { v: 1, fingerprint, intent: null, completed: [], firstFailure: null };
    const record = existsSync(file) ? readValue(file, JournalSchema, ENROLLMENT_REQUEST_BYTES) : fresh;
    if (record.fingerprint !== fingerprint) throw new EnrollmentError('request-conflict');
    return new RequestJournal(root, file, record);
  }

  get completed(): EnrollmentPhase[] {
    return [...this.record.completed];
  }

  get firstFailure(): EnrollmentFailure | null {
    return this.record.firstFailure;
  }

  /** One request attaches or detaches, never both: its retries must converge on one outcome. */
  intend(intent: 'attach' | 'detach'): void {
    if (this.record.intent !== null && this.record.intent !== intent)
      throw new EnrollmentError('request-conflict');
    this.record.intent = intent;
    this.save();
  }

  checkpoint(phase: EnrollmentPhase): void {
    if (!this.record.completed.includes(phase)) this.record.completed.push(phase);
    this.save();
  }

  fail(failure: EnrollmentFailure): void {
    this.record.firstFailure ??= failure;
    this.save();
  }

  save(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writePrivate(this.file, this.record);
  }
}
