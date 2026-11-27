import { z } from 'zod';
import { TopicNameSchema } from '../protocol/event.ts';
import { MAX_NODES } from '../protocol/bounds.ts';
import { NodeIdSchema } from '../protocol/identity.ts';
import { TopicNamespaceSchema } from '../protocol/topic.ts';
import { ServiceNamespaceSchema } from '../service/declaration.ts';
import { ServiceGrantsSchema } from '../service/policy-schema.ts';
import { FleetKeyIdSchema, FleetSerialSchema } from './identity.ts';
import { FleetManifestSchema } from './manifest.ts';

/**
 * The fleet bundle: the manifest, signed, in the form every node keeps a copy of.
 *
 * The bundle is what lets the fleet's configuration live on every machine, not on one and reach the
 * others by hand: a signer publishes it once, every broker keeps it and
 * hands it to each node as it connects, and a node that holds the whole bundle hands it back to a
 * broker that lost it. A node trusts a bundle because of the signature, never because of who sent
 * it — so any node may carry it and no carrier can change it.
 *
 * Two shapes of copy. The `full` part is the whole manifest and goes only to members that hold the
 * full copy. Each `own` member gets a `slice`: the tables projected for that one node, signed on
 * their own, so a machine the fleet does not fully trust applies its configuration without ever
 * learning the rest of the fleet.
 */

export const MAX_FLEET_BUNDLE_BYTES = 1024 * 1024;
export const FLEET_BUNDLE_FORMAT = 'stitchwire.fleet-bundle';

/** An Ed25519 public key: the 32 raw bytes, base64url without padding. */
export const FleetPublicKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/, 'an Ed25519 public key in base64url');

/** The keys a node or broker accepts a bundle from. Written locally, never taken from a bundle. */
export const FleetTrustSchema = z
  .array(z.strictObject({ id: FleetKeyIdSchema, publicKey: FleetPublicKeySchema }))
  .min(1)
  .max(8)
  .superRefine((trust, ctx) => {
    if (new Set(trust.map((key) => key.id)).size !== trust.length)
      ctx.addIssue({ code: 'custom', message: 'trusted key ids must be unique' });
  });
export type FleetTrust = z.infer<typeof FleetTrustSchema>;

/**
 * A signed document. The payload is carried as the exact string that was signed: re-serialising a
 * parsed object before checking it would make the signature depend on key order and spacing.
 */
export const FleetSignedSchema = z.strictObject({
  keyId: FleetKeyIdSchema,
  payload: z.string().min(2).max(MAX_FLEET_BUNDLE_BYTES),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/, 'an Ed25519 signature in base64url'),
});
export type FleetSigned = z.infer<typeof FleetSignedSchema>;

/** What one node's configuration takes from the fleet — nothing else of the fleet is in it. */
export const FleetNodeTablesSchema = z.strictObject({
  events: z.strictObject({
    publish: z.array(TopicNameSchema).max(256),
    subscribe: z.array(TopicNameSchema).max(256),
    namespaces: z.strictObject({
      publish: z.array(TopicNamespaceSchema).max(64),
      subscribe: z.array(TopicNamespaceSchema).max(64),
    }),
  }),
  services: z.strictObject({
    grants: ServiceGrantsSchema,
    namespaces: z.array(ServiceNamespaceSchema).max(16),
  }),
});
export type FleetNodeTables = z.infer<typeof FleetNodeTablesSchema>;

export const FleetFullPayloadSchema = z.strictObject({
  kind: z.literal('full'),
  serial: FleetSerialSchema,
  issuedAt: z.iso.datetime(),
  manifest: FleetManifestSchema,
});

export const FleetSlicePayloadSchema = z.strictObject({
  kind: z.literal('slice'),
  serial: FleetSerialSchema,
  issuedAt: z.iso.datetime(),
  node: NodeIdSchema,
  tables: FleetNodeTablesSchema,
});

/**
 * One edition of the fleet's configuration. `full` is null in a copy reduced to one node's slice —
 * the only form an `own` member ever receives or stores.
 */
export const FleetBundleSchema = z.strictObject({
  format: z.literal(FLEET_BUNDLE_FORMAT),
  serial: FleetSerialSchema,
  full: FleetSignedSchema.nullable(),
  // One signed slice per own-copy member, so no more than the fleet may name (`MAX_NODES`).
  slices: z
    .record(NodeIdSchema, FleetSignedSchema)
    .refine((slices) => Object.keys(slices).length <= MAX_NODES, {
      message: `a bundle carries at most ${MAX_NODES} slices`,
    }),
});
export type FleetBundle = z.infer<typeof FleetBundleSchema>;

/** Node → broker, on every connect and every offer: the edition this node keeps. */
export const FleetSyncSchema = z.strictObject({ serial: FleetSerialSchema.nullable() });
export type FleetSync = z.infer<typeof FleetSyncSchema>;

/**
 * The edition the broker keeps, and the bundle itself — reduced to what this node may hold — only
 * when it is newer than the node's. `serial` lets a node that holds the full copy see that the
 * broker is behind and hand it the newer one.
 */
export const FleetSyncAckSchema = z.strictObject({
  serial: FleetSerialSchema.nullable(),
  bundle: FleetBundleSchema.nullable(),
});
export type FleetSyncAck = z.infer<typeof FleetSyncAckSchema>;

/** Any node → broker: a complete bundle to keep. Its signature is the authority, not the sender. */
export const FleetPublishSchema = z.strictObject({ bundle: FleetBundleSchema });
export type FleetPublish = z.infer<typeof FleetPublishSchema>;

export const FleetPublishAckSchema = z.strictObject({
  accepted: z.boolean(),
  serial: FleetSerialSchema.nullable(),
  detail: z.string().max(512),
});
export type FleetPublishAck = z.infer<typeof FleetPublishAckSchema>;

/** Broker → every node: a newer edition is kept here; ask for it. */
export const FleetOfferSchema = z.strictObject({ serial: FleetSerialSchema });
