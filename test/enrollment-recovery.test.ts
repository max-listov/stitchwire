import { expect, test } from 'bun:test';
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import type { EnrollmentRequest } from '../packages/contracts/src/enrollment/request.ts';
import { executeEnrollment } from '../packages/runtime/src/enrollment/operation.ts';
import { RequestJournal } from '../packages/runtime/src/enrollment/journal.ts';
import { applyConfigFile } from '../packages/runtime/src/fleet/copy.ts';
import { runEnrollmentCrash } from './enrollment-crash-runner.ts';
import { pastBusy, withFixtureConfigLock } from './enrollment-lock.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import { brokerHealth, until } from './support.ts';
import { refusalOf } from './enrollment-results.ts';
import { SCENARIO_CEILING_MS } from './enrollment-scenarios/registry.ts';

test(
  'crash boundaries recover by reading effects and preserve credentials and the first refusal',
  async () => {
    const stand = await enrollmentStand();
    async function crash(request: EnrollmentRequest, operation: string, cut: string) {
      const file = join(stand.root, 'crash-request.json');
      stand.write(file, request);
      const child = await runEnrollmentCrash(
        resolve(import.meta.dir, 'fixtures/enrollment-crash.ts'),
        file,
        operation,
        cut,
      );
      expect(child.exitCode).toBe(73);
    }
    // A resume right after a killed writer asks again on the exact busy of the configuration lock,
    // as an orchestrator does: the dead writer's lock is taken over by the next caller that finds it.
    const resume = (request: EnrollmentRequest, operation: 'prepare' | 'apply' | 'detach') =>
      pastBusy(
        () => executeEnrollment(request, operation),
        (answer) => answer,
      );
    try {
      await crash(stand.request, 'prepare', 'credential');
      expect((await resume(stand.request, 'prepare')).status).toBe('prepared');
      expect(stand.config().brokers[0]?.token).toBe('worker-secret-token');
      const horizon = async () => {
        try {
          return (await brokerHealth(Number(new URL(stand.url).port))).observingSince;
        } catch {
          return null;
        }
      };
      const before = await horizon();
      await crash(stand.admission, 'apply', 'admission');
      // The killed writer had already admitted the digest, so the broker reloads its roster; the resume
      // is measured against the reloaded broker, not against how long a loaded machine takes to restart it.
      expect(
        await until(async () => {
          const now = await horizon();
          return now !== null && now !== before;
        }, 60_000),
      ).toBe(true);
      const resumed = await resume(stand.admission, 'apply');
      expect([resumed.status, refusalOf(resumed)]).toEqual(['admitted', null]);
      await stand.startWorker();
      // Every write boundary of a binding change is a scenario of the registry; here the owner attaches.
      expect((await executeEnrollment(stand.request, 'apply')).status).toBe('ready');
      const request = { ...stand.request, requestId: crypto.randomUUID() };
      RequestJournal.open(request).fail({
        code: 'supervisor-failed',
        phase: 'supervisor',
        at: new Date().toISOString(),
        systemCode: null,
      });
      expect((await executeEnrollment(request, 'apply')).firstFailure?.code).toBe('supervisor-failed');
      expect(
        refusalOf(
          await executeEnrollment({ ...request, owner: { ...request.owner, id: 'changed' } }, 'apply'),
        )?.code,
      ).toBe('request-conflict');
      const update = {
        ...stand.request,
        requestId: crypto.randomUUID(),
        owner: { id: 'first', descriptors: stand.second.bindings },
      };
      await crash(update, 'apply', 'owner-intent');
      const detach = {
        ...stand.request,
        requestId: crypto.randomUUID(),
        owner: { id: 'first', descriptors: [] },
      };
      await crash(detach, 'detach', 'owner-intent');
      expect(stand.config().services.descriptors).toEqual([stand.first.declarationPath]);
      expect(stand.config().events.descriptors).toEqual([stand.first.topicPath]);
      // A read-only status is one observation. Wait for the declaration verdict after a fleet
      // poll that encountered our crashed writer's lock has reconciled; persistent drift fails.
      let observed = await executeEnrollment(detach, 'status');
      await until(async () => {
        if (refusalOf(observed)?.code === 'bundle-conflict' && refusalOf(observed)?.phase === 'verification')
          observed = await executeEnrollment(detach, 'status');
        return (
          refusalOf(observed)?.code !== 'bundle-conflict' || refusalOf(observed)?.phase !== 'verification'
        );
      }, 5000);
      expect(refusalOf(observed)).toMatchObject({ code: 'declaration-refused', phase: 'verification' });
      await crash(detach, 'detach', 'owner-config');
      expect((await resume(detach, 'detach')).status).toBe('detached');
      expect(stand.config().services.descriptors).toEqual([]);
      expect(stand.config().events.descriptors).toEqual([]);
      expect(stand.config().brokers[0]?.token).toBe('worker-secret-token');
    } finally {
      await stand.stop();
    }
  },
  SCENARIO_CEILING_MS,
);

test('a live config lock excludes fleet projection and the next projection reads current owner fields', async () => {
  // File transaction mechanics have no running reconciler; real contention is covered by the CLI stand.
  const root = realpathSync(mkdtempSync('/tmp/wire-config-lock-'));
  const configFile = join(root, 'broker.json');
  writeFileSync(configFile, JSON.stringify({ capabilities: {} }), { mode: 0o600 });
  try {
    const project = (config: Record<string, unknown>) => ({ ...config, capabilities: { reader: [] } });
    const apply = () =>
      applyConfigFile(configFile, {
        project,
        tablesOf: (config) => config.capabilities,
        same: (left, right) => JSON.stringify(left) === JSON.stringify(right),
        validate: () => null,
      });
    await withFixtureConfigLock(configFile, async () => {
      const value = JSON.parse(readFileSync(configFile, 'utf8'));
      writeFileSync(configFile, JSON.stringify({ ...value, auditQueueLimit: 123 }), { mode: 0o600 });
      await expect(apply()).rejects.toMatchObject({ code: 'LOCK_TIMEOUT' });
      // A file that already carries the projection needs no transaction: under the same held lock
      // the answer is `aligned` at once, so a poll with nothing to write never makes a writer busy.
      const carried = await applyConfigFile(configFile, {
        project: (config) => config,
        tablesOf: (config) => config.capabilities,
        same: (left, right) => JSON.stringify(left) === JSON.stringify(right),
        validate: () => null,
      });
      expect(carried.state).toBe('aligned');
    });
    expect((await apply()).state).toBe('written');
    expect(JSON.parse(readFileSync(configFile, 'utf8')).auditQueueLimit).toBe(123);
    const alias = join(root, 'broker-alias.json');
    symlinkSync(configFile, alias);
    expect(
      (
        await applyConfigFile(alias, {
          project: (config) => ({ ...config, auditQueueLimit: 124 }),
          tablesOf: (config) => config.auditQueueLimit,
          same: (a, b) => a === b,
          validate: () => null,
        })
      ).state,
    ).toBe('written');
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(configFile, 'utf8')).auditQueueLimit).toBe(124);
    let current = true;
    const stale = applyConfigFile(configFile, {
      project: (config) => ({ ...config, auditQueueLimit: 1 }),
      tablesOf: (config) => config.auditQueueLimit,
      same: (a, b) => a === b,
      validate: () => null,
      isCurrent: () => current,
    });
    current = false;
    expect((await stale).state).toBe('refused');
    expect(JSON.parse(readFileSync(configFile, 'utf8')).auditQueueLimit).toBe(124);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
