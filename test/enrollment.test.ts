import { expect, test } from 'bun:test';
import { existsSync, lstatSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createWireClient } from '../packages/local-client/src/client.ts';
import { BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { loadBrokerConfig } from '../packages/runtime/src/config/io.ts';
import { ownedDeclarations } from '../packages/runtime/src/enrollment/bindings.ts';
import { verifiedCopy } from '../packages/runtime/src/enrollment/material.ts';
import {
  brokerObservation,
  checkDeclarationAcks,
  nodeObservation,
} from '../packages/runtime/src/enrollment/observe.ts';
import { executeEnrollment } from '../packages/runtime/src/enrollment/operation.ts';
import { applyConfigFile } from '../packages/runtime/src/fleet/copy.ts';
import { applyBrokerTables, brokerTablesOf, sameTables } from '../packages/runtime/src/fleet/projection.ts';
import { enrollmentEvents } from './enrollment-events.ts';
import { materialOf, proofOf, refusalOf } from './enrollment-results.ts';
import { SCENARIO_CEILING_MS } from './enrollment-scenarios/registry.ts';
import { enrollmentStand } from './enrollment-stand.ts';

test(
  'CLI plans without writes, admits once and reuses one node across independent owners',
  async () => {
    const stand = await enrollmentStand();
    const reader = createWireClient({ socketPath: stand.observer.socket });
    const publisher = createWireClient({ socketPath: stand.worker.socket });
    const feeds: Array<{ close(): void }> = [];
    const connection = async () =>
      (await brokerObservation(stand.url, stand.request.expectedVersion)).nodes.find(
        (node) => node.nodeId === 'worker',
      )?.since;
    try {
      const alias = join(stand.root, 'config-alias.json');
      symlinkSync(stand.worker.config, alias);
      const request = { ...stand.request, config: alias };
      const before = readFileSync(stand.worker.config);
      // The stand is alive: its observer opens its own journals whenever it gets to it, and every
      // running process publishes its locks through short-lived files. What a plan may not create
      // is anything else.
      const transient = (name: string) =>
        name.startsWith('request-') ||
        name.startsWith('observer.') ||
        name.endsWith('.lock') ||
        name.endsWith('.tmp');
      const listed = () =>
        readdirSync(stand.root)
          .filter((name) => !transient(name))
          .sort();
      const files = listed();
      const plan = await stand.cli(request, 'plan');
      expect(plan.result.status).toBe('planned');
      expect(readFileSync(stand.worker.config)).toEqual(before);
      expect(listed()).toEqual(files);
      expect(existsSync(`${stand.worker.config}.enrollment`)).toBe(false);
      const prepare = await stand.cli(request, 'prepare');
      expect(prepare.result.status).toBe('prepared');
      const brokerPlan = await stand.cli(stand.admission, 'plan');
      expect(brokerPlan.result.status).toBe('planned');
      expect(materialOf(brokerPlan.result)?.bundle.full).toBeNull();
      expect(Object.keys(materialOf(brokerPlan.result)?.bundle.slices ?? {})).toEqual(['worker']);
      expect((await stand.cli(stand.admission, 'apply')).result.status).toBe('admitted');
      const registered = readFileSync(stand.brokerConfig);
      expect((await stand.cli(stand.admission, 'apply')).result.status).toBe('admitted');
      expect(readFileSync(stand.brokerConfig)).toEqual(registered);
      const child = await stand.startWorker();
      const applied = await stand.cli(request, 'apply');
      expect(applied.result.status).toBe('ready');
      // The history lists the steps that ran: for an existing agent nothing is installed or started.
      expect(applied.result.completed).toEqual(['credential', 'configuration', 'verification']);
      expect(proofOf(applied.result)).toEqual({ httpStatus: 200 });
      expect(stand.reached).toContainEqual({ caller: 'worker', service: 'example.probe', operation: 'read' });
      const config = readFileSync(stand.worker.config);
      const receiptPath = `${stand.worker.config}.enrollment/owners.json`;
      const receipt = readFileSync(receiptPath);
      const connectedSince = await connection();
      expect(typeof connectedSince).toBe('string');
      expect((await stand.cli(request, 'status')).result.status).toBe('ready');
      expect(readFileSync(receiptPath)).toEqual(receipt);
      expect(readFileSync(stand.worker.config)).toEqual(config);
      expect((await stand.cli(request, 'apply')).result.status).toBe('ready');
      expect(lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(existsSync(`${alias}.enrollment`)).toBe(false);
      expect(readFileSync(stand.worker.config)).toEqual(config);
      expect(await connection()).toBe(connectedSince);
      expect(child.exitCode).toBeNull();
      // Enrollment judges the agent's answer through its own strict reader, so the test reads it the same way.
      const status = await nodeObservation(request);
      if (status === null) throw new Error('the agent answers no status');
      expect(status.services.declarations.descriptors[0]?.state).toBe('loaded');
      expect(status.events.declarations.descriptors[0]?.state).toBe('loaded');
      expect(status.events.declarations.lanes[0]).toMatchObject({ accepted: 1, refused: [] });
      const owned = ownedDeclarations(
        stand.config(),
        stand.worker.config,
        stand.first.bindings,
        status.events,
      );
      expect(() => checkDeclarationAcks(status, request, owned)).not.toThrow();
      for (const declarations of [status.services.declarations, status.events.declarations]) {
        const lane = declarations.lanes[0];
        if (lane === undefined) throw new Error('missing fixture lane');
        const accepted = lane.accepted;
        lane.accepted = 0;
        expect(() => checkDeclarationAcks(status, request, owned)).toThrow('declaration-refused');
        lane.accepted = accepted;
      }
      const firstEvents = await enrollmentEvents(reader, publisher, stand.first.topic);
      feeds.push(firstEvents.feed);
      await firstEvents.deliver();
      firstEvents.feed.close();

      const invoke = (service: string, operation = 'read') =>
        reader.invokeService({
          to: 'worker',
          service,
          revision: '1',
          operation,
          payload: '{}',
          timeoutMs: 1000,
        });
      expect((await invoke('owner.first')).outcome.status).toBe('response');
      const count = stand.reached.length;
      expect((await invoke('owner.first', 'write')).outcome).toMatchObject({
        status: 'failure',
        code: 'denied',
      });
      expect(stand.reached).toHaveLength(count);
      // Two owners, detach and the last detach are scenarios of the registry (test/enrollment-scenarios).
    } finally {
      for (const feed of feeds) feed.close();
      publisher.close();
      reader.close();
      await stand.stop();
    }
  },
  SCENARIO_CEILING_MS,
);

test('preflight distinguishes version, bundle, credential and unsafe proof failures without mutations', async () => {
  const stand = await enrollmentStand();
  try {
    const before = readFileSync(stand.worker.config);
    const run = (request: unknown) => executeEnrollment(request, 'plan');
    expect(refusalOf(await run({ ...stand.request, expectedVersion: '999.0.0' }))?.code).toBe(
      'version-mismatch',
    );
    expect(
      refusalOf(
        await run({
          ...stand.request,
          proof: { ...stand.request.proof, call: { ...stand.request.proof.call, operation: 'write' } },
        }),
      )?.code,
    ).toBe('proof-not-read');
    const foreign = {
      ...stand.request,
      requestId: crypto.randomUUID(),
      owner: { id: 'x', descriptors: stand.first.bindings },
    };
    stand.write(stand.worker.config, {
      ...stand.config(),
      services: { ...stand.config().services, descriptors: [stand.first.declarationPath] },
    });
    expect(refusalOf(await executeEnrollment(foreign, 'apply'))?.code).toBe('owner-conflict');
    expect((await executeEnrollment(stand.admission, 'apply')).status).toBe('admitted');
    expect(
      refusalOf(
        await run({ ...stand.admission, requestId: crypto.randomUUID(), tokenSha256: 'f'.repeat(64) }),
      )?.code,
    ).toBe('credential-conflict');
    expect(readFileSync(stand.worker.config)).not.toEqual(before);
    expect(stand.reached).toHaveLength(0);
  } finally {
    await stand.stop();
  }
}, 30_000);

test('broker admission writes raw projected tables so FleetKeeper sees aligned without rewriting broker.json', async () => {
  const stand = await enrollmentStand();
  try {
    expect((await executeEnrollment(stand.admission, 'apply')).status).toBe('admitted');
    const afterAdmit = readFileSync(stand.brokerConfig, 'utf8');
    const broker = loadBrokerConfig(stand.brokerConfig);
    if (broker.fleet === undefined) throw new Error('expected broker fleet settings');
    const opened = verifiedCopy(broker.fleet.copy, broker.fleet.trust, true);
    if (opened.manifest === null) throw new Error('expected full fleet manifest');
    const manifest = opened.manifest;
    const applied = await applyConfigFile(stand.brokerConfig, {
      project: (config) => applyBrokerTables(config, manifest),
      tablesOf: brokerTablesOf,
      same: sameTables,
      validate: (config) => (BrokerConfigSchema.safeParse(config).success ? null : 'invalid'),
    });
    expect(applied).toEqual({ state: 'aligned' });
    expect(readFileSync(stand.brokerConfig, 'utf8')).toBe(afterAdmit);
  } finally {
    await stand.stop();
  }
}, 30_000);
