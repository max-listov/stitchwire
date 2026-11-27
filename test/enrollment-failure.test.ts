import { expect, test } from 'bun:test';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { EnrollmentError, failureOf } from '../packages/runtime/src/enrollment/failure.ts';
import { executeEnrollment, resultOf } from '../packages/runtime/src/enrollment/operation.ts';
import { Steps } from '../packages/runtime/src/enrollment/steps.ts';
import { AT_ONCE, OWN_EFFECTS, settled } from '../packages/runtime/src/enrollment/wait.ts';
import { withFixtureConfigLock } from './enrollment-lock.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import { refusalOf } from './enrollment-results.ts';

const osError = (code: string) =>
  Object.assign(new Error(`${code}: refused by the operating system`), { code });

test('a refusal belongs to the step it interrupts, whichever function threw it', async () => {
  const steps = new Steps();
  const sharedCheck = (): string => {
    throw new EnrollmentError('runtime-conflict');
  };
  for (const phase of ['preflight', 'supervisor', 'verification'] satisfies (typeof steps.phase)[]) {
    const error = await steps.run(phase, sharedCheck).catch((thrown: unknown) => thrown);
    expect(failureOf(error, steps.phase)).toMatchObject({ code: 'runtime-conflict', phase });
  }
  // A step that returned gives the phase back: what refuses after it belongs to the step around it.
  const around = await steps
    .run('configuration', async () => {
      await steps.run('preflight', () => 'observed');
      return sharedCheck();
    })
    .catch((thrown: unknown) => thrown);
  expect(failureOf(around, steps.phase)).toMatchObject({ code: 'runtime-conflict', phase: 'configuration' });
  // Negative control: the refusal of the inner step itself keeps the inner step.
  await steps.run('configuration', () => steps.run('credential', sharedCheck)).catch(() => {});
  expect(steps.phase).toBe('credential');
  // A recorded step is recovery evidence only once it finished.
  const recorded: string[] = [];
  steps.recordInto((phase) => recorded.push(phase));
  await steps.record('artifact', () => 'installed');
  await steps.record('supervisor-unit', sharedCheck).catch(() => {});
  expect(recorded).toEqual(['artifact']);
});

test('the operating system code is kept wherever it was measured, and a local refusal is not a fleet decision', () => {
  // Wrapped in an enrollment refusal: the code names enrollment's verdict, systemCode what the OS said.
  const wrapped = new EnrollmentError('artifact-mismatch', { cause: osError('ENOENT') });
  expect(failureOf(wrapped, 'preflight')).toMatchObject({ code: 'artifact-mismatch', systemCode: 'ENOENT' });
  const deep = new EnrollmentError('declaration-invalid', {
    cause: new EnrollmentError('state-invalid', { cause: osError('EISDIR') }),
  });
  expect(failureOf(deep, 'preflight').systemCode).toBe('EISDIR');
  // Raw access refusals are the machine's own; `admission-denied` stays the fleet's word.
  expect(failureOf(osError('EACCES'), 'credential')).toMatchObject({
    code: 'permission-denied',
    systemCode: 'EACCES',
  });
  expect(failureOf(osError('EPERM'), 'configuration').code).toBe('permission-denied');
  expect(failureOf(new EnrollmentError('admission-denied'), 'preflight')).toMatchObject({
    code: 'admission-denied',
    systemCode: null,
  });
  expect(failureOf(osError('ENOSPC'), 'artifact')).toMatchObject({ code: 'io-failed', systemCode: 'ENOSPC' });
  // Negative control: an error with no measured code claims none.
  expect(failureOf(new Error('plain'), 'preflight')).toMatchObject({ code: 'io-failed', systemCode: null });
});

test('a wait retries only what its patience names, and ends on the first final refusal', async () => {
  let attempts = 0;
  const later = await settled(async () => {
    if (++attempts < 3) throw new EnrollmentError('broker-unavailable');
    return 'observed';
  }, OWN_EFFECTS);
  expect([later, attempts]).toEqual(['observed', 3]);
  attempts = 0;
  const final = settled(async () => {
    attempts++;
    throw new EnrollmentError('declaration-invalid');
  }, OWN_EFFECTS);
  await expect(final).rejects.toMatchObject({ code: 'declaration-invalid' });
  // A read-only answer about delivered material is given at once, even for a transient code.
  const atOnce = settled(async () => {
    attempts++;
    throw new EnrollmentError('broker-unavailable');
  }, AT_ONCE);
  await expect(atOnce).rejects.toMatchObject({ code: 'broker-unavailable' });
  expect(attempts).toBe(2);
});

test('an outcome outside the contract is still answered as one refusal', () => {
  const shell: Parameters<typeof resultOf>[0] = { v: 1, requestId: null, nodeId: null, operation: 'status' };
  const ready = (version: string): Parameters<typeof resultOf>[1] => ({
    kind: 'node',
    status: 'ready',
    credentials: [],
    runtime: { version, installation: null },
    proof: null,
  });
  // The defect is this program's, not the machine's I/O, and the journal's history stays readable.
  const result = resultOf(shell, ready('x'.repeat(65)), 'verification', ['credential'], null);
  expect(refusalOf(result)).toMatchObject({ code: 'state-invalid', phase: 'verification' });
  expect(result.completed).toEqual(['credential']);
  // Positive control: the same outcome inside the contract is returned as it is.
  expect(resultOf(shell, ready('1.2.3'), 'verification', [], null).status).toBe('ready');
});

test('an operation the request cannot have is refused before any wait, record or lock', async () => {
  const stand = await enrollmentStand();
  try {
    const journal = join(`${stand.brokerConfig}.enrollment`, `${stand.admission.requestId}.json`);
    for (const operation of ['detach', 'prepare'] satisfies ('detach' | 'prepare')[]) {
      const refused = await executeEnrollment(stand.admission, operation);
      expect(refusalOf(refused)).toMatchObject({ code: 'invalid-request', phase: 'preflight' });
      expect(refused.firstFailure).toBeNull();
      expect(existsSync(journal)).toBe(false);
    }
    const { tokenSha256: _digest, ...undigested } = stand.admission;
    expect(refusalOf(await executeEnrollment(undigested, 'apply'))).toMatchObject({
      code: 'invalid-request',
      phase: 'preflight',
    });
    expect(existsSync(journal)).toBe(false);
    // The same requestId is still usable: nothing recorded an intent it never had.
    const admitted = await executeEnrollment(stand.admission, 'apply');
    expect([admitted.status, admitted.firstFailure]).toEqual(['admitted', null]);
  } finally {
    await stand.stop();
  }
}, 30_000);

test('a busy configuration is reported and is not the first failure of the request', async () => {
  const stand = await enrollmentStand();
  try {
    const busy = await withFixtureConfigLock(stand.brokerConfig, () =>
      executeEnrollment(stand.admission, 'apply'),
    );
    expect(refusalOf(busy)).toMatchObject({
      code: 'busy',
      phase: 'configuration',
      systemCode: 'LOCK_TIMEOUT',
    });
    expect(busy.firstFailure).toBeNull();
    const admitted = await executeEnrollment(stand.admission, 'apply');
    expect([admitted.status, admitted.firstFailure]).toEqual(['admitted', null]);
    // Negative control of the same field: a refusal met under the request's lock is its first
    // failure, and the success that follows still carries it.
    const repeated = { ...stand.admission, requestId: crypto.randomUUID() };
    chmodSync(stand.brokerConfig, 0o400);
    const refused = await executeEnrollment(repeated, 'apply');
    const denied = { code: 'permission-denied', phase: 'admission', systemCode: 'EACCES' };
    expect(refusalOf(refused)).toMatchObject(denied);
    expect(refused.firstFailure).toMatchObject(denied);
    chmodSync(stand.brokerConfig, 0o600);
    const resumed = await executeEnrollment(repeated, 'apply');
    expect([resumed.status, resumed.firstFailure]).toMatchObject(['admitted', denied]);
  } finally {
    await stand.stop();
  }
}, 30_000);
