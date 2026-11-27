/**
 * The wire, end to end, in one process: a real broker, two real agents, real child processes.
 *
 * Everything asserted here is a property the fleet depends on and cannot check by inspection —
 * that a refusal is a refusal and not a zero exit, that an allowlist is enforced on the RECEIVING
 * side, and that a missing peer fails fast instead of hanging until someone's deadline.
 */

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { temporaryFile } from './temporary.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { CommandProfileSchema } from '../packages/runtime/src/config/profiles.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

const PORT = freePort();
const TOKEN_A = 'a'.repeat(40);
const TOKEN_B = 'b'.repeat(40);

let broker: Awaited<ReturnType<typeof startBroker>>;
let alpha: Agent; // caller, and callable
let bravo: Agent; // executor

beforeAll(async () => {
  broker = await startBroker(
    brokerConfig(
      { alpha: TOKEN_A, bravo: TOKEN_B, ghost: 'never-connects-'.padEnd(40, 'x') },
      {
        port: PORT,
        // bravo is deliberately absent: default-deny must be observable
        capabilities: { alpha: [{ operation: 'peer', targets: ['*'] }] },
        commandGrants: [
          { caller: 'alpha', targets: ['bravo'], command: 'rm' },
          { caller: 'alpha', targets: ['*'], command: 'cat' },
          { caller: 'alpha', targets: ['*'], command: 'echo' },
          { caller: 'alpha', targets: ['*'], command: 'probe' },
          { caller: 'alpha', targets: ['*'], command: 'sleeper' },
        ],
      },
    ),
  );

  const lane = (token: string) => ({
    brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token }],
    defaultTimeoutMs: 10_000,
  });
  alpha = createAgent(NodeConfigSchema.parse({ ...lane(TOKEN_A), nodeId: 'alpha', allow: {} }));
  bravo = createAgent(
    NodeConfigSchema.parse({
      ...lane(TOKEN_B),
      nodeId: 'bravo',
      allow: {
        echo: {
          bin: '/bin/echo',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
        cat: {
          bin: '/bin/cat',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
        sleeper: {
          bin: '/bin/sleep',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
      },
    }),
  );
  await waitConnected(alpha, bravo);
});

afterAll(async () => {
  await alpha?.stop();
  await bravo?.stop();
  await broker?.stop();
});

test('a call crosses the broker and returns the command’s own output and exit code', async () => {
  const r = await alpha.call({ to: 'bravo', argv: ['echo', 'across the wire'], stdin: null });
  expect(r.failure).toBe('none');
  expect(r.code).toBe(0);
  expect(r.stdout).toBe('across the wire\n');
});

test('stdin travels with the call instead of through argv', async () => {
  const body = 'line one\nline "two"; $HOME\n';
  const r = await alpha.call({ to: 'bravo', argv: ['cat'], stdin: body });
  expect(r.failure).toBe('none');
  expect(r.stdout).toBe(body);
});

test('a non-zero exit is the command’s verdict, not a transport failure', async () => {
  const r = await alpha.call({ to: 'bravo', argv: ['cat', '/no/such/file'], stdin: null });
  expect(r.failure).toBe('none'); // the call itself worked perfectly
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain('/no/such/file');
});

test('the receiving node refuses anything outside its own allowlist', async () => {
  // Granted at the BROKER on purpose. The broker's per-command table and the node's allowlist are
  // two independent authorities, and this test is about the second: a node refuses what it never
  // declared, even when the router was told the caller may ask for it. ADR 0002 is why — the
  // machine bearing the consequence keeps the final gate.
  const r = await alpha.call({ to: 'bravo', argv: ['rm', '-rf', '/'], stdin: null });
  expect(r.failure).toBe('denied');
  expect(r.detail).toContain('allowlist');
  expect(r.stdout).toBe('');
});

test('policy is default-deny: a node with no ACL entry reaches nobody', async () => {
  const r = await bravo.call({ to: 'alpha', argv: ['echo', 'nope'], stdin: null });
  expect(r.failure).toBe('denied');
  expect(r.detail).toContain('bravo → alpha');
});

test('a registered but absent node fails immediately, not at the deadline', async () => {
  const started = Date.now();
  const r = await alpha.call({ to: 'ghost', argv: ['echo', 'hi'], stdin: null, timeoutMs: 60_000 });
  expect(r.failure).toBe('offline');
  expect(Date.now() - started).toBeLessThan(2_000);
});

test('a command that overruns its deadline is killed and reported as a timeout', async () => {
  const r = await alpha.call({ to: 'bravo', argv: ['sleeper', '30'], stdin: null, timeoutMs: 1_500 });
  expect(r.failure).toBe('timeout');
});

test('the roster names every registered node, connected or not', async () => {
  const status = await alpha.status();
  expect(status.connected).toBe(true);
  const byId = Object.fromEntries(status.nodes.map((n) => [n.nodeId, n]));
  expect(byId.bravo?.serves).toBe(true);
  expect(byId.ghost?.online).toBe(false);
});

test('a bad token never reaches the contract layer', async () => {
  const impostor = createAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token: 'z'.repeat(40) }],
      nodeId: 'alpha',
      allow: {},
    }),
  );
  // The broker answers the dial and refuses it: wait for that answer, not for a stretch of time.
  expect(await until(async () => (await impostor.status()).lanes[0]?.lastFailure?.refused === true)).toBe(
    true,
  );
  expect(impostor.connected).toBe(false);
  const r = await impostor.call({ to: 'bravo', argv: ['echo', 'hi'], stdin: null });
  expect(r.failure).toBe('transport');
  await impostor.stop();
});

test('a second agent refuses to steal a live agent’s socket', async () => {
  // The failure this pins: an unconditional unlink lets a hand-started second instance silently
  // take the path while the first keeps serving into a socket nobody can reach.
  const { startAgent } = await import('../packages/runtime/src/node/agent-application.ts');
  const socketPath = temporaryFile('claim.sock');
  // A previous failed run may have left anything here — a regular file included, which the
  // framework rightly refuses to touch. The test owns this path; start from a clean one.
  const { rmSync } = await import('node:fs');
  rmSync(socketPath, { force: true });
  const cfg = NodeConfigSchema.parse({
    brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token: TOKEN_A }],
    nodeId: 'alpha',
    allow: {},
    agentSocket: socketPath,
  });
  const first = await startAgent(cfg);
  try {
    // The framework's probe-then-unlink refuses a path answered by a live listener instead of
    // silently robbing it — the split-brain my hand-rolled claim used to allow.
    const refusedAt = performance.now();
    const failure = await startAgent(cfg).then(
      () => undefined,
      (error: unknown) => error as Error,
    );
    const refusalMs = performance.now() - refusedAt;
    // The journal's exclusive lock now catches a second agent BEFORE the socket claim does, and
    // says so in this fleet's words rather than as a syscall. The property under test is unchanged:
    // a second agent is refused rather than allowed to rob a live one, and it is refused promptly.
    expect(failure?.message).toContain('locked by this machine');
    // And it arrives PROMPTLY. stitchkit 0.61 made a failed startup roll back on the application's
    // own shutdown budget, so on the framework defaults this refusal could take 35 seconds — during
    // a rollout that reads as a hang rather than as the clean refusal it is. The declared budget is
    // what keeps it immediate, and a number nobody asserts is a number that quietly stops being true.
    expect(refusalMs).toBeLessThan(3_000);
    // And it arrives UNWRAPPED, which is the real assertion here. A resource becomes
    // rollback-eligible the moment its `start` is invoked, so every teardown callback must survive
    // a start that produced nothing. When one of ours did not, its own crash joined the rollback
    // and the honest "socket is in use" became an AggregateError about an undefined `shutdown` —
    // a diagnosis destroyed by the cleanup of the thing being diagnosed.
    expect(failure?.constructor.name).toBe('Error');
  } finally {
    await first.stop();
  }
  // A REGULAR file at the path is not a dead socket — it is something else, and destroying it
  // silently would be worse than failing. The framework's isSocket() guard is stricter than the
  // hand-rolled claim it replaced, which would have deleted this file without asking.
  await Bun.write(socketPath, '');
  expect(startAgent(cfg)).rejects.toThrow('not a socket');
  const { unlinkSync } = await import('node:fs');
  unlinkSync(socketPath);

  // A genuinely stale SOCKET — left by a SIGKILLed process — must be reclaimed without manual help.
  const holder = Bun.spawn([
    'bun',
    '-e',
    `Bun.serve({ unix: ${JSON.stringify(socketPath)}, fetch: () => new Response('x') }); setTimeout(() => {}, 60_000);`,
  ]);
  const { existsSync } = await import('node:fs');
  expect(await until(() => existsSync(socketPath))).toBe(true);
  holder.kill(9);
  await holder.exited;
  const second = await startAgent(cfg);
  expect(second.socketPath).toBe(socketPath);
  await second.stop();
});

test('an allowed command finds the runtime that the agent itself runs on', async () => {
  // Regression for a defect that blocked the fleet dashboard build: under systemd the service has a
  // minimal PATH, and a script with the shebang `#!/usr/bin/env bun` failed before its first line of
  // code. We check through the whole wire with a real script with such a shebang, not on a mock of the
  // environment.
  const { childEnv } = await import('../packages/runtime/src/node/exec.ts');
  const { dirname } = await import('node:path');

  const runtimeDir = dirname(process.execPath);
  const profile = CommandProfileSchema.parse({ bin: '/bin/echo', env: { inherit: ['PATH'] } });

  // Exactly the systemd case: PATH is minimal, the runtime is not in it — we prepend it.
  const bare = childEnv('alpha', profile, { PATH: '/usr/bin:/bin' });
  expect(bare.PATH).toBe(`${runtimeDir}:/usr/bin:/bin`);
  // The machine's own paths must survive: replacing PATH would break commands that need
  // /usr/local/bin, instead of fixing the one.
  expect(bare.PATH).toContain('/usr/bin');

  // Already there — we do not duplicate it.
  const already = childEnv('alpha', profile, { PATH: `${runtimeDir}:/usr/bin` });
  expect(already.PATH).toBe(`${runtimeDir}:/usr/bin`);

  // The node secret does not travel into the command.
  expect(
    childEnv('alpha', profile, { PATH: '', STITCHWIRE_TOKEN: 'secret' }).STITCHWIRE_TOKEN,
  ).toBeUndefined();

  const script = temporaryFile('shebang-probe');
  await Bun.write(script, '#!/usr/bin/env bun\nconsole.log("runtime found")\n');
  await Bun.spawn(['chmod', '+x', script]).exited;

  const shebangNode = createAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token: TOKEN_B }],
      nodeId: 'bravo',
      allow: { probe: { bin: script, timeoutMs: 900_000 } },
    }),
  );
  await waitConnected(shebangNode);
  try {
    const r = await alpha.call({ to: 'bravo', argv: ['probe'], stdin: null });
    expect(r.failure).toBe('none');
    expect(r.stdout.trim()).toBe('runtime found');
  } finally {
    await shebangNode.stop();
  }
});

test('large output arrives through a pipe in full, not just up to the pipe buffer', async () => {
  // Regression for a silent data loss: `process.exit()` cut the process off without waiting for stdout
  // to drain, and exactly 65536 bytes went into the pipe — with a zero exit code and an empty stderr.
  // To a file everything arrived, so the defect hid from any check made through `>`.
  const script = temporaryFile('bigout.ts');
  await Bun.write(
    script,
    `const payload = 'x'.repeat(800_000)\n` +
      `await Bun.write(Bun.stdout, payload)\n` +
      `process.exitCode = 0\n`,
  );
  const proc = Bun.spawn(['bun', script], { stdout: 'pipe' });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  expect(text.length).toBe(800_000);
  // Specifically through a pipe: with a file this defect never showed.
  expect(text.length).toBeGreaterThan(65_536);
});

test('the doctor does not stay silent about an allowed command without a binary', async () => {
  const ghost = createAgent(
    NodeConfigSchema.parse({
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${PORT}`, token: TOKEN_B }],
      nodeId: 'bravo',
      allow: {
        real: {
          bin: '/bin/echo',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
        ghost: {
          bin: '/opt/nonexistent/ghost',
          callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
          stdin: { mode: 'text', maxBytes: 1048576 },
          env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
          timeoutMs: 900_000,
          concurrency: 128,
        },
      },
    }),
  );
  await waitConnected(ghost);
  try {
    const status = await ghost.status();
    const byName = Object.fromEntries(status.allow.map((a) => [a.name, a.present]));
    expect(byName.real).toBe(true);
    // Previously the status listed the name and stayed silent about the file being absent: the same
    // class as someone else's scar with `command -v nginx || exit 0` — a "success" that checked
    // nothing.
    expect(byName.ghost).toBe(false);
  } finally {
    await ghost.stop();
  }
});
