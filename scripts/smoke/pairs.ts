/**
 * Scenarios of one broker and two nodes whose versions differ or whose executables are the rollback's:
 * a fleet that is half rolled out must refuse the node it was not rolled out to, and the release it
 * replaces must still run the same scenario if the fleet has to go back.
 */

import { chmodSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from '../../test/support.ts';
import { sha256 } from '../../packages/runtime/src/config/io.ts';
import { rpc } from './door-probes.ts';
import {
  type BinaryPair,
  connectedWithin,
  ECHO_ENV,
  ECHO_PROFILE,
  localJson,
  StatusProbeSchema,
  start,
  stop,
  token,
  waitAgent,
  waitBroker,
  writeConfig,
} from './harness.ts';

async function refusedPair(
  binaries: BinaryPair,
  root: string,
  brokerBinary: string,
  matchingBinary: string,
  oddBinary: string,
  marker: string,
): Promise<void> {
  const port = freePort();
  const callerToken = token();
  const executorToken = token();
  const brokerPath = join(root, `${marker}-broker.json`);
  const callerPath = join(root, `${marker}-caller.json`);
  const executorPath = join(root, `${marker}-executor.json`);
  const callerSocket = join(root, `${marker}-caller.sock`);
  const executorSocket = join(root, `${marker}-executor.sock`);
  await writeConfig(brokerPath, {
    host: '127.0.0.1',
    port,
    nodes: [
      { id: 'caller', tokenSha256s: [sha256(callerToken)] },
      { id: 'executor', tokenSha256s: [sha256(executorToken)] },
    ],
    capabilities: { caller: [{ operation: 'peer', targets: ['executor'] }] },
    commandGrants: [{ caller: 'caller', targets: ['executor'], command: 'echo' }],
    auditPath: join(root, `${marker}-audit.jsonl`),
  });
  const lane = (token: string) => ({
    brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }],
    serves: true,
    defaultTimeoutMs: 3_000,
  });
  await writeConfig(callerPath, {
    ...lane(callerToken),
    nodeId: 'caller',
    allow: {},
    agentSocket: callerSocket,
  });
  await writeConfig(executorPath, {
    ...lane(executorToken),
    nodeId: 'executor',
    allow: {
      echo: { ...ECHO_PROFILE, env: ECHO_ENV },
    },
    agentSocket: executorSocket,
  });
  const broker = start(`${marker}-broker`, brokerBinary, ['broker', '--config', brokerPath]);
  const matching = start(`${marker}-caller`, matchingBinary, ['agent', '--config', callerPath]);
  const odd = start(`${marker}-executor`, oddBinary, ['agent', '--config', executorPath]);
  try {
    await waitBroker(port);
    // The control: same protocol on both ends must connect, or the refusal below proves nothing.
    await waitAgent(callerSocket);
    if (await connectedWithin(executorSocket, 6_000)) {
      throw new Error(`${marker}: a node on the other wire protocol was admitted`);
    }
    // The door is the operator's window, and it must stay open on a node whose lane is refused.
    const status = StatusProbeSchema.parse(await localJson(executorSocket, '/status'));
    if (status.connected) throw new Error(`${marker}: refused node reported itself connected`);
  } finally {
    await Promise.all([stop(matching), stop(odd)]);
    await stop(broker);
  }
  if (binaries.candidate === binaries.rollback) throw new Error('mixed-version probe used one binary twice');
}

export async function rollbackPair(
  binaries: BinaryPair,
  root: string,
  brokerBinary: string,
  callerBinary: string,
  executorBinary: string,
  marker: string,
  probe: (
    callerSocket: string,
    target: string,
    marker: string,
    context: { port: number; executorSocket: string },
  ) => Promise<void> = rpc,
): Promise<void> {
  const port = freePort();
  const callerToken = token();
  const executorToken = token();
  const brokerPath = join(root, `${marker}-broker.json`);
  const callerPath = join(root, `${marker}-caller.json`);
  const executorPath = join(root, `${marker}-executor.json`);
  const callerSocket = join(root, `${marker}-caller.sock`);
  const executorSocket = join(root, `${marker}-executor.sock`);
  await writeConfig(brokerPath, {
    host: '127.0.0.1',
    port,
    nodes: [
      { id: 'caller', tokenSha256s: [sha256(callerToken)] },
      { id: 'executor', tokenSha256s: [sha256(executorToken)] },
    ],
    // The config shape here follows the ROLLBACK BINARY, not this file's own age. When the previous
    // release predates a config change the shape must be the old one; when it does not, the new
    // one. Nothing enforces that pairing — it broke silently the first time the rollback binary moved
    // past a config change, and the symptom was a broker that never became healthy.
    capabilities: { caller: [{ operation: 'peer', targets: ['executor'] }] },
    commandGrants: [{ caller: 'caller', targets: ['executor'], command: 'echo' }],
    auditPath: join(root, `${marker}-audit.jsonl`),
  });
  const lane = (token: string) => ({
    brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token }],
    serves: true,
    defaultTimeoutMs: 3_000,
  });
  await writeConfig(callerPath, {
    ...lane(callerToken),
    nodeId: 'caller',
    allow: {},
    agentSocket: callerSocket,
  });
  await writeConfig(executorPath, {
    ...lane(executorToken),
    nodeId: 'executor',
    allow: {
      echo: ECHO_PROFILE,
    },
    agentSocket: executorSocket,
  });
  const useSavedCopy = marker === 'rollback-command';
  const saved = (path: string): string => {
    if (!useSavedCopy) return path;
    const copy = `${path}.saved`;
    copyFileSync(path, copy);
    chmodSync(copy, 0o600);
    return copy;
  };
  const brokerRunPath = saved(brokerPath);
  const callerRunPath = saved(callerPath);
  const executorRunPath = saved(executorPath);
  // The sentinel this scenario lacked. Its config shape has to match the era of the binary it
  // runs, and that pairing is written by hand — so when the previous release moved past a config
  // change, the fixture kept feeding the old shape and the only symptom was «the broker never
  // became healthy», twenty lines away from the cause. Asking the binary itself costs one spawn
  // and answers in its own words.
  for (const [role, binary, config] of [
    ['broker', brokerBinary, brokerRunPath],
    ['caller', callerBinary, callerRunPath],
    ['executor', executorBinary, executorRunPath],
  ] as const) {
    const kind = role === 'broker' ? 'broker' : 'node';
    const check = Bun.spawn([binary, 'config', 'validate', kind, config], { stdout: 'pipe', stderr: 'pipe' });
    const detail = `${await new Response(check.stdout).text()}${await new Response(check.stderr).text()}`;
    if ((await check.exited) !== 0) {
      throw new Error(
        `${marker}: ${binary} refuses this scenario's ${kind} config — the fixture is written for a ` +
          `different release's config shape than the binary it runs.\n${detail.trim()}`,
      );
    }
  }
  const broker = start(`${marker}-broker`, brokerBinary, ['broker', '--config', brokerRunPath]);
  const caller = start(`${marker}-caller`, callerBinary, ['agent', '--config', callerRunPath]);
  const executor = start(`${marker}-executor`, executorBinary, ['agent', '--config', executorRunPath]);
  try {
    await waitBroker(port);
    await Promise.all([waitAgent(callerSocket), waitAgent(executorSocket)]);
    await probe(callerSocket, 'executor', marker, { port, executorSocket });
  } finally {
    await Promise.all([stop(caller), stop(executor)]);
    await stop(broker);
  }
  if (binaries.candidate === binaries.rollback) throw new Error('mixed-version probe used one binary twice');
}

/**
 * The version assertion, and the reason this file exists in its current shape.
 *
 * One fleet runs one version, so "does a mixed pair still work" is not a question this project
 * asks. What matters is whether a mismatch **presents itself**: the handshake matches on the
 * release, so a peer on another build is refused at the gate rather than admitted into a fleet that
 * then looks healthy and behaves oddly.
 *
 * What must hold, and each part matters on its own:
 *  - the broker is healthy and its OWN-version node connects, so a failure below is the mismatch
 *    and not a broken harness;
 *  - the other-version node never reaches `connected`, for a generous window;
 *  - that node's local door still answers. This is the difference between a node that reports its
 *    situation and one that hangs — the operator sees `connected: false` on the socket, not silence.
 */
async function mismatchRefused(
  binaries: BinaryPair,
  root: string,
  brokerBinary: string,
  oddBinary: string,
  marker: string,
): Promise<void> {
  await refusedPair(binaries, root, brokerBinary, brokerBinary, oddBinary, marker);
}

/**
 * The half-finished rollout, which is the realistic one: brokers moved, a node was missed. The
 * mirror case adds nothing — the check is symmetric by construction, since one gate decides it.
 */
export async function halfFinishedRollout(binaries: BinaryPair, root: string): Promise<void> {
  await mismatchRefused(binaries, root, binaries.candidate, binaries.rollback, 'half-finished-rollout');
}
