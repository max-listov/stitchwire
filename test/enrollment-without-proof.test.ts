import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EnrollmentNodeRequest } from '../packages/contracts/src/enrollment/request.ts';
import type { EnrollmentCode } from '../packages/contracts/src/enrollment/result.ts';
import { auditRecords } from './enrollment-controls/proof-route.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import { until } from './support.ts';
import { proofOf, refusalOf } from './enrollment-results.ts';
import { SCENARIO_CEILING_MS } from './enrollment-scenarios/registry.ts';

test(
  'without a proof enrollment certifies transport and declarations and dispatches no call',
  async () => {
    const stand = await enrollmentStand();
    try {
      const { proof: _proof, ...rest } = stand.request;
      const request: EnrollmentNodeRequest = { ...rest, requestId: crypto.randomUUID() };
      const audit = join(stand.root, 'audit.jsonl');
      const dispatches = () => auditRecords(audit).filter((row) => row.phase === 'dispatch').length;
      const reached = stand.reached.length;
      const ingress = stand.ingressTraces.length;
      const before = dispatches();

      const planned = await stand.cli(request, 'plan');
      expect([planned.code, planned.result.status]).toEqual([0, 'planned']);
      const prepared = await stand.cli(request, 'prepare');
      expect([prepared.code, prepared.result.status]).toEqual([0, 'prepared']);
      expect((await stand.cli(stand.admission, 'apply')).result.status).toBe('admitted');
      await stand.startWorker();
      const ready = await stand.cli(request, 'apply');
      expect([ready.code, ready.result.status, refusalOf(ready.result), proofOf(ready.result)]).toEqual([
        0,
        'ready',
        null,
        null,
      ]);
      const status = await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'status');
      expect([status.code, status.result.status, proofOf(status.result)]).toEqual([0, 'ready', null]);

      // The same readiness checks still refuse without a proof, each with its own named code.
      const refusals: Array<[EnrollmentNodeRequest, EnrollmentCode]> = [
        [{ ...request, expectedVersion: '999.0.0' }, 'version-mismatch'],
        [
          { ...request, brokers: [...request.brokers, { id: 'absent', url: 'http://127.0.0.1:9' }] },
          'broker-unavailable',
        ],
        [{ ...request, agentSocket: stand.observer.socket }, 'runtime-conflict'],
      ];
      const outside = join(stand.root, 'outside-namespace.json');
      stand.write(outside, { binding: stand.probe.binding, callers: [] });
      refusals.push([
        { ...request, owner: { id: 'first', descriptors: [{ kind: 'service', path: outside }] } },
        'declaration-invalid',
      ]);
      for (const [refused, code] of refusals) {
        const result = await stand.cli({ ...refused, requestId: crypto.randomUUID() }, 'status');
        expect({ code, observed: refusalOf(result.result)?.code, status: result.result.status }).toEqual({
          code,
          observed: code,
          status: 'failed',
        });
      }

      // A lane the broker stops admitting is refused at verification, where only the live node is read.
      const roster = readFileSync(stand.brokerConfig);
      const broker = JSON.parse(roster.toString());
      stand.write(stand.brokerConfig, {
        ...broker,
        nodes: broker.nodes.filter((node: { id: string }) => node.id !== request.nodeId),
      });
      const lane = await until(async () => {
        const result = (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'status')).result;
        return (
          refusalOf(result)?.phase === 'verification' &&
          ['handshake-refused', 'broker-unavailable'].includes(refusalOf(result)?.code ?? '')
        );
      }, 20_000);
      writeFileSync(stand.brokerConfig, roster);
      expect(lane).toBe(true);
      expect(
        await until(
          async () =>
            (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'status')).result.status ===
            'ready',
          20_000,
        ),
      ).toBe(true);

      const detached = await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'detach');
      expect([detached.code, detached.result.status]).toEqual([0, 'detached']);
      expect(dispatches()).toBe(before);
      expect(stand.reached.length).toBe(reached);
      expect(stand.ingressTraces.length).toBe(ingress);
      // Positive control: the same audit reading sees the dispatch of a proven status.
      const proven = await stand.cli({ ...stand.request, requestId: crypto.randomUUID() }, 'detach');
      expect(proven.result.status).toBe('detached');
      const attached = await stand.cli({ ...stand.request, requestId: crypto.randomUUID() }, 'apply');
      expect([attached.result.status, proofOf(attached.result)?.httpStatus]).toEqual(['ready', 200]);
      expect(await until(() => dispatches() > before, 5000)).toBe(true);
      // The audit is written in order and asynchronously: a dispatch by any operation without a proof
      // would have been recorded before this one. Exactly one new row is the decisive reading the
      // immediate count above cannot give.
      expect(dispatches()).toBe(before + 1);
      expect(stand.reached.length).toBe(reached + 1);
    } finally {
      await stand.stop();
    }
  },
  SCENARIO_CEILING_MS,
);
