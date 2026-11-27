import { existsSync } from 'node:fs';
import { loadBrokerConfig, loadNodeConfig, sha256 } from '../../config/io.ts';
import { paths } from '../../config/paths.ts';
import { flagValue, freshToken, positional, createConfigFile } from '../configuration.ts';
import { NodeConfigSchema } from '../../config/node.ts';
import { BrokerConfigSchema } from '../../config/broker.ts';
import { fail } from '../io.ts';

/** `stitchwire init <node|broker>`: write a configuration that loads, and say what to do with it. */
export async function runInit(argv: string[]): Promise<number> {
  const kind = argv[1];
  if (kind !== 'node' && kind !== 'broker') {
    fail('usage: stitchwire init <node|broker> [options] [path]');
  }
  // The trailing positional is the destination; everything else arrives as a flag.
  const target = positional(argv.slice(2))[0] ?? (kind === 'node' ? paths.nodeConfig : paths.brokerConfig);
  // Refusing to overwrite is the whole safety story here: the file it would replace holds the
  // only copy of a token, and a regenerated node is a node the broker no longer recognises.
  if (existsSync(target)) fail(`${target} already exists — remove it first, or name another path`);

  if (kind === 'node') {
    const nodeId = flagValue(argv, '--id');
    const broker = flagValue(argv, '--broker');
    if (nodeId === undefined) fail('missing --id <slug>: the name this node answers to on the wire');
    if (broker === undefined) fail('missing --broker <url>: where this node dials out to');
    const token = freshToken();
    const config = {
      nodeId,
      brokers: [{ id: 'primary', url: broker, token }],
      serves: true,
      allow: {},
      streams: {},
      events: { publish: [], subscribe: [] },
    };
    NodeConfigSchema.parse(config);
    await createConfigFile(target, config);
    // Validated by loading it back, so "init wrote a file" can never mean "init wrote a file the
    // agent will refuse at boot".
    const parsed = loadNodeConfig(target);
    console.log(`wrote ${target} (mode 600) for node '${parsed.nodeId}'`);
    console.log(`tokenSha256s[0] ${sha256(token)}`);
    console.log(`\nadd that digest to the broker: stitchwire init broker --node ${nodeId}=${sha256(token)}`);
    console.log('the token itself stays in this file and is never sent anywhere but the handshake');
    return 0;
  }

  const entries = argv.filter((entry, index) => argv[index - 1] === '--node' && !entry.startsWith('--'));
  if (entries.length === 0) {
    fail('missing --node <id>=<digest>: a broker with no registered node admits nobody');
  }
  const nodes = entries.map((entry) => {
    const [id, digest] = entry.split('=');
    if (id === undefined || digest === undefined || digest.length !== 64) {
      fail(`--node expects <id>=<digest>, received '${entry}'`);
    }
    return { id, tokenSha256s: [digest] };
  });
  const port = flagValue(argv, '--port');
  const config = {
    host: '127.0.0.1',
    port: port === undefined ? 8790 : Number(port),
    nodes,
    capabilities: {},
  };
  BrokerConfigSchema.parse(config);
  await createConfigFile(target, config);
  const parsed = loadBrokerConfig(target);
  console.log(`wrote ${target} (mode 600) with ${parsed.nodes.length} node(s), no grants yet`);
  console.log('default-deny is intentional: add a `capabilities` entry per caller before it can call');
  return 0;
}
