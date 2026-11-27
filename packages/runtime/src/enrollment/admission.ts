import { accessSync, constants } from 'node:fs';
import { parseJsonBytes, readRegularFileSync } from 'stitchkit/files';
import type { EnrollmentAdmissionRequest } from '../../../contracts/src/enrollment/request.ts';
import type { Sha256 } from '../../../contracts/src/protocol/paths.ts';
import { type BrokerConfig, BrokerConfigSchema } from '../config/broker.ts';
import { loadBrokerConfig, MAX_CONFIG_FILE_BYTES } from '../config/io.ts';
import { withConfigLock } from '../config/transaction.ts';
import { applyBrokerTables } from '../fleet/projection.ts';
import { asJson } from '../json.ts';
import { EnrollmentError } from './failure.ts';
import { writePrivate } from './files.ts';
import type { RequestJournal } from './journal.ts';
import { materialFor, verifiedCopy } from './material.ts';
import { brokerObservation } from './observe.ts';
import type { Outcome, Steps } from './steps.ts';
import { OWN_EFFECTS, settled } from './wait.ts';

function localBrokerUrl(config: BrokerConfig): string {
  const host = ['0.0.0.0', '::', '127.0.0.1'].includes(config.host) ? '127.0.0.1' : config.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${config.port}`;
}

/** What the broker's own files and its running process say about this node, without a write. */
async function observe(request: EnrollmentAdmissionRequest) {
  // Preserve native access denial before the human-readable config loader formats its error.
  accessSync(request.config, constants.R_OK);
  const config = loadBrokerConfig(request.config);
  if (config.fleet === undefined) throw new EnrollmentError('admission-denied');
  const opened = verifiedCopy(config.fleet.copy, config.fleet.trust, true);
  const material = materialFor(opened, config.fleet.trust, request.nodeId);
  const health = await brokerObservation(localBrokerUrl(config), request.expectedVersion, opened.serial);
  const admitted = config.nodes.find((node) => node.id === request.nodeId)?.tokenSha256s ?? [];
  if (admitted.length > 0 && request.tokenSha256 !== undefined && !admitted.includes(request.tokenSha256))
    throw new EnrollmentError('credential-conflict');
  const running = health.fleet.machines.some((node) => node.nodeId === request.nodeId);
  return { config, opened, material, admitted, running };
}

/** File publication is not runtime admission: the running broker must report this row too. */
async function admittedByRuntime(request: EnrollmentAdmissionRequest) {
  const observed = await observe(request);
  if (observed.admitted.length === 0 || !observed.running) throw new EnrollmentError('runtime-unavailable');
  return observed;
}

function admit(
  request: EnrollmentAdmissionRequest,
  digest: Sha256,
  observed: Awaited<ReturnType<typeof observe>>,
): void {
  accessSync(request.config, constants.R_OK | constants.W_OK);
  const { config, opened } = observed;
  if (opened.manifest === null) throw new EnrollmentError('bundle-invalid');
  // Project over the raw JSON rather than writing Zod-materialised defaults (such as
  // `maxRetainedBytes: 0` on topic namespaces), so FleetKeeper sees `aligned` immediately instead
  // of rewriting broker.json and triggering a spurious supervisor reload 5 seconds later.
  const currentBytes = readRegularFileSync(request.config, { limit: MAX_CONFIG_FILE_BYTES });
  const rawConfig = asJson(parseJsonBytes(currentBytes));
  const raw =
    observed.admitted.length === 0
      ? {
          ...rawConfig,
          nodes: [...config.nodes, { id: request.nodeId, tokenSha256s: [digest], note: '' }],
        }
      : rawConfig;
  const projected = applyBrokerTables(raw, opened.manifest);
  BrokerConfigSchema.parse(projected);
  const body = `${JSON.stringify(projected, null, 2)}\n`;
  if (!Buffer.from(currentBytes).equals(Buffer.from(body))) writePrivate(request.config, projected);
  const confirmed = loadBrokerConfig(request.config).nodes.find((node) => node.id === request.nodeId);
  if (!confirmed?.tokenSha256s.includes(digest)) throw new EnrollmentError('credential-conflict');
}

/**
 * The broker side: its operating-system owner admits one node's credential digest into the roster
 * the broker already keeps. `plan` hands out the node's bootstrap material and never claims
 * admission; `status` answers `admitted` only once the running broker reports the node.
 */
export const admissionFlow = {
  async inspect(
    request: EnrollmentAdmissionRequest,
    operation: 'plan' | 'status',
    steps: Steps,
  ): Promise<Outcome> {
    const observed = await steps.run('preflight', () => observe(request));
    const { material, admitted } = observed;
    if (operation === 'plan' || admitted.length === 0)
      return { kind: 'admission', status: 'planned', material, admitted };
    await steps.run('admission', () => admittedByRuntime(request));
    return { kind: 'admission', status: 'admitted', material, admitted };
  },

  async mutation(request: EnrollmentAdmissionRequest, digest: Sha256, steps: Steps) {
    await steps.run('preflight', () => settled(() => observe(request), OWN_EFFECTS));
    return async (journal: RequestJournal): Promise<Outcome> => {
      journal.save();
      await steps.run('configuration', () =>
        withConfigLock(request.config, async () => {
          const observed = await steps.run('preflight', () => observe(request));
          await steps.record('admission', () => admit(request, digest, observed));
        }),
      );
      const observed = await steps.run('admission', () =>
        settled(() => admittedByRuntime(request), OWN_EFFECTS),
      );
      return {
        kind: 'admission',
        status: 'admitted',
        material: observed.material,
        admitted: observed.admitted,
      };
    };
  },
};
