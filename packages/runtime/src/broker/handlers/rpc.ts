import type { BoundedAdmission } from 'stitchkit/application';
import {
  capacityRefusal,
  NOT_REFUSED,
  policyRefusal,
  type Refused,
  requestRefusal,
  transportFailure,
  unclassifiedFailure,
} from '../../../../contracts/src/protocol/failure.ts';
import type { NodeId } from '../../../../contracts/src/protocol/identity.ts';
import { type Admission, AdmissionSchema, type Invocation } from '../../../../contracts/src/protocol/rpc.ts';
import type { Audit } from '../audit.ts';
import type { CommandRouter } from '../commands.ts';
import type { Registry } from '../registry.ts';

/**
 * What the call plane touches. `dispatch` and `auditCall` are callbacks for the same reason the
 * routers take sinks: the plane decides, and something else owns the socket.
 */
export interface RpcPlaneDeps {
  readonly audit: Audit;
  readonly registry: Registry;
  readonly calls: BoundedAdmission;
  readonly commands: CommandRouter;
  readonly dispatch: (socketId: string, invocation: Invocation) => void;
  readonly auditCall: (
    audit: Audit,
    invocation: Invocation,
    accepted: boolean,
    failure: Refused['failure'],
    refusal: Refused['refusal'],
    transportCause: Refused['transportCause'],
    detail: string,
  ) => void;
}

export function call(
  deps: RpcPlaneDeps,
  nodeId: NodeId,
  callerSocketId: string,
  invocation: Invocation,
  acknowledge: (admission: Admission) => void,
): void {
  const refuse = (refused: Refused): void => {
    deps.auditCall(
      deps.audit,
      { ...invocation, from: nodeId },
      false,
      refused.failure,
      refused.refusal,
      refused.transportCause,
      refused.detail,
    );
    acknowledge(AdmissionSchema.parse({ accepted: false, ...refused }));
  };

  // The sender is the authenticated socket, never the envelope's own claim. Otherwise `from`
  // would be a field anyone can write, and the audit log would record fiction.
  if (invocation.from !== nodeId) {
    refuse(
      unclassifiedFailure(
        'rejected',
        `envelope claims to be from '${invocation.from}' on a '${nodeId}' connection`,
      ),
    );
    return;
  }
  if (deps.commands.has(invocation.id)) {
    refuse(requestRefusal(`invocation '${invocation.id}' is already in flight`, 'rejected'));
    return;
  }
  // The command is the first element of argv — the declared profile's name. Authorising by name
  // is what makes the broker's table readable as a list of operations rather than as a blanket.
  const [command = ''] = invocation.argv;
  if (!deps.registry.mayInvokeCommand(nodeId, invocation.to, command)) {
    refuse(policyRefusal(`policy does not allow ${nodeId} → ${invocation.to} to run '${command}'`));
    return;
  }
  const admitted = deps.calls.acquire(nodeId);
  if (admitted.outcome === 'refused') {
    refuse(
      capacityRefusal(
        admitted.reason === 'key-rate'
          ? `rate limit reached for ${nodeId}`
          : `inflight limit reached for ${nodeId}`,
        admitted.retryAfterMs ?? null,
      ),
    );
    return;
  }
  const target = deps.registry.serverFor(invocation.to);
  if (target === undefined) {
    admitted.lease.release();
    refuse(transportFailure('target-offline', `${invocation.to} holds no serving connection right now`));
    return;
  }

  deps.commands.begin({
    lease: admitted.lease,
    invocation,
    callerSocketId,
    targetSocketId: target.socketId,
  });

  deps.auditCall(deps.audit, invocation, true, 'none', 'none', null, '');
  deps.dispatch(target.socketId, invocation);
  acknowledge(AdmissionSchema.parse({ accepted: true, ...NOT_REFUSED }));
}
