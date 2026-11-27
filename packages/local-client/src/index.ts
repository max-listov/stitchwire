export { serviceDescriptorFromContract } from '../../contracts/src/service/contract-descriptor.ts';
export {
  type BrokerHealthFetch,
  DEFAULT_BROKER_HEALTH_MAX_BYTES,
  DEFAULT_BROKER_HEALTH_TIMEOUT_MS,
  readBrokerHealth,
  type ReadBrokerHealthOptions,
} from './broker-health.ts';
export {
  type CallRequest,
  createWireClient,
  type PeerRequest,
  type PublishRequest,
  type ServiceRequestOptions,
  type StreamRequest,
  type SubscribeRequest,
  type WireClient,
} from './client.ts';
export * from './contracts.ts';
export {
  type DeclarationFileOptions,
  type DeclarationRemoveResult,
  type DeclarationWriteResult,
  removeServiceDeclarationFile,
  removeTopicDescriptorFile,
  writeServiceDeclarationFile,
  writeTopicDescriptorFile,
} from './declarations.ts';
export {
  extractWireClientError,
  extractWireServiceError,
  type WireErrorCode,
  wireErrorCode,
} from './error-chain.ts';
export { WireClientError } from './errors.ts';
export type { WireFeed } from './feed.ts';
export { createServiceIngress, type ServiceCaller, serviceCaller } from './ingress.ts';
export type { RequestOptions, WireClientOptions } from './options.ts';
export {
  defaultConfigDir,
  defaultEventDropInDir,
  defaultNodeConfigPath,
  defaultServiceDropInDir,
  defaultStateDir,
  defaultWireSocketPath,
  type WireDropInPathOptions,
  type WirePathOptions,
} from './paths.ts';
export {
  decodeWireData,
  type EventFlowItem,
  type EventItem,
  type StreamItem,
} from './readers.ts';
export { createServiceFetch, WireServiceError } from './service.ts';
