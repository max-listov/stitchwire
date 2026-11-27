import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EnrollmentNodeRequest,
  EnrollmentOperation,
} from '../../packages/contracts/src/enrollment/request.ts';
import type { WireClient } from '../../packages/local-client/src/client.ts';
import { brokerObservation } from '../../packages/runtime/src/enrollment/observe.ts';
import { sha256 } from '../../packages/runtime/src/config/io.ts';
import { fileDigest } from '../../packages/runtime/src/enrollment/artifact.ts';
import { requestedInstallation } from '../../packages/runtime/src/enrollment/installation.ts';
import { unitFile } from '../../packages/runtime/src/enrollment/systemd.ts';
import type { enrollmentStand, ProvenRequest } from '../enrollment-stand.ts';
import { until } from '../support.ts';

type Stand = Awaited<ReturnType<typeof enrollmentStand>>;
type Check = (condition: unknown, label: string) => void;

export function selfProofRequest(stand: Stand, request: ProvenRequest): ProvenRequest {
  return {
    ...request,
    requestId: crypto.randomUUID(),
    proof: {
      descriptor: stand.first.descriptorPath,
      call: { ...request.proof.call, to: request.nodeId, service: stand.first.descriptor.service },
      responseSha256: sha256(
        JSON.stringify({
          caller: request.nodeId,
          service: stand.first.descriptor.service,
          operation: 'read',
        }),
      ),
    },
  };
}

/** Includes absence and all recovery files, so an early-but-writing refusal cannot pass. */
function mutationSnapshot(stand: Stand, request: EnrollmentNodeRequest): string {
  const ledger = `${request.config}.enrollment`;
  const files = [
    request.config,
    ...(request.material === undefined ? [] : [request.material]),
    stand.first.descriptorPath,
    join(stand.root, `${request.nodeId}-fleet.json`),
    ...[requestedInstallation(request)].flatMap((installation) =>
      installation === null
        ? []
        : [
            installation.artifact.source,
            installation.artifact.destination,
            unitFile(installation.supervision),
          ],
    ),
    ...(existsSync(ledger)
      ? readdirSync(ledger, { recursive: true, withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) => join(entry.parentPath, entry.name))
      : []),
  ];
  return JSON.stringify({
    ledger: existsSync(ledger),
    files: files.sort().map((file) => [file, existsSync(file) ? fileDigest(file) : null]),
  });
}

export async function selfProofRefusals(
  stand: Stand,
  request: ProvenRequest,
  check: Check,
  run: (value: EnrollmentNodeRequest, operation: EnrollmentOperation) => ReturnType<Stand['cli']> = stand.cli,
) {
  const before = mutationSnapshot(stand, request);
  const reached = stand.reached.length;
  const operations: EnrollmentOperation[] = ['plan', 'prepare', 'apply', 'status', 'detach'];
  for (const operation of operations) {
    const response = await run(selfProofRequest(stand, request), operation);
    check(
      response.code === 2 &&
        response.result.status === 'failed' &&
        response.result.failure.code === 'proof-not-remote' &&
        response.result.failure.phase === 'preflight',
      `self-target ${operation} is refused before enrollment effects`,
    );
    check(
      mutationSnapshot(stand, request) === before && stand.reached.length === reached,
      `self-target ${operation} changes no files and never dispatches`,
    );
  }
}

export async function localSelfCallControl(
  stand: Stand,
  request: ProvenRequest,
  client: WireClient,
  check: Check,
) {
  const original = readFileSync(stand.first.declarationPath);
  try {
    const declaration = JSON.parse(original.toString());
    stand.write(stand.first.declarationPath, {
      ...declaration,
      callers: [...declaration.callers, { caller: request.nodeId, scope: { kind: 'service-read' } }],
    });
    check(
      await until(
        async () =>
          (await client.status()).services.declarations.lanes.some(
            (lane) => lane.accepted === 2 && lane.refused.length === 0,
          ),
        10_000,
      ),
      'fixture grants a real ordinary self-call',
    );
    const self = selfProofRequest(stand, request);
    const before = stand.reached.length;
    const { outcome } = await client.invokeService(self.proof.call);
    check(
      outcome.status === 'response' &&
        sha256(outcome.payload) === self.proof.responseSha256 &&
        stand.reached.length === before + 1,
      'ordinary local SDK self-call keeps working',
    );
    const connected = async () =>
      (await brokerObservation(stand.url, request.expectedVersion)).nodes.find(
        (node) => node.nodeId === request.nodeId,
      )?.since;
    const since = await connected();
    await selfProofRefusals(stand, request, check);
    check(
      typeof since === 'string' && (await connected()) === since,
      'rejected self-proof never restarts the connected agent',
    );
  } finally {
    writeFileSync(stand.first.declarationPath, original);
  }
  check(
    await until(
      async () =>
        (await client.status()).services.declarations.lanes.some(
          (lane) => lane.accepted === 1 && lane.refused.length === 0,
        ),
      10_000,
    ),
    'ordinary descriptor restored after self-proof control',
  );
}
