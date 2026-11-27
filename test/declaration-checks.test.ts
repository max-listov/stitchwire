import { expect, test } from 'bun:test';
import type { LocalStatus } from '../packages/contracts/src/door/status.ts';
import { serviceDeclarationChecks } from '../packages/runtime/src/cli/declaration-checks.ts';
import { status } from './doctor-fixture.ts';

/** `doctor` reports an owner's service declaration: what was read, what was refused, what each broker took. */

function declared(services: Partial<LocalStatus['services']['declarations']>): LocalStatus {
  const base = status();
  const lane = base.lanes[0]?.id ?? 'primary';
  return {
    ...base,
    services: {
      ...base.services,
      declarations: {
        descriptors: [{ path: '/s.json', state: 'loaded', service: 'owner.x', callers: 1, detail: null }],
        refused: [],
        lanes: [{ lane, declaredAt: new Date().toISOString(), accepted: 1, refused: [] }],
        ...services,
      },
    },
  };
}

test('a declaration read and taken by every broker is reported without a warning', () => {
  const checks = serviceDeclarationChecks(declared({}));
  expect(checks.map((check) => check.code)).toEqual(['services.descriptor', 'services.declared']);
  expect(checks.every((check) => check.level === 'ok')).toBe(true);
});

test('a descriptor that did not load, a service refused here and a grant a broker refused each show', () => {
  const lane = status().lanes[0]?.id ?? 'primary';
  const checks = serviceDeclarationChecks(
    declared({
      descriptors: [{ path: '/s.json', state: 'invalid', service: null, callers: 0, detail: 'EACCES' }],
      refused: [{ path: '/t.json', service: 'other.x', detail: 'outside the namespaces' }],
      lanes: [
        {
          lane,
          declaredAt: new Date().toISOString(),
          accepted: 0,
          refused: [{ service: 'owner.x', caller: 'reader', detail: 'no grant' }],
        },
      ],
    }),
  );
  expect(checks.map((check) => [check.code, check.level])).toEqual([
    ['services.descriptor', 'fail'],
    ['services.declared', 'fail'],
    ['services.declared', 'warn'],
  ]);
});

test('a lane that has not answered yet is unknown, and no declaration bound is silent', () => {
  expect(serviceDeclarationChecks(declared({ lanes: [] })).map((check) => check.level)).toEqual([
    'ok',
    'unknown',
  ]);
  expect(serviceDeclarationChecks(status())).toEqual([]);
});
