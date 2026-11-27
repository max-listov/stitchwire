#!/usr/bin/env bun

/**
 * The release gate: does this artifact work, does it refuse a fleet that is not itself, and does the
 * release it replaces still run if we have to go back. Not a conformance matrix — there are no
 * dialects to reconcile, only one version at a time and a way home.
 *
 * The harness (`smoke/harness.ts`) runs the packed artifacts as processes and the probes
 * (`smoke/door-probes.ts`) ask a running node through its door; the scenarios are here.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { PeerObservationSchema } from '../packages/contracts/src/peer-contract.ts';
import { BrokerHealthContractSchema } from '../packages/contracts/src/protocol/broker-health.ts';
import { freePort, until } from '../test/support.ts';
import {
  bootTransitionDoor,
  classifiedRpc,
  event,
  resumeAfterAbsence,
  stream,
  waitRpc,
} from './smoke/door-probes.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import {
  type BinaryPair,
  ECHO_ENV,
  ECHO_PROFILE,
  isolatedBinary,
  localJson,
  type Running,
  start,
  stop,
  token,
  version,
  waitAgent,
  waitBroker,
  writeConfig,
} from './smoke/harness.ts';
import { halfFinishedRollout, rollbackPair } from './smoke/pairs.ts';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`missing ${name} path`);
  return value;
}

async function malformedFails(binary: string, root: string): Promise<void> {
  const path = join(root, 'malformed-broker.json');
  const port = freePort();
  await writeConfig(path, {
    host: '127.0.0.1',
    port,
    nodes: [{ id: 'producer', tokenSha256s: ['0'.repeat(64)] }],
    topics: {
      invalid: { producer: 'producer', subscribers: ['missing'], delivery: 'ordered' },
    },
  });
  const child = Bun.spawn([binary, 'broker', '--config', path], { stdout: 'ignore', stderr: 'ignore' });
  const code = await Promise.race([child.exited, Bun.sleep(3_000).then(() => -999)]);
  if (code === -999) {
    child.kill('SIGKILL');
    await child.exited;
    throw new Error('malformed broker config bound or hung instead of failing before service');
  }
  if (code === 0) throw new Error('malformed broker config was accepted');
  try {
    await fetch(`http://127.0.0.1:${port}/health`);
    throw new Error('malformed broker config bound a health service');
  } catch (error) {
    if (error instanceof Error && error.message.includes('bound a health service')) throw error;
  }
}

async function allNew(binaries: BinaryPair, root: string): Promise<void> {
  const port = freePort();
  const callerToken = token();
  const executorToken = token();
  const brokerPath = join(root, 'all-new-broker.json');
  const callerPath = join(root, 'all-new-caller.json');
  const executorPath = join(root, 'all-new-executor.json');
  const callerSocket = join(root, 'all-new-caller.sock');
  const executorSocket = join(root, 'all-new-executor.sock');
  await writeConfig(brokerPath, {
    host: '127.0.0.1',
    port,
    nodes: [
      { id: 'caller', tokenSha256s: [sha256(callerToken)] },
      { id: 'executor', tokenSha256s: [sha256(executorToken)] },
    ],
    capabilities: {
      caller: [
        { operation: 'peer', targets: ['executor'] },
        { operation: 'stream', targets: ['executor'] },
        { operation: 'subscribe', targets: ['executor'] },
      ],
      executor: [
        { operation: 'publish', targets: ['executor'] },
        { operation: 'subscribe', targets: ['executor'] },
      ],
    },
    commandGrants: [{ caller: 'caller', targets: ['executor'], command: 'echo' }],
    topics: {
      'boot.release': {
        producer: 'executor',
        subscribers: ['executor'],
        delivery: 'ordered',
        maxEventsPerSecond: 1,
      },
      // Two subscribers, not one: this harness is a single process that opens a subscription per
      // probe, and cancelling a reader does not drop the unix connection while that process lives —
      // the door closes the subscription when the connection really goes, which is on exit. A
      // ceiling of one would refuse the second probe and read as a product fault.
      'generic.release': {
        producer: 'executor',
        subscribers: ['caller'],
        delivery: 'ordered',
        publicationMode: 'on-change',
        maxSubscribers: 4,
        retain: { maxAgeMs: 60_000, maxBytes: 4_096 },
      },
      'volatile.release': {
        producer: 'executor',
        subscribers: ['caller'],
        delivery: 'ordered',
        publicationMode: 'periodic',
        maxSubscribers: 4,
      },
    },
    auditPath: join(root, 'all-new-audit.jsonl'),
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
    streams: {},
    events: { publish: [], subscribe: ['generic.release', 'volatile.release'] },
    agentSocket: callerSocket,
  });
  await writeConfig(executorPath, {
    ...lane(executorToken),
    nodeId: 'executor',
    allow: {
      echo: { ...ECHO_PROFILE, env: ECHO_ENV },
    },
    streams: {
      fixed: {
        bin: '/usr/bin/printf',
        argv: ['mixed-stream'],
        callerArgs: { mode: 'none' },
        stdin: { mode: 'none' },
      },
    },
    events: { publish: ['generic.release', 'volatile.release', 'boot.release'], subscribe: ['boot.release'] },
    agentSocket: executorSocket,
  });
  let broker = start('all-new-broker', binaries.candidate, ['broker', '--config', brokerPath]);
  const caller = start('all-new-caller', binaries.candidate, ['agent', '--config', callerPath]);
  const executor = start('all-new-executor', binaries.candidate, ['agent', '--config', executorPath]);
  try {
    await waitBroker(port);
    await Promise.all([waitAgent(callerSocket), waitAgent(executorSocket)]);
    // The candidate's own contract names the modes: a mode the writer adds is not refused here.
    const flow = z
      .object({
        topics: z.array(
          BrokerHealthContractSchema.shape.topics.element
            .pick({ topic: true, publicationMode: true })
            .strip(),
        ),
      })
      .parse(await (await fetch(`http://127.0.0.1:${port}/health`)).json());
    if (
      flow.topics.find((topic) => topic.topic === 'generic.release')?.publicationMode !== 'on-change' ||
      flow.topics.find((topic) => topic.topic === 'volatile.release')?.publicationMode !== 'periodic'
    )
      throw new Error('declared publication mode lost at health boundary');
    await classifiedRpc(callerSocket, 'executor', 'new-rpc');
    const peer = PeerObservationSchema.parse(
      await localJson(callerSocket, '/peer-observation', { to: 'executor' }),
    );
    if (peer.outcome !== 'ok' || peer.sampleCount !== 1 || peer.latestMs === null)
      throw new Error('native peer RTT failed');
    await bootTransitionDoor(executorSocket);
    await stream(callerSocket, 'executor');
    await event(executorSocket, callerSocket);
    await resumeAfterAbsence(executorSocket, callerSocket);
    await stop(broker);
    broker = start('all-new-broker-restarted', binaries.candidate, ['broker', '--config', brokerPath]);
    await waitBroker(port);
    await waitRpc(callerSocket, 'executor', 'after-reconnect');
  } finally {
    await Promise.all([stop(caller), stop(executor)]);
    await stop(broker);
  }
}

async function singleHomedTarget(binary: string, root: string): Promise<void> {
  const callerToken = token();
  const executorToken = token();
  const ports = [freePort(), freePort()];
  const running: Running[] = [];
  const lanes = ports.map((port, index) => ({
    id: `lane-${index}`,
    url: `http://127.0.0.1:${port}`,
    token: callerToken,
  }));
  const targetLane = lanes[1];
  if (targetLane === undefined) throw new Error('missing target lane');
  const callerSocket = join(root, 'target-caller.sock');
  const targetSocket = join(root, 'target-executor.sock');
  try {
    for (const [index, port] of ports.entries()) {
      const path = join(root, `target-broker-${index}.json`);
      await writeConfig(path, {
        host: '127.0.0.1',
        port,
        nodes: [
          { id: 'caller', tokenSha256s: [sha256(callerToken)] },
          { id: 'executor', tokenSha256s: [sha256(executorToken)] },
        ],
        capabilities: {
          caller: [
            { operation: 'peer', targets: ['executor'] },
            { operation: 'stream', targets: ['executor'] },
          ],
        },
        commandGrants: [{ caller: 'caller', targets: ['executor'], command: 'echo' }],
        auditPath: join(root, `target-audit-${index}.jsonl`),
      });
      running.push(start(`target-broker-${index}`, binary, ['broker', '--config', path]));
      await waitBroker(port);
    }
    const callerPath = join(root, 'target-caller.json');
    const targetPath = join(root, 'target-executor.json');
    await writeConfig(callerPath, { nodeId: 'caller', brokers: lanes, agentSocket: callerSocket });
    await writeConfig(targetPath, {
      nodeId: 'executor',
      brokers: [{ ...targetLane, token: executorToken }],
      agentSocket: targetSocket,
      allow: {
        echo: { ...ECHO_PROFILE, env: ECHO_ENV },
      },
      streams: {
        fixed: {
          bin: '/usr/bin/printf',
          argv: ['mixed-stream'],
          callerArgs: { mode: 'none' },
          stdin: { mode: 'none' },
        },
      },
    });
    running.push(start('target-executor', binary, ['agent', '--config', targetPath]));
    await waitAgent(targetSocket);
    running.push(start('target-caller', binary, ['agent', '--config', callerPath]));
    await waitAgent(callerSocket);
    const status = z.object({ lanes: z.array(z.object({ connected: z.boolean() })) });
    const bothUp = await until(
      async () =>
        status.parse(await localJson(callerSocket, '/status')).lanes.every((lane) => lane.connected),
      undefined,
      40,
    );
    if (!bothUp) throw new Error('both caller lanes must be healthy');
    for (let i = 0; i < 8; i += 1) await classifiedRpc(callerSocket, 'executor', `target-${i}`);
    for (let i = 0; i < 4; i += 1) await stream(callerSocket, 'executor');
    for (const path of ['/call', '/stream']) {
      const body =
        path === '/call' ? { to: 'executor', argv: ['echo'] } : { to: 'executor', profile: 'fixed' };
      const response = await fetch(`http://localhost/wire${path}`, {
        unix: callerSocket,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...body, lane: 'lane-0' }),
      });
      if (response.ok) throw new Error('caller-selected lane was admitted');
      await response.body?.cancel();
    }
  } finally {
    for (const child of running.reverse()) await stop(child);
  }
}

// Reserve room for scenario names and the native socket's staging suffix on macOS.
const root = mkdtempSync('/tmp/wire-mixed-');
try {
  const binaries: BinaryPair = {
    candidate: isolatedBinary(argument('--candidate-binary'), root, 'stitchwire-candidate'),
    rollback: isolatedBinary(argument('--rollback-binary'), root, 'stitchwire-rollback'),
  };
  const candidateVersion = await version(binaries.candidate);
  const rollbackVersion = await version(binaries.rollback);
  // Pinned on purpose, and now permanently on the refusal question: one fleet runs one version, so
  // "do these two interoperate" has one answer for every release and the matrix asserts it rather
  // than re-deciding it. Bump both pins at release time; never loosen the guard.
  if (candidateVersion !== '0.58.0' || rollbackVersion !== '0.57.0') {
    throw new Error('conformance harness received unexpected artifact versions');
  }
  await halfFinishedRollout(binaries, root);
  await allNew(binaries, root);
  await singleHomedTarget(binaries.candidate, root);
  await malformedFails(binaries.candidate, root);
  await rollbackPair(
    binaries,
    root,
    binaries.rollback,
    binaries.rollback,
    binaries.rollback,
    'rollback-command',
  );
  console.log(
    JSON.stringify({
      candidateVersion,
      rollbackVersion,
      halfFinishedRolloutRefused: 'GO',
      allNewClassifiedRpcStreamEventResume: 'GO',
      restartReconnectRpc: 'GO',
      nativePeerRtt: 'GO',
      declaredPublicationModes: 'GO',
      localAheadNamedBootTransition: 'GO',
      singleHomedTargetRpcStreamSelectors: 'GO',
      malformedConfigFailFirst: 'GO',
      rollbackCommand: 'GO',
      rollbackSavedConfigPreflight: 'GO',
    }),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
