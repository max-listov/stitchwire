import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { EnrollmentResultSchema } from '../../packages/contracts/src/enrollment/result.ts';
import {
  type EnrollmentAdmissionRequest,
  EnrollmentNodeRequestSchema,
  EnrollmentOperationSchema,
} from '../../packages/contracts/src/enrollment/request.ts';
import { fileDigest } from '../../packages/runtime/src/enrollment/artifact.ts';
import { command } from '../../packages/runtime/src/enrollment/native.ts';
import { checkSupervisor, ownedUnit, systemdOf } from './systemd.ts';
import { withFixtureConfigLock } from '../enrollment-lock.ts';
import { createWireClient } from '../../packages/local-client/src/client.ts';
import { until } from '../support.ts';
import { enrollmentStand } from '../enrollment-stand.ts';
import { refusalOf } from '../enrollment-results.ts';

export async function externalSupervisorControl(binary: string): Promise<boolean> {
  const stand = await enrollmentStand({
    entry: binary,
    workerId: `external-${crypto.randomUUID().slice(0, 8)}`,
  });
  const destination = join(stand.root, 'second/bin/stitchwire');
  const request = EnrollmentNodeRequestSchema.parse({
    ...stand.request,
    supervisor: checkSupervisor(realpathSync(process.execPath), {
      source: binary,
      destination,
      sha256: fileDigest(binary),
    }),
  });
  const unit = ownedUnit(request);
  let child: Bun.Subprocess | undefined;
  let paused = false;
  try {
    if ((await stand.cli(stand.admission, 'apply')).result.status !== 'admitted') return false;
    child = await stand.startWorker();
    const client = createWireClient({ socketPath: stand.worker.socket });
    try {
      if (
        !(await until(async () => {
          try {
            return (await client.status()).bundle.config === 'aligned';
          } catch {
            return false;
          }
        }))
      )
        return false;
    } finally {
      client.close();
    }
    const result = (await stand.cli(request, 'apply')).result;
    const unchanged = () =>
      !existsSync(destination) &&
      !existsSync(unit.file) &&
      !existsSync(`${request.config}.enrollment`) &&
      child?.exitCode === null;
    // An agent enrollment did not install is refused while the operation still only reads.
    const refusal = refusalOf(result);
    if (refusal?.code !== 'runtime-conflict' || refusal.phase !== 'preflight' || !unchanged()) return false;
    // Hold only our child in the real listener gap. Pause under the fixture lock so a fleet
    // poll cannot leave its own lock held, then remove only this fixture's socket pathname.
    await withFixtureConfigLock(request.config, async () => {
      if (child === undefined || child.exitCode !== null) throw new Error('external fixture child stopped');
      process.kill(child.pid, 'SIGSTOP');
      paused = true;
      unlinkSync(stand.worker.socket);
    });
    for (const operation of EnrollmentOperationSchema.options) {
      const unavailable = (await stand.cli(request, operation)).result;
      if (refusalOf(unavailable)?.code !== 'runtime-conflict' || !unchanged()) return false;
    }
    return true;
  } finally {
    if (paused && child?.exitCode === null) process.kill(child.pid, 'SIGCONT');
    await unit.remove();
    await stand.stop();
  }
}

export async function permissionControl(
  binary: string,
  admission: EnrollmentAdmissionRequest,
): Promise<boolean> {
  const root = mkdtempSync('/tmp/we-unprivileged-');
  try {
    chmodSync(root, 0o755);
    const bun = join(root, 'bun');
    const artifact = join(root, 'stitchwire');
    const request = join(root, 'request.json');
    copyFileSync(realpathSync(process.execPath), bun);
    chmodSync(bun, 0o755);
    copyFileSync(binary, artifact);
    chmodSync(artifact, 0o644);
    writeFileSync(request, JSON.stringify(admission), { mode: 0o644 });
    const result = await command('/usr/sbin/runuser', [
      '-u',
      'nobody',
      '--',
      bun,
      artifact,
      'enroll',
      'plan',
      '--request',
      request,
    ]);
    const report = EnrollmentResultSchema.parse(JSON.parse(result.text));
    return (
      result.code === 2 &&
      refusalOf(report)?.code === 'permission-denied' &&
      refusalOf(report)?.systemCode === 'EACCES'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** A broken executable accepts version probes but fails the actual supervised agent launch. */
export async function supervisorControl(binary: string): Promise<boolean> {
  const stand = await enrollmentStand({
    entry: binary,
    workerId: `broken-${crypto.randomUUID().slice(0, 8)}`,
  });
  // This control owns a new installation, not a pre-existing configuration with unknown ownership.
  unlinkSync(stand.worker.config);
  unlinkSync(join(stand.root, `${stand.request.nodeId}-fleet.json`));
  const fakeBun = join(stand.root, 'bun-fails-agent');
  const realBun = realpathSync(process.execPath);
  writeFileSync(
    fakeBun,
    `#!${realBun}\nif (Bun.argv[3] === 'agent') process.exit(69);\n` +
      `const child = Bun.spawn([${JSON.stringify(realBun)}, ...Bun.argv.slice(2)], {stdin:'inherit',stdout:'inherit',stderr:'inherit'});\nprocess.exitCode = await child.exited;\n`,
    { mode: 0o700 },
  );
  const request = EnrollmentNodeRequestSchema.parse({
    ...stand.request,
    supervisor: checkSupervisor(fakeBun, {
      source: binary,
      destination: join(stand.root, 'installed/bin/stitchwire'),
      sha256: fileDigest(binary),
    }),
  });
  const unit = ownedUnit(request);
  try {
    const prepared = (await stand.cli(request, 'prepare')).result;
    if (prepared.status !== 'prepared') return false;
    const admission = { ...stand.admission, tokenSha256: prepared.credentials[0]?.sha256 };
    if ((await stand.cli(admission, 'apply')).result.status !== 'admitted') return false;
    const result = (await stand.cli(request, 'apply')).result;
    if (refusalOf(result)?.code !== 'supervisor-failed' || result.firstFailure?.code !== 'supervisor-failed')
      return false;
    copyFileSync(realBun, fakeBun);
    chmodSync(fakeBun, 0o700);
    await command('/usr/bin/systemctl', ['reset-failed', unit.name]);
    const resumed = (await stand.cli(request, 'apply')).result;
    return resumed.status === 'ready' && resumed.firstFailure?.code === 'supervisor-failed';
  } finally {
    await unit.remove();
    await stand.stop();
  }
}

/**
 * A unit enrollment did not write is never overwritten or run: one with other bytes under the
 * requested name, a drop-in for that name, or a unit of that name systemd loads from another
 * directory of its search path while ours is absent, refuses before any file of the node is created.
 */
export async function foreignUnitControl(binary: string): Promise<boolean> {
  const stand = await enrollmentStand({
    entry: binary,
    workerId: `foreign-${crypto.randomUUID().slice(0, 8)}`,
  });
  unlinkSync(stand.worker.config);
  unlinkSync(join(stand.root, `${stand.request.nodeId}-fleet.json`));
  const supervisor = checkSupervisor(realpathSync(process.execPath), {
    source: binary,
    destination: join(stand.root, 'installed/bin/stitchwire'),
    sha256: fileDigest(binary),
  });
  const request = EnrollmentNodeRequestSchema.parse({ ...stand.request, supervisor });
  // A refusal that regressed installs and starts the unit; cleanup stops what this run started.
  const unit = ownedUnit(request);
  const unitPath = join('/etc/systemd/system', supervisor.unit ?? '');
  const dropIn = `${unitPath}.d`;
  // A directory of the system manager's search path other than the one enrollment writes to.
  const vendorPath = join('/run/systemd/system', supervisor.unit ?? '');
  const foreign = '[Service]\nExecStart=/bin/true\n';
  const untouched = () =>
    !existsSync(request.config) &&
    !existsSync(`${request.config}.enrollment`) &&
    !existsSync(systemdOf(request).artifact.destination);
  try {
    writeFileSync(unitPath, foreign);
    const occupied = (await stand.cli(request, 'apply')).result;
    if (
      refusalOf(occupied)?.code !== 'runtime-conflict' ||
      refusalOf(occupied)?.phase !== 'preflight' ||
      readFileSync(unitPath, 'utf8') !== foreign ||
      !untouched()
    )
      return false;
    rmSync(unitPath);
    mkdirSync(dropIn, { recursive: true });
    writeFileSync(join(dropIn, 'override.conf'), '[Service]\nEnvironment=FOREIGN=1\n');
    await command('/usr/bin/systemctl', ['daemon-reload']);
    const shadowed = (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'apply')).result;
    if (refusalOf(shadowed)?.code !== 'runtime-conflict' || existsSync(unitPath) || !untouched())
      return false;
    rmSync(dropIn, { recursive: true });
    writeFileSync(vendorPath, foreign);
    await command('/usr/bin/systemctl', ['daemon-reload']);
    const vendor = (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'apply')).result;
    return (
      refusalOf(vendor)?.code === 'runtime-conflict' &&
      refusalOf(vendor)?.phase === 'preflight' &&
      readFileSync(vendorPath, 'utf8') === foreign &&
      !existsSync(unitPath) &&
      untouched()
    );
  } finally {
    await unit.remove();
    rmSync(unitPath, { force: true });
    rmSync(dropIn, { recursive: true, force: true });
    rmSync(vendorPath, { force: true });
    await command('/usr/bin/systemctl', ['daemon-reload']);
    await stand.stop();
  }
}
