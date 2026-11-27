import { existsSync } from 'node:fs';
import { localContract } from '../../../contracts/src/door/local-contract.ts';
import { doorPath } from '../../../contracts/src/door/paths.ts';
import { type LocalStatus, LocalStatusSchema } from '../../../contracts/src/door/status.ts';
import type {
  EnrollmentDescriptor,
  EnrollmentEndpoint,
  EnrollmentNodeRequest,
} from '../../../contracts/src/enrollment/request.ts';
import { SERVICE_MAX_DESCRIPTOR_BYTES } from '../../../contracts/src/service/contracts.ts';
import { ServiceDescriptorSchema } from '../../../contracts/src/service/policy-schema.ts';
import { createWireClient, type WireClient } from '../../../local-client/src/client.ts';
import { readBrokerObservation, readDoctorObservation } from '../cli/doctor-read.ts';
import { loadNodeConfig, sha256 } from '../config/io.ts';
import { declarationIdentity } from '../config/drop-in.ts';
import { configIdentity } from '../config/identity.ts';
import { RELEASE_VERSION } from '../release-version.ts';
import { configuredBindings, type OwnedDeclarations, ownedDeclarations } from './bindings.ts';
import { EnrollmentError } from './failure.ts';
import { readValue } from './files.ts';
import { OWN_EFFECT_MS } from './wait.ts';

export async function brokerObservation(url: string, expectedVersion: string, serial?: number) {
  const health = await readBrokerObservation(url).catch((cause: unknown) => {
    throw new EnrollmentError('broker-unavailable', { cause });
  });
  if (health.fleet.latest !== expectedVersion || expectedVersion !== RELEASE_VERSION)
    throw new EnrollmentError('version-mismatch');
  // A broker of this release always writes its bundle; one that writes none cannot be certified.
  const { bundle } = health;
  if (bundle === undefined) throw new EnrollmentError('broker-unavailable');
  if (serial !== undefined && bundle.serial !== serial)
    throw new EnrollmentError(
      bundle.serial !== null && bundle.serial > serial ? 'bundle-stale' : 'bundle-conflict',
    );
  return { ...health, bundle };
}

/** Every broker is asked at once; the refusal reported is the first in the request's own order. */
export async function brokersObserved(
  brokers: readonly EnrollmentEndpoint[],
  expectedVersion: string,
  serial: number,
): Promise<void> {
  const answers = await Promise.allSettled(
    brokers.map((broker) => brokerObservation(broker.url, expectedVersion, serial)),
  );
  for (const answer of answers) if (answer.status === 'rejected') throw answer.reason;
}

/** Enrollment certifies broker routing; the ordinary SDK may still execute self-calls locally. */
export function checkProofTarget(request: EnrollmentNodeRequest): void {
  if (request.proof?.call.to === request.nodeId) throw new EnrollmentError('proof-not-remote');
}

/** A proof is one unary read the owner's descriptor declares; no proof means nothing to refuse. */
export function checkProofDescriptor(request: EnrollmentNodeRequest): void {
  checkProofTarget(request);
  const proof = request.proof;
  if (proof === undefined) return;
  const descriptor = readValue(proof.descriptor, ServiceDescriptorSchema, SERVICE_MAX_DESCRIPTOR_BYTES);
  const operation = descriptor.operations.find((candidate) => candidate.id === proof.call.operation);
  if (
    descriptor.service !== proof.call.service ||
    descriptor.revision !== proof.call.revision ||
    operation?.effect !== 'read' ||
    operation.response.kind !== 'unary'
  )
    throw new EnrollmentError('proof-not-read');
}

export async function nodeObservation(request: EnrollmentNodeRequest): Promise<LocalStatus | null> {
  if (!existsSync(request.agentSocket)) return null;
  try {
    return await readDoctorObservation(
      `http://localhost${doorPath(localContract, 'status')}`,
      LocalStatusSchema,
      request.agentSocket,
    );
  } catch (cause) {
    throw new EnrollmentError('runtime-unavailable', { cause });
  }
}

export function checkNodeIdentity(status: LocalStatus, request: EnrollmentNodeRequest): void {
  if (
    status.nodeId !== request.nodeId ||
    status.config === null ||
    configIdentity(status.config.path) !== request.config ||
    status.config.mode !== '600'
  )
    throw new EnrollmentError('runtime-conflict');
  if (status.version !== request.expectedVersion) throw new EnrollmentError('version-mismatch');
}

type Declared = Pick<LocalStatus, 'services' | 'events'>;
const sum = (counts: number[]) => counts.reduce((total, count) => total + count, 0);
/** One lane's answer to what the agent sent it, and whether it refused anything of this owner. */
type LaneJudgement = { lane: string; answered: number; refusesOwner: boolean };
/** What the agent sent every lane of one kind, and whether it refused anything of this owner itself. */
type Judgement = { sent: number; refusesOwner: boolean; lanes: LaneJudgement[] };

/**
 * Each kind of binding as the running agent reports it. What it sent a lane is counted from its own
 * status — an entry it refused locally was never sent — and a refusal is the owner's only when it
 * names the owner's file (a service refused here), the owner's service (a grant a broker refused),
 * or a topic of the owner's that the plan does not give to the owner's files.
 */
const declared = {
  service: (status: Declared, owned: OwnedDeclarations): Judgement => {
    const { descriptors, refused, lanes } = status.services.declarations;
    const mine = (path: string) => owned.paths.has(declarationIdentity(path));
    const local = new Set(refused.map(({ path }) => path));
    const services = new Set(
      descriptors.flatMap((entry) => (mine(entry.path) && entry.service !== null ? [entry.service] : [])),
    );
    return {
      sent: sum(
        descriptors
          .filter((entry) => entry.state === 'loaded' && !local.has(entry.path))
          .map((entry) => entry.callers),
      ),
      refusesOwner: refused.some(({ path }) => mine(path)),
      lanes: lanes.map((ack) => ({
        lane: ack.lane,
        answered: ack.accepted + ack.refused.length,
        refusesOwner: ack.refused.some(({ service }) => services.has(service)),
      })),
    };
  },
  topic: (status: Declared, owned: OwnedDeclarations): Judgement => {
    const { descriptors, refused, lanes } = status.events.declarations;
    return {
      sent: sum(descriptors.map((entry) => entry.topics)) - refused.length,
      refusesOwner: refused.some(({ topic }) => owned.topics.has(topic) && !owned.held.has(topic)),
      lanes: lanes.map((ack) => ({
        lane: ack.lane,
        answered: ack.accepted + ack.refused.length,
        refusesOwner: ack.refused.some(({ topic }) => owned.topics.has(topic)),
      })),
    };
  },
} satisfies Record<EnrollmentDescriptor['kind'], (status: Declared, owned: OwnedDeclarations) => Judgement>;
const KINDS: EnrollmentDescriptor['kind'][] = ['service', 'topic'];
const readingsOf = {
  service: (status: Declared) => status.services.declarations.descriptors,
  topic: (status: Declared) => status.events.declarations.descriptors,
} satisfies Record<EnrollmentDescriptor['kind'], (status: Declared) => { path: string; state: string }[]>;

/**
 * Every lane must have answered the complete dynamic set the agent sends now, an empty withdrawal
 * included, and nothing of this owner may be refused, by the agent or by a broker. A broker answers
 * every entry it is sent (`accepted + refused`), and the agent drops a lane's answer whenever it
 * sends again, so an answer that counts what was sent is the answer to the current set; a lane that
 * shows an earlier answer, or none, is refused. A refusal of another owner's file is that file's.
 */
export function checkDeclarationAcks(
  status: Declared,
  request: Pick<EnrollmentNodeRequest, 'brokers'>,
  owned: OwnedDeclarations,
): void {
  for (const kind of KINDS) {
    const { sent, refusesOwner, lanes } = declared[kind](status, owned);
    if (
      refusesOwner ||
      request.brokers.some((broker) => {
        const ack = lanes.find((lane) => lane.lane === broker.id);
        return ack === undefined || ack.refusesOwner || ack.answered !== sent;
      })
    )
      throw new EnrollmentError('declaration-refused');
  }
}

/** The agent answering on the node's door, and it is this node at this version. */
export async function runningNode(request: EnrollmentNodeRequest): Promise<LocalStatus> {
  const status = await nodeObservation(request);
  if (status === null) throw new EnrollmentError('runtime-unavailable');
  checkNodeIdentity(status, request);
  return status;
}

/**
 * The running agent is at this edition, connected to every broker, with the owner's bindings
 * loaded (or, after a detach, gone from both the runtime and the configuration).
 */
export function checkNode(
  status: LocalStatus,
  request: EnrollmentNodeRequest,
  serial: number,
  detached: boolean,
  bindings: readonly EnrollmentDescriptor[],
): void {
  for (const broker of request.brokers) {
    const lane = status.lanes.find((candidate) => candidate.id === broker.id && candidate.url === broker.url);
    if (!lane?.connected)
      throw new EnrollmentError(lane?.lastFailure?.refused ? 'handshake-refused' : 'broker-unavailable');
  }
  if (status.bundle.serial !== serial || status.bundle.config !== 'aligned')
    throw new EnrollmentError('bundle-conflict');
  const config = loadNodeConfig(request.config);
  for (const kind of KINDS) {
    const readings = readingsOf[kind](status);
    const configured = new Set(configuredBindings[kind](config).map(configIdentity));
    for (const { path } of bindings.filter((entry) => entry.kind === kind)) {
      const reading = readings.find((entry) => declarationIdentity(entry.path) === path);
      if (detached ? reading !== undefined || configured.has(path) : reading?.state !== 'loaded')
        throw new EnrollmentError('declaration-refused');
    }
  }
  // The drop-in directories are the ones the agent derived from its configuration path as it spelled it.
  if (status.config === null) throw new EnrollmentError('runtime-conflict');
  checkDeclarationAcks(
    status,
    request,
    ownedDeclarations(config, status.config.path, bindings, status.events),
  );
}

/**
 * A proof answer that is the route still settling, not the route's verdict: the target is not on the
 * broker yet, or the lane was lost mid-call. An apply causes exactly this itself — the broker keeps
 * the new edition and reloads, dropping every lane for a moment — so it is waited out like the
 * apply's other effects. A policy refusal or a wrong answer is final at once.
 */
const SETTLING_PROOF = new Set(['offline', 'unavailable']);

/**
 * The requested read, made through a broker; null when the request asked for no proof. `connect`
 * opens the client the read is made with: the agent's door, unless a test stands in for it.
 */
export async function serviceProof(
  request: EnrollmentNodeRequest,
  connect: () => Pick<WireClient, 'invokeService' | 'close'> = () =>
    createWireClient({ socketPath: request.agentSocket }),
): Promise<{ httpStatus: number } | null> {
  const proof = request.proof;
  if (proof === undefined) return null;
  // The descriptor is read again before dispatch: status and crash recovery certify it too.
  checkProofDescriptor(request);
  const client = connect();
  const started = Date.now();
  try {
    for (;;) {
      // A proof is a declared read, so asking again after a lost lane repeats nothing.
      const { outcome } = await client.invokeService(proof.call);
      if (outcome.status === 'response') {
        if (
          outcome.httpStatus < 200 ||
          outcome.httpStatus >= 300 ||
          sha256(outcome.payload) !== proof.responseSha256
        )
          throw new EnrollmentError('proof-failed', { cause: { httpStatus: outcome.httpStatus } });
        return { httpStatus: outcome.httpStatus };
      }
      // The ceiling bounds the start of the last attempt, as in `settled`: that call may then take up
      // to the proof's own `timeoutMs` before its answer is final.
      if (!SETTLING_PROOF.has(outcome.code) || Date.now() - started >= OWN_EFFECT_MS)
        throw new EnrollmentError('proof-failed', { cause: outcome });
      await Bun.sleep(100);
    }
  } catch (cause) {
    if (cause instanceof EnrollmentError) throw cause;
    throw new EnrollmentError('proof-failed', { cause });
  } finally {
    client.close();
  }
}
