import { wireLogger } from '../logger.ts';
import {
  type ApplicationShutdownOptions,
  createApplication,
  defineManagedResource,
  managedServerResource,
  projectApplicationStatus,
} from 'stitchkit/application';
import { createServer } from 'stitchkit/server';
import type { ApplicationStatus } from '../../../contracts/src/door/status.ts';
import { applicationStatus } from '../application-status.ts';
import type { BrokerConfig } from '../config/broker.ts';
import { type Audit, createAudit } from './audit.ts';
import type { BrokerHandle } from './contracts.ts';
import { BrokerTransportObservation } from './transport-observation.ts';

interface BrokerWireRuntime {
  serverOptions: Parameters<typeof createServer>[0];
  stopAdmission(): void;
}

/** Owns the framework lifecycle; the supplied builder owns only Wire domain composition. */
export async function startBrokerApplication<TWire extends BrokerWireRuntime>(
  config: BrokerConfig,
  buildWire: (
    audit: Audit,
    observation: BrokerTransportObservation,
    projection: () => ApplicationStatus,
  ) => Promise<TWire>,
): Promise<BrokerHandle> {
  let auditWriter: Audit | undefined;
  const auditResource = defineManagedResource({
    id: 'audit',
    start: async () => {
      auditWriter = await createAudit(config.auditPath, config.auditQueueLimit, config.auditRotate);
      return { value: auditWriter };
    },
    drain: async () => {
      observation.flush();
      await auditWriter?.flush();
    },
    close: async () => {
      await auditWriter?.close();
    },
  });
  const observation = new BrokerTransportObservation(`${config.host}:${config.port}`, () => {
    if (auditWriter === undefined) throw new Error('transport observation started before audit');
    return auditWriter;
  });
  let wireRuntime: TWire | undefined;
  let application: ReturnType<typeof createApplication> | undefined;
  const projection = (): ApplicationStatus => {
    if (application === undefined) throw new Error('broker application has not been created');
    return applicationStatus(projectApplicationStatus(application.getSnapshot()));
  };
  const wireResource = defineManagedResource({
    id: 'wire',
    dependsOn: [auditResource],
    start: async (context) => {
      wireRuntime = await buildWire(context.use(auditResource), observation, projection);
      return { value: wireRuntime };
    },
    stopAdmission: () => wireRuntime?.stopAdmission(),
  });
  const wireServer = managedServerResource({
    id: 'wire-server',
    dependsOn: [wireResource],
    server: async (context) => {
      const { serverOptions } = context.use(wireResource);
      try {
        return createServer(serverOptions);
      } catch (error) {
        await serverOptions.socket?.close();
        throw error;
      }
    },
  });
  application = createApplication({
    id: 'stitchwire-broker',
    shutdown: { gracePeriodMs: 10_000, forceTimeoutMs: 2_000 },
    resources: [auditResource, observation.schedule, wireResource, wireServer],
    onResourceFailure: (failure) => {
      wireLogger.error('[wire] resource failed', {
        resource: failure.resourceId,
        phase: failure.phase,
        error: failure.error,
      });
    },
  });
  await application.start();
  const startedApplication = application;
  return {
    port: config.port,
    stop: (options?: ApplicationShutdownOptions) => startedApplication.shutdown(options),
  };
}
