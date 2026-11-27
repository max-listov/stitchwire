import type { resultShell } from '../../../contracts/src/enrollment/outcome.ts';
import type { EnrollmentPhase, EnrollmentResult } from '../../../contracts/src/enrollment/result.ts';

/** What a flow answers: one successful variant of the result, without the shell the operation adds. */
export type Outcome = EnrollmentResult extends infer Result
  ? Result extends { status: 'failed' }
    ? never
    : Omit<Result, keyof ReturnType<typeof resultShell>>
  : never;

/**
 * The step that is running. A refusal belongs to the innermost step it interrupts, whichever
 * function threw it, and a step whose completion is recovery evidence is recorded in the request's
 * journal. A step that returns gives the phase back to the step around it; outside every step an
 * operation is in preflight.
 */
export class Steps {
  phase: EnrollmentPhase = 'preflight';
  /** The step entered last: where an operation stood when every step had already returned. */
  last: EnrollmentPhase = 'preflight';
  private checkpoint: (phase: EnrollmentPhase) => void = () => {};

  /** Read-only operations record nothing; a mutation records into its journal under its lock. */
  recordInto(checkpoint: (phase: EnrollmentPhase) => void): void {
    this.checkpoint = checkpoint;
  }

  async run<T>(phase: EnrollmentPhase, step: () => T | Promise<T>): Promise<T> {
    const around = this.phase;
    this.phase = phase;
    this.last = phase;
    const value = await step();
    this.phase = around;
    return value;
  }

  async record<T>(phase: EnrollmentPhase, step: () => T | Promise<T>): Promise<T> {
    const value = await this.run(phase, step);
    this.checkpoint(phase);
    return value;
  }
}
