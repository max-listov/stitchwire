import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EnrollmentNodeRequest } from '../packages/contracts/src/enrollment/request.ts';
import { verifiedCopy } from '../packages/runtime/src/enrollment/material.ts';
import { brokerObservation } from '../packages/runtime/src/enrollment/observe.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import { until } from './support.ts';
import { refusalOf, runtimeOf } from './enrollment-results.ts';
import { SCENARIO_CEILING_MS } from './enrollment-scenarios/registry.ts';

test(
  'a connected node lives on its kept signed copy, and only a node without one needs material',
  async () => {
    const stand = await enrollmentStand();
    const kept = join(stand.root, `${stand.request.nodeId}-fleet.json`);
    const serialOf = () => verifiedCopy(kept, stand.trust, false).serial;
    try {
      expect((await stand.cli(stand.admission, 'apply')).result.status).toBe('admitted');
      let agent = await stand.startWorker();
      expect((await stand.cli(stand.request, 'apply')).result.status).toBe('ready');

      // Another member joins: a publication that has nothing to do with this node.
      const serial = stand.publish((manifest) => ({
        ...manifest,
        members: { ...manifest.members, bystander: { copy: 'own' } },
      }));
      const { material: _delivered, ...rest } = stand.request;
      const own: EnrollmentNodeRequest = rest;
      const fresh = (request: EnrollmentNodeRequest) => ({ ...request, requestId: crypto.randomUUID() });

      // Once the broker holds the new edition the kept copy may still lag it; status follows the copy.
      expect(
        await until(
          async () =>
            (await brokerObservation(stand.url, stand.request.expectedVersion)).bundle.serial === serial,
          15_000,
        ),
      ).toBe(true);
      const status = await stand.cli(fresh(own), 'status');
      expect([status.code, status.result.status, refusalOf(status.result)]).toEqual([0, 'ready', null]);
      expect(serialOf()).toBe(serial);
      expect(runtimeOf(status.result)).toMatchObject({ installation: null });

      // The material the orchestrator kept from bootstrap is older now: it never replaces the copy.
      const keptBytes = readFileSync(kept);
      const stale = await stand.cli(fresh(stand.request), 'status');
      expect([stale.code, refusalOf(stale.result)?.code]).toEqual([2, 'bundle-stale']);
      expect(readFileSync(kept)).toEqual(keptBytes);

      // The same requestId may drop its material once the node keeps a copy: material is evidence.
      const attach = fresh(stand.request);
      expect(
        refusalOf(
          (
            await stand.cli(
              { ...attach, owner: { id: 'second', descriptors: stand.second.bindings } },
              'prepare',
            )
          ).result,
        )?.code,
      ).toBe('bundle-stale');
      const second: EnrollmentNodeRequest = {
        ...own,
        requestId: attach.requestId,
        owner: { id: 'second', descriptors: stand.second.bindings },
      };
      const attached = await stand.cli(second, 'apply');
      expect([attached.code, attached.result.status]).toEqual([0, 'ready']);
      expect((await stand.cli(second, 'apply')).result.status).toBe('ready');
      const detached = await stand.cli(fresh(second), 'detach');
      expect([detached.code, detached.result.status]).toEqual([0, 'detached']);

      // Negative controls: a damaged or missing kept copy is a named refusal, never success. A live
      // agent repairs its copy from memory, so the controls run while it is stopped.
      agent.kill();
      await agent.exited;
      writeFileSync(kept, '{"not":"a bundle"}\n', { mode: 0o600 });
      const damaged = await stand.cli(fresh(own), 'status');
      expect([damaged.code, refusalOf(damaged.result)?.code]).toEqual([2, 'bundle-invalid']);
      writeFileSync(kept, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]), { mode: 0o600 });
      const undecodable = await stand.cli(fresh(own), 'status');
      expect([undecodable.code, refusalOf(undecodable.result)?.code]).toEqual([2, 'bundle-invalid']);
      rmSync(kept);
      const missing = await stand.cli(fresh(own), 'status');
      expect([missing.code, refusalOf(missing.result)?.code]).toEqual([2, 'material-required']);
      writeFileSync(kept, keptBytes, { mode: 0o600 });
      agent = await stand.startWorker();
      expect((await stand.cli(fresh(own), 'status')).result.status).toBe('ready');

      // A first prepare has no copy to read: it needs the broker's material.
      const elsewhere = join(stand.root, 'elsewhere');
      const first: EnrollmentNodeRequest = {
        ...own,
        requestId: crypto.randomUUID(),
        config: join(elsewhere, 'node.json'),
        agentSocket: join(elsewhere, 'agent.sock'),
      };
      const unprepared = await stand.cli(first, 'prepare');
      expect([
        unprepared.code,
        refusalOf(unprepared.result)?.code,
        refusalOf(unprepared.result)?.phase,
      ]).toEqual([2, 'material-required', 'preflight']);
      expect(existsSync(elsewhere)).toBe(false);
      expect(
        await until(async () => (await stand.cli(fresh(own), 'status')).result.status === 'ready', 5000),
      ).toBe(true);
    } finally {
      await stand.stop();
    }
  },
  SCENARIO_CEILING_MS,
);
