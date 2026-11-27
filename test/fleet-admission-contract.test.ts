import { expect, test } from 'bun:test';
import {
  FleetAdmissionNodeRequestSchema,
  FleetAdmissionRequestSchema,
  FleetAdmissionResultSchema,
} from '../packages/contracts/src/enrollment/fleet-admission.ts';
import { EnrollmentNodeRequestSchema } from '../packages/contracts/src/enrollment/request.ts';
import { admissionRequestExample, admissionResultExample } from './fleet-admission-examples.ts';

test('the operator entry contract accepts its documented request and result shapes', () => {
  expect(FleetAdmissionRequestSchema.safeParse(admissionRequestExample).success).toBe(true);
  const { credentials: _digests, ...first } = admissionRequestExample;
  expect(FleetAdmissionRequestSchema.safeParse(first).success).toBe(true);
  const result = FleetAdmissionResultSchema.safeParse(admissionResultExample);
  expect(result.success ? 'ok' : JSON.stringify(result.error.issues.slice(0, 3))).toBe('ok');
});

test("the operator's half and the orchestrator's half make one valid node request", () => {
  const result = FleetAdmissionResultSchema.parse(admissionResultExample);
  if (result.status === 'failed' || result.node === null) throw new Error('example has a node half');
  const { node } = result;
  const request = {
    v: 1,
    kind: 'node',
    requestId: crypto.randomUUID(),
    ...node.request,
    material: '/var/lib/orchestrator/material.json',
    supervisor: {
      ...node.request.supervisor,
      artifact: { ...node.request.supervisor.artifact, source: '/var/lib/orchestrator/stitchwire' },
    },
    owner: { id: 'example', descriptors: [] },
  };
  expect(EnrollmentNodeRequestSchema.safeParse(request).success).toBe(true);
  // A fragment the node would refuse is refused by the operator contract already.
  const twice = {
    ...node.request,
    brokers: [...node.request.brokers, { ...node.request.brokers[0], id: 'other' }],
  };
  expect(FleetAdmissionNodeRequestSchema.safeParse(twice).success).toBe(false);
});

test('the operator entry contract refuses other versions, extra fields, duplicates and tokens', () => {
  const refused = [
    { ...admissionRequestExample, v: 2 },
    { ...admissionRequestExample, extra: true },
    { ...admissionRequestExample, target: 'host; rm -rf /' },
    {
      ...admissionRequestExample,
      grants: { ...admissionRequestExample.grants, services: ['example.', 'example.'] },
    },
    { ...admissionRequestExample, credentials: [{ broker: 'primary', token: 'secret' }] },
    {
      ...admissionRequestExample,
      credentials: [admissionRequestExample.credentials[0], admissionRequestExample.credentials[0]],
    },
  ];
  for (const value of refused) expect(FleetAdmissionRequestSchema.safeParse(value).success).toBe(false);
  expect(FleetAdmissionResultSchema.safeParse({ ...admissionResultExample, v: 2 }).success).toBe(false);
});

test('a withdrawal is an operation of the same contract with its own final status and refusal', () => {
  const withdrawn = {
    ...admissionResultExample,
    operation: 'withdraw',
    status: 'withdrawn',
    phase: null,
    waiting: [],
    completed: ['membership', 'admission', 'inventory'],
    node: null,
  };
  expect(FleetAdmissionResultSchema.safeParse(withdrawn).success).toBe(true);
  const refused = {
    v: 1,
    requestId: admissionRequestExample.requestId,
    nodeId: admissionRequestExample.nodeId,
    operation: 'withdraw',
    observedAt: admissionResultExample.observedAt,
    completed: [],
    firstFailure: null,
    unrecorded: [],
    status: 'failed',
    failure: { code: 'node-active', phase: 'preflight', broker: null, at: admissionResultExample.observedAt },
  };
  expect(FleetAdmissionResultSchema.safeParse(refused).success).toBe(true);
  // Negative controls: an operation and a status the contract does not have are refused.
  expect(FleetAdmissionResultSchema.safeParse({ ...withdrawn, operation: 'remove' }).success).toBe(false);
  expect(FleetAdmissionResultSchema.safeParse({ ...withdrawn, status: 'removed' }).success).toBe(false);
});
