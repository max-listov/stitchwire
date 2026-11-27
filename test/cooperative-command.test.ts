import { expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { LocalCallSchema, LocalStreamRequestSchema } from '../packages/contracts/src/door/requests.ts';
import { MAX_COMMAND_TIMEOUT_MS } from '../packages/contracts/src/protocol/bounds.ts';
import { InvocationSchema } from '../packages/contracts/src/protocol/rpc.ts';
import { UNARY_HEADERS_TIMEOUT_MS } from '../packages/local-client/src/operation.ts';
import { COMMAND_RESULT_GRACE_MS, ClientOptionsSchema } from '../packages/local-client/src/options.ts';
import { CommandProfileSchema, StreamProfileSchema } from '../packages/runtime/src/config/profiles.ts';
import { ExecutionAdmission } from '../packages/runtime/src/node/admission.ts';
import { execute } from '../packages/runtime/src/node/exec.ts';
import { drainLaneRpc, type RunningCommand } from '../packages/runtime/src/node/lane-rpc.ts';
import { stillRunning } from '../packages/runtime/src/node/process-state.ts';
import { until } from './support.ts';

const fixture = join(import.meta.dir, 'fixtures/cooperative-command.ts');
const markerSchema = z.strictObject({ pid: z.number().int(), childPid: z.number().int() });

test('the SDK headers backstop lies strictly past the longest command deadline', () => {
  // Equal timers would race at the boundary and a caller could see either verdict (ADR 0009).
  expect(UNARY_HEADERS_TIMEOUT_MS).toBeGreaterThan(MAX_COMMAND_TIMEOUT_MS + COMMAND_RESULT_GRACE_MS);
});

test('long command deadline is shared at each boundary without widening streams', () => {
  const call = { to: 'worker', argv: ['transaction'], timeoutMs: MAX_COMMAND_TIMEOUT_MS };
  expect(LocalCallSchema.safeParse(call).success).toBe(true);
  expect(
    InvocationSchema.safeParse({ ...call, id: crypto.randomUUID(), ts: '', from: 'caller', stdin: null })
      .success,
  ).toBe(true);
  expect(CommandProfileSchema.safeParse({ bin: '/bin/echo', timeoutMs: call.timeoutMs }).success).toBe(true);
  expect(
    ClientOptionsSchema.safeParse({ socketPath: '/tmp/example.sock', timeoutMs: call.timeoutMs }).success,
  ).toBe(false);
  expect(LocalCallSchema.safeParse({ ...call, timeoutMs: MAX_COMMAND_TIMEOUT_MS + 1 }).success).toBe(false);
  expect(
    CommandProfileSchema.safeParse({ bin: '/bin/echo', timeoutMs: MAX_COMMAND_TIMEOUT_MS + 1 }).success,
  ).toBe(false);
  expect(
    LocalStreamRequestSchema.safeParse({ to: 'worker', profile: 'feed', timeoutMs: call.timeoutMs }).success,
  ).toBe(false);
  expect(StreamProfileSchema.safeParse({ bin: '/bin/echo', timeoutMs: call.timeoutMs }).success).toBe(false);
  expect(
    StreamProfileSchema.safeParse({ bin: '/bin/echo', cancellation: { mode: 'cooperative', graceMs: 1000 } })
      .success,
  ).toBe(false);
  for (const graceMs of [0, 900001, Infinity]) {
    expect(
      CommandProfileSchema.safeParse({ bin: '/bin/echo', cancellation: { mode: 'cooperative', graceMs } })
        .success,
    ).toBe(false);
  }
});

type Scenario = {
  mode: 'owner' | 'ignore' | 'orphan' | 'linger';
  /** Stop the run through a shutting-down agent's drain with this grace instead of a withdrawal. */
  drainGraceMs?: number;
  cause: 'cancel' | 'timeout';
  cooperative: boolean;
  graceMs?: number;
};

async function scenario({ mode, cause, cooperative, graceMs = 2000, drainGraceMs }: Scenario) {
  const root = mkdtempSync(join(tmpdir(), 'wire-cooperative-'));
  const marker = join(root, 'ready.json');
  const profile = CommandProfileSchema.parse({
    bin: process.execPath,
    argv: [fixture, mode, marker],
    timeoutMs: 3000,
    ...(cooperative ? { cancellation: { mode: 'cooperative', graceMs } } : {}),
  });
  const withdrawal = new AbortController();
  const command: RunningCommand = { withdrawal, force: new AbortController() };
  const gate = new ExecutionAdmission({ maxInflight: 1 });
  const invocation = InvocationSchema.parse({
    id: crypto.randomUUID(),
    ts: '',
    from: 'caller',
    to: 'worker',
    argv: ['transaction'],
    stdin: null,
    // The deadline must outlast the fixture's start, or a slow spawn reads as "did not start".
    timeoutMs: cause === 'timeout' ? 1000 : 3000,
  });
  const pending = execute(
    invocation,
    { transaction: profile },
    gate,
    withdrawal.signal,
    command.force.signal,
  );
  try {
    const readMarker = (): z.infer<typeof markerSchema> | undefined => {
      try {
        return markerSchema.parse(JSON.parse(readFileSync(marker, 'utf8')));
      } catch {
        return undefined;
      }
    };
    await until(() => readMarker() !== undefined);
    const ready = readMarker();
    if (ready === undefined) throw new Error('fixture did not start');
    let drained: Promise<void> | undefined;
    if (drainGraceMs !== undefined) {
      const task = pending.then(() => {});
      drained = drainLaneRpc(new Map(), new Map([[invocation.id, command]]), new Set([task]), drainGraceMs);
    } else if (cause === 'cancel') {
      withdrawal.abort();
      withdrawal.abort();
    }
    const blocked = gate.acquire('transaction');
    expect(blocked.accepted).toBe(false);
    const result = await pending;
    await drained;
    const events = readdirSync(root).sort();
    expect(result.failure).toBe(cause === 'cancel' ? 'cancelled' : 'timeout');
    // A SIGKILL is delivered, not awaited: wait on the condition, with the clock only as a ceiling.
    expect(await until(() => !stillRunning(ready.pid))).toBe(true);
    expect(await until(() => !stillRunning(ready.childPid))).toBe(true);
    const freed = gate.acquire('transaction');
    expect(freed.accepted).toBe(true);
    if (freed.accepted) freed.release();
    return { result, events };
  } finally {
    withdrawal.abort();
    await pending;
    rmSync(root, { recursive: true, force: true });
  }
}

test('cooperative withdrawal waits for a child transaction beyond ordinary kill grace', async () => {
  const { events } = await scenario({ mode: 'owner', cause: 'cancel', cooperative: true });
  expect(events).toContain('committed');
  expect(events).not.toContain('child-signalled');
  expect(events.filter((name) => name.startsWith('owner-cancellation-'))).toHaveLength(1);
});

test('ordinary group cancellation is a decisive negative control for child preservation', async () => {
  const { events } = await scenario({ mode: 'owner', cause: 'cancel', cooperative: false });
  expect(events).not.toContain('committed');
});

test('cooperative deadline allows the owner to settle its child transaction', async () => {
  const { events } = await scenario({ mode: 'owner', cause: 'timeout', cooperative: true });
  expect(events).toContain('committed');
  expect(events).not.toContain('child-signalled');
});

test('noncooperating owner is force-killed within configured grace', async () => {
  const { events } = await scenario({ mode: 'ignore', cause: 'cancel', cooperative: true, graceMs: 200 });
  // The child commits 1200 ms after start; a 200 ms grace that forced the kill leaves no commit.
  expect(events).not.toContain('committed');
});

test('the owner leaving ends the grace: a descendant it left is killed, not finished', async () => {
  // The owner is the party that decides what happens to its helpers (ADR 0013). One that exits and
  // leaves its child mid-transaction has decided to abandon it, so the child gets KILL, not SIGTERM.
  const { events } = await scenario({ mode: 'orphan', cause: 'cancel', cooperative: true });
  expect(events).not.toContain('committed');
  expect(events).not.toContain('child-signalled');
});

test('a descendant that holds no pipe does not outlive a cooperative stop', async () => {
  // The owner exits on SIGTERM at once; its child holds none of the command's pipes, so completion
  // arrives while the child still runs. Without the final group kill it would run on, unowned.
  const { result } = await scenario({ mode: 'linger', cause: 'cancel', cooperative: true });
  expect(result.failure).toBe('cancelled');
});

test('a shutting-down agent ends a cooperative grace instead of outliving it', async () => {
  // Grace one minute, drain one tenth of a second: the child would commit at 1200 ms, so a commit
  // means drain waited for the owner instead of killing the group it still owned.
  const { result, events } = await scenario({
    mode: 'owner',
    cause: 'cancel',
    cooperative: true,
    graceMs: 60_000,
    drainGraceMs: 100,
  });
  expect(result.failure).toBe('cancelled');
  expect(events).not.toContain('committed');
});

test('already cancelled invocation never spawns its executable', async () => {
  const profile = CommandProfileSchema.parse({ bin: '/nonexistent/example-command' });
  const result = await execute(
    InvocationSchema.parse({
      id: crypto.randomUUID(),
      ts: '',
      from: 'caller',
      to: 'worker',
      argv: ['transaction'],
      stdin: null,
      timeoutMs: 1000,
    }),
    { transaction: profile },
    new ExecutionAdmission({ maxInflight: 1 }),
    AbortSignal.abort(),
  );
  expect(result.failure).toBe('cancelled');
  expect(result.detail).toContain('before execution');
});

test('JSON validation preserves stderr truncation independently of stdout parse success', async () => {
  for (const [stdout, stderrBytes, expectedTruncated, failure] of [
    ['not-json', 1025, true, 'exec'],
    ['{}', 1025, true, 'none'],
    ['not-json', 10, false, 'exec'],
  ] as const) {
    const profile = CommandProfileSchema.parse({
      bin: process.execPath,
      argv: [
        '--eval',
        `process.stdout.write(${JSON.stringify(stdout)});process.stderr.write('e'.repeat(${stderrBytes}));`,
      ],
      outputBytes: 1024,
      output: { mode: 'json' },
    });
    const result = await execute(
      InvocationSchema.parse({
        id: crypto.randomUUID(),
        ts: '',
        from: 'caller',
        to: 'worker',
        argv: ['inspect'],
        stdin: null,
        timeoutMs: 5000,
      }),
      { inspect: profile },
      new ExecutionAdmission({ maxInflight: 1 }),
      new AbortController().signal,
    );
    expect(result).toMatchObject({ failure, truncated: expectedTruncated, code: 0 });
    expect(Buffer.byteLength(result.stderr)).toBe(Math.min(1024, stderrBytes));
  }
});
