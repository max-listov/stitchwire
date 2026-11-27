import { createBoundedAdmission } from 'stitchkit/application';
import { z } from 'zod';
import { serviceAbortOrigin } from './cancellation.ts';
import { createHandler, implement, type RawRoute } from 'stitchkit/server';
import { LOCAL_API_VERSION } from '../../../contracts/src/door/common.ts';
import { doorPath } from '../../../contracts/src/door/paths.ts';
import { SERVICE_TRACE_HEADER } from '../../../contracts/src/service/diagnostics.ts';
import { serviceContract } from '../../../contracts/src/service/service-contract.ts';
import type { TraceService } from './trace.ts';
import {
  SERVICE_MAX_TIMEOUT_MS,
  type ServiceCall,
  type ServiceOutcome,
  serviceFailure,
} from '../../../contracts/src/service/contracts.ts';

/** Admission and deadline include body parsing, not just the typed handler. */
export function createLocalServiceRoute(
  source: {
    invokeService(input: ServiceCall, signal?: AbortSignal): Promise<ServiceOutcome>;
  },
  trace?: TraceService,
): RawRoute {
  const admission = createBoundedAdmission({ policy: { global: { maxConcurrent: 32 } } });
  const observations = new WeakMap<Request, { traceId: string; started: number; outcome?: ServiceOutcome }>();
  const handler = createHandler({
    services: [
      implement(serviceContract, {
        invokeService: async (ctx) => {
          const observation = ctx.req && observations.get(ctx.req);
          if (!observation) throw new Error('missing service door observation');
          const input = { ...ctx.input, traceId: observation.traceId };
          if (ctx.input.traceId !== undefined && ctx.input.traceId !== input.traceId) {
            const outcome = serviceFailure('invalid-request');
            observation.outcome = outcome;
            return { v: LOCAL_API_VERSION, traceId: input.traceId, outcome };
          }
          trace?.(input, 'door-parsed', performance.now() - observation.started);
          const outcome = await source.invokeService(input, ctx.signal);
          observation.outcome = outcome;
          trace?.(input, 'door-result', performance.now() - observation.started, outcome);
          return { v: LOCAL_API_VERSION, traceId: input.traceId, outcome };
        },
      }),
    ],
  });
  return {
    method: 'POST',
    path: doorPath(serviceContract, 'invokeService'),
    serviceName: serviceContract.meta.prefix,
    action: 'invokeService',
    handler: async (req) => {
      const header = req.headers.get(SERVICE_TRACE_HEADER);
      const parsed = z.uuid().safeParse(header);
      const observation: { traceId: string; started: number; outcome?: ServiceOutcome } = {
        traceId: parsed.success ? parsed.data : crypto.randomUUID(),
        started: performance.now(),
      };
      trace?.(observation, 'door-entry', 0);
      let terminal = false;
      const finish = (outcome?: ServiceOutcome) => {
        if (terminal) return;
        terminal = true;
        trace?.(observation, 'door-terminal', performance.now() - observation.started, outcome);
      };
      if (header !== null && !parsed.success) {
        const outcome = serviceFailure('invalid-request');
        finish(outcome);
        return Response.json({ v: LOCAL_API_VERSION, traceId: observation.traceId, outcome });
      }
      const acquired = admission.acquire();
      if (acquired.outcome === 'refused') {
        const outcome = serviceFailure('capacity');
        finish(outcome);
        return Response.json({ v: LOCAL_API_VERSION, traceId: observation.traceId, outcome });
      }
      const controller = new AbortController();
      controller.signal.addEventListener(
        'abort',
        () =>
          finish(
            serviceFailure(
              'cancelled',
              'unknown',
              null,
              'none',
              undefined,
              serviceAbortOrigin(controller.signal),
            ),
          ),
        { once: true },
      );
      const abort = () => controller.abort('door-disconnect');
      req.signal.addEventListener('abort', abort, { once: true });
      if (req.signal.aborted) abort();
      const timer = setTimeout(() => controller.abort('door-deadline'), SERVICE_MAX_TIMEOUT_MS);
      const request = new Request(req, { signal: controller.signal });
      observations.set(request, observation);
      try {
        return await handler(request);
      } finally {
        finish(observation.outcome);
        observations.delete(request);
        clearTimeout(timer);
        req.signal.removeEventListener('abort', abort);
        acquired.lease.release();
      }
    },
  };
}
