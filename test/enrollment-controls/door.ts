import { existsSync, renameSync, unlinkSync } from 'node:fs';
import { bindUnixSocket } from 'stitchkit/files';
import type { EnrollmentNodeRequest } from '../../packages/contracts/src/enrollment/request.ts';
import { nodeObservation } from '../../packages/runtime/src/enrollment/observe.ts';
import { command } from '../../packages/runtime/src/enrollment/native.ts';
import type { enrollmentStand } from '../enrollment-stand.ts';
import { refusalOf } from '../enrollment-results.ts';

/** A matching live unit and its old listener must not certify a healthy foreign replacement door. */
export async function foreignDoorControl(
  stand: Awaited<ReturnType<typeof enrollmentStand>>,
  request: EnrollmentNodeRequest,
  unit: string,
): Promise<boolean> {
  const status = await nodeObservation(request);
  if (status === null) return false;
  const pid = async () =>
    (await command('/usr/bin/systemctl', ['show', unit, '--property', 'MainPID', '--value'])).text;
  const before = await pid();
  const saved = `${request.agentSocket}.held`;
  let foreign: Bun.Server<undefined> | undefined;
  let refused = false;
  let hits = 0;
  renameSync(request.agentSocket, saved);
  try {
    foreign = bindUnixSocket({ path: request.agentSocket, mode: 0o600 }, (unix) =>
      Bun.serve({
        unix,
        fetch() {
          hits++;
          return Response.json(status);
        },
      }),
    );
    // A separate origin avoids reusing the original door's keep-alive connection after rename.
    const response = await fetch('http://foreign-door.invalid/status', {
      unix: request.agentSocket,
      signal: AbortSignal.timeout(5000),
    });
    await response.arrayBuffer();
    const result = (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'status')).result;
    refused = hits > 0 && refusalOf(result)?.code === 'runtime-conflict' && (await pid()) === before;
  } finally {
    await foreign?.stop(true);
    if (foreign !== undefined && existsSync(request.agentSocket)) unlinkSync(request.agentSocket);
    renameSync(saved, request.agentSocket);
  }
  return (
    refused &&
    (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'status')).result.status === 'ready' &&
    (await pid()) === before
  );
}
