import type { JsonFileReading } from 'stitchkit/files';
import type { z } from 'zod';
import type {
  ServiceDeclarationsStatusSchema,
  ServiceDescriptorReadingSchema,
  ServiceLaneDeclarationSchema,
  ServiceLocalRefusalSchema,
} from '../../../contracts/src/door/status.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import {
  MAX_DECLARED_SERVICES,
  parseServiceDeclaration,
  SERVICE_MAX_DECLARATION_BYTES,
  type ServiceDeclaration,
  type ServiceDeclare,
  type ServiceDeclareAck,
  serviceInNamespace,
} from '../../../contracts/src/service/declaration.ts';
import type {
  ServiceBinding,
  ServiceGrant,
  ServicePolicy,
} from '../../../contracts/src/service/policy-schema.ts';
import { DeclarationFileSet, declarationReadingDetail } from '../config/drop-in.ts';
import { wireLogger } from '../logger.ts';
import { DECLARATION_POLL_MS, type DeclaringLane, PolledDeclarer } from './polled-declarer.ts';

type ServiceDescriptorReading = z.infer<typeof ServiceDescriptorReadingSchema>;
/** Refused here, before any broker saw it: outside this node's namespaces, or colliding locally. */
type ServiceLocalRefusal = z.infer<typeof ServiceLocalRefusalSchema>;
type ServiceLaneDeclaration = z.infer<typeof ServiceLaneDeclarationSchema>;
type ServiceDeclarationSnapshot = z.infer<typeof ServiceDeclarationsStatusSchema>;

interface ServiceDeclaringLane extends DeclaringLane {
  declareServices(request: ServiceDeclare): Promise<ServiceDeclareAck | null>;
}

/** One grant, built so the scope's kind decides which of the grant's two shapes it is. */
function grantFor(
  caller: string,
  target: string,
  service: string,
  scope: ServiceGrant['scope'],
): ServiceGrant {
  return scope.kind === 'service-read'
    ? { caller, target, service, scope }
    : { caller, target, service, scope };
}

type NodeServices = ServicePolicy & {
  namespaces: readonly string[];
  descriptors: readonly string[];
};

function declarationReading(
  path: string,
  file: JsonFileReading<ServiceDeclaration>,
): { reading: ServiceDescriptorReading; declaration: ServiceDeclaration | null } {
  if (file.state !== 'read')
    return {
      reading: {
        path,
        state: file.state === 'missing' ? 'missing' : 'invalid',
        service: null,
        callers: 0,
        detail: file.state === 'missing' ? 'no file at this path' : declarationReadingDetail(file),
      },
      declaration: null,
    };
  return {
    reading: {
      path,
      state: 'loaded',
      service: file.value.binding.service,
      callers: file.value.callers.length,
      detail: null,
    },
    declaration: file.value,
  };
}

/**
 * Why this node refuses a declaration on its own, before any broker sees it: the service lies
 * outside the namespaces the fleet granted, or the service or its socket is already bound here.
 * `null` accepts. The node agent and `config validate service --node` both ask this one function.
 */
export function localRefusalReason(
  binding: ServiceBinding,
  namespaces: readonly string[],
  services: ReadonlySet<string>,
  sockets: ReadonlySet<string>,
): string | null {
  if (!namespaces.some((namespace) => serviceInNamespace(namespace, binding.service)))
    return namespaces.length === 0
      ? 'no service namespace is granted to this node'
      : `outside the service namespaces this node may serve (${namespaces.join(', ')})`;
  if (services.has(binding.service)) return 'this service is already bound on this node';
  if (sockets.has(binding.socketPath)) return `socket ${binding.socketPath} already serves another service`;
  return null;
}

/** One declaration file of the set, by path; `null` when it holds no declaration in force. */
export interface ServiceDeclarationFile {
  path: string;
  declaration: ServiceDeclaration | null;
}

/**
 * Which declarations of these files, in force order, a node serves beside its fleet bindings, and
 * which it refuses on its own and why (`localRefusalReason`): an earlier file keeps a service or a
 * socket a later one claims again. The agent serves the accepted part and reports the rest;
 * enrollment and `config validate` judge a set by the same plan. `socketKey` is how a socket path
 * is compared — as spelled for the agent, by its canonical identity for enrollment.
 */
export function planServiceDeclarations(
  files: readonly ServiceDeclarationFile[],
  namespaces: readonly string[],
  bound: readonly ServiceBinding[],
  socketKey: (socketPath: string) => string = (socketPath) => socketPath,
): { accepted: { path: string; declaration: ServiceDeclaration }[]; refused: ServiceLocalRefusal[] } {
  const services = new Set(bound.map((binding) => binding.service));
  const sockets = new Set(bound.map((binding) => socketKey(binding.socketPath)));
  const accepted: { path: string; declaration: ServiceDeclaration }[] = [];
  const refused: ServiceLocalRefusal[] = [];
  for (const { path, declaration } of files) {
    if (declaration === null) continue;
    const binding = { ...declaration.binding, socketPath: socketKey(declaration.binding.socketPath) };
    const refusal = localRefusalReason(binding, namespaces, services, sockets);
    if (refusal !== null) refused.push({ path, service: binding.service, detail: refusal });
    else {
      services.add(binding.service);
      sockets.add(binding.socketPath);
      accepted.push({ path, declaration });
    }
  }
  return { accepted, refused };
}

/**
 * The serving half of owner-declared services.
 *
 * Reads the declarations bound in `node.json` and any `*.json` files placed into the node's
 * `services.d/` drop-in directory, keeps only services inside the namespaces the fleet granted it,
 * updates the local executor and announces every change to all connected broker lanes without
 * restarting the agent.
 */
export class ServiceDeclarer extends PolledDeclarer<
  ServiceDeclaringLane,
  ServiceDeclare,
  ServiceLaneDeclaration
> {
  private descriptors: ServiceDescriptorReading[] = [];
  private local: ServiceLocalRefusal[] = [];
  private readonly files = new DeclarationFileSet(parseServiceDeclaration, SERVICE_MAX_DECLARATION_BYTES);

  constructor(
    private readonly nodeId: string,
    private readonly services: NodeServices,
    private readonly serve: (policy: ServicePolicy) => void,
    pollMs = DECLARATION_POLL_MS,
    /** The `services.d/` drop-in directory (`dropInDirs`), or `undefined` for none. */
    dropInDir?: string,
  ) {
    super(pollMs, services.descriptors, dropInDir);
  }

  async refresh(): Promise<void> {
    const scan = this.scanSources(MAX_DECLARED_SERVICES);
    const issueSignature = scan.issue === null ? '' : `${scan.issue.path}:${scan.issue.detail}`;
    const files = await this.files.readChanged(scan.entries, issueSignature);
    if (files === null) return;
    const readings = files.map((file, index) => declarationReading(scan.entries[index]?.path ?? '', file));
    const plan = planServiceDeclarations(
      readings.map(({ reading, declaration }) => ({ path: reading.path, declaration })),
      this.services.namespaces,
      this.services.bindings,
    );
    const local = plan.refused;
    const bindings: ServiceBinding[] = plan.accepted.map(({ declaration }) => declaration.binding);
    const grants: ServiceGrant[] = plan.accepted.flatMap(({ declaration }) =>
      declaration.callers.map(({ caller, scope }) =>
        grantFor(caller, this.nodeId, declaration.binding.service, scope),
      ),
    );
    const summaryDescriptors = readings.map(({ reading }) => reading);
    if (scan.issue !== null) {
      summaryDescriptors.push({
        path: scan.issue.path,
        state: 'invalid',
        service: null,
        callers: 0,
        detail: scan.issue.detail,
      });
    }
    this.descriptors = summaryDescriptors;
    this.local = local;
    const fingerprint = JSON.stringify({ bindings, grants });
    if (fingerprint === this.fingerprint) return;
    this.fingerprint = fingerprint;
    this.request = { target: this.nodeId, grants };
    this.serve({
      bindings: [...this.services.bindings, ...bindings],
      grants: [...this.services.grants, ...grants],
    });
    await this.sendToAll();
  }

  snapshot(): ServiceDeclarationSnapshot {
    return { descriptors: this.descriptors, refused: this.local, lanes: this.laneResults() };
  }

  protected async ask(lane: string, connection: ServiceDeclaringLane, request: ServiceDeclare) {
    const ack = await connection.declareServices(request);
    if (ack === null) return null;
    return { lane, declaredAt: nowIso(), accepted: ack.accepted, refused: ack.refused };
  }

  protected report(result: ServiceLaneDeclaration): void {
    if (result.refused.length > 0)
      wireLogger.error('[wire] broker refused declared service grants', {
        lane: result.lane,
        refused: result.refused,
      });
  }
}
