import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CommandProfile, CommandProfileSchema } from '../packages/runtime/src/config/profiles.ts';
import { ExecutionAdmission } from '../packages/runtime/src/node/admission.ts';
import { execute } from '../packages/runtime/src/node/exec.ts';
import { InvocationSchema } from '../packages/contracts/src/protocol/rpc.ts';

const cursor = (prefix: 'epg1_' | 'erc1_' | 'elg1_' | 'ecr1_'): string => `${prefix}${'a'.repeat(43)}`;

function invocation(name: string, args: string[] = []) {
  return InvocationSchema.parse({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: 'consumer',
    to: 'owner-node',
    argv: [name, ...args],
    stdin: null,
    // Ten seconds, not one, and it is not a hint that anything here is slow: the fixture spawns a
    // real process, and under the full suite the machine is running dozens of them. A one-second
    // deadline made this test report `timeout` for a correct catch-up on 2026-09-01 — it was
    // measuring the load, not the behaviour. Nothing in this file asserts how fast the work is.
    timeoutMs: 10_000,
  });
}

function admission(): ExecutionAdmission {
  return new ExecutionAdmission({ maxInflight: 8, maxCallsPerMinute: 600 });
}

function ownerProfiles(bin: string, marker: string): Record<string, CommandProfile> {
  const common = {
    bin,
    stdin: { mode: 'none' as const },
    env: { set: { FIXTURE_MARKER: marker } },
    timeoutMs: 10_000,
    outputBytes: 1_048_576,
  };
  return {
    'example-page': CommandProfileSchema.parse({
      ...common,
      argv: ['journal'],
      callerArgs: {
        mode: 'options',
        options: {
          '--after': { type: 'opaque', prefix: 'epg1_', minBytes: 48, maxBytes: 48 },
          '--limit': { type: 'integer', min: 1, max: 500 },
        },
      },
    }),
    'example-record': CommandProfileSchema.parse({
      ...common,
      argv: ['receipt'],
      callerArgs: {
        mode: 'options',
        options: {
          '--reference': {
            type: 'opaque',
            prefix: 'erc1_',
            minBytes: 48,
            maxBytes: 48,
            required: true,
          },
          '--max-bytes': { type: 'integer', min: 1_024, max: 1_048_576 },
        },
      },
    }),
    'example-log': CommandProfileSchema.parse({
      ...common,
      argv: ['log'],
      callerArgs: {
        mode: 'options',
        options: {
          '--reference': {
            type: 'opaque',
            prefix: 'elg1_',
            minBytes: 48,
            maxBytes: 48,
            required: true,
          },
          '--after': { type: 'opaque', prefix: 'ecr1_', minBytes: 48, maxBytes: 48 },
          '--max-bytes': { type: 'integer', min: 256, max: 65_536 },
          '--max-lines': { type: 'integer', min: 1, max: 200 },
        },
      },
    }),
  };
}

function fixture(applicationCount = 2): {
  profiles: Record<string, CommandProfile>;
  marker: string;
  journal: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'stitchwire-owner-profile-'));
  const marker = join(dir, 'executed');
  const bin = join(dir, 'owner-fixture');
  const journal = `${JSON.stringify({
    schema: 'fixture-owner-page/v1',
    status: 'ok',
    records: Array.from({ length: applicationCount }, (_, index) => ({ app: `application-${index}` })),
    nextCursor: null,
  })}\n`;
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FIXTURE_MARKER ?? '', 'executed\\n');
const operation = Bun.argv[2];
const outputs = {
  journal: ${JSON.stringify(journal)},
  receipt: '{"schema":"fixture-owner-receipt/v1","status":"unknown-reference"}\\n',
  log: '{"schema":"fixture-owner-log/v1","status":"ok","entries":[],"nextCursor":null}\\n',
};
process.stdout.write(outputs[operation] ?? '');
`,
  );
  chmodSync(bin, 0o755);
  return { profiles: ownerProfiles(bin, marker), marker, journal };
}

test('offline catch-up uses one three-profile owner lane without any wake-up event', async () => {
  for (const registeredApplications of [1, 10, 100]) {
    const { profiles, journal } = fixture(registeredApplications);
    expect(Object.keys(profiles).sort()).toEqual(['example-log', 'example-page', 'example-record']);
    expect(Object.keys(profiles)).toHaveLength(3);
    const result = await execute(
      invocation('example-page', ['--after', cursor('epg1_'), '--limit', '500']),
      profiles,
      admission(),
    );
    expect(result.failure).toBe('none');
    expect(result.stdout).toBe(journal);
  }
});

test('typed owner failures cross the fixed RPC profile byte-for-byte', async () => {
  const { profiles } = fixture();
  const expected = '{"schema":"fixture-owner-receipt/v1","status":"unknown-reference"}\n';
  const result = await execute(
    invocation('example-record', ['--reference', cursor('erc1_')]),
    profiles,
    admission(),
  );
  expect(result.failure).toBe('none');
  expect(result.stdout).toBe(expected);
});

test('typed options reject path, operation and bound injection before owner execution', async () => {
  const cases: Array<[string, string[]]> = [
    ['example-page', ['--root', '/tmp/application']],
    ['example-page', ['--after', '/tmp/application']],
    ['example-page', ['--limit', '501']],
    ['example-page', ['--limit', '01']],
    ['example-record', ['--reference', cursor('elg1_')]],
    ['example-record', ['--max-bytes', '1024']],
    ['example-log', ['--reference', cursor('elg1_'), '--reference', cursor('elg1_')]],
    ['example-log', ['--reference', cursor('elg1_'), '--max-lines', '201']],
    ['example-log', ['--reference', cursor('elg1_'), '--after', '$(touch_owned)']],
  ];

  for (const [name, args] of cases) {
    const { profiles, marker } = fixture();
    const result = await execute(invocation(name, args), profiles, admission());
    expect(result.failure).toBe('denied');
    expect(existsSync(marker)).toBe(false);
  }
});

test('profile schema rejects caller-option policies that cannot fit transport bounds', () => {
  expect(() =>
    CommandProfileSchema.parse({
      bin: '/fixture/owner',
      callerArgs: {
        mode: 'options',
        options: {
          '--cursor': { type: 'opaque', minBytes: 2, maxBytes: 1 },
        },
      },
    }),
  ).toThrow();
  expect(() =>
    CommandProfileSchema.parse({
      bin: '/fixture/owner',
      callerArgs: { mode: 'options', options: {} },
    }),
  ).toThrow();
});

test('a profile that declares JSON output is answered by the node, not by the caller parser', async () => {
  const { execute } = await import('../packages/runtime/src/node/exec.ts');
  const { ExecutionAdmission } = await import('../packages/runtime/src/node/admission.ts');
  const { CommandProfileSchema } = await import('../packages/runtime/src/config/profiles.ts');
  const gate = new ExecutionAdmission({ maxInflight: 4 });
  const call = (name: string) => ({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: 'caller',
    to: 'worker',
    argv: [name],
    stdin: null,
    timeoutMs: 5_000,
  });
  const declared = (argv: string[], json: boolean) => ({
    emit: CommandProfileSchema.parse({
      bin: '/bin/echo',
      argv,
      ...(json ? { output: { mode: 'json' } } : {}),
    }),
  });

  const good = await execute(call('emit'), declared(['{"ok":true}'], true), gate);
  expect(good.failure).toBe('none');
  expect(JSON.parse(good.stdout)).toEqual({ ok: true });

  // The caller learns the command broke its own declaration — as a failure, not as a successful
  // call whose body happens to be unparseable.
  const bad = await execute(call('emit'), declared(['not json at all'], true), gate);
  expect(bad.failure).toBe('exec');
  expect(bad.detail).toContain('declares JSON output');

  // A profile that declares nothing keeps the behaviour every profile had before the field existed.
  const raw = await execute(call('emit'), declared(['not json at all'], false), gate);
  expect(raw.failure).toBe('none');
});
