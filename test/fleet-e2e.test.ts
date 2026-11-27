import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FleetBundleSchema, FleetSlicePayloadSchema } from '../packages/contracts/src/fleet/bundle.ts';
import { FleetManifestSchema } from '../packages/contracts/src/fleet/manifest.ts';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { parseBrokerConfigBytes, parseNodeConfigBytes, sha256 } from '../packages/runtime/src/config/io.ts';
import type { Agent } from '../packages/runtime/src/node/agent-contract.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { fleetSigner } from './signed-fleet.ts';
import { supervise } from '../packages/runtime/src/cli/supervise.ts';
import { CALL_POLL_MS, freePort, until, waitConnected } from './support.ts';

/**
 * The fleet's configuration lives on every machine and repairs itself, with nobody logging in.
 *
 * One signed bundle is installed on one node. That node hands it to its broker; the broker keeps
 * it, runs the tables it projects and hands each other node the part it may hold; each node runs its
 * own. Then the machines are broken the ways they break in practice — a broker that lost its copy
 * and its tables, a configuration edited by hand — and the fleet puts itself back.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-fleet-e2e-'));
const TOKEN_HOLDER = 'h'.repeat(40);
const TOKEN_CLIENT = 'c'.repeat(40);
const key = fleetSigner('signer');
const trust = key.trust;

const manifest = FleetManifestSchema.parse({
  version: 1,
  members: { holder: { copy: 'full' }, client: { copy: 'own' }, bystander: { copy: 'own' } },
  access: [
    { from: 'holder', to: 'client', commands: ['echo'] },
    { from: 'bystander', to: 'holder', commands: ['echo'] },
  ],
  topics: { 'fleet.lifecycle': { producer: 'client', subscribers: ['holder'], delivery: 'ordered' } },
});

describe('a signed bundle installed on one node configures the fleet and repairs it', () => {
  const stops: Array<() => Promise<void>> = [];
  afterAll(async () => {
    for (const stop of stops.reverse()) await stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  });

  test('broker and nodes take their tables from the bundle, and put them back when broken', async () => {
    const port = freePort();
    const brokerPath = join(root, 'broker.json');
    const brokerCopy = join(root, 'broker-bundle.json');
    const bareBroker = {
      host: '127.0.0.1',
      port,
      nodes: [
        { id: 'holder', tokenSha256s: [sha256(TOKEN_HOLDER)] },
        { id: 'client', tokenSha256s: [sha256(TOKEN_CLIENT)] },
      ],
      auditPath: join(root, 'audit.jsonl'),
      fleet: { trust, copy: brokerCopy, pollMs: 300 },
    };
    writeFileSync(brokerPath, JSON.stringify(bareBroker), { mode: 0o600 });
    // Exactly what `stitchwire broker` and `stitchwire agent` run: restart in place on a changed file.
    const brokerProcess = () =>
      supervise({
        what: 'broker',
        path: brokerPath,
        load: parseBrokerConfigBytes,
        start: (config, reload) => startBroker(config, { configPath: brokerPath, reload }),
        watchMs: 300,
      });
    const broker = await brokerProcess();
    stops.push(() => broker.stop());

    const node = (id: string, token: string, extra: Record<string, unknown>) => {
      const path = join(root, `${id}.json`);
      writeFileSync(
        path,
        JSON.stringify({
          nodeId: id,
          brokers: [
            {
              id: 'primary',
              url: `http://127.0.0.1:${port}`,
              token,
              reconnect: { minDelayMs: 100, maxDelayMs: 400 },
            },
          ],
          fleet: { trust, copy: join(root, `${id}-bundle.json`), pollMs: 300 },
          ...extra,
        }),
        { mode: 0o600 },
      );
      return path;
    };
    const holderPath = node('holder', TOKEN_HOLDER, {});
    const clientPath = node('client', TOKEN_CLIENT, {
      allow: { echo: { bin: '/bin/echo', callerArgs: { mode: 'append', maxCount: 2, maxBytes: 64 } } },
    });
    const agent = (path: string) =>
      supervise({
        what: 'agent',
        path,
        load: parseNodeConfigBytes,
        start: (config, reload): Agent => createAgent(config, { path }, undefined, undefined, reload),
        watchMs: 300,
      });
    const holder = await agent(holderPath);
    const client = await agent(clientPath);
    stops.push(
      () => holder.stop(),
      () => client.stop(),
    );
    await waitConnected(holder.current, client.current);

    const echo = async () => {
      const result = await holder.current.call({
        to: 'client',
        argv: ['echo', 'fleet'],
        stdin: null,
        timeoutMs: 3_000,
      });
      return result.code === 0;
    };
    // No bundle yet: the broker grants nothing, and the call is refused.
    expect(await echo()).toBe(false);

    // The signer's whole act: install one bundle into one node's copy.
    const edition = key.edition(manifest, 1);
    writeFileSync(join(root, 'holder-bundle.json'), JSON.stringify(edition), { mode: 0o600 });

    if (!(await until(echo, 20_000, CALL_POLL_MS)))
      throw new Error(
        `not granted: ${JSON.stringify({ holder: (await holder.current.status()).bundle, client: (await client.current.status()).bundle })}`,
      );

    // The client runs its projected tables from the configuration file it rewrote and reloaded.
    expect(
      await until(async () => {
        const status = await client.current.status();
        return status.bundle.config === 'aligned' && status.events.publish.includes('fleet.lifecycle');
      }, 10_000),
    ).toBe(true);
    const clientStatus = await client.current.status();
    expect(clientStatus.bundle).toMatchObject({ copy: 'own', serial: 1, signer: 'signer' });
    expect(client.reloads).toBeGreaterThanOrEqual(1);
    expect((await holder.current.status()).bundle).toMatchObject({
      copy: 'full',
      serial: 1,
      config: 'aligned',
    });

    // The client keeps its own slice and nothing else of the fleet.
    const kept = FleetBundleSchema.parse(JSON.parse(readFileSync(join(root, 'client-bundle.json'), 'utf8')));
    expect(kept.full).toBeNull();
    expect(Object.keys(kept.slices)).toEqual(['client']);
    const said = JSON.stringify(
      FleetSlicePayloadSchema.parse(JSON.parse(kept.slices.client?.payload ?? '{}')),
    );
    expect(said).not.toContain('bystander');
    expect(said).not.toContain('holder');

    // A broker that lost its copy and its tables is repaired by the node that keeps the full bundle.
    await broker.stop();
    rmSync(brokerCopy, { force: true });
    writeFileSync(brokerPath, JSON.stringify(bareBroker), { mode: 0o600 });
    const repaired = await brokerProcess();
    stops.push(() => repaired.stop());
    expect(await until(echo, 25_000, CALL_POLL_MS)).toBe(true);
    expect(repaired.reloads).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(readFileSync(brokerCopy, 'utf8')).serial).toBe(1);

    // A deleted copy is written again from the edition the node keeps.
    const clientCopy = join(root, 'client-bundle.json');
    rmSync(clientCopy, { force: true });
    expect(
      await until(() => {
        try {
          return FleetBundleSchema.parse(JSON.parse(readFileSync(clientCopy, 'utf8'))).serial === 1;
        } catch {
          return false;
        }
      }, 5_000),
    ).toBe(true);

    // A hand edit of the client's fleet tables is undone on disk.
    const edited = JSON.parse(readFileSync(clientPath, 'utf8'));
    writeFileSync(clientPath, JSON.stringify({ ...edited, events: { ...edited.events, publish: [] } }), {
      mode: 0o600,
    });
    expect(
      await until(
        () => JSON.parse(readFileSync(clientPath, 'utf8')).events.publish.includes('fleet.lifecycle'),
        10_000,
      ),
    ).toBe(true);

    const audit = readFileSync(join(root, 'audit.jsonl'), 'utf8');
    expect(audit).toContain('"kind":"fleet-bundle"');
  }, 120_000);
});
