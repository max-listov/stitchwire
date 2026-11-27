import {
  NOT_REFUSED,
  policyRefusal,
  type Refused,
  transportFailure,
  unclassifiedFailure,
} from '../../../../contracts/src/protocol/failure.ts';
import type { NodeId } from '../../../../contracts/src/protocol/identity.ts';
import {
  type StreamAdmission,
  StreamAdmissionSchema,
  type StreamOpen,
} from '../../../../contracts/src/protocol/stream.ts';
import type { ServiceGrant } from '../../../../contracts/src/service/policy-schema.ts';
import { authorizeServiceRoute } from '../../service/policy.ts';
import type { Audit } from '../audit.ts';
import type { Registry } from '../registry.ts';
import type { StreamRouter } from '../streams.ts';

/** What the stream plane's opening decision touches, named so it can leave the connection closure. */
export interface StreamPlaneDeps {
  readonly audit: Audit;
  readonly registry: Registry;
  readonly streams: StreamRouter;
  /**
   * Read at every opening, never captured: a service stream is authorised by the same live grants as
   * a unary call — configured ones and those its serving node declared for its owners. A captured
   * list would hold only the configured ones, so every stream of an owner-declared service would be
   * refused while unary calls to the same service passed.
   */
  readonly serviceGrants: () => readonly ServiceGrant[];
}

export function open(
  deps: StreamPlaneDeps,
  nodeId: NodeId,
  socketId: string,
  request: StreamOpen,
  acknowledge: (admission: StreamAdmission) => void,
): void {
  // One record shape on both paths — see the same note in the event plane.
  const record = (decision: {
    accepted: boolean;
    refusal: Refused['refusal'];
    transportCause: Refused['transportCause'];
    detail: string;
  }): void => {
    const source = request.source;
    deps.audit.write({
      kind: 'stream-open',
      streamId: request.streamId,
      from: nodeId,
      to: request.to,
      source: source.kind,
      subject: source.kind === 'profile' ? source.profile : `${source.service}:${source.operation}`,
      requestBytes:
        source.kind === 'profile'
          ? Buffer.byteLength(source.args.join('\0')) +
            (source.stdin === null ? 0 : Buffer.byteLength(source.stdin))
          : Buffer.byteLength(source.payload),
      resumeRequested: source.kind === 'profile' && source.cursor !== null,
      ...decision,
    });
  };
  const refuse = (refused: Refused): void => {
    record({
      accepted: false,
      refusal: refused.refusal,
      transportCause: refused.transportCause,
      detail: refused.detail,
    });
    acknowledge(StreamAdmissionSchema.parse({ accepted: false, ...refused, limits: null }));
  };
  if (request.from !== nodeId) {
    refuse(
      unclassifiedFailure('rejected', `stream envelope claims '${request.from}' on a '${nodeId}' connection`),
    );
    return;
  }
  const sourceAllowed =
    request.source.kind === 'profile'
      ? deps.registry.mayPerform('stream', nodeId, request.to)
      : authorizeServiceRoute(deps.serviceGrants(), {
          id: request.streamId,
          from: request.from,
          to: request.to,
          service: request.source.service,
          revision: request.source.revision,
          operation: request.source.operation,
          payload: request.source.payload,
          timeoutMs: request.timeoutMs,
        }) !== null;
  if (!sourceAllowed) {
    refuse(policyRefusal(`stream policy does not allow ${nodeId} → ${request.to}`));
    return;
  }
  const target = deps.registry.serverFor(request.to);
  if (target === undefined) {
    refuse(transportFailure('target-offline', `${request.to} holds no serving connection right now`));
    return;
  }
  const decision = deps.streams.open(request, socketId, target.socketId);
  if (!decision.accepted) {
    refuse(decision.refused);
    return;
  }
  record({ accepted: true, refusal: 'none', transportCause: null, detail: '' });
  acknowledge(
    StreamAdmissionSchema.parse({
      accepted: true,
      ...NOT_REFUSED,
      limits: decision.limits,
    }),
  );
}
