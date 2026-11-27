import assert from 'node:assert/strict';
import { readdirSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { EnrollmentNodeRequestSchema } from '../../packages/contracts/src/enrollment/request.ts';
import type { EnrollmentResult } from '../../packages/contracts/src/enrollment/result.ts';
import { createWireClient } from '../../packages/local-client/src/client.ts';
import { fileDigest } from '../../packages/runtime/src/enrollment/artifact.ts';
import { command } from '../../packages/runtime/src/enrollment/native.ts';
import { checkSupervisor, ownedUnit } from '../enrollment-controls/systemd.ts';
import { refusalOf, runtimeOf } from '../enrollment-results.ts';
import { enrollmentEntry, enrollmentStand, type ProvenRequest } from '../enrollment-stand.ts';

/** One named observation of a scenario; a false one ends the scenario with its name. */
export type Check = (condition: unknown, label: string) => asserts condition;

/** What a driver gives every scenario: which runtime is under acceptance and how a check is counted. */
export type ScenarioEnv = {
  /** A built artifact; absent, the scenario runs the source entry. */
  entry?: string;
  crashRunner: string;
  /** A real, uniquely named Linux installation instead of the stand's own agent. */
  systemd: boolean;
  check: Check;
};

/**
 * A fresh fleet with one node that is not enrolled yet, and the request that will enroll it.
 * `defaultDropIns` gives the node a `node.json`, so its agent reads `services.d/` and `events.d/`.
 */
export async function enrolled(env: ScenarioEnv, options: { defaultDropIns?: boolean } = {}) {
  const workerId = `enroll-${crypto.randomUUID().slice(0, 8)}`;
  const binary = env.entry ?? enrollmentEntry;
  const stand = await enrollmentStand({ entry: binary, workerId, ...options });
  const reader = createWireClient({ socketPath: stand.observer.socket });
  const worker = createWireClient({ socketPath: stand.worker.socket });
  const request: ProvenRequest = {
    ...EnrollmentNodeRequestSchema.parse({
      ...stand.request,
      ...(env.systemd
        ? {
            supervisor: checkSupervisor(realpathSync(process.execPath), {
              source: binary,
              destination: join(stand.root, `installed-\${WIRE_ENROLL_UNSET}/bin/stitchwire`),
              sha256: fileDigest(binary),
            }),
          }
        : {}),
    }),
    proof: stand.request.proof,
  };
  const unit = env.systemd ? ownedUnit(request) : null;
  const feeds: Array<{ close(): void }> = [];
  if (env.systemd) {
    // A new installation owns its configuration from birth; the stand's prepared one is not its.
    unlinkSync(stand.worker.config);
    unlinkSync(join(stand.root, `${workerId}-fleet.json`));
  }
  return {
    stand,
    reader,
    worker,
    request,
    workerId,
    binary,
    unit,
    feeds,
    /** A call from the observer to a service of the enrolled node, or of another target. */
    invoke: (service: string, operation = 'read', to = workerId) =>
      reader.invokeService({ to, service, revision: '1', operation, payload: '{}', timeoutMs: 1000 }),
    async close() {
      for (const feed of feeds) feed.close();
      reader.close();
      worker.close();
      await unit?.remove();
      await stand.stop();
    },
  };
}
export type Enrolled = Awaited<ReturnType<typeof enrolled>>;

/**
 * The node brought to `ready` the way an orchestrator does it: prepare, admit, start, apply. The
 * bootstrap scenario checks each of these steps by name; every other scenario starts from here.
 */
export async function madeReady(context: Enrolled, env: ScenarioEnv) {
  const { stand, request } = context;
  const prepared = (await stand.cli(request, 'prepare')).result;
  assert(prepared.status === 'prepared', `prepare: ${refusalOf(prepared)?.code}`);
  const admission = { ...stand.admission, tokenSha256: prepared.credentials[0]?.sha256 };
  const admitted = (await stand.cli(admission, 'apply')).result;
  assert(admitted.status === 'admitted', `admission: ${refusalOf(admitted)?.code}`);
  if (!env.systemd) {
    await stand.startWorker();
    await stand.awaitProofRoute();
  }
  const ready = (await stand.cli(request, 'apply')).result;
  assert(ready.status === 'ready', `ready: ${refusalOf(ready)?.code} at ${refusalOf(ready)?.phase}`);
  return { admission, ready, credential: stand.config().brokers[0]?.token };
}

/** The unit that manages the node, as the ready result names it; an orchestrator knows no other name. */
export function serviceUnitOf(ready: EnrollmentResult): string {
  return runtimeOf(ready)?.installation?.service.unit ?? '';
}

export async function mainPidOf(serviceUnit: string): Promise<string> {
  return (await command('/usr/bin/systemctl', ['show', serviceUnit, '--property', 'MainPID', '--value']))
    .text;
}

/** Nothing enrollment leaves behind holds the node's token: journals, request files, unit, logs. */
export async function credentialStaysPrivate(
  context: Enrolled,
  credential: string | undefined,
  serviceUnit: string,
  env: ScenarioEnv,
): Promise<void> {
  const { stand, request, unit } = context;
  const token = credential ?? 'missing-credential';
  for (const file of readdirSync(`${request.config}.enrollment`).filter((name) => name.endsWith('.json')))
    env.check(
      !readFileSync(join(`${request.config}.enrollment`, file), 'utf8').includes(token),
      'journal contains no plaintext credential',
    );
  env.check(
    readdirSync(stand.root)
      .filter((name) => name.startsWith('request-'))
      .every((name) => !readFileSync(join(stand.root, name), 'utf8').includes(token)),
    'request files contain no plaintext credential',
  );
  if (!env.systemd) return;
  env.check(!readFileSync(unit?.file ?? '', 'utf8').includes(token), 'unit contains no plaintext credential');
  const journal = await command('/usr/bin/journalctl', ['-u', serviceUnit, '--no-pager', '-o', 'cat']);
  env.check(
    journal.code === 0 && !journal.text.includes(token),
    'supervisor logs contain no plaintext credential',
  );
}
