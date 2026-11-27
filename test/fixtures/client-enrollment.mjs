import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EnrollmentAdmissionRequestSchema,
  EnrollmentCodeSchema,
  EnrollmentNodeRequestSchema,
  EnrollmentOperationSchema,
  EnrollmentPhaseSchema,
  EnrollmentRequestSchema,
  EnrollmentResultSchema,
  FleetAdmissionRequestSchema,
  FleetAdmissionResultSchema,
} from '@stitchwire/client/enrollment';
import * as main from '@stitchwire/client';

/*
 * An orchestrator that knows the enrollment contract only through the packed SDK.
 *   build <stand.json> <dir>  writes requests built by the exported schemas
 *   parse <stand.json> <dir>  reads the real CLI's results with the exported schemas
 */
const runtime = process.versions.bun ? 'bun' : 'node';
const [mode, standFile, dir] = process.argv.slice(2);
const stand = JSON.parse(readFileSync(standFile, 'utf8'));
const file = (name) => join(dir, `${runtime}-${name}.json`);

assert.equal(main.EnrollmentNodeRequestSchema, undefined, 'the main entry carries no enrollment contract');
assert.deepEqual(EnrollmentOperationSchema.options, ['plan', 'prepare', 'apply', 'status', 'detach']);
assert.ok(EnrollmentPhaseSchema.options.includes('verification'));
assert.ok(EnrollmentCodeSchema.options.includes('material-required'));

if (mode === 'build') {
  const admission = EnrollmentAdmissionRequestSchema.parse({
    ...stand.admission,
    requestId: crypto.randomUUID(),
  });
  const node = EnrollmentNodeRequestSchema.parse({ ...stand.node, requestId: crypto.randomUUID() });
  writeFileSync(file('admission'), JSON.stringify(admission));
  writeFileSync(file('node'), JSON.stringify(node));
  // The exported schema refuses exactly what the CLI refuses.
  const other = { ...admission, v: 2 };
  const extra = { ...admission, unexpected: true };
  assert.equal(EnrollmentRequestSchema.safeParse(other).success, false);
  assert.equal(EnrollmentRequestSchema.safeParse(extra).success, false);
  writeFileSync(file('other-version'), JSON.stringify(other));
  writeFileSync(file('extra-field'), JSON.stringify(extra));
  // The operator entry contract is part of the same export.
  assert.equal(FleetAdmissionRequestSchema.safeParse(stand.operator.request).success, true);
  assert.equal(FleetAdmissionResultSchema.safeParse(stand.operator.result).success, true);
  assert.equal(FleetAdmissionRequestSchema.safeParse({ ...stand.operator.request, v: 2 }).success, false);
  console.log(`${runtime}: enrollment requests built by the packed contract`);
} else if (mode === 'parse') {
  const read = (name) =>
    EnrollmentResultSchema.parse(JSON.parse(readFileSync(file(`${name}-result`), 'utf8')));
  const admission = read('admission');
  assert.equal(admission.status, 'planned');
  assert.equal(admission.material?.bundle.full, null);
  const node = read('node');
  assert.equal(node.status, 'failed');
  assert.equal(node.failure?.code, 'broker-unavailable');
  for (const name of ['other-version', 'extra-field']) {
    const refused = read(name);
    assert.equal(refused.failure?.code, 'invalid-request');
  }
  console.log(`${runtime}: real CLI results parsed by the packed contract`);
} else throw new Error('usage: client-enrollment.mjs <build|parse> <stand.json> <dir>');
