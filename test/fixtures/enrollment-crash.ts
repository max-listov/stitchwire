/** Disposable crash injector: production enrollment has no fault flags or hooks. */
import { readFileSync } from 'node:fs';
import { EnrollmentOperationSchema } from '../../packages/contracts/src/enrollment/request.ts';
import { RequestJournal } from '../../packages/runtime/src/enrollment/journal.ts';
import { executeEnrollment } from '../../packages/runtime/src/enrollment/operation.ts';
import { OwnersLedger } from '../../packages/runtime/src/enrollment/owners.ts';

const [file, operation, cut] = process.argv.slice(2);
if (file === undefined) throw new Error('missing fixture request');
const checkpoint = RequestJournal.prototype.checkpoint;
RequestJournal.prototype.checkpoint = function (phase) {
  if (phase === cut) process.exit(73);
  return checkpoint.call(this, phase);
};
const set = OwnersLedger.prototype.set;
OwnersLedger.prototype.set = function (owner, descriptors, attached) {
  if (cut === 'owner-before-intent') process.exit(73);
  set.call(this, owner, descriptors, attached);
  if (cut === 'owner-intent') process.exit(73);
};
const confirm = OwnersLedger.prototype.confirm;
OwnersLedger.prototype.confirm = function (owner) {
  if (cut === 'owner-config') process.exit(73);
  confirm.call(this, owner);
};
console.log(
  JSON.stringify(
    await executeEnrollment(
      JSON.parse(readFileSync(file, 'utf8')),
      EnrollmentOperationSchema.parse(operation),
    ),
  ),
);
