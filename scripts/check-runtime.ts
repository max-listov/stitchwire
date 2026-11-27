import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { LocalStatusSchema } from '../packages/contracts/src/door/status.ts';
import {
  LocalServiceResultSchema,
  ServiceIngressSchema,
} from '../packages/contracts/src/service/contracts.ts';
import { BrokerHealthContractSchema } from '../packages/contracts/src/protocol/broker-health.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { DoctorReportSchema } from '../packages/runtime/src/cli/doctor-report.ts';
import { freePort, until } from '../test/support.ts';
import { installRuntimeAssets } from './runtime-assets.ts';
import { bindUnixSocket, writeFileAtomicSync } from 'stitchkit/files';

const root = resolve(import.meta.dir, '..');
const scratch = await mkdtemp(join(tmpdir(), 'wire-runtime-proof-'));
const artifact = join(scratch, 'bin/stitchwire');
const processes: ReturnType<typeof Bun.spawn>[] = [];
let owner: ReturnType<typeof Bun.serve> | undefined;
const paths = Object.fromEntries(['left', 'right', 'reader', 'worker'].map((id) => [id, join(scratch, id)]));
function directory(id: string): string {
  const path = paths[id];
  if (!path) throw new Error('Unknown isolated runtime');
  return path;
}
function environment(id: string) {
  return {
    PATH: process.env.PATH ?? '',
    STITCHWIRE_CONFIG_DIR: directory(id),
    STITCHWIRE_STATE_DIR: directory(id),
  };
}
async function run(argv: string[], id = 'reader', expectedExit = 0): Promise<void> {
  const child = Bun.spawn([process.execPath, ...argv], {
    cwd: scratch,
    env: { ...environment(id), WIRE_DOCTOR_TEST_ARTIFACT: artifact },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // A watchdog must be slower than the work by a margin, or it reports its own impatience as a
  // failure of the code. For the doctor tests that margin is not a measurement: the two files
  // declare 38 CLI spawns, and each test's budget lets every spawn use its whole guard
  // (`budget()` in test/doctor-fixture.ts, 339 s in all). Below that sum this killer could fire
  // before bun names the slow test; above it, bun always reports first.
  const watchdog = argv[0] === 'test' ? 420_000 : 10_000;
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    child.kill('SIGKILL');
  }, watchdog);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (argv[1] === 'doctor' && argv.includes('--json')) {
    const report = DoctorReportSchema.parse(JSON.parse(stdout));
    if (report.exitCode !== code) throw new Error('Doctor report/exit mismatch');
  }
  if (code !== expectedExit && argv[1] === 'doctor') {
    // Doctor never prints authentication tokens; keep its exact diagnostic for failed clean installs.
    throw new Error(`Isolated doctor failed (${code})\n${stdout}\n${stderr}`);
  }
  const verdict = hung ? `exceeded its ${watchdog / 1000}s watchdog` : `failed (${code})`;
  if (code !== expectedExit && argv[0] === 'test') {
    // The tests run on synthetic fixtures and never read this run's configuration, but they inherit
    // its environment; cut every credential this run minted before the report shows their output.
    // Without it a failure here is a bare exit code nobody can diagnose (attempt 418a1c66).
    throw new Error(`Isolated doctor tests ${verdict}\n${redact(`${stdout}\n${stderr}`)}`);
  }
  if (code !== expectedExit)
    throw new Error(`Isolated command ${argv[1] ?? 'script'} ${verdict}; output withheld to protect config`);
}
const credentials: string[] = [];
function redact(text: string): string {
  return credentials.reduce((value, secret) => value.replaceAll(secret, '[redacted credential]'), text);
}
async function save(path: string, data: unknown): Promise<void> {
  writeFileAtomicSync(path, JSON.stringify(data), { mode: 0o600 });
}
try {
  installRuntimeAssets(join(root, 'dist/stitchwire'), artifact);
  for (const id of Object.keys(paths)) await mkdir(directory(id), { mode: 0o700 });
  await run([artifact, '--version']);
  const ports = [freePort(), freePort()];
  const nodes: Array<{ id: string; digest: string }> = [];
  for (const id of ['reader', 'worker']) {
    const configPath = join(directory(id), 'node.json');
    await run(
      [artifact, 'init', 'node', '--id', id, '--broker', `http://127.0.0.1:${ports[0]}`, configPath],
      id,
    );
    const config = await Bun.file(configPath).json();
    const token = config.brokers[0].token;
    credentials.push(token);
    if (id === 'reader') {
      const before = await Bun.file(configPath).text();
      const updatePath = join(directory(id), 'config-update.json');
      await save(updatePath, {
        operation: 'replace',
        expectedSha256: sha256(before),
        value: { ...config, events: { ...config.events, descriptors: [] } },
      });
      const update = [artifact, 'config', 'update', 'node', configPath, '--request', updatePath];
      await run([...update, '--check'], id);
      if ((await Bun.file(configPath).text()) !== before)
        throw new Error('Standalone config check changed bytes');
      await run(update, id);
      const after = await Bun.file(configPath).text();
      if (
        JSON.parse(after).brokers[0].token !== token ||
        !Array.isArray(JSON.parse(after).events.descriptors)
      )
        throw new Error('Standalone config transaction lost state');
      await run(update, id, 1);
      if ((await Bun.file(configPath).text()) !== after)
        throw new Error('Standalone stale config update changed bytes');
    }
    nodes.push({ id, digest: sha256(token) });
    config.agentSocket = join(directory(id), 'agent.sock');
    config.brokers = ports.map((number, index) => ({
      id: index === 0 ? 'left' : 'right',
      url: `http://127.0.0.1:${number}`,
      token,
    }));
    await save(configPath, config);
  }
  for (const [index, id] of ['left', 'right'].entries()) {
    await run(
      [
        artifact,
        'init',
        'broker',
        ...nodes.flatMap((node) => ['--node', `${node.id}=${node.digest}`]),
        '--port',
        String(ports[index]),
        join(directory(id), 'broker.json'),
      ],
      id,
    );
  }
  const descriptorPath = join(scratch, 'descriptor.json');
  await save(descriptorPath, {
    service: 'example.catalog',
    revision: '1',
    maxInflight: 2,
    operations: [
      {
        id: 'lookup',
        path: '/catalog/lookup',
        effect: 'read',
        limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 },
        response: { kind: 'unary' },
      },
    ],
  });
  for (const id of ['left', 'right', 'worker']) {
    const kind = id === 'worker' ? 'node' : 'broker';
    const path = join(directory(id), `${kind}.json`);
    const args = [
      join(root, 'scripts/activate-service-policy.ts'),
      '--kind',
      kind,
      '--config',
      path,
      '--descriptor',
      descriptorPath,
      '--caller',
      'reader',
      '--read',
      'worker',
      ...(kind === 'node' ? ['--socket', join(scratch, 'owner.sock'), '--endpoint', '/invoke'] : []),
    ];
    const before = await Bun.file(path).text();
    const candidatePath = `${path}.candidate`;
    await run([...args, '--apply', 'no', '--out', candidatePath], id);
    if ((await Bun.file(path).text()) !== before) throw new Error('Dry-run modified configuration');
    await copyFile(path, `${path}.backup`);
    await run([...args, '--apply', 'yes'], id);
    if ((await Bun.file(path).text()) !== (await Bun.file(candidatePath).text()))
      throw new Error('Applied policy differs from reviewed candidate');
    await run([artifact, 'config', 'validate', kind, path], id);
  }
  let dispatches = 0;
  owner = bindUnixSocket({ path: join(scratch, 'owner.sock'), mode: 0o600 }, (unix) =>
    Bun.serve({
      unix,
      fetch: async (request) => {
        const input = ServiceIngressSchema.parse(await request.json());
        if (input.operation !== 'lookup') return new Response(null, { status: 404 });
        dispatches++;
        return Response.json({ key: 'synthetic', value: 'isolated artifact' });
      },
    }),
  );
  for (const id of ['left', 'right', 'worker', 'reader']) {
    processes.push(
      Bun.spawn([process.execPath, artifact, id === 'left' || id === 'right' ? 'broker' : 'agent'], {
        cwd: scratch,
        env: environment(id),
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
  }
  const socket = join(directory('reader'), 'agent.sock');
  const ready = await until(async () => {
    try {
      const status = LocalStatusSchema.parse(
        await (
          await fetch('http://localhost/wire/status', { unix: socket, signal: AbortSignal.timeout(250) })
        ).json(),
      );
      const lanes =
        status.connected &&
        status.lanes.length === 2 &&
        status.lanes.every((lane) => lane.connected) &&
        status.nodes.some((node) => node.nodeId === 'worker' && node.online && node.serves);
      if (!lanes) return false;
      const brokers = await Promise.all(
        ports.map(async (number) =>
          BrokerHealthContractSchema.parse(
            await (
              await fetch(`http://127.0.0.1:${number}/health`, {
                signal: AbortSignal.timeout(250),
              })
            ).json(),
          ),
        ),
      );
      // A merged caller roster proves one serving route, not both brokers' admission of both peers.
      return brokers.every((broker) =>
        ['reader', 'worker'].every((id) =>
          broker.fleet.machines.some(
            (machine) =>
              machine.nodeId === id && machine.online && machine.release.current === status.version,
          ),
        ),
      );
    } catch {
      /* The spawned processes may not have bound their sockets yet. */
      return false;
    }
  });
  if (!ready) throw new Error('Standalone artifact failed to connect caller and worker');
  const lockOwner = z.object({
    pid: z.number().int().positive(),
    process: z.object({
      platform: z.enum(['linux', 'darwin']),
      bootId: z.string().min(1),
      namespace: z.string().min(1),
      startId: z.string().regex(/^\d+$/),
    }),
  });
  for (const id of ['reader', 'worker']) {
    for (const journal of ['publication-audit', 'service-audit']) {
      const record = await Bun.file(join(directory(id), `agent.sock.${journal}.jsonl.lock`)).json();
      if (!lockOwner.safeParse(record).success)
        throw new Error(`Standalone ${id}/${journal} lock has no OS process identity`);
    }
  }
  await run([artifact, 'doctor']);
  await run([artifact, 'doctor', '--json']);
  await run([artifact, 'doctor', '--json', '--broker', `http://127.0.0.1:${ports[0]}`]);
  await run([artifact, 'doctor', '--json', '--config', join(scratch, 'missing.json')], 'reader', 3);
  for (const revision of ['1', 'wrong']) {
    const result = LocalServiceResultSchema.parse(
      await (
        await fetch('http://localhost/wire/services/invoke', {
          unix: socket,
          method: 'POST',
          signal: AbortSignal.timeout(3000),
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            to: 'worker',
            service: 'example.catalog',
            revision,
            operation: 'lookup',
            payload: '{}',
            timeoutMs: 2000,
          }),
        })
      ).json(),
    );
    if (
      revision === '1'
        ? result.outcome.status !== 'response'
        : result.outcome.status !== 'failure' || result.outcome.delivery !== 'not-dispatched'
    )
      throw new Error('Standalone service outcome mismatch');
  }
  if (dispatches !== 1) throw new Error('Denied request reached isolated owner');
  await run(['test', join(root, 'test/doctor.test.ts'), join(root, 'test/doctor-transport.test.ts')]);
  console.log(
    JSON.stringify({
      standaloneRuntime: true,
      configTransactions: true,
      brokers: 2,
      agents: 2,
      serviceRead: true,
      dryRunUnchanged: true,
      deniedWithoutDispatch: true,
      doctorArtifactRegressions: true,
    }),
  );
} finally {
  for (const child of processes.reverse()) child.kill('SIGTERM');
  const timer = setTimeout(() => {
    for (const child of processes) if (child.exitCode === null) child.kill('SIGKILL');
  }, 3000);
  await Promise.all(processes.map((child) => child.exited));
  clearTimeout(timer);
  owner?.stop(true);
  await rm(scratch, { recursive: true, force: true });
}
