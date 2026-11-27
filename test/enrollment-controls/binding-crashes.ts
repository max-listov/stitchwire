import { join } from 'node:path';
import type { EnrollmentNodeRequest } from '../../packages/contracts/src/enrollment/request.ts';
import { sameTables } from '../../packages/runtime/src/fleet/projection.ts';
import { refusalOf } from '../enrollment-results.ts';
import { runEnrollmentCrash } from '../enrollment-crash-runner.ts';
import type { enrollmentStand } from '../enrollment-stand.ts';

/** Each interruption changes both tables; a receipt on an unchanged configuration proves nothing. */
export async function bindingCrashControls(
  stand: Awaited<ReturnType<typeof enrollmentStand>>,
  request: EnrollmentNodeRequest,
  runner: string,
  check: (condition: unknown, label: string) => void,
) {
  let latest = request;
  for (const [index, cut] of [
    'owner-before-intent',
    'owner-intent',
    'owner-config',
    'configuration',
    'verification',
  ].entries()) {
    const target = index % 2 === 0 ? stand.first : stand.second;
    const before = stand.config();
    latest = {
      ...request,
      requestId: crypto.randomUUID(),
      owner: { id: request.owner.id, descriptors: target.bindings },
    };
    const file = join(stand.root, 'binding-crash-request.json');
    stand.write(file, latest);
    const child = await runEnrollmentCrash(runner, file, 'apply', cut);
    check(child.exitCode === 73, `abrupt binding child exit at ${cut}`);
    const observed = stand.config();
    const afterWrite = cut !== 'owner-before-intent' && cut !== 'owner-intent';
    check(
      sameTables(
        observed.services.descriptors,
        afterWrite ? [target.declarationPath] : before.services.descriptors,
      ) &&
        sameTables(observed.events.descriptors, afterWrite ? [target.topicPath] : before.events.descriptors),
      `both config tables reflect the real write boundary at ${cut}`,
    );
    const resumed = (await stand.cli(latest, 'apply')).result;
    check(
      resumed.status === 'ready' &&
        sameTables(stand.config().services.descriptors, [target.declarationPath]) &&
        sameTables(stand.config().events.descriptors, [target.topicPath]),
      `normal artifact resumes both bindings after ${cut} (${resumed.status}/${refusalOf(resumed)?.code ?? 'ok'}@${refusalOf(resumed)?.phase ?? 'done'}/${refusalOf(resumed)?.systemCode ?? '-'})`,
    );
  }
  return latest;
}
