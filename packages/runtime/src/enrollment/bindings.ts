import type {
  EnrollmentDescriptor,
  EnrollmentNodeRequest,
} from '../../../contracts/src/enrollment/request.ts';
import type { FleetNodeTables } from '../../../contracts/src/fleet/bundle.ts';
import {
  MAX_TOPIC_DESCRIPTOR_FILES,
  parseTopicDescriptor,
  TOPIC_MAX_DESCRIPTOR_BYTES,
  TopicDescriptorSchema,
} from '../../../contracts/src/protocol/topic.ts';
import { SERVICE_MAX_DESCRIPTOR_BYTES } from '../../../contracts/src/service/contracts.ts';
import {
  MAX_DECLARED_SERVICES,
  parseServiceDeclaration,
  SERVICE_MAX_DECLARATION_BYTES,
  ServiceDeclarationSchema,
} from '../../../contracts/src/service/declaration.ts';
import { ServiceDescriptorSchema } from '../../../contracts/src/service/policy-schema.ts';
import { declarationIdentity, dropInDirs, dropInOwner, readDeclarationSetSync } from '../config/drop-in.ts';
import { loadNodeConfig } from '../config/io.ts';
import { type NodeConfig, NodeConfigSchema } from '../config/node.ts';
import { configIdentity, socketIdentity } from '../config/identity.ts';
import { sameTables } from '../fleet/projection.ts';
import { planServiceDeclarations } from '../node/service-declarations.ts';
import { planTopicDeclarations } from '../node/topic-declarations.ts';
import { EnrollmentError } from './failure.ts';
import { readValue, writePrivate } from './files.ts';
import type { OwnersLedger } from './owners.ts';

type BindingTables = Pick<NodeConfig, 'services' | 'events'>;
type Kind = EnrollmentDescriptor['kind'];

/** Where each kind of binding lives in a node configuration. */
export const configuredBindings = {
  service: (config: BindingTables) => config.services.descriptors,
  topic: (config: BindingTables) => config.events.descriptors,
} satisfies Record<Kind, (config: BindingTables) => string[]>;

export function canonicalBindings(bindings: readonly EnrollmentDescriptor[]): EnrollmentDescriptor[] {
  const canonical = bindings.map((binding) => ({ ...binding, path: configIdentity(binding.path) }));
  if (new Set(canonical.map(({ path }) => path)).size !== canonical.length)
    throw new EnrollmentError('owner-conflict');
  return canonical;
}

/** A fresh snapshot, projected without writes. Ownership covers a path across both parser kinds. */
function projectedBindings(
  request: EnrollmentNodeRequest,
  config: BindingTables,
  ledger: OwnersLedger,
  detached: boolean,
): BindingTables {
  const owner = request.owner.id;
  if (detached && !ledger.knows(owner)) throw new EnrollmentError('owner-conflict');
  const requested = detached ? ledger.bindings(owner) : request.owner.descriptors;
  const configured = new Set(
    [...configuredBindings.service(config), ...configuredBindings.topic(config)].map(configIdentity),
  );
  /**
   * A binding written with no recorded owner, which this request explicitly takes over as it is. It
   * keeps its kind: the binding is taken from the table that holds it, so a request naming it under
   * the other kind leaves it there too and is refused below as one path under two kinds.
   */
  const adopted = (entry: EnrollmentDescriptor) =>
    !detached && request.owner.adopt === true && configured.has(entry.path) && !ledger.claimed(entry.path);
  for (const entry of requested)
    if (
      ledger.managedByAnother(owner, entry.path) ||
      (!detached && configured.has(entry.path) && !ledger.manages(owner, entry.path) && !adopted(entry))
    )
      throw new EnrollmentError('owner-conflict');
  const taken = new Set(requested.filter(adopted).map(({ kind, path }) => `${kind}:${path}`));
  const descriptors = (kind: Kind) => [
    ...configuredBindings[kind](config).filter((path) => {
      const identity = configIdentity(path);
      return !ledger.manages(owner, identity, kind) && !taken.has(`${kind}:${identity}`);
    }),
    ...(detached ? [] : requested.filter((entry) => entry.kind === kind).map(({ path }) => path)),
  ];
  const projected = {
    services: { ...config.services, descriptors: descriptors('service') },
    events: { ...config.events, descriptors: descriptors('topic') },
  };
  // Aliased or differently typed bindings must not make a second owner for one filesystem object.
  const paths = [...projected.services.descriptors, ...projected.events.descriptors].map(configIdentity);
  if (new Set(paths).size !== paths.length) throw new EnrollmentError('owner-conflict');
  return projected;
}

/**
 * A declaration set as the agent started from `agentConfig` reads it, as its user: an unreadable
 * file declares nothing.
 */
function readSet(config: BindingTables, agentConfig: string) {
  const dirs = dropInDirs(config, agentConfig);
  const agentUid = dropInOwner(agentConfig);
  const services = readDeclarationSetSync(
    config.services.descriptors,
    dirs.services,
    MAX_DECLARED_SERVICES,
    parseServiceDeclaration,
    SERVICE_MAX_DECLARATION_BYTES,
    agentUid,
  ).files;
  const topics = readDeclarationSetSync(
    config.events.descriptors,
    dirs.events,
    MAX_TOPIC_DESCRIPTOR_FILES,
    parseTopicDescriptor,
    TOPIC_MAX_DESCRIPTOR_BYTES,
    agentUid,
  ).files;
  return {
    services: services.map((file) => ({
      path: file.path,
      declaration: file.reading.state === 'read' ? file.reading.value : null,
    })),
    topics: topics.map((file) => ({
      path: file.path,
      topics: file.reading.state === 'read' ? file.reading.value.topics : {},
    })),
    dropIns: new Set([...services, ...topics].flatMap((file) => (file.dropIn ? [file.path] : []))),
  };
}

/**
 * What one owner's files are in the set the agent reads, to tell the agent's refusals of this
 * request from its refusals of another file: the owner's paths, the topics those files declare, and
 * which of them the agent's plan gives to the owner's own files. A topic refusal carries no path, so
 * a refused name the plan gives to the owner is another file declaring it again.
 */
export interface OwnedDeclarations {
  /** The owner's binding paths, by canonical identity. */
  paths: ReadonlySet<string>;
  /** Every topic the owner's files declare. */
  topics: ReadonlySet<string>;
  /** The owner's topics the plan places in the owner's own files. */
  held: ReadonlySet<string>;
}

export function ownedDeclarations(
  config: BindingTables,
  agentConfig: string,
  bindings: readonly EnrollmentDescriptor[],
  events: { namespaces: { publish: readonly string[] }; publish: readonly string[] },
): OwnedDeclarations {
  const paths = new Set(bindings.map(({ path }) => path));
  const mine = (path: string) => paths.has(declarationIdentity(path));
  const { topics } = readSet(config, agentConfig);
  const plan = planTopicDeclarations(topics, events.namespaces.publish, events.publish);
  return {
    paths,
    topics: new Set(topics.flatMap((file) => (mine(file.path) ? Object.keys(file.topics) : []))),
    held: new Set([...plan.owner].flatMap(([name, path]) => (mine(path) ? [name] : []))),
  };
}

/** What a set holds in force, each service and topic keyed with its file, mapped to that file. */
function inForce(
  set: ReturnType<typeof readSet>,
  tables: FleetNodeTables,
  bound: BindingTables['services']['bindings'],
): Map<string, string> {
  const held = new Map<string, string>();
  const services = planServiceDeclarations(set.services, tables.services.namespaces, bound, socketIdentity);
  for (const { path, declaration } of services.accepted)
    held.set(JSON.stringify(['service', path, declaration.binding.service]), path);
  const topics = planTopicDeclarations(set.topics, tables.events.namespaces.publish, tables.events.publish);
  for (const [name, path] of topics.owner) held.set(JSON.stringify(['topic', path, name]), path);
  return held;
}

/**
 * Validate the whole final set the agent would read — the explicit bindings of `config` and the
 * drop-in files the agent started from `agentConfig` reads, as its user — with the policy the
 * agent itself applies. Every explicit
 * declaration must load and be in force. A drop-in declaration in force with the `current` bindings
 * must stay in force: a reload must not discard another owner's last valid declaration, and an
 * explicit binding that would take a drop-in's service, socket or topic, or push it past the
 * aggregate limit, is refused rather than let win.
 */
function checkDeclarations(
  config: BindingTables,
  current: BindingTables,
  tables: FleetNodeTables,
  agentConfig: string,
): void {
  const services = config.services.descriptors.map((path) => {
    const declaration = readValue(path, ServiceDeclarationSchema, SERVICE_MAX_DECLARATION_BYTES);
    const descriptor = readValue(
      declaration.binding.descriptorPath,
      ServiceDescriptorSchema,
      SERVICE_MAX_DESCRIPTOR_BYTES,
    );
    if (descriptor.service !== declaration.binding.service) throw new EnrollmentError('declaration-invalid');
    return JSON.stringify(['service', path, declaration.binding.service]);
  });
  const topics = config.events.descriptors.flatMap((path) =>
    Object.keys(readValue(path, TopicDescriptorSchema, TOPIC_MAX_DESCRIPTOR_BYTES).topics).map((name) =>
      JSON.stringify(['topic', path, name]),
    ),
  );
  const after = inForce(readSet(config, agentConfig), tables, config.services.bindings);
  if ([...services, ...topics].some((key) => !after.has(key)))
    throw new EnrollmentError('declaration-invalid');
  const now = readSet(current, agentConfig);
  for (const [key, path] of inForce(now, tables, current.services.bindings))
    if (now.dropIns.has(path) && !after.has(key)) throw new EnrollmentError('declaration-invalid');
}

/**
 * The bindings this request would leave in the configuration, refused before any write when the
 * final set could not be loaded: no reload turns an unloadable declaration into a loadable one.
 * `agentConfig` is the configuration path as the running agent spells it (`status.config.path`):
 * a `node.json` reached through a link of another name has its drop-in directories beside the
 * spelling, not beside the file. With no agent running it is the request's own path, the one an
 * installation starts its agent with.
 */
export function checkOwner(
  request: EnrollmentNodeRequest,
  config: BindingTables,
  tables: FleetNodeTables,
  ledger: OwnersLedger,
  detached: boolean,
  agentConfig: string,
): BindingTables {
  const projected = projectedBindings(request, config, ledger, detached);
  if (
    !NodeConfigSchema.shape.services.safeParse(projected.services).success ||
    !NodeConfigSchema.shape.events.safeParse(projected.events).success
  )
    throw new EnrollmentError('declaration-invalid');
  try {
    checkDeclarations(projected, config, tables, agentConfig);
  } catch (cause) {
    throw new EnrollmentError('declaration-invalid', { cause });
  }
  return projected;
}

/** One atomic configuration write for both kinds, under the reconciler's configuration lock. */
export function attachOwner(
  request: EnrollmentNodeRequest,
  config: NodeConfig,
  tables: FleetNodeTables,
  ledger: OwnersLedger,
  detached: boolean,
  agentConfig: string,
): NodeConfig {
  const bindings = checkOwner(request, config, tables, ledger, detached, agentConfig);
  const parsed = NodeConfigSchema.safeParse({ ...config, ...bindings });
  if (!parsed.success) throw new EnrollmentError('declaration-invalid', { cause: parsed.error });
  const owner = request.owner.id;
  ledger.set(owner, detached ? ledger.bindings(owner) : request.owner.descriptors, !detached);
  if (!sameTables(config, parsed.data)) writePrivate(request.config, parsed.data);
  const confirmed = loadNodeConfig(request.config);
  if (
    !sameTables(confirmed.services.descriptors, bindings.services.descriptors) ||
    !sameTables(confirmed.events.descriptors, bindings.events.descriptors)
  )
    throw new EnrollmentError('state-invalid');
  ledger.confirm(owner);
  return confirmed;
}
