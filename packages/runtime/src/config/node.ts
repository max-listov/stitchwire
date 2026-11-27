/** The node configuration: its brokers, events, services and fleet. */

import { z } from 'zod';
import { LaneUrlSchema } from '../../../contracts/src/protocol/lane-url.ts';
import {
  checkServiceBindings,
  ServiceBindingSchema,
  ServiceGrantsSchema,
} from '../../../contracts/src/service/policy-schema.ts';
import { MAX_DECLARED_SERVICES, ServiceNamespaceSchema } from '../../../contracts/src/service/declaration.ts';
import { MAX_STREAM_TIMEOUT_MS } from '../../../contracts/src/protocol/bounds.ts';
import {
  CommandNameSchema,
  MAX_NODE_BROKERS,
  NodeIdSchema,
  SLUG_PATTERN,
} from '../../../contracts/src/protocol/identity.ts';
import { StreamProfileNameSchema } from '../../../contracts/src/protocol/stream.ts';
import { TopicNameSchema } from '../../../contracts/src/protocol/event.ts';
import { AbsoluteFilePathSchema } from '../../../contracts/src/protocol/paths.ts';
import { MAX_TOPIC_DESCRIPTOR_FILES, TopicNamespaceSchema } from '../../../contracts/src/protocol/topic.ts';
import { FleetTrustSchema } from '../../../contracts/src/fleet/bundle.ts';

import { paths } from './paths.ts';
import { CommandProfileSchema, StreamProfileSchema, NodeAdmissionSchema } from './profiles.ts';

const unique = (values: readonly string[]): boolean => new Set(values).size === values.length;

const NodeEventTopicsSchema = z
  .object({
    publish: z.array(TopicNameSchema).max(256).default([]),
    subscribe: z.array(TopicNameSchema).max(256).default([]),
    /**
     * Namespaces the fleet granted this node. Publishing covers any name inside them that this
     * node's owners declare; subscribing covers any name inside them. Written by the fleet.
     */
    namespaces: z
      .object({
        publish: z.array(TopicNamespaceSchema).max(64).default([]),
        subscribe: z.array(TopicNamespaceSchema).max(64).default([]),
      })
      .strict()
      .prefault({}),
    /**
     * Topic descriptors installed by the owners of this node's applications, as service descriptors
     * are. Written by the owner's installer, not by the fleet: this is where an owner adds a topic.
     */
    descriptors: z.array(z.string().min(1).max(1024)).max(MAX_TOPIC_DESCRIPTOR_FILES).default([]),
    /**
     * Drop-in directory polled for owner `*.json` topic descriptors without editing `node.json`.
     * Absent defaults to `<dirname(node.json)>/events.d`; `null` explicitly disables drop-in scanning.
     */
    dropInDir: AbsoluteFilePathSchema.nullable().optional(),
  })
  .strict()
  .superRefine((events, ctx) => {
    if (!unique(events.publish)) {
      ctx.addIssue({ code: 'custom', path: ['publish'], message: 'publish topics must be unique' });
    }
    if (!unique(events.subscribe)) {
      ctx.addIssue({ code: 'custom', path: ['subscribe'], message: 'subscribe topics must be unique' });
    }
    if (!unique(events.namespaces.publish) || !unique(events.namespaces.subscribe)) {
      ctx.addIssue({ code: 'custom', path: ['namespaces'], message: 'namespaces must be unique' });
    }
    if (!unique(events.descriptors)) {
      ctx.addIssue({ code: 'custom', path: ['descriptors'], message: 'descriptor paths must be unique' });
    }
  })
  .prefault({});

/**
 * The services this node runs. `bindings`, `grants` and `namespaces` — the service-name prefixes
 * this node may serve — are written by the fleet. `descriptors` are written by the owners'
 * installers: each names one file declaring a service binding and who may call it
 * (`ServiceDeclarationSchema`). That file is where an owner adds a service or a reader.
 */
const NodeServicesSchema = z
  .strictObject({
    bindings: z.array(ServiceBindingSchema),
    grants: ServiceGrantsSchema,
    namespaces: z.array(ServiceNamespaceSchema).max(16).default([]),
    descriptors: z.array(z.string().min(1).max(1024)).max(MAX_DECLARED_SERVICES).default([]),
    /**
     * Drop-in directory polled for owner `*.json` service declarations without editing `node.json`.
     * Absent defaults to `<dirname(node.json)>/services.d`; `null` explicitly disables drop-in scanning.
     */
    dropInDir: AbsoluteFilePathSchema.nullable().optional(),
  })
  .superRefine((services, ctx) => {
    checkServiceBindings(services, ctx);
    if (!unique(services.namespaces))
      ctx.addIssue({ code: 'custom', path: ['namespaces'], message: 'service namespaces must be unique' });
    if (!unique(services.descriptors))
      ctx.addIssue({ code: 'custom', path: ['descriptors'], message: 'descriptor paths must be unique' });
  });

const BrokerEndpointSchema = z
  .object({
    id: z.string().regex(SLUG_PATTERN),
    url: LaneUrlSchema,
    token: z.string().min(16).max(256),
    reconnect: z
      .object({
        minDelayMs: z.number().int().min(100).max(60_000),
        maxDelayMs: z.number().int().min(100).max(300_000),
      })
      .strict()
      .refine((value) => value.maxDelayMs >= value.minDelayMs, {
        message: 'maxDelayMs must be greater than or equal to minDelayMs',
      })
      .optional(),
  })
  .strict();
export type BrokerEndpoint = z.infer<typeof BrokerEndpointSchema>;

/**
 * Where this node takes its fleet tables from, when it takes them from a signed fleet bundle.
 *
 * Absent, the node runs its configuration as written. Present, the fleet tables — `events.publish`,
 * `events.subscribe`, `events.namespaces`, `services.grants`, `services.namespaces` — are projected
 * from the newest bundle signed by one of these keys, and rewritten whenever they differ. The keys
 * are local on purpose: a bundle can never vouch for the key that signed it.
 */
const NodeFleetSchema = z.strictObject({
  trust: FleetTrustSchema,
  /** The copy this node keeps and repairs itself from. */
  copy: z.string().min(1).max(1024).default(paths.fleetCopy),
  /** Further files a bundle may arrive in, read-only — a second delivery path beside the brokers. */
  sources: z.array(z.string().min(1).max(1024)).max(8).default([]),
  pollMs: z.number().int().min(200).max(300_000).default(5_000),
});
export type NodeFleet = z.infer<typeof NodeFleetSchema>;

const NodeConfigBaseSchema = z.object({
  fleet: NodeFleetSchema.optional(),
  services: NodeServicesSchema.default({ bindings: [], grants: [], namespaces: [], descriptors: [] }),
  nodeId: NodeIdSchema,
  /** False turns the agent into a caller-only client: it can reach others, nobody can reach it. */
  serves: z.boolean().default(true),
  /** The key obeys the same addressable command-name shape as broker grants. */
  allow: z.record(CommandNameSchema, CommandProfileSchema).default({}),
  streams: z.record(StreamProfileNameSchema, StreamProfileSchema).default({}),
  events: NodeEventTopicsSchema,
  defaultTimeoutMs: z.number().int().min(1_000).max(MAX_STREAM_TIMEOUT_MS).default(30_000),
  admission: NodeAdmissionSchema,
  agentSocket: z.string().default(paths.agentSocket),
});

export const NodeConfigSchema = NodeConfigBaseSchema.extend({
  /** Every lane authenticates independently and stays connected. One source of truth: there is no
   *  second shape for "which broker", because a second shape is a second thing to keep true. */
  brokers: z.array(BrokerEndpointSchema).min(1).max(MAX_NODE_BROKERS),
})
  .strict()
  .superRefine((config, ctx) => {
    const ids = new Set(config.brokers.map((broker) => broker.id));
    const urls = new Set(config.brokers.map((broker) => broker.url));
    if (ids.size !== config.brokers.length)
      ctx.addIssue({ code: 'custom', path: ['brokers'], message: 'broker lane ids must be unique' });
    if (urls.size !== config.brokers.length)
      ctx.addIssue({ code: 'custom', path: ['brokers'], message: 'broker endpoint urls must be unique' });
  });

export type NodeConfig = z.infer<typeof NodeConfigSchema>;
