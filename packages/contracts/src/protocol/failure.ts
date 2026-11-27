import { z } from 'zod';

export const FailureSchema = z.enum([
  'none', // the command ran; `code` is its own verdict
  'offline', // the target node holds no serving connection right now
  'denied', // refused before execution; `refusal` below says by what
  'timeout', // accepted and dispatched, but no result arrived in time
  'rejected', // the broker refused the envelope itself (bad shape, unknown target)
  'exec', // the target tried to run it and could not (missing binary, spawn error)
  'transport', // the caller lost the broker mid-flight
  // The caller withdrew. Distinct from `timeout`, which means nobody withdrew and nobody answered,
  // and from `rejected`, which means the work never started. Here the work started and was stopped
  // on purpose — the one outcome where an unfinished command is the correct result.
  'cancelled',
]);
export type Failure = z.infer<typeof FailureSchema>;

/** The machine-readable transport fact. `detail` explains it to a person; consumers branch here. */
export const TransportCauseSchema = z.enum([
  'no-connected-lane',
  'presence-pending-timeout',
  'target-offline',
  'lane-lost-after-dispatch',
  'acknowledgement-timeout',
]);
export type TransportCause = z.infer<typeof TransportCauseSchema>;

/**
 * What each transport cause means to the layers that report it, in one table: the wire's `failure`,
 * the code of a service outcome, and whether the owner could have seen the call (`delivery`).
 * A cause that appears with any other pairing is a contradiction, and the refinements reject it.
 */
export const TRANSPORT_CAUSES = {
  'no-connected-lane': { failure: 'transport', serviceCode: 'unavailable', delivery: 'not-dispatched' },
  'presence-pending-timeout': {
    failure: 'transport',
    serviceCode: 'unavailable',
    delivery: 'not-dispatched',
  },
  'target-offline': { failure: 'offline', serviceCode: 'offline', delivery: 'not-dispatched' },
  'lane-lost-after-dispatch': { failure: 'transport', serviceCode: 'unavailable', delivery: 'unknown' },
  'acknowledgement-timeout': { failure: 'timeout', serviceCode: 'timeout', delivery: 'unknown' },
} as const satisfies Record<
  TransportCause,
  {
    failure: 'offline' | 'timeout' | 'transport';
    serviceCode: 'offline' | 'timeout' | 'unavailable';
    delivery: 'not-dispatched' | 'unknown';
  }
>;

/**
 * What kind of "no" this is — the second dimension of a refusal, and the one a client can act on.
 *
 * `failure` says which layer refused; on its own it cannot say whether trying again is sensible.
 * A node at its concurrency ceiling and a command outside the allowlist both arrive as `denied`,
 * yet one clears itself in milliseconds and the other never will. Without this field the only way
 * to tell them apart is to match English prose out of `detail` — which is not a contract, so every
 * consumer ends up guessing, and the usual guess is "permanent": a healthy fleet drawn as broken.
 */
export const RefusalSchema = z.enum([
  'none', // not a classified refusal — `failure` carries the whole meaning
  'policy', // permanent: an ACL, a capability grant, an allowlist or a topic declaration says no
  'capacity', // temporary: a limit that frees on its own — retrying later is the correct response
  'request', // permanent for THIS request: it exceeds a profile bound — change it, then retry
]);
export type Refusal = z.infer<typeof RefusalSchema>;

/** A whole hour is far past any admission window here; the ceiling exists so a peer cannot park a
 *  client for a day by writing one large number. */
export const MAX_RETRY_AFTER_MS = 3_600_000;

export const RetryAfterSchema = z.number().int().min(0).max(MAX_RETRY_AFTER_MS).nullable();

/** The classification of an answer that is not a refusal: every field says "nothing went wrong". */
export const NOT_REFUSED = {
  failure: 'none',
  refusal: 'none',
  retryAfterMs: null,
  transportCause: null,
  detail: '',
} as const;

/** The required classification carried by every exact-version wire envelope that can say "no". */
export const RefusalFields = {
  refusal: RefusalSchema,
  /** Set only where the limit is a known-length window (a per-minute rate). An inflight or
   *  concurrency ceiling frees when someone else finishes, which is not a time — it stays `null`
   *  rather than inviting a client to sleep on an invented number. */
  retryAfterMs: RetryAfterSchema,
  transportCause: TransportCauseSchema.nullable(),
};

/** Keeps the two dimensions from contradicting each other on the wire: a classified refusal that
 *  claims success, or a retry hint on a refusal that will never clear, is a bug the receiver would
 *  otherwise have to defend against. */
export function refusalRefinement(
  value: {
    failure: Failure;
    refusal: Refusal;
    retryAfterMs: number | null;
    transportCause: TransportCause | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.refusal !== 'none' && value.failure === 'none') {
    ctx.addIssue({
      code: 'custom',
      path: ['refusal'],
      message: 'a classified refusal cannot carry failure "none"',
    });
  }
  if (value.retryAfterMs !== null && value.refusal !== 'capacity') {
    ctx.addIssue({
      code: 'custom',
      path: ['retryAfterMs'],
      message: 'retryAfterMs belongs to a capacity refusal',
    });
  }
  if (value.transportCause != null && !['offline', 'timeout', 'transport'].includes(value.failure)) {
    ctx.addIssue({
      code: 'custom',
      path: ['transportCause'],
      message: 'transportCause belongs to an offline, timeout or transport failure',
    });
  }
  if (value.transportCause != null) {
    const expectedFailure = TRANSPORT_CAUSES[value.transportCause].failure;
    if (value.failure !== expectedFailure)
      ctx.addIssue({
        code: 'custom',
        path: ['transportCause'],
        message: `${value.transportCause} requires failure "${expectedFailure}"`,
      });
  }
}

/** One refusal, classified at the point that knows why — carried together so `failure` and
 *  `refusal` cannot be set from two different opinions about the same "no". */
export interface Refused {
  failure: Failure;
  refusal: Refusal;
  detail: string;
  retryAfterMs: number | null;
  transportCause: TransportCause | null;
}

/** An ACL, a capability grant, an allowlist or a topic declaration says no. Retrying is pointless;
 *  a human has to change configuration. */
export function policyRefusal(detail: string): Refused {
  return { failure: 'denied', refusal: 'policy', detail, retryAfterMs: null, transportCause: null };
}

/**
 * A ceiling that frees on its own. The caller is not doing anything wrong and the data is intact —
 * this is the case a client must never render as "unavailable".
 *
 * `failure` is a parameter for the same reason `requestRefusal` has one: admission REFUSES a call
 * before it runs (`denied`), while a buffer that overflows mid-flight is not a refusal at all and
 * keeps the code its layer already used. The class is the same; which layer hit the ceiling is not.
 *
 * The hint is clamped rather than trusted: every producer computes it from wall-clock deltas, and a
 * clock stepped backwards further than the window would otherwise put a value past the schema
 * ceiling into `.parse` — a thrown error inside a socket handler instead of a refusal.
 */
export function capacityRefusal(
  detail: string,
  retryAfterMs: number | null = null,
  failure: Failure = 'denied',
): Refused {
  return {
    failure,
    refusal: 'capacity',
    detail,
    retryAfterMs: retryAfterMs === null ? null : Math.min(MAX_RETRY_AFTER_MS, Math.max(0, retryAfterMs)),
    transportCause: null,
  };
}

/** The request itself does not fit a bound — too much stdin, too long a timeout, an argument shape
 *  the profile does not accept, a chunk over the stream ceiling. Identical retries fail identically.
 *
 *  `failure` is a parameter because the same class arrives under two codes: a node REFUSES an
 *  oversized call (`denied`), while the broker REJECTS a frame that breaks the ceilings it enforces
 *  (`rejected`). Which layer said no and what kind of no it is are separate questions. */
export function requestRefusal(detail: string, failure: Failure = 'denied'): Refused {
  return { failure, refusal: 'request', detail, retryAfterMs: null, transportCause: null };
}

/** A failure that is not a classified refusal: nobody said no, something else went wrong. */
export function unclassifiedFailure(failure: Failure, detail: string): Refused {
  return { failure, refusal: 'none', detail, retryAfterMs: null, transportCause: null };
}

/** A transport failure classified at the layer that observed the route transition. */
export function transportFailure(transportCause: TransportCause, detail: string): Refused {
  const { failure } = TRANSPORT_CAUSES[transportCause];
  return { failure, refusal: 'none', detail, retryAfterMs: null, transportCause };
}
