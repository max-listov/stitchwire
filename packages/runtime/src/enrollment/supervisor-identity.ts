import { existsSync } from 'node:fs';
import { verifySupervisedProcess } from 'stitchkit/service-host';
import type { EnrollmentNodeRequest } from '../../../contracts/src/enrollment/request.ts';
import { EnrollmentError } from './failure.ts';
import { keptSupervision, type Supervision } from './installation.ts';
import { checkUnit, mainPid, unitFile } from './systemd.ts';

/**
 * Which installation manages this node's agent, measured by the record an earlier enrollment left
 * for this config; `null` when enrollment never installed one. The live unit must own this exact
 * Unix door: another healthy agent cannot certify its launch.
 */
export async function supervisorIdentity(request: EnrollmentNodeRequest): Promise<Supervision | null> {
  const supervision = keptSupervision(request.config);
  if (supervision === null) return null;
  if (!existsSync(unitFile(supervision))) throw new EnrollmentError('runtime-conflict');
  await checkUnit(supervision);
  try {
    const pid = await mainPid(supervision);
    const observed = await verifySupervisedProcess({
      pid,
      expectedExe: supervision.bun,
      expectedArgv: [supervision.bun, supervision.destination, 'agent', '--config', request.config],
      socketPath: request.agentSocket,
    });
    if (observed.status !== 'verified')
      throw new EnrollmentError(observed.status, { cause: observed.reason });
    // The measured process still has to be the manager's current owner after inspecting its door.
    if ((await mainPid(supervision)) !== pid) throw new EnrollmentError('runtime-conflict');
    return supervision;
  } catch (cause) {
    if (cause instanceof EnrollmentError) throw cause;
    throw new EnrollmentError('runtime-conflict', { cause });
  }
}
