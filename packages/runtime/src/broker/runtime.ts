import type { BrokerConfig } from '../config/broker.ts';
import type { SelfReload } from '../fleet/reconcile.ts';
import type { Audit } from './audit.ts';
import type { ApplicationStatus } from '../../../contracts/src/door/status.ts';
import { startBrokerApplication } from './broker-application.ts';
import type { BrokerHandle } from './contracts.ts';
import type { StrandedNodes } from './handshake.ts';
import * as fleetHealth from './health.ts';
import { Registry } from './registry.ts';
import type { BrokerTransportObservation } from './transport-observation.ts';
import { bindConnections } from './wire-connection.ts';
import { healthService } from './wire-health.ts';
import { createWireParts } from './wire-parts.ts';
import { openWireSocket } from './wire-socket.ts';

interface BrokerStartOptions {
  /** The file this configuration was read from; the fleet bundle rewrites its tables there. */
  configPath?: string;
  /** Restart from that file; asked for after a rewrite changed what this broker runs. */
  reload?: SelfReload;
}

export async function startBroker(
  config: BrokerConfig,
  options: BrokerStartOptions = {},
): Promise<BrokerHandle> {
  const registry = new Registry(config);
  const stranded: StrandedNodes = new Map();

  /**
   * Everything the wire is made of, built inside the resource that owns it. The kernel starts it
   * only after the audit writer is up, which is the one ordering that matters here: a broker that
   * can admit a call before it can record one is a broker whose log has a hole at exactly the
   * moment something went wrong.
   */
  const buildWire = async (
    audit: Audit,
    transportObservation: BrokerTransportObservation,
    projection: () => ApplicationStatus,
  ) => {
    const { socket, realtime } = await openWireSocket(config, registry, stranded, audit);
    const parts = createWireParts({
      config,
      registry,
      realtime,
      audit,
      configPath: options.configPath,
      reload: options.reload,
    });
    bindConnections({ realtime, registry, audit, parts, transportObservation, presence });
    const health = healthService({
      config,
      registry,
      audit,
      parts,
      transportObservation,
      projection,
      presence,
      fleetStanding,
    });
    return {
      serverOptions: { services: [health], socket, port: config.port, hostname: config.host },
      stopAdmission: parts.stopAdmission,
    };
  };

  /**
   * The roster, with what the broker knows about builds folded in — one source, three readers.
   *
   * A node refused over its version is registered (an unregistered id never reaches the version
   * check), so it is already in the roster as offline; what the plain roster loses is the build it
   * brought. Putting it back here means `nodes:list`, `/health.nodes` and the fleet aggregate all
   * answer the same thing, instead of three views that agree until they do not.
   */
  const presence = () => fleetHealth.presence(registry, stranded);
  const fleetStanding = () => fleetHealth.fleetStanding(registry, stranded);

  return startBrokerApplication(config, buildWire);
}
