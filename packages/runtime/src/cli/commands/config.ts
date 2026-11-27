import { readJsonOnce } from 'stitchkit/files';
import {
  MAX_DECLARED_SERVICES,
  parseServiceDeclaration,
  SERVICE_MAX_DECLARATION_BYTES,
} from '../../../../contracts/src/service/declaration.ts';
import {
  declarationIdentity,
  declarationReadingDetail,
  declarationSchema,
  dropInDirs,
  dropInOwner,
  readDeclarationSetSync,
} from '../../config/drop-in.ts';
import { configIdentity } from '../../config/identity.ts';
import { loadBrokerConfig, loadNodeConfig, sha256 } from '../../config/io.ts';
import type { NodeConfig } from '../../config/node.ts';
import { paths } from '../../config/paths.ts';
import { planServiceDeclarations } from '../../node/service-declarations.ts';
import { freshToken } from '../configuration.ts';
import { fail } from '../io.ts';

/** `stitchwire keygen`: a fresh token and the digest the broker registers for it. */
export function runKeygen(): number {
  const token = freshToken();
  console.log(`token       ${token}`);
  console.log(`tokenSha256s[0] ${sha256(token)}`);
  console.log("\nput the token in the node's node.json, the digest in the broker's broker.json");
  return 0;
}

/**
 * The `services.d/` directory the agent started from `nodePath` reads. Its default lies beside the
 * path the agent was started with, which only the agent knows: a link of another name, or one in
 * another directory, would give that agent another directory than the file's own. Such a
 * configuration is refused with what to set instead.
 */
function serviceDropInDir(node: NodeConfig, nodePath: string): string | undefined {
  const spelled = dropInDirs(node, nodePath).services;
  const canonical = configIdentity(nodePath);
  const beside = dropInDirs(node, canonical).services;
  const identity = (dir: string | undefined) => (dir === undefined ? undefined : declarationIdentity(dir));
  if (identity(beside) !== identity(spelled))
    fail(
      `cannot tell which drop-in directory the node reads: ${nodePath} is ${canonical}, and only a file named node.json has one beside it; set services.dropInDir in the configuration`,
    );
  return spelled;
}

/**
 * `stitchwire config validate service <path> [--node <node.json>]`: a service declaration read the
 * way the node agent reads it — same size bound, strict UTF-8, same parse function, same one-line
 * reason. That is the verdict of the schema. With `--node` the file is also judged inside the set
 * that node's agent reads — its fleet bindings, the declarations `node.json` binds and its
 * `services.d/` drop-in files, in the agent's force order — by the plan the agent applies
 * (`planServiceDeclarations`): outside the granted namespaces, a service or socket an earlier file
 * already holds, a drop-in file the agent would not read. A file not yet in the set is judged as if
 * added last, so "accepted" means it takes nothing another declaration holds now. Drop-in files are
 * judged as the agent's user reads them — the owner of `node.json` — whoever runs the command; a
 * `node.json` whose default drop-in directory depends on how its path is spelled is refused, since
 * only the agent knows the spelling it was started with.
 */
function validateServiceDeclaration(path: string, nodePath: string | undefined): void {
  const reading = readJsonOnce(path, declarationSchema(parseServiceDeclaration), {
    limit: SERVICE_MAX_DECLARATION_BYTES,
  });
  if (reading.state === 'missing') fail(`no declaration at ${path}`);
  if (reading.state !== 'read') fail(`invalid service declaration: ${declarationReadingDetail(reading)}`);
  const { binding, callers } = reading.value;
  if (nodePath !== undefined) {
    const node = loadNodeConfig(nodePath);
    const set = readDeclarationSetSync(
      node.services.descriptors,
      serviceDropInDir(node, nodePath),
      MAX_DECLARED_SERVICES,
      parseServiceDeclaration,
      SERVICE_MAX_DECLARATION_BYTES,
      dropInOwner(nodePath),
    );
    const identity = declarationIdentity(path);
    const own = set.files.find((file) => declarationIdentity(file.path) === identity);
    if (own !== undefined && own.reading.state !== 'read')
      fail(
        `the node would not load this service declaration: ${own.reading.state === 'missing' ? 'no file at this path' : declarationReadingDetail(own.reading)}`,
      );
    if (own === undefined && set.issue !== null)
      fail(`the node would not read this service declaration: ${set.issue.detail} (${set.issue.path})`);
    if (own === undefined && set.files.length >= MAX_DECLARED_SERVICES)
      fail(
        `the node would refuse this service declaration: it already reads ${MAX_DECLARED_SERVICES} declarations`,
      );
    const files = set.files.map((file) => ({
      path: file.path,
      declaration: file.reading.state === 'read' ? file.reading.value : null,
    }));
    const plan = planServiceDeclarations(
      own === undefined ? [...files, { path, declaration: reading.value }] : files,
      node.services.namespaces,
      node.services.bindings,
    );
    const refusal = plan.refused.find((refused) => declarationIdentity(refused.path) === identity);
    if (refusal !== undefined) fail(`the node would refuse this service declaration: ${refusal.detail}`);
  }
  console.log(
    `valid service declaration: ${binding.service}, ${callers.length} caller scope(s)${nodePath === undefined ? '' : ', accepted by the node configuration'}`,
  );
}

const SERVICE_USAGE = 'service <path> [--node <node.json>]';

/** `stitchwire config validate <node|broker> [path]` and `config validate service <path>`. */
export function runConfigValidate(argv: string[]): number {
  const kind = argv[2];
  if (argv[1] === 'validate' && kind === 'service') {
    const nodeFlag = argv.length === 6 && argv[4] === '--node';
    if (argv.length !== 4 && !nodeFlag) fail(SERVICE_USAGE);
    validateServiceDeclaration(argv[3] ?? '', nodeFlag ? argv[5] : undefined);
    return 0;
  }
  if (argv[1] !== 'validate' || (kind !== 'node' && kind !== 'broker') || argv.length > 4) {
    fail(`usage: stitchwire config validate <node|broker> [path] | ${SERVICE_USAGE}`);
  }
  const path = argv[3];
  if (kind === 'node') {
    const config = loadNodeConfig(path ?? paths.nodeConfig);
    console.log(
      `valid node config: ${config.nodeId}, ${config.brokers.length} broker lane(s), ${Object.keys(config.allow).length} command profile(s), ${Object.keys(config.streams).length} stream profile(s), ${config.events.publish.length} publish and ${config.events.subscribe.length} subscribe topic(s)`,
    );
  } else {
    const config = loadBrokerConfig(path ?? paths.brokerConfig);
    console.log(
      `valid broker config: ${config.nodes.length} node(s), ${Object.keys(config.topics).length} topic(s), operation-scoped capabilities loaded`,
    );
  }
  return 0;
}
