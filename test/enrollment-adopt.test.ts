import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWireClient } from '../packages/local-client/src/client.ts';
import { refusalOf } from './enrollment-results.ts';
import { SCENARIO_CEILING_MS } from './enrollment-scenarios/registry.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import { until } from './support.ts';

/**
 * Bindings an installer wrote into the configuration before enrollment existed have no recorded
 * owner. An owner takes them over only when its request says so, and taking over changes nothing
 * the agent runs: no configuration byte, no new declaration.
 */
test(
  'an owner adopts the bindings written without an owner, only when it asks, and changes nothing the agent runs',
  async () => {
    const stand = await enrollmentStand();
    const client = createWireClient({ socketPath: stand.worker.socket });
    try {
      // The installer's own edit: both kinds bound by hand, no enrollment record.
      const initial = stand.config();
      stand.write(stand.worker.config, {
        ...JSON.parse(readFileSync(stand.worker.config, 'utf8')),
        services: { ...initial.services, descriptors: [stand.first.declarationPath] },
        events: { ...initial.events, descriptors: [stand.first.topicPath] },
      });
      expect((await stand.cli(stand.admission, 'apply')).result.status).toBe('admitted');
      await stand.startWorker();
      const declared = async () => {
        const status = await client.status();
        return [
          status.services.declarations.lanes[0]?.declaredAt,
          status.events.declarations.lanes[0]?.declaredAt,
        ];
      };
      const before = readFileSync(stand.worker.config);
      // The agent announces what the installer bound before anything is adopted.
      expect(await until(async () => (await declared()).every((at) => typeof at === 'string'), 10_000)).toBe(
        true,
      );
      const announced = await declared();
      const owners = join(`${stand.worker.config}.enrollment`, 'owners.json');

      // Without an explicit intent the bindings stay nobody's: the ordinary apply is refused.
      const ordinary = (await stand.cli(stand.request, 'apply')).result;
      expect(refusalOf(ordinary)).toMatchObject({ code: 'owner-conflict', phase: 'preflight' });
      expect(readFileSync(stand.worker.config)).toEqual(before);

      // A kind the configuration does not hold the path under is not an adoption.
      const otherKind = {
        ...stand.request,
        requestId: crypto.randomUUID(),
        owner: {
          id: 'first',
          adopt: true,
          descriptors: [{ kind: 'topic' as const, path: stand.first.declarationPath }],
        },
      };
      expect(refusalOf((await stand.cli(otherKind, 'apply')).result)?.code).toBe('owner-conflict');

      // Adopting: ready, and the agent runs exactly what it ran — same bytes, no new declaration.
      const adopting = {
        ...stand.request,
        requestId: crypto.randomUUID(),
        owner: { ...stand.request.owner, adopt: true },
      };
      expect((await stand.cli(adopting, 'plan')).result.status).toBe('planned');
      const adopted = (await stand.cli(adopting, 'apply')).result;
      expect([adopted.status, refusalOf(adopted)?.code ?? null]).toEqual(['ready', null]);
      expect(readFileSync(stand.worker.config)).toEqual(before);
      expect(await declared()).toEqual(announced);
      expect(Object.keys(JSON.parse(readFileSync(owners, 'utf8')))).toEqual(['first']);

      // A path another owner now holds is still refused, adopt or not.
      const second = {
        ...stand.request,
        requestId: crypto.randomUUID(),
        owner: { id: 'second', adopt: true, descriptors: stand.first.bindings },
      };
      expect(refusalOf((await stand.cli(second, 'apply')).result)).toMatchObject({
        code: 'owner-conflict',
        phase: 'preflight',
      });

      // From here they are the owner's: the same set without adopt is ready, and detach removes all.
      const owned = { ...stand.request, requestId: crypto.randomUUID() };
      expect((await stand.cli(owned, 'apply')).result.status).toBe('ready');
      expect(readFileSync(stand.worker.config)).toEqual(before);
      const detached = (await stand.cli({ ...stand.request, requestId: crypto.randomUUID() }, 'detach'))
        .result;
      expect(detached.status).toBe('detached');
      expect([stand.config().services.descriptors, stand.config().events.descriptors]).toEqual([[], []]);
    } finally {
      client.close();
      await stand.stop();
    }
  },
  SCENARIO_CEILING_MS,
);
