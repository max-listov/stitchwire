import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { CommandProfileSchema } from '../packages/runtime/src/config/profiles.ts';
import { ExecutionAdmission } from '../packages/runtime/src/node/admission.ts';
import { childEnv, execute } from '../packages/runtime/src/node/exec.ts';

test('explicit profile PATH wins over inheritance and retains the runtime directory', () => {
  const runtime = dirname(process.execPath);
  const profile = CommandProfileSchema.parse({
    bin: '/usr/bin/env',
    env: { inherit: ['PATH'], set: { PATH: '/usr/bin:/usr/sbin:/bin' } },
  });
  expect(childEnv('caller', profile, { PATH: '/untrusted-example' }).PATH).toBe(
    `${runtime}:/usr/bin:/usr/sbin:/bin`,
  );
  const noInheritance = CommandProfileSchema.parse({
    bin: '/usr/bin/env',
    env: { set: { PATH: '/usr/bin:/bin' } },
  });
  expect(childEnv('caller', noInheritance, { PATH: '/untrusted-example' }).PATH).toBe(
    `${runtime}:/usr/bin:/bin`,
  );
  const empty = CommandProfileSchema.parse({
    bin: '/usr/bin/env',
    env: { inherit: ['PATH'], set: { PATH: '' } },
  });
  expect(childEnv('caller', empty, { PATH: '/usr/bin' }).PATH).toBe(runtime);
  const already = CommandProfileSchema.parse({
    bin: '/usr/bin/env',
    env: { set: { PATH: `${runtime}:/usr/bin` } },
  });
  expect(childEnv('caller', already).PATH).toBe(`${runtime}:/usr/bin`);
});

test('the actual spawned executable receives the profile-selected headless PATH', async () => {
  const profile = CommandProfileSchema.parse({
    bin: '/usr/bin/env',
    env: { set: { PATH: '/usr/bin:/usr/sbin:/bin' } },
  });
  const result = await execute(
    {
      id: crypto.randomUUID(),
      ts: '',
      from: 'caller',
      to: 'worker',
      argv: ['environment'],
      stdin: null,
      timeoutMs: 1000,
    },
    { environment: profile },
    new ExecutionAdmission({ maxInflight: 1 }),
  );
  expect(result.failure).toBe('none');
  expect(result.stdout.split('\n')).toContain(`PATH=${dirname(process.execPath)}:/usr/bin:/usr/sbin:/bin`);
});
