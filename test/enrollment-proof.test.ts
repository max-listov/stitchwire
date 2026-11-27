import { expect, test } from 'bun:test';
import { executeEnrollment } from '../packages/runtime/src/enrollment/operation.ts';
import { selfProofRefusals } from './enrollment-controls/proof.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import { SCENARIO_CEILING_MS } from './enrollment-scenarios/registry.ts';

test(
  'the in-process API refuses a self-target proof before and after the node is enrolled',
  async () => {
    const stand = await enrollmentStand();
    const check = (condition: unknown, label: string) => expect(condition, label).toBe(true);
    // The CLI path of the same refusals is a scenario of the registry; this is the API an SDK calls.
    const api: Parameters<typeof selfProofRefusals>[3] = async (request, operation) => {
      const result = await executeEnrollment(request, operation);
      return { code: result.status === 'failed' ? 2 : 0, result };
    };
    try {
      await selfProofRefusals(stand, stand.request, check, api);
      check((await stand.cli(stand.admission, 'apply')).result.status === 'admitted', 'admit node');
      await stand.startWorker();
      check((await stand.cli(stand.request, 'apply')).result.status === 'ready', 'remote enrollment');
      await selfProofRefusals(stand, stand.request, check, api);
    } finally {
      await stand.stop();
    }
  },
  SCENARIO_CEILING_MS,
);
