import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { refusalOf } from '../enrollment-results.ts';
import type { Check, Enrolled } from '../enrollment-scenarios/enrolled.ts';
import { PROCESS_START_CEILING_MS, until } from '../support.ts';

/**
 * Two foreign drop-in files in `services.d/` declare one service, so the agent itself refuses the
 * later one, and both stay there. An owner whose own files have nothing to do with them attaches,
 * and the first owner applies again: each is `ready`. Before the write and after it, enrollment
 * judges only what belongs to the request, so a conflict among other files is never this owner's.
 */
export async function foreignDropInConflictControl(context: Enrolled, check: Check): Promise<void> {
  const { stand, request, worker } = context;
  const dir = join(dirname(request.config), 'services.d');
  mkdirSync(dir, { mode: 0o700 });
  const foreign = ['a', 'b'].map((name) => {
    const descriptorPath = join(dir, `.${name}.descriptor`);
    stand.write(descriptorPath, { ...stand.first.descriptor, service: 'owner.dup' });
    const path = join(dir, `${name}.json`);
    stand.write(path, {
      binding: {
        ...stand.first.binding,
        service: 'owner.dup',
        descriptorPath,
        socketPath: join(stand.root, `dup-${name}.sock`),
      },
      callers: [{ caller: 'observer', scope: { kind: 'service-read' } }],
    });
    return path;
  });
  const conflict = async () => {
    const { refused } = (await worker.status()).services.declarations;
    return refused.some((entry) => entry.path === foreign[1] && entry.service === 'owner.dup');
  };
  check(
    await until(conflict, PROCESS_START_CEILING_MS),
    'the agent reads both foreign drop-in files and refuses the later one itself',
  );

  const second = {
    ...request,
    requestId: crypto.randomUUID(),
    owner: { id: 'second', descriptors: stand.second.bindings },
  };
  const attached = (await stand.cli(second, 'apply')).result;
  check(
    attached.status === 'ready',
    `an unrelated owner attaches beside the foreign conflict: ${refusalOf(attached)?.code ?? 'ok'} at ${refusalOf(attached)?.phase ?? 'complete'}`,
  );
  const repeated = (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'apply')).result;
  check(
    repeated.status === 'ready',
    `the first owner applies again beside it: ${refusalOf(repeated)?.code ?? 'ok'} at ${refusalOf(repeated)?.phase ?? 'complete'}`,
  );
  check(await conflict(), 'the foreign conflict is still there, refused by the agent');
}
