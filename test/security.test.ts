import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_ARG_BYTES, MAX_ARG_COUNT, MAX_STDIN_BYTES } from '../packages/contracts/src/protocol/bounds.ts';
import { InvocationSchema, ResultSchema } from '../packages/contracts/src/protocol/rpc.ts';
import { createAudit } from '../packages/runtime/src/broker/audit.ts';
import { Registry } from '../packages/runtime/src/broker/registry.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { CommandProfileSchema } from '../packages/runtime/src/config/profiles.ts';
import { ExecutionAdmission, PublishAdmission } from '../packages/runtime/src/node/admission.ts';
import { childEnv, execute } from '../packages/runtime/src/node/exec.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { stillRunning } from '../packages/runtime/src/node/process-state.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

const TOKEN = 't'.repeat(40);

function invocation(input: { argv: string[]; stdin?: string | null; timeoutMs?: number }) {
  return InvocationSchema.parse({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    from: 'caller',
    to: 'executor',
    argv: input.argv,
    stdin: input.stdin ?? null,
    timeoutMs: input.timeoutMs ?? 1_000,
  });
}

function admission(maxCallsPerMinute = 600): ExecutionAdmission {
  return new ExecutionAdmission({ maxInflight: 8, maxCallsPerMinute });
}

test('a capability grant is operation-scoped and grants nothing beside itself', () => {
  const broker = BrokerConfigSchema.parse({
    nodes: [
      { id: 'caller', tokenSha256s: [sha256(TOKEN)] },
      { id: 'executor', tokenSha256s: [sha256('e'.repeat(40))] },
    ],
    capabilities: { caller: [{ operation: 'peer', targets: ['executor'] }] },
    commandGrants: [
      { caller: 'caller', targets: ['executor'], command: 'echo' },
      { caller: 'caller', targets: ['executor'], command: 'probe' },
      { caller: 'caller', targets: ['executor'], command: 'sleep' },
      { caller: 'caller', targets: ['executor'], command: 'tree' },
    ],
  });
  const registry = new Registry(broker);
  expect(registry.authenticate('caller', TOKEN)).toBe(true);
  expect(registry.mayPerform('peer', 'caller', 'executor')).toBe(true);
  // Command execution is no longer implied by reachability: it is granted per command, and an
  // unnamed command is refused even to a caller that may observe the same node.
  expect(registry.mayInvokeCommand('caller', 'executor', 'echo')).toBe(true);
  expect(registry.mayInvokeCommand('caller', 'executor', 'undeclared')).toBe(false);
  expect(registry.mayInvokeCommand('stranger', 'executor', 'echo')).toBe(false);
  expect(registry.mayPerform('stream', 'caller', 'executor')).toBe(false);
  expect(registry.mayPerform('publish', 'caller', 'executor')).toBe(false);
  expect(registry.mayPerform('subscribe', 'caller', 'executor')).toBe(false);
});

test('a command must declare what it allows; the bare-path form is refused', () => {
  const node = NodeConfigSchema.parse({
    brokers: [{ id: 'primary', url: 'https://wire.example.com', token: TOKEN }],
    nodeId: 'executor',
    allow: {
      declared: {
        bin: '/bin/echo',
        callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
        stdin: { mode: 'text', maxBytes: 1048576 },
        timeoutMs: 900_000,
        concurrency: 128,
      },
    },
  });
  expect(node.allow.declared?.bin).toBe('/bin/echo');
  expect(node.allow.declared?.callerArgs.mode).toBe('append');
  expect(node.allow.declared?.stdin.mode).toBe('text');
  // `name → absolute binary` used to expand into exactly the profile above. It was retired because
  // a per-command grant on the broker cannot mean anything while a granted command accepts any
  // argv: the grant names an operation, and inside it everything was permitted. The capability is
  // unchanged — a command still runs on demand — but it has to say what it allows.
  expect(
    NodeConfigSchema.safeParse({
      brokers: [{ id: 'primary', url: 'https://wire.example.com', token: TOKEN }],
      nodeId: 'executor',
      allow: { bare: '/bin/echo' },
    }).success,
  ).toBe(false);
  expect(node.admission.maxPendingPublishes).toBe(32);
  expect(node.admission.maxPublishesPerMinute).toBe(600);
  expect(node.admission.publishAckTimeoutMs).toBe(5_000);
});

test('the shapes this project stopped carrying are refused, not quietly normalised', () => {
  // Both were live inputs once and are gone. Refusing them is the point: a config that names a form
  // nobody supports must fail at load, on the machine, rather than start something subtly different.
  const withAcl = BrokerConfigSchema.safeParse({
    nodes: [{ id: 'caller', tokenSha256s: [sha256(TOKEN)] }],
    acl: { caller: ['executor'] },
  });
  expect(withAcl.success).toBe(false);

  const withRetiredPair = NodeConfigSchema.safeParse({
    url: 'https://wire.example.com',
    token: TOKEN,
    nodeId: 'executor',
    allow: {},
  });
  expect(withRetiredPair.success).toBe(false);
});

test('bounded two-digest rotation accepts either digest and rejects a third', () => {
  const nextToken = 'n'.repeat(40);
  const config = BrokerConfigSchema.parse({
    nodes: [{ id: 'caller', tokenSha256s: [sha256(TOKEN), sha256(nextToken)] }],
  });
  const registry = new Registry(config);
  expect(registry.authenticate('caller', TOKEN)).toBe(true);
  expect(registry.authenticate('caller', nextToken)).toBe(true);
  expect(registry.authenticate('caller', 'x'.repeat(40))).toBe(false);
  expect(() =>
    BrokerConfigSchema.parse({
      nodes: [
        {
          id: 'caller',
          tokenSha256s: [sha256(TOKEN), sha256(nextToken), sha256('x'.repeat(40))],
        },
      ],
    }),
  ).toThrow();
});

test('publish admission bounds pending work, timeout and disconnect cleanup', async () => {
  const admission = new PublishAdmission({
    maxPendingPublishes: 2,
    publishAckTimeoutMs: 100,
  });
  const first = admission.dispatch(() => true);
  const second = admission.dispatch(() => true);
  expect(admission.status().pending).toBe(2);
  expect((await admission.dispatch(() => true)).detail).toContain('pending publish limit');
  admission.disconnect();
  expect((await first).failure).toBe('transport');
  expect((await second).failure).toBe('transport');
  expect(admission.status().pending).toBe(0);

  const timed = admission.dispatch(() => true);
  expect((await timed).failure).toBe('timeout');
  expect(admission.status().pending).toBe(0);
});

test('protocol rejects oversized argv and stdin before admission', () => {
  expect(() => invocation({ argv: Array.from({ length: MAX_ARG_COUNT + 1 }, () => 'x') })).toThrow();
  expect(() => invocation({ argv: ['probe', 'x'.repeat(MAX_ARG_BYTES)] })).toThrow();
  expect(() => invocation({ argv: ['echo'], stdin: 'x'.repeat(MAX_STDIN_BYTES + 1) })).toThrow();
  expect(() => invocation({ argv: ['echo'], stdin: '🙂'.repeat(MAX_STDIN_BYTES / 2) })).toThrow();
});

test('profile fixes base argv and rejects unapproved caller args and stdin', async () => {
  const profile = CommandProfileSchema.parse({
    bin: '/usr/bin/printf',
    argv: ['fixed:%s'],
    callerArgs: { mode: 'append', maxCount: 1, maxBytes: 8, allowedValues: ['ok'] },
    stdin: { mode: 'none' },
    timeoutMs: 1_000,
  });
  const allowed = { probe: profile };

  const ok = await execute(invocation({ argv: ['probe', 'ok'] }), allowed, admission());
  expect(ok.failure).toBe('none');
  expect(ok.stdout).toBe('fixed:ok');

  const badArg = await execute(invocation({ argv: ['probe', 'nope'] }), allowed, admission());
  expect(badArg.failure).toBe('denied');
  const badStdin = await execute(
    invocation({ argv: ['probe', 'ok'], stdin: 'secret' }),
    allowed,
    admission(),
  );
  expect(badStdin.failure).toBe('denied');
});

test('profile env is an allowlist and output is capped observably', async () => {
  const envProfile = CommandProfileSchema.parse({ bin: '/usr/bin/env', outputBytes: 64 * 1024 });
  const env = childEnv('caller', envProfile, { PATH: '/usr/bin:/bin', STITCHWIRE_SECRET: 'never' });
  expect(env.STITCHWIRE_SECRET).toBeUndefined();
  expect(env.STITCHWIRE_CALLER).toBe('caller');
  expect(
    childEnv(
      'authenticated',
      CommandProfileSchema.parse({
        bin: '/usr/bin/env',
        env: { set: { STITCHWIRE_CALLER: 'spoofed' }, inherit: ['STITCHWIRE_CALLER'] },
      }),
      { STITCHWIRE_CALLER: 'inherited' },
    ).STITCHWIRE_CALLER,
  ).toBe('authenticated');

  const result = await execute(invocation({ argv: ['env'] }), { env: envProfile }, admission());
  expect(result.failure).toBe('none');
  expect(result.stdout).not.toContain('STITCHWIRE_SECRET');
  expect(result.stdout).toContain('STITCHWIRE_CALLER=caller');

  const outputProfile = CommandProfileSchema.parse({
    bin: '/usr/bin/yes',
    argv: ['🙂'],
    outputBytes: 1_024,
    timeoutMs: 2_000,
  });
  const output = await execute(
    invocation({ argv: ['output'], timeoutMs: 2_000 }),
    { output: outputProfile },
    admission(),
  );
  expect(output.truncated).toBe(true);
  expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(1_024);
  expect(ResultSchema.safeParse(output).success).toBe(true);
});

test('node admission enforces profile concurrency and rate without spawning excess work', async () => {
  const profile = CommandProfileSchema.parse({
    bin: '/bin/sleep',
    callerArgs: { mode: 'append', maxCount: 1, maxBytes: 2, allowedValues: ['1'] },
    timeoutMs: 2_000,
    concurrency: 1,
  });
  const gate = admission(2);
  // `execute` takes its admission lease before its first await, so the slot is held from here on.
  const first = execute(invocation({ argv: ['sleep', '1'], timeoutMs: 2_000 }), { sleep: profile }, gate);
  const concurrent = await execute(
    invocation({ argv: ['sleep', '1'], timeoutMs: 2_000 }),
    { sleep: profile },
    gate,
  );
  expect(concurrent.failure).toBe('denied');
  expect(concurrent.refusal).toBe('capacity');
  // A concurrency ceiling frees when the call ahead finishes — that is not a time, so no hint.
  expect(concurrent.retryAfterMs).toBeNull();
  expect(concurrent.detail).toContain('concurrency');
  expect((await first).failure).toBe('none');

  const once = await execute(
    invocation({ argv: ['sleep', '1'], timeoutMs: 2_000 }),
    { sleep: profile },
    gate,
  );
  expect(once.failure).toBe('none');
  const rate = await execute(
    invocation({ argv: ['sleep', '1'], timeoutMs: 2_000 }),
    { sleep: profile },
    gate,
  );
  expect(rate.failure).toBe('denied');
  expect(rate.refusal).toBe('capacity');
  expect(rate.retryAfterMs).not.toBeNull();
  expect(rate.retryAfterMs ?? 0).toBeGreaterThan(0);
  expect(rate.retryAfterMs ?? 0).toBeLessThanOrEqual(60_000);
  expect(rate.detail).toContain('rate');
});

test('broker admission enforces caller inflight and rate budgets', async () => {
  const port = freePort();
  const executorToken = 'e'.repeat(40);
  const auditPath = join(mkdtempSync(join(tmpdir(), 'stitchwire-broker-')), 'audit.jsonl');
  const broker = await startBroker(
    brokerConfig(
      { caller: TOKEN, executor: executorToken },
      {
        port,
        capabilities: { caller: [{ operation: 'peer', targets: ['executor'] }] },
        commandGrants: [
          { caller: 'caller', targets: ['executor'], command: 'echo' },
          { caller: 'caller', targets: ['executor'], command: 'probe' },
          { caller: 'caller', targets: ['executor'], command: 'sleep' },
          { caller: 'caller', targets: ['executor'], command: 'tree' },
        ],
        admission: { maxInflightPerNode: 1, maxCallsPerMinutePerNode: 2 },
        auditPath,
      },
    ),
  );
  const caller = createAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token: TOKEN }],
      nodeId: 'caller',
    }),
  );
  const executor = createAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token: executorToken }],
      nodeId: 'executor',
      allow: {
        sleep: {
          bin: '/bin/sleep',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
        echo: {
          bin: '/bin/echo',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
      },
    }),
  );
  await waitConnected(caller, executor);

  try {
    const first = caller.call({ to: 'executor', argv: ['sleep', '1'], stdin: null });
    // The broker admits the first call over the wire and exposes no inflight count to wait on; this
    // pause only orders the two calls, and the first one's one-second run is far longer than it.
    await Bun.sleep(50);
    const inflight = await caller.call({ to: 'executor', argv: ['echo', 'blocked'], stdin: null });
    expect(inflight.failure).toBe('denied');
    expect(inflight.refusal).toBe('capacity');
    expect(inflight.retryAfterMs).toBeNull();
    expect(inflight.detail).toContain('inflight');
    expect((await first).failure).toBe('none');

    const second = await caller.call({ to: 'executor', argv: ['echo', 'accepted'], stdin: null });
    expect(second.failure).toBe('none');
    const rate = await caller.call({ to: 'executor', argv: ['echo', 'blocked'], stdin: null });
    expect(rate.failure).toBe('denied');
    expect(rate.refusal).toBe('capacity');
    expect(rate.retryAfterMs ?? 0).toBeGreaterThan(0);
    expect(rate.detail).toContain('rate');
  } finally {
    await caller.stop();
    await executor.stop();
    await broker.stop();
  }
});

test('timeout terminates the exact process group including descendants', async () => {
  const profile = CommandProfileSchema.parse({
    bin: '/bin/sh',
    argv: ['-c', '/bin/sh -c \'trap "" TERM; echo $$; exec /bin/sleep 30\' & child=$!; wait'],
    timeoutMs: 1_000,
  });
  const result = await execute(invocation({ argv: ['tree'] }), { tree: profile }, admission());
  expect(result.failure).toBe('timeout');
  const childPid = Number(result.stdout.trim());
  expect(Number.isInteger(childPid)).toBe(true);
  // Wait for the CONDITION, and ask the right one. `process.kill(pid, 0)` succeeds for a zombie —
  // an exited process its parent has not reaped — so the bare probe would call a dead descendant
  // alive and fail this assertion on any machine whose supervisor does not reap. The sleep was a
  // duration where a state was needed, which is the same defect one layer up.
  const gone = await until(() => !stillRunning(childPid));
  if (!gone) process.kill(childPid, 'SIGKILL');
  expect(gone).toBe(true);
});

test('audit is asynchronous, redacted and exposes write failures', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stitchwire-audit-'));
  const path = join(dir, 'audit.jsonl');
  const audit = await createAudit(path);
  audit.write({
    kind: 'call',
    id: crypto.randomUUID(),
    from: 'caller',
    to: 'executor',
    command: 'probe',
    refusal: 'none',
    argc: 2,
    argvBytes: 30,
    stdinBytes: 40,
    accepted: true,
    failure: 'none',
    transportCause: null,
    detail: '',
  });
  expect(audit.status().queued).toBe(1);
  await audit.flush();
  const line = readFileSync(path, 'utf8');
  expect(line).toContain('"command":"probe"');
  expect(line).toContain('"stdinBytes":40');
  expect(line).not.toContain('sensitive argument');
  expect(audit.status().writeFailures).toBe(0);

  const boundedPath = join(dir, 'bounded.jsonl');
  const bounded = await createAudit(boundedPath, 1);
  bounded.write({ kind: 'disconnect', nodeId: 'caller', broker: 'test:0', reason: 'first' });
  bounded.write({ kind: 'disconnect', nodeId: 'caller', broker: 'test:0', reason: 'overflow' });
  expect(bounded.status().dropped).toBe(1);
  await bounded.flush();
  expect(readFileSync(boundedPath, 'utf8')).not.toContain('overflow');
  await Promise.all([audit.close(), bounded.close()]);

  // A path that cannot be a journal is now refused when the journal is opened, not on the first
  // record. That is the better half of the change: an unusable audit path stops the process at
  // startup instead of running a broker whose record-keeping silently fails.
  await expect(createAudit(dir)).rejects.toThrow();

  // The other half still has to hold: a failure that arrives AFTER a healthy start is reported,
  // never swallowed. Forced by taking write permission away from the directory and then making the
  // journal roll, which is the failure an operator actually meets — a volume that filled up or a
  // permission that changed under a running process.
  const rollingDir = mkdtempSync(join(tmpdir(), 'stitchwire-audit-roll-'));
  const rollingPath = join(rollingDir, 'audit.jsonl');
  const rolling = await createAudit(rollingPath, 4_096, { maxBytes: 1024, keep: 2 });
  rolling.write({ kind: 'disconnect', nodeId: 'caller', broker: 'test:0', reason: 'before' });
  await rolling.flush();
  chmodSync(rollingDir, 0o500);
  try {
    // Enough to cross a 1 KB ceiling once. An earlier shape of this wrote two hundred records and
    // made a neighbouring test time out — a probe that destabilises its neighbours is not paying
    // for itself, and one rotation proves the same thing as fifty.
    for (let index = 0; index < 20; index += 1)
      rolling.write({
        kind: 'disconnect',
        nodeId: 'caller',
        broker: 'test:0',
        reason: `fill-${index}`.padEnd(80, 'x'),
      });
    await rolling.flush();
    expect(rolling.status().writeFailures).toBeGreaterThan(0);
    expect(rolling.status().lastFailure).not.toBeNull();
  } finally {
    chmodSync(rollingDir, 0o700);
    await rolling.close();
  }
});
