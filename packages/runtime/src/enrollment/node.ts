import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LocalStatus } from '../../../contracts/src/door/status.ts';
import type {
  EnrollmentCredential,
  EnrollmentNodeRequest,
} from '../../../contracts/src/enrollment/request.ts';
import type { EnrollmentRuntime } from '../../../contracts/src/enrollment/result.ts';
import { freshToken } from '../cli/configuration.ts';
import { loadNodeConfig, sha256 } from '../config/io.ts';
import { type NodeConfig, NodeConfigSchema } from '../config/node.ts';
import { withConfigLock } from '../config/transaction.ts';
import { tablesFor } from '../fleet/bundle.ts';
import { applyNodeTables, sameTables } from '../fleet/projection.ts';
import { checkArtifact, fileDigest, installArtifact } from './artifact.ts';
import { attachOwner, checkOwner } from './bindings.ts';
import { EnrollmentError } from './failure.ts';
import { writePrivate } from './files.ts';
import {
  type Installation,
  installationReserved,
  requestedInstallation,
  reserveInstallation,
  type Supervision,
} from './installation.ts';
import type { RequestJournal } from './journal.ts';
import { checkKept, offeredEdition } from './material.ts';
import {
  brokersObserved,
  checkNodeIdentity,
  checkProofDescriptor,
  checkNode,
  nodeObservation,
  runningNode,
  serviceProof,
} from './observe.ts';
import { OwnersLedger } from './owners.ts';
import type { Outcome, Steps } from './steps.ts';
import { supervisorIdentity } from './supervisor-identity.ts';
import { checkUnit, publishUnit, startUnit, unitActive } from './systemd.ts';
import { AT_ONCE, KEPT_EDITION, OWN_EFFECTS, type Patience, patience, settled } from './wait.ts';

/** Delivered material is definitive; a kept copy is followed until it agrees with the brokers. */
function editionWait(request: EnrollmentNodeRequest): Patience {
  return request.material === undefined ? KEPT_EDITION : AT_ONCE;
}

function credentialsOf(config: NodeConfig): EnrollmentCredential[] {
  return config.brokers.map((broker) => ({ broker: broker.id, sha256: sha256(broker.token) }));
}

/**
 * The agent answering on this door is run by the installation enrollment recorded for this config,
 * or by something enrollment never installed (`null`). A request that names an installation must be
 * the one that holds the reservation.
 */
async function supervised(
  request: EnrollmentNodeRequest,
  installation: Installation | null,
): Promise<Supervision | null> {
  if (installation !== null && !installationReserved(request.config, installation))
    throw new EnrollmentError('runtime-conflict');
  return supervisorIdentity(request);
}

/**
 * What cannot change while one operation waits: the installation the request names, and whether its
 * delivered runtime is the requested bytes at the fleet's version. The check is measured once and
 * its verdict remembered, so a repeated observation neither hashes nor runs the runtime again.
 */
type Fixed = { installation: Installation | null; artifactChecked(): Promise<void> };
export function fixedFacts(request: EnrollmentNodeRequest, check = checkArtifact): Fixed {
  const installation = requestedInstallation(request);
  let checked: Promise<void> | undefined;
  return {
    installation,
    artifactChecked() {
      checked ??= installation === null ? Promise.resolve() : check(installation, request.expectedVersion);
      return checked;
    },
  };
}

/**
 * Everything a node operation reads before it may write, in one fresh snapshot: the configuration,
 * the edition it is judged against, every broker, the running agent and the owner's final bindings.
 * It repeats while an operation waits, so everything in it but the remembered artifact verdict is an
 * observation.
 */
async function observe(request: EnrollmentNodeRequest, fixed: Fixed, detached: boolean) {
  const { installation } = fixed;
  if (!detached) checkProofDescriptor(request);
  const info = statSync(request.config, { throwIfNoEntry: false });
  if (info !== undefined) accessSync(request.config, constants.R_OK);
  const config = info === undefined ? null : loadNodeConfig(request.config);
  const { material, opened } = offeredEdition(request, config);
  await brokersObserved(request.brokers, request.expectedVersion, opened.serial);
  // An unreachable door is not proof that an external agent stopped. A systemd enrollment may
  // resume only the reservation that preceded this configuration's birth.
  const reserved = installation !== null && installationReserved(request.config, installation);
  if (config !== null) {
    if (
      (installation !== null && !reserved) ||
      (statSync(request.config).mode & 0o777) !== 0o600 ||
      config.nodeId !== request.nodeId ||
      config.agentSocket !== request.agentSocket ||
      !sameTables(config.fleet?.trust, material.trust) ||
      !sameTables(
        config.brokers.map(({ id, url }) => ({ id, url })),
        request.brokers,
      )
    )
      throw new EnrollmentError('runtime-conflict');
    if (config.fleet === undefined) throw new EnrollmentError('bundle-invalid');
  }
  const running = await nodeObservation(request);
  if (running !== null) {
    checkNodeIdentity(running, request);
    if (running.bundle.serial !== null && running.bundle.serial > opened.serial)
      throw new EnrollmentError('bundle-stale');
    if (config?.fleet !== undefined && running.bundle.serial !== null && !existsSync(config.fleet.copy))
      throw new EnrollmentError('bundle-conflict');
    if (config === null) throw new EnrollmentError('runtime-conflict');
  }
  if (installation === null && config === null) throw new EnrollmentError('runtime-unavailable');
  if (!detached) {
    await fixed.artifactChecked();
    if (running !== null) await supervised(request, installation);
    else if (installation !== null) await checkUnit(installation.supervision);
  }
  const tables = tablesFor(opened, request.nodeId);
  if (tables === null) throw new EnrollmentError('bundle-invalid');
  const ledger = OwnersLedger.read(request.config);
  const empty = {
    services: { ...tables.services, bindings: [], descriptors: [] },
    events: { ...tables.events, descriptors: [] },
  };
  // The drop-in directories are the ones the running agent derives from its own spelling of its path.
  const agentConfig = running?.config?.path ?? request.config;
  checkOwner(request, config ?? empty, tables, ledger, detached, agentConfig);
  return { config, material, opened, tables, ledger, agentConfig };
}
type Observed = Awaited<ReturnType<typeof observe>>;

/** The node's configuration and its kept signed copy, each created once and then only read back. */
export function prepareNode(
  request: EnrollmentNodeRequest,
  observed: Pick<Observed, 'config' | 'material' | 'opened' | 'tables'>,
  installation: Installation | null,
): void {
  let config = observed.config;
  if (config === null) {
    const root = dirname(request.config);
    mkdirSync(dirname(request.agentSocket), { recursive: true, mode: 0o700 });
    const value = {
      nodeId: request.nodeId,
      agentSocket: request.agentSocket,
      brokers: request.brokers.map((broker) => ({ ...broker, token: freshToken() })),
      fleet: { trust: observed.material.trust, copy: join(root, `${request.nodeId}.fleet.json`) },
    };
    config = NodeConfigSchema.parse(applyNodeTables(value, observed.tables));
    // Reserve the validated supervisor before config birth, under the caller's config lock.
    // A crash after either write keeps one reservation and never adopts an unowned config.
    if (installation !== null) reserveInstallation(request.config, installation);
    // A retry reads this authoritative credential even when the process died before its receipt.
    writePrivate(request.config, config);
  }
  if (config.fleet === undefined) throw new EnrollmentError('bundle-invalid');
  checkKept(config.fleet.copy, config.fleet.trust, observed.opened, request.nodeId);
  if (!existsSync(config.fleet.copy)) writePrivate(config.fleet.copy, observed.material.bundle);
}

/** What runs this node, measured after verification rather than repeated from the request. */
function runtimeOf(status: LocalStatus, supervision: Supervision | null): EnrollmentRuntime {
  return {
    version: status.version,
    installation:
      supervision === null
        ? null
        : {
            path: supervision.destination,
            sha256: fileDigest(supervision.destination),
            service: { manager: 'systemd', scope: supervision.scope, unit: supervision.unit },
          },
  };
}

/**
 * The node as it runs now, by whom it is run, held to the edition it is judged against as that
 * edition is now. Identity precedes connectivity: an agent that is not ours is never waited for.
 */
async function verified(
  request: EnrollmentNodeRequest,
  installation: Installation | null,
  delivered: number,
  detached: boolean,
  ledger: OwnersLedger,
): Promise<{ status: LocalStatus; supervision: Supervision | null }> {
  const status = await runningNode(request);
  const supervision = await supervised(request, installation);
  const serial =
    request.material === undefined
      ? offeredEdition(request, loadNodeConfig(request.config)).opened.serial
      : delivered;
  const bindings = detached ? ledger.bindings(request.owner.id) : request.owner.descriptors;
  checkNode(status, request, serial, detached, bindings);
  return { status, supervision };
}

/**
 * The node side: its operating-system owner creates the node's credential and configuration,
 * installs or reuses the agent, binds one owner's descriptors and reads the running node back.
 */
export const nodeFlow = {
  async inspect(
    request: EnrollmentNodeRequest,
    operation: 'plan' | 'status',
    steps: Steps,
  ): Promise<Outcome> {
    const detached =
      operation === 'status' && OwnersLedger.read(request.config).attached(request.owner.id) === false;
    const fixed = fixedFacts(request);
    const { installation } = fixed;
    const observed = await steps.run('preflight', () =>
      settled(() => observe(request, fixed, detached), editionWait(request)),
    );
    const credentials = observed.config === null ? [] : credentialsOf(observed.config);
    if (operation === 'plan') return { kind: 'node', status: 'planned', credentials };
    return steps.run('verification', async () => {
      const { status, supervision } = await settled(
        () => verified(request, installation, observed.opened.serial, detached, observed.ledger),
        editionWait(request),
      );
      const runtime = runtimeOf(status, supervision);
      if (detached) return { kind: 'node', status: 'detached', credentials, runtime };
      return { kind: 'node', status: 'ready', credentials, runtime, proof: await serviceProof(request) };
    });
  },

  async mutation(request: EnrollmentNodeRequest, operation: 'prepare' | 'apply' | 'detach', steps: Steps) {
    const detached = operation === 'detach';
    const fixed = fixedFacts(request);
    const { installation } = fixed;
    await steps.run('preflight', () =>
      settled(() => observe(request, fixed, detached), patience(OWN_EFFECTS, editionWait(request))),
    );
    return async (journal: RequestJournal): Promise<Outcome> => {
      if (operation === 'prepare') journal.save();
      else journal.intend(detached ? 'detach' : 'attach');
      const { serial, ledger, credentials } = await steps.run('configuration', () =>
        withConfigLock(request.config, async () => {
          const observed = await steps.run('preflight', () => observe(request, fixed, detached));
          if (!detached) await steps.record('credential', () => prepareNode(request, observed, installation));
          if (operation !== 'prepare')
            await steps.record(detached ? 'detach' : 'configuration', () => {
              if (!existsSync(request.config)) throw new EnrollmentError('runtime-unavailable');
              attachOwner(
                request,
                loadNodeConfig(request.config),
                observed.tables,
                observed.ledger,
                detached,
                observed.agentConfig,
              );
            });
          return {
            serial: observed.opened.serial,
            ledger: observed.ledger,
            // Read back under the same lock: the credentials reported are the ones this run left.
            credentials: credentialsOf(loadNodeConfig(request.config)),
          };
        }),
      );
      if (operation === 'prepare') return { kind: 'node', status: 'prepared', credentials };
      if (!detached && installation !== null) {
        await steps.record('artifact', () => installArtifact(installation.artifact));
        await steps.record('supervisor-unit', () => publishUnit(installation));
        await steps.record('supervisor', () => startUnit(installation.supervision));
      }
      return steps.record('verification', async () => {
        const { status, supervision } = await settled(
          () => verified(request, installation, serial, detached, ledger),
          patience(OWN_EFFECTS, editionWait(request)),
        ).catch(async (cause: unknown) => {
          // A unit that is not running explains every unanswered observation after it.
          if (!detached && installation !== null && !(await unitActive(installation.supervision)))
            throw new EnrollmentError('supervisor-failed', { cause });
          throw cause;
        });
        const runtime = runtimeOf(status, supervision);
        if (detached) return { kind: 'node', status: 'detached', credentials, runtime };
        return { kind: 'node', status: 'ready', credentials, runtime, proof: await serviceProof(request) };
      });
    };
  },
};
