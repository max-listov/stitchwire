import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createWireClient } from '../packages/local-client/src/client.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import { refusalOf } from './enrollment-results.ts';
import { SCENARIO_CEILING_MS } from './enrollment-scenarios/registry.ts';

test(
  'an agent started through a link to its node.json has its drop-ins judged beside that spelling',
  async () => {
    const stand = await enrollmentStand({ linkedConfig: true });
    const client = createWireClient({ socketPath: stand.worker.socket });
    try {
      expect((await stand.cli(stand.admission, 'apply')).result.status).toBe('admitted');
      // A drop-in beside the link serves the service the owner is about to bind explicitly. Beside the
      // file the link points to there is no drop-in directory at all: `worker.json` has none.
      const dropIns = join(dirname(stand.agentConfig), 'services.d');
      mkdirSync(dropIns, { mode: 0o700 });
      const live = join(dropIns, 'live.json');
      copyFileSync(stand.first.declarationPath, live);
      await stand.startWorker();
      expect((await client.status()).config?.path).toBe(stand.agentConfig);

      const refused = await stand.cli(stand.request, 'apply');
      expect([refused.code, refusalOf(refused.result)?.code]).toEqual([2, 'declaration-invalid']);
      expect(stand.config().services.descriptors).toEqual([]);

      // Control: the same request, once the drop-in is gone, binds the service.
      rmSync(live);
      const applied = await stand.cli({ ...stand.request, requestId: crypto.randomUUID() }, 'apply');
      expect([applied.code, applied.result.status]).toEqual([0, 'ready']);
      expect(stand.config().services.descriptors).toHaveLength(1);
    } finally {
      client.close();
      await stand.stop();
    }
  },
  SCENARIO_CEILING_MS,
);
