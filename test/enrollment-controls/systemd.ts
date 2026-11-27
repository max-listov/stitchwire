import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import type {
  EnrollmentArtifact,
  EnrollmentNodeRequest,
  EnrollmentSystemdSupervisor,
} from '../../packages/contracts/src/enrollment/request.ts';
import {
  requestedInstallation,
  type Supervision,
} from '../../packages/runtime/src/enrollment/installation.ts';
import { systemctl, unitFile } from '../../packages/runtime/src/enrollment/systemd.ts';

/**
 * Systemd acceptance runs next to whatever the host already supervises — on a fleet node, the live
 * `stitchwire-agent.service`. Every installation a check makes therefore has its own unit name, and
 * cleanup removes a unit only when this run created it.
 */
export function checkSupervisor(bun: string, artifact: EnrollmentArtifact): EnrollmentSystemdSupervisor {
  return {
    kind: 'systemd',
    scope: 'system',
    bun,
    unit: `stitchwire-check-${crypto.randomUUID().slice(0, 8)}.service`,
    artifact,
  };
}

export function systemdOf(request: EnrollmentNodeRequest): EnrollmentSystemdSupervisor {
  if (request.supervisor.kind !== 'systemd') throw new Error('a systemd check needs a systemd request');
  return request.supervisor;
}

export function supervisionOf(request: EnrollmentNodeRequest): Supervision {
  const installation = requestedInstallation(request);
  if (installation === null) throw new Error('a systemd check needs a systemd request');
  return installation.supervision;
}

/** The unit this run may remove: absent before it, and the file it leaves is the one enrollment wrote. */
export function ownedUnit(request: EnrollmentNodeRequest) {
  const supervision = supervisionOf(request);
  const file = unitFile(supervision);
  const before = existsSync(file) ? readFileSync(file) : null;
  return {
    name: supervision.unit,
    file,
    async remove(): Promise<void> {
      if (before !== null || !existsSync(file)) return;
      await systemctl(supervision, ['disable', '--now', supervision.unit]);
      unlinkSync(file);
      await systemctl(supervision, ['daemon-reload']);
      await systemctl(supervision, ['reset-failed', supervision.unit]);
    },
  };
}
