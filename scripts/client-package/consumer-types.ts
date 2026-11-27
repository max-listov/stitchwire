import { join, resolve } from 'node:path';
import rootManifest from '../../package.json' with { type: 'json' };
import { root, run } from './run.ts';

/**
 * A consumer that imports the main entry typechecks under NodeNext and Bundler resolution, and one that
 * imports only `@stitchwire/client/contracts` typechecks with no `@types/node`.
 */
export async function proveConsumerTypes(scratch: string): Promise<void> {
  await Bun.write(
    join(scratch, 'consumer.ts'),
    `import {
    brokerHealthUrl,
    createWireClient,
    defaultEventDropInDir,
    defaultNodeConfigPath,
    defaultServiceDropInDir,
    defaultWireSocketPath,
    extractWireClientError,
    extractWireServiceError,
    isTopicAuthorized,
    isTopicInNamespace,
    parseServiceDeclaration,
    parseTopicDescriptor,
    readBrokerHealth,
    removeServiceDeclarationFile,
    removeTopicDescriptorFile,
    SERVICE_MAX_DECLARATION_BYTES,
    ServiceDescriptorSchema,
    TOPIC_MAX_DESCRIPTOR_BYTES,
    wireErrorCode,
    writeServiceDeclarationFile,
    writeTopicDescriptorFile,
    type BrokerHealth,
    type CallResult,
    type ServiceDescriptor,
    type StreamItem,
    type TopicDescriptor,
    type WireFeed,
  } from '@stitchwire/client';
  const client = createWireClient({ socketPath: defaultWireSocketPath() });
  const call: Promise<CallResult> = client.call({ to: 'worker', argv: ['read'] });
  const stream: WireFeed<StreamItem> = client.stream({ to: 'worker', profile: 'logs' });
  // @ts-expect-error argv must be an array
  client.call({ to: 'worker', argv: 'shell string' });
  // @ts-expect-error no caller-selected executable path
  client.stream({ to: 'worker', profile: 'logs', bin: '/bin/sh' });
  void call; void stream;
  const declaration = parseServiceDeclaration({});
  if (declaration.ok) { const callers: number = declaration.value.callers.length; void callers; } else { const detail: string = declaration.detail; void detail; }
  const topics = parseTopicDescriptor({});
  if (topics.ok) { const td: TopicDescriptor = topics.value; void td; }
  const maxBytes: number = SERVICE_MAX_DECLARATION_BYTES + TOPIC_MAX_DESCRIPTOR_BYTES;
  const descriptor: ServiceDescriptor = ServiceDescriptorSchema.parse({});
  const healthUrl: string = brokerHealthUrl('wss://broker.example.test');
  const healthPromise: Promise<BrokerHealth> = readBrokerHealth(healthUrl);
  const authorized: boolean = isTopicInNamespace('owner.', 'owner.x') && isTopicAuthorized('owner.x', { subscribe: [] }, 'subscribe');
  const failure = wireErrorCode(new Error('x'));
  const code: string | undefined = failure?.source === 'service' ? failure.code : failure?.code;
  void maxBytes; void descriptor; void healthPromise; void authorized; void code;
  void extractWireServiceError; void extractWireClientError;
  void defaultNodeConfigPath; void defaultServiceDropInDir; void defaultEventDropInDir;
  void writeServiceDeclarationFile; void removeServiceDeclarationFile;
  void writeTopicDescriptorFile; void removeTopicDescriptorFile;
  `,
  );
  // Browser-only typecheck for `@stitchwire/client/contracts`: no `@types/node`, only ES2022 + DOM.
  await Bun.write(
    join(scratch, 'browser-consumer.ts'),
    `import {
    AuditStatusSchema,
    BrokerHealthSchema,
    brokerHealthUrl,
    ClientErrorCodeSchema,
    FleetConfigStateSchema,
    FleetEditionStatusSchema,
    FleetNodeStatusSchema,
    isTopicAuthorized,
    isTopicInNamespace,
    LaneStatusSchema,
    parseServiceDeclaration,
    parseTopicDescriptor,
    PeerResultSchema,
    ServiceDeclarationSchema,
    ServiceFailureCodeSchema,
    StatusResultSchema,
    TopicDescriptorSchema,
    TopicProfileSchema,
    type BrokerHealth,
    type StatusResult,
  } from '@stitchwire/client/contracts';
  const health: BrokerHealth = BrokerHealthSchema.parse({});
  const status: StatusResult = StatusResultSchema.parse({});
  void health; void status;
  void AuditStatusSchema; void LaneStatusSchema; void FleetNodeStatusSchema;
  void FleetEditionStatusSchema; void FleetConfigStateSchema; void PeerResultSchema;
  void ClientErrorCodeSchema; void ServiceFailureCodeSchema; void ServiceDeclarationSchema;
  void TopicDescriptorSchema; void TopicProfileSchema; void parseServiceDeclaration;
  void parseTopicDescriptor; void isTopicInNamespace; void isTopicAuthorized; void brokerHealthUrl;
  `,
  );
  await run(
    ['bun', 'add', '--dev', '--ignore-scripts', `@types/node@${rootManifest.devDependencies['@types/node']}`],
    scratch,
  );
  console.log(
    await run(
      [
        'bun',
        resolve(root, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--types',
        'node',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2022',
        'consumer.ts',
      ],
      scratch,
    ),
  );
  await run(
    [
      'bun',
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--types',
      'node',
      '--module',
      'ESNext',
      '--moduleResolution',
      'Bundler',
      '--target',
      'ES2022',
      'consumer.ts',
    ],
    scratch,
  );
  // Browser-only check: `--types` empty and `--lib ES2022,DOM` proves `/contracts` needs no `@types/node`.
  await run(
    [
      'bun',
      resolve(root, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--types',
      '--lib',
      'ES2022,DOM',
      '--module',
      'ESNext',
      '--moduleResolution',
      'Bundler',
      '--target',
      'ES2022',
      'browser-consumer.ts',
    ],
    scratch,
  );
}
