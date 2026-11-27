import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import {
  type EnrollmentArtifact,
  type EnrollmentNodeRequest,
  EnrollmentPathSchema,
  EnrollmentUnitSchema,
} from '../../../contracts/src/enrollment/request.ts';
import { Sha256Schema } from '../../../contracts/src/protocol/paths.ts';
import { sha256 } from '../config/io.ts';
import { EnrollmentError } from './failure.ts';
import { ENROLLMENT_REQUEST_BYTES, readValue, writePrivate } from './files.ts';
import { enrollmentRoot } from './journal.ts';
import { AGENT_UNIT, renderUnit } from './unit.ts';

/** The installation enrollment made for one configuration: its reservation and later its evidence. */
const InstallationRecordSchema = z.strictObject({
  v: z.literal(1),
  bun: EnrollmentPathSchema,
  scope: z.enum(['system', 'user']),
  unit: EnrollmentUnitSchema,
  /** The unit file as enrollment wrote it: a later release may render units differently. */
  unitSha256: Sha256Schema,
  destination: EnrollmentPathSchema,
  sha256: Sha256Schema,
});

/** Which unit runs which Bun and runtime file, in which scope. */
export type Supervision = Omit<z.infer<typeof InstallationRecordSchema>, 'v' | 'sha256'>;

/** A supervised installation a request asks for, resolved once: every later step reads these facts. */
export type Installation = {
  supervision: Supervision;
  artifact: EnrollmentArtifact;
  unitText: string;
};

function recordFile(config: string): string {
  return join(enrollmentRoot(config), 'runtime.json');
}

/** Null for an existing agent: enrollment installs nothing and supervises nothing for it. */
export function requestedInstallation(request: EnrollmentNodeRequest): Installation | null {
  const { supervisor } = request;
  if (supervisor.kind === 'existing') return null;
  let bun: string;
  try {
    bun = realpathSync(supervisor.bun);
  } catch (cause) {
    // No Bun where the request says is a Bun that does not meet the request.
    throw new EnrollmentError('version-mismatch', { cause });
  }
  const { artifact, scope } = supervisor;
  const unitText = renderUnit({
    role: 'agent',
    scope,
    bun,
    runtime: artifact.destination,
    config: request.config,
    configDir: dirname(request.config),
    stateDir: dirname(request.agentSocket),
  });
  return {
    supervision: {
      bun,
      scope,
      unit: supervisor.unit ?? AGENT_UNIT,
      unitSha256: sha256(unitText),
      destination: artifact.destination,
    },
    artifact,
    unitText,
  };
}

/** The supervision enrollment once installed for this config, whatever the current request asks. */
export function keptSupervision(config: string): Supervision | null {
  const file = recordFile(config);
  if (!existsSync(file)) return null;
  const {
    v: _version,
    sha256: _installed,
    ...supervision
  } = readValue(file, InstallationRecordSchema, ENROLLMENT_REQUEST_BYTES);
  return supervision;
}

/**
 * One node has one supervisor: a second owner cannot install another service on its socket. A
 * record that differs from the request is a conflict; `reserved` says whether this exact
 * installation holds the configuration.
 */
export function installationReserved(config: string, installation: Installation): boolean {
  const file = recordFile(config);
  if (!existsSync(file)) return false;
  // Both sides in the schema's own key order: the comparison is of values, never of spellings.
  const wanted = InstallationRecordSchema.parse({
    v: 1,
    ...installation.supervision,
    sha256: installation.artifact.sha256,
  });
  if (
    JSON.stringify(readValue(file, InstallationRecordSchema, ENROLLMENT_REQUEST_BYTES)) !==
    JSON.stringify(wanted)
  )
    throw new EnrollmentError('runtime-conflict');
  return true;
}

/** Reserve the installation before the configuration it will run is born. */
export function reserveInstallation(config: string, installation: Installation): void {
  if (installationReserved(config, installation)) return;
  writePrivate(
    recordFile(config),
    InstallationRecordSchema.parse({
      v: 1,
      ...installation.supervision,
      sha256: installation.artifact.sha256,
    }),
  );
}
