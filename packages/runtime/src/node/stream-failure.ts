import {
  capacityRefusal,
  policyRefusal,
  type Refused,
  requestRefusal,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import type { StreamTerminalReason } from '../../../contracts/src/protocol/stream.ts';
import type { ServiceOutcome } from '../../../contracts/src/service/contracts.ts';

export class ProducerFailure extends Error {
  constructor(
    readonly reason: StreamTerminalReason,
    message: string,
  ) {
    super(message);
  }
}

/** A producer limit is permanent for the same request; other stream failures may clear. */
export function producerRefusal(reason: StreamTerminalReason, detail: string): Refused {
  if (reason === 'limit') return requestRefusal(detail, 'exec');
  return unclassifiedFailure(reason === 'slow-consumer' || reason === 'timeout' ? 'timeout' : 'exec', detail);
}

/** Preserve the service executor's failure layer instead of flattening every refusal to policy. */
export function serviceOutcomeRefusal(outcome: ServiceOutcome): Refused {
  if (outcome.status !== 'failure') return unclassifiedFailure('exec', 'service stream refused');
  const detail = `service stream ${outcome.code}`;
  switch (outcome.code) {
    case 'denied':
    case 'unsupported':
      return policyRefusal(detail);
    case 'invalid-request':
      return requestRefusal(detail);
    case 'capacity':
      return capacityRefusal(detail);
    case 'timeout':
      return unclassifiedFailure('timeout', detail);
    case 'cancelled':
      return unclassifiedFailure('cancelled', detail);
    case 'offline':
      return unclassifiedFailure('offline', detail);
    case 'unavailable':
    case 'invalid-response':
      return unclassifiedFailure('exec', detail);
  }
}
