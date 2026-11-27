import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ServiceBindingSchema } from '../packages/contracts/src/service/policy-schema.ts';
import { EnrollmentError, failureOf } from '../packages/runtime/src/enrollment/failure.ts';
import { ENROLLMENT_REQUEST_BYTES, readValue } from '../packages/runtime/src/enrollment/files.ts';
import { enrollmentRoot } from '../packages/runtime/src/enrollment/journal.ts';
import { executeEnrollment } from '../packages/runtime/src/enrollment/operation.ts';
import { ServiceDescriptorStore } from '../packages/runtime/src/service/descriptor-store.ts';
import { refusalOf } from './enrollment-results.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import { catalogDescriptor, catalogOperation } from './service-stand.ts';

/**
 * Bytes that are not the record are the record's defect, never the disk's. A damaged enrollment
 * record is `state-invalid` and a damaged descriptor is `invalid`, whether the bytes are not JSON or
 * JSON of another shape: an operator told `io-failed` or `unavailable` repairs the wrong thing.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-damaged-record-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const RecordSchema = z.strictObject({ v: z.literal(1) });
const refusalCode = (read: () => unknown) => {
  try {
    read();
  } catch (error) {
    return { thrown: error instanceof EnrollmentError, code: failureOf(error, 'preflight').code };
  }
  throw new Error('the damaged record was read as a value');
};

test('an enrollment record that is not JSON, or JSON of another shape, is state-invalid', () => {
  const path = join(root, 'record.json');
  for (const damaged of ['{ "v": 1', '{"v":2}', '[]']) {
    writeFileSync(path, damaged);
    expect({
      damaged,
      ...refusalCode(() => readValue(path, RecordSchema, ENROLLMENT_REQUEST_BYTES)),
    }).toEqual({
      damaged,
      thrown: true,
      code: 'state-invalid',
    });
  }
  // Positive control: the same reader returns the record its schema accepts.
  writeFileSync(path, '{"v":1}');
  expect(readValue(path, RecordSchema, ENROLLMENT_REQUEST_BYTES)).toEqual({ v: 1 });
  // Negative control: an operating-system refusal keeps its own code, it is not a damaged record.
  expect(
    refusalCode(() => readValue(join(root, 'absent.json'), RecordSchema, ENROLLMENT_REQUEST_BYTES)),
  ).toEqual({
    thrown: false,
    code: 'io-failed',
  });
});

test('a damaged journal refuses the operation as state-invalid, and a whole one is read again', async () => {
  const stand = await enrollmentStand();
  try {
    const directory = enrollmentRoot(stand.brokerConfig);
    const journal = join(directory, `${stand.admission.requestId}.json`);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const damaged of ['{ "v": 1, "fingerprint"', '{"v":1,"fingerprint":"not a digest"}']) {
      writeFileSync(journal, damaged, { mode: 0o600 });
      const refused = await executeEnrollment(stand.admission, 'apply');
      expect({ damaged, refusal: refusalOf(refused)?.code }).toEqual({ damaged, refusal: 'state-invalid' });
    }
    // Positive control: without the damaged record the same request is admitted.
    rmSync(journal);
    const admitted = await executeEnrollment(stand.admission, 'apply');
    expect([admitted.status, refusalOf(admitted)]).toEqual(['admitted', null]);
  } finally {
    await stand.stop();
  }
}, 30_000);

test('a descriptor that is not JSON is invalid with the parser cause, and an absent one unavailable', async () => {
  const store = new ServiceDescriptorStore();
  const bindingFor = (descriptorPath: string) =>
    ServiceBindingSchema.parse({
      service: 'owner.catalog',
      descriptorPath,
      socketPath: '/run/owner/owner.sock',
      endpointPath: '/invoke',
      maxInflight: 1,
      limits: { requestBytes: 1024, responseBytes: 1024, timeoutMs: 1000 },
    });
  const path = join(root, 'descriptor.json');
  writeFileSync(path, '{ "service": "owner.catalog", ');
  const broken = await store.load(bindingFor(path));
  expect(broken.state).toBe('invalid');
  if (broken.state === 'loaded') throw new Error('a descriptor that is not JSON was loaded');
  expect(broken.detail).toContain('SyntaxError');
  writeFileSync(path, '{"service":"owner.catalog"}');
  expect((await store.load(bindingFor(path))).state).toBe('invalid');
  // Positive control: the same path with a whole descriptor loads.
  writeFileSync(path, JSON.stringify(catalogDescriptor([catalogOperation('peek', '/catalog/peek', 'read')])));
  expect((await store.load(bindingFor(path))).state).toBe('loaded');
  // Negative control: a path with nothing there is the disk's answer, not a damaged descriptor.
  expect((await store.load(bindingFor(join(root, 'absent-descriptor.json')))).state).toBe('unavailable');
});
