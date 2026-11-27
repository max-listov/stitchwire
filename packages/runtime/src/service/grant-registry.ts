import { ownEntry } from '../json.ts';
import type { NodeId } from '../../../contracts/src/protocol/identity.ts';
import {
  type ServiceDeclare,
  type ServiceDeclareAck,
  type ServiceDeclareRefusal,
  serviceInNamespace,
} from '../../../contracts/src/service/declaration.ts';
import type { ServiceGrant } from '../../../contracts/src/service/policy-schema.ts';
import type { BrokerConfig } from '../config/broker.ts';

/**
 * Every service grant this broker routes, from both places a grant can come from.
 *
 * Fleet grants are fixed by configuration. Declared grants arrive from the node that serves the
 * service: it may grant calls only to itself, and only for a service inside a namespace the
 * configuration gave it. Each declaration replaces that node's previous one whole. Nothing here is
 * persisted — after a restart the node's next connection declares again.
 *
 * A caller this broker does not register is accepted rather than refused: such a grant can never
 * be exercised here, and refusing it would warn forever on a node whose readers reach it through
 * another broker.
 */
export class ServiceGrantRegistry {
  private readonly declared = new Map<NodeId, ServiceGrant[]>();
  private cached: readonly ServiceGrant[] | null = null;

  constructor(private readonly config: Pick<BrokerConfig, 'serviceGrants' | 'serviceNamespaces'>) {}

  grants(): readonly ServiceGrant[] {
    this.cached ??= [...this.config.serviceGrants, ...[...this.declared.values()].flat()];
    return this.cached;
  }

  declare(nodeId: NodeId, request: ServiceDeclare): ServiceDeclareAck {
    const refuse = (grant: ServiceGrant, detail: string): ServiceDeclareRefusal => ({
      service: grant.service,
      caller: grant.caller,
      detail,
    });
    if (request.target !== nodeId)
      return {
        accepted: 0,
        refused: request.grants.map((grant) =>
          refuse(grant, 'declared target does not match the authenticated socket'),
        ),
      };
    const namespaces = ownEntry(this.config.serviceNamespaces, nodeId) ?? [];
    const accepted: ServiceGrant[] = [];
    const refused: ServiceDeclareRefusal[] = [];
    for (const grant of request.grants) {
      if (grant.target !== nodeId) refused.push(refuse(grant, 'node grants only to itself'));
      else if (!namespaces.some((namespace) => serviceInNamespace(namespace, grant.service)))
        refused.push(
          refuse(
            grant,
            namespaces.length === 0
              ? 'no service namespace granted'
              : 'outside the service namespaces granted to this node',
          ),
        );
      else accepted.push(grant);
    }
    if (accepted.length === 0) this.declared.delete(nodeId);
    else this.declared.set(nodeId, accepted);
    this.cached = null;
    return { accepted: accepted.length, refused };
  }
}
