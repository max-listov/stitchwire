import { readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EnrollmentDescriptor,
  EnrollmentNodeRequest,
} from '../../packages/contracts/src/enrollment/request.ts';
import type { enrollmentStand } from '../enrollment-stand.ts';

type Stand = Awaited<ReturnType<typeof enrollmentStand>>;

/** Refuse before any binding/receipt mutation; the descriptor contents remain the owner's files. */
export async function bindingRefusalControls(
  stand: Stand,
  request: EnrollmentNodeRequest,
  check: (condition: unknown, label: string) => void,
) {
  const config = readFileSync(request.config);
  const receipt = readFileSync(`${request.config}.enrollment/owners.json`);
  async function refused(descriptors: EnrollmentDescriptor[], code: string, label: string) {
    const result = (
      await stand.cli(
        { ...request, requestId: crypto.randomUUID(), owner: { id: 'foreign', descriptors } },
        'apply',
      )
    ).result;
    check(result.status === 'failed' && result.failure?.code === code, label);
    check(
      config.equals(readFileSync(request.config)) &&
        receipt.equals(readFileSync(`${request.config}.enrollment/owners.json`)),
      `${label} preserves config and ownership`,
    );
  }
  await refused(stand.first.bindings, 'owner-conflict', 'foreign typed paths are refused');
  const alias = join(stand.root, 'topic-alias.json');
  symlinkSync(stand.first.topicPath, alias);
  await refused(
    [{ kind: 'topic', path: alias }],
    'owner-conflict',
    'a descriptor symlink cannot evade ownership',
  );
  const path = join(stand.root, 'refused-topic.json');
  const topics: Array<[string, string]> = [
    ['outside.events.metrics', 'topic outside namespace is refused'],
    ['owner.events.fleet', 'exact fleet topic collision is refused'],
    [stand.first.topic, 'another owner topic name collision is refused'],
  ];
  for (const [topic, label] of topics) {
    stand.write(path, { topics: { [topic]: { delivery: 'ordered' } } });
    await refused([{ kind: 'topic', path }], 'declaration-invalid', label);
  }
  const declaration = join(stand.root, 'refused-service.json');
  stand.write(declaration, { binding: stand.first.binding, callers: [] });
  await refused(
    [{ kind: 'service', path: declaration }],
    'declaration-invalid',
    'another owner service name collision is refused',
  );
  const descriptorPath = join(stand.root, 'third-service.json');
  stand.write(descriptorPath, { ...stand.first.descriptor, service: 'owner.third' });
  stand.write(declaration, {
    binding: { ...stand.first.binding, service: 'owner.third', descriptorPath },
    callers: [],
  });
  await refused(
    [{ kind: 'service', path: declaration }],
    'declaration-invalid',
    'another service socket collision is refused',
  );
}
