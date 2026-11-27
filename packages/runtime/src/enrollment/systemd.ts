import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { readRegularFileSync } from 'stitchkit/files';
import { createDefaultSystemdHostAdapter, systemdMainPid, systemdUnitActive } from 'stitchkit/service-host';
import { sha256 } from '../config/io.ts';
import { EnrollmentError } from './failure.ts';
import { writeOnce } from './files.ts';
import type { Installation, Supervision } from './installation.ts';
import { command } from './native.ts';

const MAX_UNIT_BYTES = 64 * 1024;

type Unit = Pick<Supervision, 'scope' | 'unit'>;

export function unitFile(unit: Unit): string {
  return unit.scope === 'system'
    ? join('/etc/systemd/system', unit.unit)
    : join(homedir(), '.config/systemd/user', unit.unit);
}

/** `systemctl` in the manager that owns the unit: the system one, or the calling user's. */
export function systemctl(unit: Pick<Supervision, 'scope'>, args: string[]) {
  return command('/usr/bin/systemctl', [...(unit.scope === 'user' ? ['--user'] : []), ...args]);
}

function properties(text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) found.set(line.slice(0, index), line.slice(index + 1));
  }
  return found;
}

/** Drop-ins every service of the manager loads (`service.d/`) are the host's, not a takeover. */
function foreignDropIns(paths: string): boolean {
  return paths
    .split(' ')
    .filter(Boolean)
    .some((path) => basename(dirname(path)) !== 'service.d');
}

/**
 * The unit file must be the one enrollment wrote, or absent, and systemd must load this name from
 * nowhere else: a vendor unit, a mask or a drop-in for this name would run something enrollment
 * never wrote. The comparison is with the digest recorded when the unit was written, so a release
 * that renders units differently still recognises an installation made by an earlier one.
 */
export async function checkUnit(supervision: Supervision): Promise<void> {
  const path = unitFile(supervision);
  if (
    existsSync(path) &&
    sha256(readRegularFileSync(path, { limit: MAX_UNIT_BYTES })) !== supervision.unitSha256
  )
    throw new EnrollmentError('runtime-conflict');
  const shown = await systemctl(supervision, [
    'show',
    supervision.unit,
    '--property=LoadState,FragmentPath,DropInPaths',
  ]);
  if (shown.code !== 0) throw new EnrollmentError('supervisor-failed');
  const unit = properties(shown.text);
  if (foreignDropIns(unit.get('DropInPaths') ?? '')) throw new EnrollmentError('runtime-conflict');
  if (unit.get('LoadState') === 'not-found') {
    // systemd lists no drop-ins for a unit it cannot find; its search path still holds them.
    const manager = await systemctl(supervision, ['show', '--property=UnitPath']);
    const directories = (properties(manager.text).get('UnitPath') ?? '').split(' ').filter(Boolean);
    if (manager.code !== 0 || directories.length === 0) throw new EnrollmentError('supervisor-failed');
    if (directories.some((directory) => existsSync(join(directory, `${supervision.unit}.d`))))
      throw new EnrollmentError('runtime-conflict');
    return;
  }
  if (unit.get('LoadState') !== 'loaded' || unit.get('FragmentPath') !== path)
    throw new EnrollmentError('runtime-conflict');
}

export function publishUnit(installation: Installation): void {
  const path = unitFile(installation.supervision);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    writeOnce(path, Buffer.from(installation.unitText), 0o600, MAX_UNIT_BYTES);
  } catch (cause) {
    throw new EnrollmentError('runtime-conflict', { cause });
  }
}

export async function startUnit(supervision: Supervision): Promise<void> {
  try {
    await checkUnit(supervision);
    for (const step of [['daemon-reload'], ['enable', supervision.unit], ['start', supervision.unit]])
      if ((await systemctl(supervision, step)).code !== 0) throw new EnrollmentError('supervisor-failed');
    if (!(await unitActive(supervision))) throw new EnrollmentError('supervisor-failed');
  } catch (cause) {
    if (cause instanceof EnrollmentError) throw cause;
    throw new EnrollmentError('supervisor-failed', { cause });
  }
}

/** Run queries in the same declared environment as enrollment's other manager commands. */
const adapter = {
  ...createDefaultSystemdHostAdapter(),
  async runCommand(executable: string, args: readonly string[]) {
    const result = await command(executable, [...args]);
    if (result.code === null) throw new EnrollmentError('supervisor-failed');
    return { exitCode: result.code, stdout: result.text, stderr: '' };
  },
};

export function unitActive(unit: Unit): Promise<boolean> {
  return systemdUnitActive({ unitName: unit.unit, scope: unit.scope, adapter });
}

export async function mainPid(unit: Unit): Promise<number> {
  const pid = await systemdMainPid({ unitName: unit.unit, scope: unit.scope, adapter });
  if (pid === null) throw new EnrollmentError('supervisor-failed');
  return pid;
}
