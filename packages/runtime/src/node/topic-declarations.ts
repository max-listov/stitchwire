import type { JsonFileReading } from 'stitchkit/files';
import type { z } from 'zod';
import type {
  TopicDeclarationsStatusSchema,
  TopicDescriptorReadingSchema,
  TopicLaneDeclarationSchema,
} from '../../../contracts/src/door/status.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import {
  type EventDeclare,
  type EventDeclareAck,
  type EventDeclareRefusal,
  isTopicInNamespace,
  MAX_DECLARED_TOPICS,
  MAX_TOPIC_DESCRIPTOR_FILES,
  parseTopicDescriptor,
  TOPIC_MAX_DESCRIPTOR_BYTES,
  type TopicProfile,
} from '../../../contracts/src/protocol/topic.ts';
import { DeclarationFileSet, declarationReadingDetail } from '../config/drop-in.ts';
import { wireLogger } from '../logger.ts';
import { DECLARATION_POLL_MS, type DeclaringLane, PolledDeclarer } from './polled-declarer.ts';

type DescriptorReading = z.infer<typeof TopicDescriptorReadingSchema>;
type LaneDeclaration = z.infer<typeof TopicLaneDeclarationSchema>;
type DeclarationSnapshot = z.infer<typeof TopicDeclarationsStatusSchema>;

interface TopicDeclaringLane extends DeclaringLane {
  declareTopics(request: EventDeclare): Promise<EventDeclareAck | null>;
}

/**
 * Which topics of these descriptor files, in force order, a node may announce, and which it refuses
 * and why: a name outside the namespaces the fleet granted, a name this node's configuration or an
 * earlier file already declares, and everything past the aggregate limit. `owner` names the file
 * each accepted topic comes from. The agent announces the accepted part and reports the rest;
 * enrollment and `config validate` judge a set by the same plan.
 */
export function planTopicDeclarations(
  files: readonly { path: string; topics: Record<string, TopicProfile> }[],
  namespaces: readonly string[],
  fleetTopics: readonly string[] = [],
): {
  topics: Record<string, TopicProfile>;
  refused: EventDeclareRefusal[];
  owner: ReadonlyMap<string, string>;
} {
  const topics: Record<string, TopicProfile> = {};
  const owner = new Map<string, string>();
  const claimed = new Map<string, string>(fleetTopics.map((name) => [name, "this node's configuration"]));
  const refused: EventDeclareRefusal[] = [];
  let accepted = 0;
  for (const { path, topics: declared } of files) {
    for (const name of Object.keys(declared).sort()) {
      const topic = declared[name];
      if (topic === undefined) continue;
      const refusal = !namespaces.some((namespace) => isTopicInNamespace(namespace, name))
        ? `outside the namespaces this node may publish in (${path})`
        : claimed.has(name)
          ? `declared by ${claimed.get(name)} and again by ${path}`
          : accepted >= MAX_DECLARED_TOPICS
            ? `aggregate declaration exceeds the ${MAX_DECLARED_TOPICS}-topic limit (${path})`
            : null;
      if (refusal !== null) refused.push({ topic: name, detail: refusal });
      else {
        claimed.set(name, path);
        owner.set(name, path);
        topics[name] = topic;
        accepted += 1;
      }
    }
  }
  return { topics, refused, owner };
}

function descriptorReading(
  path: string,
  file: JsonFileReading<{ topics: Record<string, TopicProfile> }>,
  lastValid: Record<string, TopicProfile> | undefined,
): { reading: DescriptorReading; topics: Record<string, TopicProfile> } {
  if (file.state === 'read')
    return {
      reading: { path, state: 'loaded', topics: Object.keys(file.value.topics).length, detail: null },
      topics: file.value.topics,
    };
  if (file.state === 'missing')
    return {
      reading: { path, state: 'missing', topics: 0, detail: 'no file at this path' },
      topics: {},
    };
  // A file that is there but cannot be read is not a file whose owner withdrew its topics: a write
  // caught half-done, or a typo in an edit, would otherwise end every subscription on every topic
  // the file declared. The last version that parsed stays declared, and the status says why the
  // current one is not in force.
  const detail = declarationReadingDetail(file);
  return {
    reading: {
      path,
      state: 'invalid',
      topics: Object.keys(lastValid ?? {}).length,
      detail: lastValid === undefined ? detail : `${detail}; the last valid version stays declared`,
    },
    topics: lastValid ?? {},
  };
}

/**
 * The producer half of owner-declared topics.
 *
 * Reads the descriptors bound in `node.json` and any `*.json` files placed into the node's
 * `events.d/` drop-in directory, keeps only names inside the namespaces the fleet granted it, and
 * announces every change to all connected broker lanes without restarting the agent.
 */
export class TopicDeclarer extends PolledDeclarer<TopicDeclaringLane, EventDeclare, LaneDeclaration> {
  private descriptors: DescriptorReading[] = [];
  private local: EventDeclareRefusal[] = [];
  /** What each descriptor declared the last time it parsed, by path; removed paths are pruned. */
  private readonly lastValid = new Map<string, Record<string, TopicProfile>>();
  private readonly files = new DeclarationFileSet(parseTopicDescriptor, TOPIC_MAX_DESCRIPTOR_BYTES);

  constructor(
    private readonly nodeId: string,
    private readonly events: {
      descriptors: readonly string[];
      namespaces: { publish: readonly string[] };
      /** Topics this node's configuration already declares; a descriptor may not declare them again. */
      publish?: readonly string[];
    },
    pollMs = DECLARATION_POLL_MS,
    /** The `events.d/` drop-in directory (`dropInDirs`), or `undefined` for none. */
    dropInDir?: string,
  ) {
    super(pollMs, events.descriptors, dropInDir);
  }

  async refresh(): Promise<void> {
    const scan = this.scanSources(MAX_TOPIC_DESCRIPTOR_FILES);
    const issueSignature = scan.issue === null ? '' : `${scan.issue.path}:${scan.issue.detail}`;
    const files = await this.files.readChanged(scan.entries, issueSignature);
    if (files === null) return;
    const activePaths = new Set(scan.entries.map((entry) => entry.path));
    for (const kept of [...this.lastValid.keys()]) {
      if (!activePaths.has(kept)) this.lastValid.delete(kept);
    }
    const readings = files.map((file, index) => {
      const path = scan.entries[index]?.path ?? '';
      const reading = descriptorReading(path, file, this.lastValid.get(path));
      if (file.state === 'read') this.lastValid.set(path, file.value.topics);
      else if (file.state === 'missing') this.lastValid.delete(path);
      return reading;
    });
    const { topics, refused: local } = planTopicDeclarations(
      readings.map(({ topics: declared }, index) => ({
        path: scan.entries[index]?.path ?? '',
        topics: declared,
      })),
      this.events.namespaces.publish,
      this.events.publish,
    );
    const summaryDescriptors = readings.map(({ reading }) => reading);
    if (scan.issue !== null) {
      summaryDescriptors.push({
        path: scan.issue.path,
        state: 'invalid',
        topics: 0,
        detail: scan.issue.detail,
      });
    }
    this.descriptors = summaryDescriptors;
    this.local = local;
    const request: EventDeclare = {
      producer: this.nodeId,
      topics: Object.fromEntries(
        Object.entries(topics).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      ),
    };
    const fingerprint = JSON.stringify(request);
    if (fingerprint === this.fingerprint) return;
    this.request = request;
    this.fingerprint = fingerprint;
    await this.sendToAll();
  }

  snapshot(): DeclarationSnapshot {
    return { descriptors: this.descriptors, refused: this.local, lanes: this.laneResults() };
  }

  protected async ask(lane: string, connection: TopicDeclaringLane, request: EventDeclare) {
    const ack = await connection.declareTopics(request);
    if (ack === null) return null;
    return { lane, declaredAt: nowIso(), accepted: ack.accepted.length, refused: ack.refused };
  }

  protected report(result: LaneDeclaration): void {
    if (result.refused.length > 0)
      wireLogger.error('[wire] broker refused declared topics', {
        lane: result.lane,
        refused: result.refused,
      });
  }
}
