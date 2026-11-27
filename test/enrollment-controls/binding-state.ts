import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EnrollmentNodeRequest } from '../../packages/contracts/src/enrollment/request.ts';
import type { WireClient } from '../../packages/local-client/src/client.ts';
import type { enrollmentStand } from '../enrollment-stand.ts';
import { until } from '../support.ts';
import { refusalOf } from '../enrollment-results.ts';

type Stand = Awaited<ReturnType<typeof enrollmentStand>>;
type Check = (condition: unknown, label: string) => void;

export async function invalidRemainingControl(
  stand: Stand,
  request: EnrollmentNodeRequest,
  publisher: WireClient,
  deliver: () => Promise<unknown>,
  check: Check,
) {
  const original = readFileSync(stand.second.topicPath);
  const config = readFileSync(request.config);
  const receipt = readFileSync(`${request.config}.enrollment/owners.json`);
  try {
    stand.write(stand.second.topicPath, { topics: 'invalid' });
    check(
      await until(
        async () =>
          (await publisher.status()).events.declarations.descriptors.some(
            (reading) => reading.path === stand.second.topicPath && reading.state === 'invalid',
          ),
        10_000,
      ),
      'foreign invalid topic retains its last valid declaration',
    );
    await deliver();
    const detached = (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'detach')).result;
    check(
      refusalOf(detached)?.code === 'declaration-invalid' &&
        config.equals(readFileSync(request.config)) &&
        receipt.equals(readFileSync(`${request.config}.enrollment/owners.json`)),
      'final-set preflight prevents reload from withdrawing a foreign last-valid topic',
    );
    await deliver();
  } finally {
    writeFileSync(stand.second.topicPath, original);
  }
  check(
    await until(
      async () =>
        (await publisher.status()).events.declarations.descriptors.some(
          (reading) => reading.path === stand.second.topicPath && reading.state === 'loaded',
        ),
      10_000,
    ),
    'the restored foreign descriptor loads normally',
  );
}

export async function brokerOnlyControl(
  stand: Stand,
  request: EnrollmentNodeRequest,
  publisher: WireClient,
  deliver: () => Promise<unknown>,
  check: Check,
) {
  const path = join(stand.root, 'broker-policy-topics.json');
  stand.write(path, {
    topics: {
      'owner.events.denied': { delivery: 'ordered', subscribers: [request.nodeId] },
      'owner.events.retained': { delivery: 'ordered', retain: { maxAgeMs: 1000, maxBytes: 8192 } },
      ...Object.fromEntries(
        Array.from({ length: 5 }, (_, index) => [`owner.events.z${index}`, { delivery: 'ordered' }]),
      ),
    },
  });
  const third: EnrollmentNodeRequest = {
    ...request,
    requestId: crypto.randomUUID(),
    owner: { id: 'third', descriptors: [{ kind: 'topic', path }] },
  };
  check(
    (await stand.cli(third, 'plan')).result.status === 'planned',
    'own slice does not pretend to carry broker-only policy',
  );
  const result = (await stand.cli(third, 'apply')).result;
  check(
    result.status === 'failed' &&
      result.failure?.code === 'declaration-refused' &&
      stand.config().events.descriptors.includes(path),
    'broker refusal reports a named partial enrollment instead of ready',
  );
  const status = await publisher.status();
  const refusals = status.events.declarations.lanes.flatMap((lane) =>
    lane.refused.map(({ detail }) => detail),
  );
  check(
    refusals.some((detail) => detail.includes('does not admit')) &&
      refusals.some((detail) => detail.includes('may retain at most')) &&
      refusals.some((detail) => detail.includes('holds at most')),
    'current broker ack enforces subscriber and aggregate topic retention budgets',
  );
  check(
    refusalOf((await stand.cli(third, 'status')).result)?.code === 'declaration-refused',
    'read-only status preserves the named broker refusal',
  );
  await deliver();
  check(
    (await stand.cli({ ...third, requestId: crypto.randomUUID() }, 'detach')).result.status === 'detached',
    'partial owner can detach without removing independent owners',
  );
  await deliver();
}

export async function removeBrokenOwnerControl(
  stand: Stand,
  request: EnrollmentNodeRequest,
  deliver: () => Promise<unknown>,
  check: Check,
) {
  check(
    (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'apply')).result.status === 'ready',
    'reattach one consumer while another feed remains open',
  );
  await deliver();
  const declaration = readFileSync(stand.first.declarationPath);
  const topics = readFileSync(stand.first.topicPath);
  try {
    stand.write(stand.first.declarationPath, {});
    stand.write(stand.first.topicPath, {});
    check(
      (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'detach')).result.status ===
        'detached',
      'removed invalid service and topic files do not block detach',
    );
    await deliver();
  } finally {
    writeFileSync(stand.first.declarationPath, declaration);
    writeFileSync(stand.first.topicPath, topics);
  }
}
