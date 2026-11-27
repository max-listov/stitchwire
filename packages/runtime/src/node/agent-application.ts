import {
  type ApplicationShutdownOptions,
  createApplication,
  defineManagedResource,
  managedServerResource,
  projectApplicationStatus,
} from 'stitchkit/application';
import { createServer, implement } from 'stitchkit/server';
import { localContract, toLocalResult } from '../../../contracts/src/door/local-contract.ts';
import { applicationStatus } from '../application-status.ts';
import { type Audit, createAudit } from '../broker/audit.ts';
import { ensureStateDir } from '../config/io.ts';
import type { NodeConfig } from '../config/node.ts';
import type { SelfReload } from '../fleet/reconcile.ts';
import { wireLogger } from '../logger.ts';
import { createLocalServiceRoute } from '../service/local.ts';
import { serviceTrace } from '../service/trace.ts';
import type { Agent, AgentHandle, ConfigOrigin, LaneHealth } from './agent-contract.ts';
import { createEventDoorService } from './event-local.ts';
import { createAgent } from './multi-home-agent.ts';
import { publicationTrace } from './publication-trace.ts';
import { createStreamDoorService } from './stream-local.ts';
export async function startAgent(
  config: NodeConfig,
  origin?: ConfigOrigin,
  /** Restart from the configuration file; the fleet bundle asks for it after rewriting that file. */
  reload?: SelfReload,
): Promise<AgentHandle> {
  // This resource owns the handle, including cleanup after a partially failed start.
  let agent: Agent | undefined;
  let reportLaneHealth: ((health: LaneHealth) => void) | undefined;
  let laneHealth: LaneHealth = { connected: 0, total: config.brokers.length };
  let startupComplete = false;
  let publicationAudit: Audit | undefined;
  let serviceAudit: Audit | undefined;
  let reportServiceAuditHealth: (healthy: boolean) => void = () => {};
  let reportAuditHealth: (healthy: boolean) => void = () => {};

  const publicationAuditResource = defineManagedResource({
    id: 'publication-audit',
    start: async (context) => {
      publicationAudit = await createAudit(`${config.agentSocket}.publication-audit.jsonl`, 256, {
        maxBytes: 8 * 1024 * 1024,
        keep: 2,
      });
      reportAuditHealth = (healthy) => context.reportHealth(healthy ? 'healthy' : 'unhealthy');
      return { value: publicationAudit };
    },
    close: async () => {
      await publicationAudit?.flush();
      await publicationAudit?.close();
    },
  });

  const serviceAuditResource = defineManagedResource({
    id: 'service-audit',
    start: async (context) => {
      serviceAudit = await createAudit(`${config.agentSocket}.service-audit.jsonl`, 256, {
        maxBytes: 8 * 1024 * 1024,
        keep: 2,
      });
      reportServiceAuditHealth = (healthy) => context.reportHealth(healthy ? 'healthy' : 'unhealthy');
      return { value: serviceAudit };
    },
    close: async () => {
      await serviceAudit?.flush();
      await serviceAudit?.close();
    },
  });

  const lanesResource = defineManagedResource({
    id: 'lanes',
    dependsOn: [publicationAuditResource, serviceAuditResource],
    start: (context) => {
      reportLaneHealth = ({ connected, total }) => {
        context.reportHealth(connected === 0 ? 'unhealthy' : connected < total ? 'degraded' : 'healthy');
      };
      const audit = context.use(publicationAuditResource);
      agent = createAgent(
        config,
        origin,
        (health) => {
          laneHealth = health;
          // Dialer readiness does not require an online broker. Report connectivity only
          // after startup so an offline node can still serve its local status door.
          if (startupComplete) reportLaneHealth?.(health);
        },
        publicationTrace(audit, config.nodeId),
        reload,
        serviceTrace(context.use(serviceAuditResource), config.nodeId),
      );
      return { value: agent };
    },
    close: async () => {
      await agent?.stop();
    },
  });

  const projection = () => applicationStatus(projectApplicationStatus(application.getSnapshot()));

  const doorResource = defineManagedResource({
    id: 'door',
    dependsOn: [lanesResource, publicationAuditResource, serviceAuditResource],
    start: (context) => {
      const node = context.use(lanesResource);
      const audit = context.use(publicationAuditResource);
      const service = implement(localContract, {
        peerObservation: (ctx) => node.observePeer(ctx.input),
        call: async (ctx) => toLocalResult(await node.call(ctx.input, ctx.signal)),
        status: async () => {
          const publicationAudit = audit.status();
          const serviceAudit = context.use(serviceAuditResource).status();
          reportServiceAuditHealth(serviceAudit.dropped === 0 && serviceAudit.writeFailures === 0);
          reportAuditHealth(publicationAudit.dropped === 0 && publicationAudit.writeFailures === 0);
          return { ...(await node.status()), application: projection(), publicationAudit, serviceAudit };
        },
      });
      return {
        value: {
          node,
          service,
          trace: publicationTrace(audit, config.nodeId),
          serviceTrace: serviceTrace(context.use(serviceAuditResource), config.nodeId),
        },
      };
    },
    // Reverse dependency order starts HTTP shutdown first. End long-lived answers
    // in this phase, before the server's drain waits for them.
    stopAdmission: async (context) => {
      await context.use(lanesResource).drainLocal();
    },
  });

  const doorServer = managedServerResource({
    id: 'door-server',
    dependsOn: [doorResource],
    server: (context) => {
      const { node, service, trace, serviceTrace } = context.use(doorResource);
      ensureStateDir(config.agentSocket);
      return createServer({
        services: [service, createStreamDoorService(node), createEventDoorService(node, trace)],
        rawRoutes: [createLocalServiceRoute(node, serviceTrace)],
        unix: { path: config.agentSocket, mode: 0o600 },
      });
    },
  });

  const application = createApplication({
    id: 'stitchwire-agent',
    shutdown: { gracePeriodMs: 10_000, forceTimeoutMs: 2_000 },
    resources: [publicationAuditResource, serviceAuditResource, lanesResource, doorResource, doorServer],
    onResourceFailure: (failure) => {
      wireLogger.error('[wire] resource failed', {
        resource: failure.resourceId,
        phase: failure.phase,
        error: failure.error,
      });
    },
  });

  await application.start();
  startupComplete = true;
  reportLaneHealth?.(laneHealth);
  if (agent === undefined) throw new Error('stitchwire agent: lanes did not publish a handle');
  const startedAgent = agent;

  return {
    ...startedAgent,
    socketPath: config.agentSocket,
    get connected() {
      return startedAgent.connected;
    },
    stop: async (options?: ApplicationShutdownOptions) => {
      await application.shutdown(options);
    },
  };
}
