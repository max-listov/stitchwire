import { existsSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EnrollmentNodeRequestSchema } from '../../packages/contracts/src/enrollment/request.ts';
import { fileDigest } from '../../packages/runtime/src/enrollment/artifact.ts';
import { checkSupervisor, ownedUnit, systemdOf } from './systemd.ts';
import { runEnrollmentCrash } from '../enrollment-crash-runner.ts';
import { enrollmentStand } from '../enrollment-stand.ts';
import { credentialsOf, refusalOf } from '../enrollment-results.ts';

export async function crashControls(
  binary: string,
  runner: string,
  check: (condition: unknown, label: string) => void,
) {
  const stand = await enrollmentStand({
    entry: binary,
    workerId: `crash-${crypto.randomUUID().slice(0, 8)}`,
  });
  unlinkSync(stand.worker.config);
  unlinkSync(join(stand.root, `${stand.request.nodeId}-fleet.json`));
  const request = EnrollmentNodeRequestSchema.parse({
    ...stand.request,
    supervisor: checkSupervisor(realpathSync(process.execPath), {
      source: binary,
      destination: join(stand.root, 'installed/bin/stitchwire'),
      sha256: fileDigest(binary),
    }),
  });
  const { artifact } = systemdOf(request);
  const unit = ownedUnit(request);
  async function crash(operation: string, cut: string) {
    const file = join(stand.root, 'crash-request.json');
    stand.write(file, request);
    const result = await runEnrollmentCrash(runner, file, operation, cut);
    check(result.exitCode === 73, `abrupt child exit after ${cut}`);
  }
  try {
    check(!existsSync(request.config), 'fresh credential control starts without config');
    await crash('prepare', 'credential');
    const token = stand.config().brokers[0]?.token;
    check(token !== undefined && token !== 'worker-secret-token', 'fresh token exists before receipt');
    const prepared = (await stand.cli(request, 'prepare')).result;
    check(
      prepared.status === 'prepared' && stand.config().brokers[0]?.token === token,
      'fresh credential resumes without rotation',
    );
    const admission = { ...stand.admission, tokenSha256: credentialsOf(prepared)[0]?.sha256 };
    check((await stand.cli(admission, 'apply')).result.status === 'admitted', 'fresh crash node admitted');
    await crash('apply', 'artifact');
    check(existsSync(artifact.destination) && !existsSync(unit.file), 'real artifact installed before unit');
    await crash('apply', 'supervisor-unit');
    check(existsSync(unit.file) && !existsSync(request.agentSocket), 'unit published before agent starts');
    const result = (await stand.cli(request, 'apply')).result;
    check(
      result.status === 'ready' && result.runtime.installation?.sha256 === artifact.sha256,
      `standalone artifact resumes real installation: ${refusalOf(result)?.code ?? 'ok'}`,
    );
    check(stand.config().brokers[0]?.token === token, 'installation resume preserves fresh credential');
    check(
      !readFileSync(`${request.config}.enrollment/${request.requestId}.json`, 'utf8').includes(token ?? ''),
      'crash recovery journal contains no token',
    );
  } finally {
    await unit.remove();
    await stand.stop();
  }
}
