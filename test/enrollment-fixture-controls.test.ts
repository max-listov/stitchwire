import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EnrollmentResult } from '../packages/contracts/src/enrollment/result.ts';
import { EnrollmentResultSchema } from '../packages/contracts/src/enrollment/result.ts';
import { createWireClient } from '../packages/local-client/src/client.ts';
import { executeEnrollment } from '../packages/runtime/src/enrollment/operation.ts';
import { runEnrollmentCrash } from './enrollment-crash-runner.ts';
import { pastBusy, withFixtureConfigLock } from './enrollment-lock.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import { PROCESS_START_CEILING_MS, until } from './support.ts';
import { refusalOf } from './enrollment-results.ts';
import { SCENARIO_CEILING_MS } from './enrollment-scenarios/registry.ts';

test(
  'fixture busy is bounded before a real crash cut; only real drift under a held lock is a conflict',
  async () => {
    const stand = await enrollmentStand(),
      runner = join(import.meta.dir, 'fixtures/enrollment-crash.ts');
    const client = createWireClient({ socketPath: stand.worker.socket });
    async function settled(run: () => Promise<EnrollmentResult>) {
      const result = await pastBusy(run, (answer) => answer);
      expect(refusalOf(result)?.code).not.toBe('busy');
      return result;
    }
    try {
      expect((await settled(() => executeEnrollment(stand.admission, 'apply'))).status).toBe('admitted');
      const worker = await stand.startWorker();
      await stand.awaitProofRoute();
      const attached = await settled(() => executeEnrollment(stand.request, 'apply'));
      expect(attached.status, JSON.stringify(refusalOf(attached))).toBe('ready');
      const before = readFileSync(stand.request.config);
      const update = {
        ...stand.request,
        requestId: crypto.randomUUID(),
        owner: { id: 'first', descriptors: stand.second.bindings },
      };
      const file = join(stand.root, 'controlled-crash.json');
      stand.write(file, update);
      await withFixtureConfigLock(update.config, async () => {
        const child = await runEnrollmentCrash(runner, file, 'apply', 'owner-intent', 250);
        expect(child.exitCode).toBe(0);
        const result = EnrollmentResultSchema.parse(JSON.parse(new TextDecoder().decode(child.stdout)));
        expect(refusalOf(result)).toMatchObject({
          code: 'busy',
          phase: 'configuration',
          systemCode: 'LOCK_TIMEOUT',
        });
        expect(readFileSync(update.config)).toEqual(before);
      });
      const retry = { ...update, requestId: crypto.randomUUID() };
      stand.write(file, retry);
      let pending: ReturnType<typeof runEnrollmentCrash> | undefined;
      try {
        await withFixtureConfigLock(retry.config, async () => {
          pending = runEnrollmentCrash(runner, file, 'apply', 'owner-intent');
          // An apply records its intent as the last thing before it tries the configuration lock:
          // a journal that names the intent is the child standing at the lock this test holds.
          const journal = join(`${retry.config}.enrollment`, `${retry.requestId}.json`);
          const intended = () =>
            existsSync(journal) && JSON.parse(readFileSync(journal, 'utf8')).intent === 'attach';
          expect(await until(intended, PROCESS_START_CEILING_MS)).toBe(true);
        });
      } finally {
        if (pending) expect((await pending).exitCode).toBe(73);
      }
      expect(readFileSync(retry.config)).toEqual(before);
      const detach = {
        ...stand.request,
        requestId: crypto.randomUUID(),
        owner: { id: 'first', descriptors: [] },
      };
      stand.write(file, detach);
      expect((await runEnrollmentCrash(runner, file, 'detach', 'owner-intent')).exitCode).toBe(73);
      await withFixtureConfigLock(detach.config, async () => {
        // A held lock alone does not turn an aligned node into a drifted one: its reconciler has
        // nothing to write and takes no lock. The verdict is read after reconciliations that ran
        // while this test held the lock, never before the agent had a chance to meet it.
        for (let reading = 0; reading < 2; reading++) {
          const last = (await client.status()).bundle.checkedAt;
          expect(await until(async () => (await client.status()).bundle.checkedAt !== last)).toBe(true);
          expect((await client.status()).bundle.config).toBe('aligned');
        }
        // Real drift under the held lock cannot be repaired. The node says so, and for as long as the
        // contention lasts every reading is the conflict, never the refusal this control intends.
        const config = JSON.parse(before.toString());
        stand.write(detach.config, {
          ...config,
          services: { ...config.services, namespaces: [], grants: [] },
        });
        // The agent reloads the file it watches; once the reloaded agent reports the drift it cannot
        // repair, the conflict is what every further reading says.
        const conflict = async () => {
          const refusal = refusalOf(await executeEnrollment(detach, 'status'));
          return refusal?.code === 'bundle-conflict' && refusal.phase === 'verification';
        };
        expect(await until(conflict, 15_000)).toBe(true);
        for (let reading = 0; reading < 3; reading++)
          expect(refusalOf(await executeEnrollment(detach, 'status'))).toMatchObject({
            code: 'bundle-conflict',
            phase: 'verification',
          });
        writeFileSync(detach.config, before, { mode: 0o600 });
      });
      let result = await executeEnrollment(detach, 'status');
      expect(
        await until(async () => {
          result = await executeEnrollment(detach, 'status');
          return (
            refusalOf(result)?.code === 'declaration-refused' && refusalOf(result)?.phase === 'verification'
          );
        }),
      ).toBe(true);
      expect(refusalOf(result)).toMatchObject({ code: 'declaration-refused', phase: 'verification' });
      expect((await client.status()).bundle.config).toBe('aligned');
      expect(readFileSync(detach.config)).toEqual(before);
      expect(worker.exitCode).toBeNull();
    } finally {
      client.close();
      await stand.stop();
    }
  },
  SCENARIO_CEILING_MS,
);

test('only the exact busy refusal of the configuration lock is asked again, up to one ceiling', async () => {
  const asked = {
    v: 1,
    requestId: null,
    nodeId: null,
    operation: 'apply',
    observedAt: new Date().toISOString(),
  };
  const failed = (code: 'busy' | 'io-failed', systemCode: string | null) =>
    EnrollmentResultSchema.parse({
      ...asked,
      status: 'failed',
      failure: { code, phase: 'configuration', at: asked.observedAt, systemCode },
      completed: [],
      firstFailure: null,
    });
  const answered = EnrollmentResultSchema.parse({
    ...asked,
    kind: 'node',
    status: 'planned',
    credentials: [],
    completed: [],
    firstFailure: null,
  });
  const answers = (list: EnrollmentResult[]) => {
    let asks = 0;
    const ask = async () => list[Math.min(asks++, list.length - 1)] ?? answered;
    return { ask, count: () => asks };
  };
  const busy = failed('busy', 'LOCK_TIMEOUT');
  const twice = answers([busy, busy, answered]);
  expect((await pastBusy(twice.ask, (answer) => answer)).status).toBe('planned');
  expect(twice.count()).toBe(3);
  // Negative controls: another refusal, or `busy` that is not the lock's, is the answer at once…
  for (const other of [failed('io-failed', 'ENOSPC'), failed('busy', null)]) {
    const once = answers([other, answered]);
    expect(await pastBusy(once.ask, (answer) => answer)).toBe(other);
    expect(once.count()).toBe(1);
  }
  // …and a lock that stays held past the ceiling is reported as busy, never waited out forever.
  const held = answers([busy]);
  expect(await pastBusy(held.ask, (answer) => answer, 60)).toBe(busy);
  expect(held.count()).toBeGreaterThan(1);
});
