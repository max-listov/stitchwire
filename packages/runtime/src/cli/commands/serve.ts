import { startBroker } from '../../broker/runtime.ts';
import { parseBrokerConfigBytes, parseNodeConfigBytes } from '../../config/io.ts';
import { paths } from '../../config/paths.ts';
import { startAgent } from '../../node/agent-application.ts';
import { flagValue } from '../configuration.ts';
import { superviseReloads } from '../supervise.ts';

/** `stitchwire broker`: run the router until signalled. */
export function runBroker(argv: string[]): Promise<number> {
  const configPath = flagValue(argv, '--config') ?? paths.brokerConfig;
  return superviseReloads({
    what: 'broker',
    path: configPath,
    load: parseBrokerConfigBytes,
    start: (config, reload) => startBroker(config, { configPath, reload }),
    announce: (config, handle) =>
      console.error(
        `[wire] broker listening on ${config.host}:${handle.port}, ${config.nodes.length} node(s) registered`,
      ),
  });
}

/** `stitchwire agent`: run the node until signalled. */
export function runAgent(argv: string[]): Promise<number> {
  const configPath = flagValue(argv, '--config') ?? paths.nodeConfig;
  return superviseReloads({
    what: 'agent',
    path: configPath,
    load: parseNodeConfigBytes,
    start: (config, reload) => startAgent(config, { path: configPath }, reload),
    announce: (config, handle) =>
      console.error(
        `[wire] agent ${config.nodeId} → ${config.brokers.length} broker lane(s), local socket ${handle.socketPath}`,
      ),
  });
}
