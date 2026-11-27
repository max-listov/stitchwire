import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeEnrollment } from '../packages/runtime/src/enrollment/operation.ts';
import { enrollmentStand } from './enrollment-stand.ts';
import type { EnrollmentDescriptor } from '../packages/contracts/src/enrollment/request.ts';
import { refusalOf } from './enrollment-results.ts';

test('invalid or overbroad material and declarations fail before node mutation', async () => {
  const stand = await enrollmentStand();
  try {
    const before = readFileSync(stand.worker.config);
    const full = join(stand.root, 'full.json');
    stand.write(full, { trust: stand.trust, bundle: stand.bundle });
    const declaration = join(stand.root, 'refused-declaration.json');
    const owning = (descriptors: unknown) => ({ ...stand.request, owner: { id: 'first', descriptors } });
    /** One row per refusal: what is asked, what the declaration file holds, and the named answer. */
    const refusals: { name: string; request: unknown; file?: unknown; code: string }[] = [
      {
        name: 'a descriptor without a kind',
        request: owning([stand.first.declarationPath]),
        code: 'invalid-request',
      },
      {
        name: 'one file bound as two kinds',
        request: owning([
          { kind: 'service', path: stand.first.declarationPath },
          { kind: 'topic', path: stand.first.declarationPath },
        ]),
        code: 'invalid-request',
      },
      {
        name: 'a socket path longer than a Unix socket',
        request: { ...stand.request, agentSocket: `/${'x'.repeat(104)}` },
        code: 'invalid-request',
      },
      {
        name: 'the full bundle as node material',
        request: { ...stand.request, material: full },
        code: 'bundle-invalid',
      },
      {
        name: 'a broker address that carries credentials',
        request: { ...stand.request, brokers: [{ id: 'primary', url: 'https://user:password@example.com' }] },
        code: 'invalid-request',
      },
      {
        name: 'a declaration file that does not exist',
        request: owning([{ kind: 'service', path: join(stand.root, 'missing-declaration.json') }]),
        code: 'declaration-invalid',
      },
      {
        name: 'a declaration whose descriptor does not exist',
        request: owning([{ kind: 'service', path: declaration }]),
        file: {
          binding: { ...stand.first.binding, descriptorPath: join(stand.root, 'missing-descriptor.json') },
          callers: [],
        },
        code: 'declaration-invalid',
      },
      {
        name: 'a declaration of a service the node already binds',
        request: owning([{ kind: 'service', path: declaration }]),
        file: { binding: stand.probe.binding, callers: [] },
        code: 'declaration-invalid',
      },
    ];
    for (const { name, request, file, code } of refusals) {
      if (file !== undefined) stand.write(declaration, file);
      const refused = refusalOf(await executeEnrollment(request, 'plan'));
      // Every row is refused while the operation only reads, and leaves nothing behind.
      expect([name, refused?.code, refused?.phase]).toEqual([name, code, 'preflight']);
      expect([name, readFileSync(stand.worker.config).equals(before)]).toEqual([name, true]);
      expect([name, existsSync(`${stand.worker.config}.enrollment`)]).toEqual([name, false]);
    }
    // Positive control: the same request without any of these faults is planned.
    expect((await executeEnrollment(stand.request, 'plan')).status).toBe('planned');
    const kinds: EnrollmentDescriptor['kind'][] = ['service', 'topic'];
    for (const kind of kinds) {
      stand.write(stand.worker.config, {
        ...JSON.parse(before.toString()),
        ...(kind === 'service'
          ? { services: { ...stand.config().services, descriptors: [stand.first.declarationPath] } }
          : { events: { ...stand.config().events, descriptors: [stand.first.topicPath] } }),
      });
      const existing = readFileSync(stand.worker.config);
      expect(refusalOf(await executeEnrollment(stand.request, 'apply'))?.code).toBe('owner-conflict');
      expect(readFileSync(stand.worker.config)).toEqual(existing);
      stand.write(stand.worker.config, JSON.parse(before.toString()));
    }
    expect(existsSync(`${stand.worker.config}.enrollment`)).toBe(false);
    expect(stand.reached).toHaveLength(0);
  } finally {
    await stand.stop();
  }
});

test('a missing broker is not an empty successful observation', async () => {
  const stand = await enrollmentStand();
  try {
    const holder = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const url = `http://127.0.0.1:${holder.port}`;
    await holder.stop(true);
    const result = await executeEnrollment({ ...stand.request, brokers: [{ id: 'primary', url }] }, 'plan');
    expect(result.status).toBe('failed');
    expect(refusalOf(result)?.code).toBe('broker-unavailable');
    expect(result.completed).toEqual([]);
  } finally {
    await stand.stop();
  }
});

test('plan checks the owning schemas against the complete final descriptor tables', async () => {
  const stand = await enrollmentStand();
  try {
    const initial = stand.config();
    const empty = { ...stand.request, owner: { id: 'new-owner', descriptors: [] } };
    const topics = Array.from({ length: 16 }, (_, index) => join(stand.root, `capacity-topic-${index}.json`));
    for (const path of topics) stand.write(path, { topics: {} });
    stand.write(stand.worker.config, { ...initial, events: { ...initial.events, descriptors: topics } });
    expect((await executeEnrollment(empty, 'plan')).status).toBe('planned');
    const filledTopics = readFileSync(stand.worker.config);
    expect(
      refusalOf(
        await executeEnrollment(
          {
            ...stand.request,
            owner: { id: 'new-owner', descriptors: [{ kind: 'topic', path: stand.first.topicPath }] },
          },
          'plan',
        ),
      )?.code,
    ).toBe('declaration-invalid');
    expect(readFileSync(stand.worker.config)).toEqual(filledTopics);

    const services = Array.from({ length: 32 }, (_, index) => {
      const service = `owner.capacity${index}`;
      const descriptorPath = join(stand.root, `capacity-descriptor-${index}.json`);
      const path = join(stand.root, `capacity-service-${index}.json`);
      stand.write(descriptorPath, { ...stand.first.descriptor, service });
      stand.write(path, {
        binding: {
          ...stand.first.binding,
          service,
          descriptorPath,
          socketPath: join(stand.root, `capacity-${index}.sock`),
        },
        callers: [],
      });
      return path;
    });
    stand.write(stand.worker.config, {
      ...initial,
      services: { ...initial.services, descriptors: services },
    });
    expect((await executeEnrollment(empty, 'plan')).status).toBe('planned');
    const filledServices = readFileSync(stand.worker.config);
    expect(
      refusalOf(
        (
          await stand.cli(
            {
              ...stand.request,
              owner: {
                id: 'new-owner',
                descriptors: [{ kind: 'service', path: stand.first.declarationPath }],
              },
            },
            'plan',
          )
        ).result,
      )?.code,
    ).toBe('declaration-invalid');
    expect(readFileSync(stand.worker.config)).toEqual(filledServices);
    expect(existsSync(`${stand.worker.config}.enrollment`)).toBe(false);
  } finally {
    await stand.stop();
  }
});
