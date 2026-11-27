/**
 * Browser-safe Stitchwire contracts, forward-compatible Zod readers and pure helpers.
 *
 * Imports ONLY `zod` and pure contract modules (no `node:*`, no `stitchkit`, no `process`, no
 * `Buffer`), so browser/Tauri/React/Vite consumers can validate status, broker health, topic
 * descriptors and service declarations without pulling in Node transport dependencies.
 */
import type { z } from 'zod';
import {
  type ClientErrorCode,
  ClientErrorCodeSchema,
  type DeliveryCertainty,
} from '../../contracts/src/door/client-error.ts';
import { LOCAL_API_VERSION } from '../../contracts/src/door/common.ts';
import { LocalResultSchema } from '../../contracts/src/door/results.ts';
import { PeerObservationSchema } from '../../contracts/src/peer-contract.ts';
import {
  brokerHealthUrl,
  type EventLoopDelaySnapshot,
  type TransportObservationSnapshot,
} from '../../contracts/src/protocol/broker-health.ts';
import { EventAckSchema } from '../../contracts/src/protocol/event.ts';
import type { TransportCause } from '../../contracts/src/protocol/failure.ts';
import {
  isTopicAuthorized,
  isTopicInNamespace,
  MAX_DECLARED_TOPICS,
  MAX_TOPIC_DESCRIPTOR_FILES,
  parseTopicDescriptor,
  TOPIC_MAX_DESCRIPTOR_BYTES,
  type TopicAccessMode,
  type TopicAuthorizationGrants,
  type TopicDescriptor,
  type TopicDescriptorInput,
  TopicDescriptorSchema,
  TopicNamespaceSchema,
  type TopicProfile,
  type TopicProfileInput,
  TopicProfileSchema,
  TopicRetentionSchema,
} from '../../contracts/src/protocol/topic.ts';
import {
  SERVICE_MAX_DESCRIPTOR_BYTES,
  SERVICE_MAX_INFLIGHT,
  SERVICE_MAX_RESPONSE_BYTES,
  SERVICE_MAX_TIMEOUT_MS,
  type ServiceCall,
  type ServiceFailureCode,
  ServiceFailureCodeSchema,
  type ServiceOutcome,
} from '../../contracts/src/service/contracts.ts';
import {
  parseServiceDeclaration,
  SERVICE_MAX_DECLARATION_BYTES,
  type ServiceDeclaration,
  type ServiceDeclarationInput,
  ServiceDeclarationSchema,
  ServiceNamespaceSchema,
  serviceInNamespace,
} from '../../contracts/src/service/declaration.ts';
import type {
  ServiceCancellationOrigin,
  ServiceClientTrace,
  ServiceDiagnostics,
  ServicePhase,
} from '../../contracts/src/service/diagnostics.ts';
import {
  type ServiceBinding,
  ServiceBindingSchema,
  type ServiceDescriptor,
  ServiceDescriptorSchema,
  type ServiceEffect,
  ServiceEffectSchema,
  ServiceLimitsSchema,
} from '../../contracts/src/service/policy-schema.ts';
import {
  SERVICE_DEFAULT_REQUEST_BYTES,
  SERVICE_MAX_REQUEST_BYTES,
} from '../../contracts/src/service/request-bounds.ts';

export const CallResultSchema = LocalResultSchema.strip();
export const PublishResultSchema = EventAckSchema.strip();

export const PeerResultSchema = PeerObservationSchema.extend({
  route: PeerObservationSchema.shape.route.unwrap().strip().nullable(),
}).strip();

export {
  AuditStatusSchema,
  type AuditStatus,
  type BrokerHealth,
  BrokerHealthSchema,
  FleetConfigStateSchema,
  type FleetConfigState,
  FleetEditionStatusSchema,
  type FleetEditionStatus,
  FleetNodeStatusSchema,
  type FleetNodeStatus,
  LaneStatusSchema,
  type LaneStatus,
  type StatusResult,
  StatusResultSchema,
} from './status-readers.ts';

export type CallResult = z.output<typeof CallResultSchema>;
export type PublishResult = z.output<typeof PublishResultSchema>;
export type PeerResult = z.output<typeof PeerResultSchema>;

export {
  brokerHealthUrl,
  ClientErrorCodeSchema,
  isTopicAuthorized,
  isTopicInNamespace,
  LOCAL_API_VERSION,
  MAX_DECLARED_TOPICS,
  MAX_TOPIC_DESCRIPTOR_FILES,
  parseServiceDeclaration,
  parseTopicDescriptor,
  SERVICE_DEFAULT_REQUEST_BYTES,
  SERVICE_MAX_DECLARATION_BYTES,
  SERVICE_MAX_DESCRIPTOR_BYTES,
  SERVICE_MAX_INFLIGHT,
  SERVICE_MAX_REQUEST_BYTES,
  SERVICE_MAX_RESPONSE_BYTES,
  SERVICE_MAX_TIMEOUT_MS,
  ServiceBindingSchema,
  ServiceDeclarationSchema,
  ServiceDescriptorSchema,
  ServiceEffectSchema,
  ServiceFailureCodeSchema,
  ServiceLimitsSchema,
  ServiceNamespaceSchema,
  serviceInNamespace,
  TOPIC_MAX_DESCRIPTOR_BYTES,
  TopicDescriptorSchema,
  TopicNamespaceSchema,
  TopicProfileSchema,
  TopicRetentionSchema,
  type ClientErrorCode,
  type DeliveryCertainty,
  type EventLoopDelaySnapshot,
  type ServiceBinding,
  type ServiceCall,
  type ServiceCancellationOrigin,
  type ServiceClientTrace,
  type ServiceDeclaration,
  type ServiceDeclarationInput,
  type ServiceDescriptor,
  type ServiceDiagnostics,
  type ServiceEffect,
  type ServiceFailureCode,
  type ServiceOutcome,
  type ServicePhase,
  type TopicAccessMode,
  type TopicAuthorizationGrants,
  type TopicDescriptor,
  type TopicDescriptorInput,
  type TopicProfile,
  type TopicProfileInput,
  type TransportCause,
  type TransportObservationSnapshot,
};
