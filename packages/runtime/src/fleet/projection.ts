import type { FleetNodeTables } from '../../../contracts/src/fleet/bundle.ts';
import type { FleetManifest } from '../../../contracts/src/fleet/manifest.ts';
import type { ServiceGrant } from '../../../contracts/src/service/policy-schema.ts';
import { asJson, type Json, sortedDeep, ownEntry } from '../json.ts';

/**
 * Every deployed table, projected from the one manifest.
 *
 * The manifest states a permission once, as a pair. A broker and a node each ask it a different
 * question, and conflating the two breaks one of them silently.
 *
 * A BROKER asks "which routes can I carry", and both ends must be its own nodes: a caller
 * authenticates to the broker it dials, so a grant naming a caller that cannot reach this broker
 * can never be exercised here and would only read as authority. `to: '*'` stays a wildcard meaning
 * "whatever this broker hosts", but its caller is still checked.
 *
 * A NODE asks "who may call ME", and the caller is exactly what it must keep: filtering by its own
 * brokers would strip every grant whose caller lives on another broker, and the node would refuse
 * the very calls the fleet authorised.
 */

interface CommandGrantRow {
  caller: string;
  targets: string[];
  command: string;
}
interface CapabilityRow {
  operation: 'peer' | 'stream' | 'publish' | 'subscribe';
  targets: string[];
}
type NamespaceGrantRow = FleetManifest['topicNamespaces'][string];

/** The six tables of broker configuration that belong to the fleet rather than to the machine. */
interface BrokerTables {
  capabilities: Record<string, CapabilityRow[]>;
  commandGrants: CommandGrantRow[];
  serviceGrants: ServiceGrant[];
  topics: Record<string, unknown>;
  topicNamespaces: Record<string, NamespaceGrantRow>;
  serviceNamespaces: Record<string, string[]>;
}

type Reach = { kind: 'roster'; nodes: ReadonlySet<string> } | { kind: 'target'; node: string };
export const roster = (nodes: ReadonlySet<string>): Reach => ({ kind: 'roster', nodes });
export const servedBy = (node: string): Reach => ({ kind: 'target', node });

const rowOrder = (left: unknown, right: unknown): number =>
  JSON.stringify(left).localeCompare(JSON.stringify(right));

function reaching(manifest: FleetManifest, reach: Reach) {
  if (reach.kind === 'target') return manifest.access.filter((entry) => entry.to === reach.node);
  const { nodes } = reach;
  return manifest.access.filter(
    (entry) => nodes.has(entry.from) && (entry.to === '*' || nodes.has(entry.to)),
  );
}

export function serviceGrantsFor(manifest: FleetManifest, reach: Reach): ServiceGrant[] {
  return reaching(manifest, reach)
    .flatMap((entry) =>
      Object.entries(entry.services ?? {}).flatMap(([service, scopes]) =>
        scopes.map(
          (scope): ServiceGrant =>
            scope === 'service-read'
              ? { caller: entry.from, target: entry.to, service, scope: { kind: 'service-read' } }
              : {
                  caller: entry.from,
                  target: entry.to,
                  service,
                  scope: { kind: 'operation', operation: scope },
                },
        ),
      ),
    )
    .sort(rowOrder);
}

/** The deployed shape groups targets under one caller and command; the manifest states pairs. */
export function commandGrantsFor(manifest: FleetManifest, nodes: ReadonlySet<string>): CommandGrantRow[] {
  const grouped = new Map<string, Set<string>>();
  for (const entry of reaching(manifest, roster(nodes)))
    for (const command of entry.commands ?? []) {
      const key = `${entry.from} ${command}`;
      grouped.set(key, (grouped.get(key) ?? new Set()).add(entry.to));
    }
  return [...grouped]
    .map(([key, group]): CommandGrantRow => {
      const [caller = '', command = ''] = key.split(' ');
      return { caller, targets: [...group].sort(), command };
    })
    .sort(rowOrder);
}

function topicsFor(manifest: FleetManifest, targets: ReadonlySet<string>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(manifest.topics)
      .filter(([, declaration]) => targets.has(declaration.producer))
      .map(
        ([name, declaration]) =>
          [
            name,
            { ...declaration, subscribers: declaration.subscribers.filter((node) => targets.has(node)) },
          ] as const,
      )
      .filter(([, declaration]) => declaration.subscribers.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * A broker carries a namespace when its producer dials that broker, and only for the readers that
 * dial it too: a reader it does not host could never subscribe here, and a namespace nobody here may
 * read is not carried at all.
 */
export function namespacesFor(
  manifest: FleetManifest,
  targets: ReadonlySet<string>,
): Record<string, NamespaceGrantRow> {
  return Object.fromEntries(
    Object.entries(manifest.topicNamespaces)
      .filter(([, grant]) => targets.has(grant.producer))
      .map(
        ([prefix, grant]) =>
          [
            prefix,
            { ...grant, subscribers: grant.subscribers.filter((subscriber) => targets.has(subscriber)) },
          ] as const,
      )
      .filter(([, grant]) => grant.subscribers.length > 0)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/** A broker carries the service namespaces of the nodes that dial it; nobody else can declare there. */
function serviceNamespacesFor(
  manifest: FleetManifest,
  targets: ReadonlySet<string>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(manifest.serviceNamespaces)
      .filter(([node]) => targets.has(node))
      .map(([node, prefixes]) => [node, [...prefixes].sort()] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * Publish and subscribe are not separate decisions: a node publishes the topics it produces and
 * subscribes to the producers of the topics that list it. Declaring them apart is what lets a
 * subscribe capability outlive every topic behind it. A namespace counts exactly like a topic.
 */
export function capabilitiesFor(
  manifest: FleetManifest,
  targets: ReadonlySet<string>,
): Record<string, CapabilityRow[]> {
  const carried = [
    ...Object.values(topicsFor(manifest, targets)).map(
      (declaration) => declaration as { producer: string; subscribers: string[] },
    ),
    ...Object.values(namespacesFor(manifest, targets)),
  ];
  const capabilities: Record<string, CapabilityRow[]> = {};
  const add = (node: string, grant: CapabilityRow): void => {
    if (grant.targets.length === 0) return;
    capabilities[node] = [...(ownEntry(capabilities, node) ?? []), grant];
  };
  for (const node of [...targets].sort()) {
    const peer = manifest.access
      .filter((entry) => entry.from === node && entry.peer)
      .map((entry) => entry.to)
      .filter((target) => target === '*' || targets.has(target));
    const stream = manifest.access
      .filter((entry) => entry.from === node && entry.stream)
      .map((entry) => entry.to)
      .filter((target) => target === '*' || targets.has(target));
    const produces = carried.some((declaration) => declaration.producer === node);
    const subscribes = [
      ...new Set(
        carried
          .filter((declaration) => declaration.subscribers.includes(node))
          .map((declaration) => declaration.producer),
      ),
    ].sort();
    add(node, { operation: 'peer', targets: [...new Set(peer)].sort() });
    add(node, { operation: 'stream', targets: [...new Set(stream)].sort() });
    add(node, { operation: 'publish', targets: produces ? [node] : [] });
    add(node, { operation: 'subscribe', targets: subscribes });
  }
  return capabilities;
}

/** Everything one node's configuration takes from the fleet. Also exactly what its slice carries. */
export function nodeTables(manifest: FleetManifest, nodeId: string): FleetNodeTables {
  const topics = Object.entries(manifest.topics);
  const namespaces = Object.entries(manifest.topicNamespaces);
  const names = <T>(entries: Array<[string, T]>, keep: (value: T) => boolean): string[] =>
    entries
      .filter(([, value]) => keep(value))
      .map(([name]) => name)
      .sort();
  return {
    events: {
      publish: names(topics, (declaration) => declaration.producer === nodeId),
      subscribe: names(topics, (declaration) => declaration.subscribers.includes(nodeId)),
      namespaces: {
        publish: names(namespaces, (grant) => grant.producer === nodeId),
        subscribe: names(namespaces, (grant) => grant.subscribers.includes(nodeId)),
      },
    },
    services: {
      grants: serviceGrantsFor(manifest, servedBy(nodeId)),
      namespaces: [...(ownEntry(manifest.serviceNamespaces, nodeId) ?? [])].sort(),
    },
  };
}

export function brokerTables(manifest: FleetManifest, nodes: ReadonlySet<string>): BrokerTables {
  return {
    capabilities: capabilitiesFor(manifest, nodes),
    commandGrants: commandGrantsFor(manifest, nodes),
    serviceGrants: serviceGrantsFor(manifest, roster(nodes)),
    topics: topicsFor(manifest, nodes),
    topicNamespaces: namespacesFor(manifest, nodes),
    serviceNamespaces: serviceNamespacesFor(manifest, nodes),
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

/** The node's roster as its broker configuration states it: the only input a broker projection reads. */
function rosterOf(brokerConfig: Json): Set<string> {
  return new Set(
    (Array.isArray(brokerConfig.nodes) ? brokerConfig.nodes : [])
      .map((node) => asJson(node).id)
      .filter((id): id is string => typeof id === 'string'),
  );
}

/**
 * A node configuration with its fleet tables replaced. Everything the machine owns — identity,
 * credentials, command profiles, bindings, the descriptors its owners installed — rides through.
 */
export function applyNodeTables(config: Json, tables: FleetNodeTables): Json {
  const events = asJson(config.events);
  const services = asJson(config.services);
  return {
    ...config,
    events: {
      ...events,
      publish: tables.events.publish,
      subscribe: tables.events.subscribe,
      namespaces: tables.events.namespaces,
    },
    services: {
      bindings: [],
      ...services,
      grants: tables.services.grants,
      namespaces: tables.services.namespaces,
    },
  };
}

export function applyBrokerTables(config: Json, manifest: FleetManifest): Json {
  return { ...config, ...brokerTables(manifest, rosterOf(config)) };
}

/** What a node configuration says in the fleet's tables, read the way the projection writes them. */
export function nodeTablesOf(config: Json): unknown {
  const events = asJson(config.events);
  const namespaces = asJson(events.namespaces);
  const services = asJson(config.services);
  return {
    events: {
      publish: strings(events.publish),
      subscribe: strings(events.subscribe),
      namespaces: { publish: strings(namespaces.publish), subscribe: strings(namespaces.subscribe) },
    },
    services: {
      grants: Array.isArray(services.grants) ? services.grants : [],
      namespaces: strings(services.namespaces),
    },
  };
}

export function brokerTablesOf(config: Json): unknown {
  return {
    capabilities: config.capabilities ?? {},
    commandGrants: config.commandGrants ?? [],
    serviceGrants: config.serviceGrants ?? [],
    topics: config.topics ?? {},
    topicNamespaces: config.topicNamespaces ?? {},
    serviceNamespaces: config.serviceNamespaces ?? {},
  };
}

/** Order inside a table is a rendering detail; membership is the fact two tables are compared on. */
export function sameTables(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortedDeep(left, rowOrder)) === JSON.stringify(sortedDeep(right, rowOrder));
}
