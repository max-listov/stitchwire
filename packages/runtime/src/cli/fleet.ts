/**
 * `stitchwire fleet` — sign the fleet's manifest, hand the bundle to this node, and inspect or
 * repair a configuration against the copy kept here.
 *
 * Publishing needs no broker address and no remote shell: the signer installs the bundle into its
 * own node's copy, and the running agent hands it to its brokers, which hand it to every node.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonOnce, writeFileAtomicSync } from 'stitchkit/files';
import type { FleetBundle, FleetTrust } from '../../../contracts/src/fleet/bundle.ts';
import { FleetManifestSchema } from '../../../contracts/src/fleet/manifest.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import { firstIssue } from '../../../contracts/src/protocol/schema-parse.ts';
import { type BrokerConfig, BrokerConfigSchema } from '../config/broker.ts';
import { inspectConfig } from '../config/inspect.ts';
import { anyJson, loadBrokerConfig, loadNodeConfig, MAX_CONFIG_FILE_BYTES } from '../config/io.ts';
import { type NodeConfig, NodeConfigSchema } from '../config/node.ts';
import { paths } from '../config/paths.ts';
import {
  buildBundle,
  nextSerial,
  type OpenedBundle,
  openBundle,
  reduceBundle,
  sameEdition,
  tablesFor,
} from '../fleet/bundle.ts';
import { applyConfigFile, writeFileAtomic } from '../fleet/copy.ts';
import {
  applyBrokerTables,
  applyNodeTables,
  brokerTablesOf,
  nodeTablesOf,
  sameTables,
} from '../fleet/projection.ts';
import { generateSigningKey, publicKeyOf, readSigningKey } from '../fleet/signature.ts';
import type { Json } from '../json.ts';
import { flagValue, positional } from './configuration.ts';
import { fail } from './io.ts';

const USAGE = `usage:
  stitchwire fleet keygen --id <key-id> [--key <path>]
  stitchwire fleet sign --manifest <path> --id <key-id> [--key <path>] [--serial N] --out <path>
  stitchwire fleet publish --manifest <path> --id <key-id> [--key <path>] [--config <node.json>] [--also <path>]...
  stitchwire fleet install <bundle> [--config <node.json>]
  stitchwire fleet show [<bundle>] [--config <node.json>]
  stitchwire fleet apply [--config <path>] [--broker]
  stitchwire fleet check [--config <path>] [--broker]`;

function required(argv: string[], flag: string, what: string): string {
  const value = flagValue(argv, flag);
  if (value === undefined || value.startsWith('--')) fail(`missing ${flag} <${what}>\n${USAGE}`);
  return value;
}

function readManifest(path: string) {
  const reading = readJsonOnce(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
  if (reading.state !== 'read')
    fail(`${path}: ${reading.state === 'missing' ? 'no such file' : reading.detail}`);
  const parsed = FleetManifestSchema.safeParse(reading.value);
  if (!parsed.success)
    fail(
      `${path} is not a valid fleet manifest:\n${parsed.error.issues
        .map((issue) => `  ${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('\n')}`,
    );
  return parsed.data;
}

function nodeSettings(configPath: string): { config: NodeConfig; fleet: NonNullable<NodeConfig['fleet']> } {
  const config = loadNodeConfig(configPath);
  if (config.fleet === undefined)
    fail(
      `${configPath} has no "fleet" section: add fleet.trust with the keys this node accepts a bundle from`,
    );
  return { config, fleet: config.fleet };
}

function openKept(path: string, trust: FleetTrust, requireFull: boolean): OpenedBundle | null {
  const reading = readJsonOnce(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
  if (reading.state === 'missing') return null;
  if (reading.state !== 'read') fail(`${path}: ${reading.detail}`);
  const opening = openBundle(reading.value, trust, { requireFull });
  if (!opening.ok) fail(`${path} is refused: ${opening.detail}`);
  return opening.opened;
}

function sign(argv: string[], current: number | null): FleetBundle {
  const manifest = readManifest(required(argv, '--manifest', 'path'));
  const keyId = required(argv, '--id', 'key-id');
  const keyPath = flagValue(argv, '--key') ?? paths.fleetSigningKey;
  const privateKeyPem = readSigningKey(keyPath);
  const serialFlag = flagValue(argv, '--serial');
  const serial = serialFlag === undefined ? nextSerial(current) : Number(serialFlag);
  if (!Number.isSafeInteger(serial) || serial < 1) fail('--serial expects a positive whole number');
  const bundle = buildBundle({ manifest, serial, issuedAt: nowIso(), keyId, privateKeyPem });
  // The signer checks its own work with the public half, exactly as every receiver will.
  const self = openBundle(bundle, [{ id: keyId, publicKey: publicKeyOf(privateKeyPem) }], {
    requireFull: true,
  });
  if (!self.ok) fail(`the bundle just signed does not verify: ${self.detail}`);
  return bundle;
}

/** Keep an edition in this node's copy, reduced to what this node may hold; the agent does the rest. */
function install(bundle: unknown, configPath: string, source: string): number {
  const { config, fleet } = nodeSettings(configPath);
  const opening = openBundle(bundle, fleet.trust, { requireFull: false });
  if (!opening.ok) fail(`${source} is refused: ${opening.detail}`);
  const kept = openKept(fleet.copy, fleet.trust, false);
  if (kept !== null && opening.opened.serial < kept.serial)
    fail(`${source} is edition ${opening.opened.serial}, older than the kept edition ${kept.serial}`);
  const reduced = reduceBundle(opening.opened, config.nodeId);
  if (reduced === null) fail(`edition ${opening.opened.serial} has no part for ${config.nodeId}`);
  if (kept !== null && opening.opened.serial === kept.serial) {
    if (!sameEdition(reduced, kept.bundle))
      fail(`edition ${kept.serial} conflicts with the kept signed edition`);
    console.log(`edition ${kept.serial} is already kept at ${fleet.copy}`);
    return 0;
  }
  writeFileAtomic(fleet.copy, `${JSON.stringify(reduced, null, 2)}\n`);
  console.log(
    `kept edition ${reduced.serial} for ${config.nodeId} (${reduced.full === null ? 'own slice' : 'full bundle'}) at ${fleet.copy}`,
  );
  console.log(`the running agent applies it and hands it to its brokers within ${fleet.pollMs} ms`);
  return 0;
}

export async function runFleet(argv: string[]): Promise<number> {
  const action = argv[0];
  const rest = argv.slice(1);
  const configPath = flagValue(rest, '--config');

  if (action === 'keygen') {
    const keyId = required(rest, '--id', 'key-id');
    const keyPath = flagValue(rest, '--key') ?? paths.fleetSigningKey;
    if (existsSync(keyPath)) fail(`${keyPath} already exists — a signing key is never overwritten`);
    const { privateKeyPem, publicKey } = generateSigningKey();
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileAtomicSync(keyPath, privateKeyPem, { mode: 0o600, replace: false });
    console.log(`wrote ${keyPath} (mode 600): the private half, which never leaves this machine`);
    console.log(
      '\nadd this entry to fleet.trust on every node and broker that accepts bundles from this key:',
    );
    console.log(JSON.stringify({ id: keyId, publicKey }));
    return 0;
  }

  if (action === 'sign') {
    const out = required(rest, '--out', 'path');
    const bundle = sign(rest, null);
    writeFileAtomic(out, `${JSON.stringify(bundle, null, 2)}\n`);
    console.log(`signed edition ${bundle.serial} with ${bundle.full?.keyId ?? '?'} → ${out}`);
    return 0;
  }

  if (action === 'publish') {
    const node = configPath ?? paths.nodeConfig;
    const { fleet } = nodeSettings(node);
    const kept = openKept(fleet.copy, fleet.trust, false);
    const bundle = sign(rest, kept?.serial ?? null);
    const also = rest.filter((entry, index) => rest[index - 1] === '--also' && !entry.startsWith('--'));
    for (const path of also) {
      writeFileAtomic(path, `${JSON.stringify(bundle, null, 2)}\n`);
      console.log(`wrote edition ${bundle.serial} to ${path}`);
    }
    return install(bundle, node, `edition ${bundle.serial}`);
  }

  if (action === 'install') {
    const source = positional(rest)[0];
    if (source === undefined) fail(USAGE);
    const reading = readJsonOnce(source, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
    if (reading.state !== 'read')
      fail(`${source}: ${reading.state === 'missing' ? 'no such file' : reading.detail}`);
    return install(reading.value, configPath ?? paths.nodeConfig, source);
  }

  if (action === 'show') {
    const node = configPath ?? paths.nodeConfig;
    const config = existsSync(node) ? loadNodeConfig(node) : null;
    const path = positional(rest)[0] ?? config?.fleet?.copy ?? paths.fleetCopy;
    const reading = readJsonOnce(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
    if (reading.state !== 'read')
      fail(`${path}: ${reading.state === 'missing' ? 'no such file' : reading.detail}`);
    const trust = config?.fleet?.trust;
    if (trust === undefined) fail(`${node} names no fleet.trust, so ${path} cannot be verified here`);
    const opening = openBundle(reading.value, trust, { requireFull: false });
    if (!opening.ok) fail(`${path} is refused: ${opening.detail}`);
    const opened = opening.opened;
    console.log(`bundle      ${path}`);
    console.log(
      `edition     ${opened.serial}, issued ${opened.issuedAt}, signed by ${opened.signer} (verified)`,
    );
    console.log(
      `copy        ${opened.manifest === null ? `own slice of ${[...opened.slices.keys()].join(', ')}` : 'full bundle'}`,
    );
    if (opened.manifest !== null)
      console.log(
        `members     ${Object.entries(opened.manifest.members)
          .map(([id, member]) => `${id} (${member.copy})`)
          .join(', ')}`,
      );
    return 0;
  }

  if (action === 'check') {
    const broker = rest.includes('--broker');
    const path = configPath ?? (broker ? paths.brokerConfig : paths.nodeConfig);
    const fleet = inspectConfig(broker ? 'broker' : 'node', path).fleet;
    if (fleet === null) {
      console.log('unknown: no fleet configuration');
      return 2;
    }
    console.log(`${fleet.state}: ${fleet.detail}`);
    return { aligned: 0, drifted: 1, unknown: 2 }[fleet.state];
  }

  if (action === 'apply') {
    const broker = rest.includes('--broker');
    const path = configPath ?? (broker ? paths.brokerConfig : paths.nodeConfig);
    let project: (config: Json) => Json;
    let tablesOf: (config: Json) => unknown;
    let validate: (config: Json) => string | null;
    let copyPath: string;
    if (broker) {
      const config: BrokerConfig = loadBrokerConfig(path);
      if (config.fleet === undefined) fail(`${path} has no "fleet" section`);
      copyPath = config.fleet.copy;
      const kept = openKept(copyPath, config.fleet.trust, true);
      if (kept === null || kept.manifest === null) {
        console.log(`unknown: no verified bundle kept at ${copyPath}`);
        return 2;
      }
      const manifest = kept.manifest;
      project = (raw) => applyBrokerTables(raw, manifest);
      tablesOf = brokerTablesOf;
      validate = (raw) => {
        const parsed = BrokerConfigSchema.safeParse(raw);
        return parsed.success ? null : firstIssue(parsed.error);
      };
    } else {
      const { config, fleet } = nodeSettings(path);
      copyPath = fleet.copy;
      const kept = openKept(copyPath, fleet.trust, false);
      const tables = kept === null ? null : tablesFor(kept, config.nodeId);
      if (tables === null) {
        console.log(`unknown: no verified bundle with a part for ${config.nodeId} kept at ${copyPath}`);
        return 2;
      }
      project = (raw) => applyNodeTables(raw, tables);
      tablesOf = nodeTablesOf;
      validate = (raw) => {
        const parsed = NodeConfigSchema.safeParse(raw);
        return parsed.success ? null : firstIssue(parsed.error);
      };
    }
    const applied = await applyConfigFile(path, { project, tablesOf, same: sameTables, validate });
    if (applied.state === 'refused') {
      console.error(`refused: ${applied.detail}`);
      return 2;
    }
    if (applied.state === 'aligned') console.log(`aligned: ${path} already matches the bundle`);
    else
      console.log(
        `written: ${path} now matches the bundle (previous file kept at ${applied.backup}); a running ${broker ? 'broker' : 'agent'} with fleet trust reloads on its next check`,
      );
    return 0;
  }

  fail(USAGE);
}
