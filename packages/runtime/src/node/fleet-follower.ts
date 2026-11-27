import { PolledJsonFile } from 'stitchkit/files';
import type { FleetBundle, FleetPublishAck, FleetSyncAck } from '../../../contracts/src/fleet/bundle.ts';
import type { FleetNodeStatus } from '../../../contracts/src/fleet/status.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import { schemaParse } from '../../../contracts/src/protocol/schema-parse.ts';
import { anyJson, MAX_CONFIG_FILE_BYTES } from '../config/io.ts';
import { type NodeConfig, NodeConfigSchema, type NodeFleet } from '../config/node.ts';
import { type OpenedBundle, openBundle, reduceBundle, sameEdition, tablesFor } from '../fleet/bundle.ts';
import { writeFileAtomic } from '../fleet/copy.ts';
import { applyNodeTables, nodeTablesOf } from '../fleet/projection.ts';
import { type EditionSource, FleetConfigReconciler, type SelfReload } from '../fleet/reconcile.ts';
import { backgroundInterval } from '../interval.ts';
import { wireLogger } from '../logger.ts';
import { UnansweredQuestions } from './unanswered.ts';

export interface FleetLane {
  readonly connected: boolean;
  syncFleet(serial: number | null): Promise<FleetSyncAck | null>;
  publishFleet(bundle: FleetBundle): Promise<FleetPublishAck | null>;
}

type LaneAnswer = FleetNodeStatus['lanes'][number];

const SYNC_NOT_ANSWERED = 'not answered';
const PUBLICATION_NOT_ANSWERED = 'publication not answered';

/**
 * The node's half of the fleet bundle: keep the newest edition, run the configuration it projects,
 * and hand it on.
 *
 * An edition arrives from three places — a broker lane (on connect, and whenever the broker offers a
 * newer one), the kept copy on disk (where `stitchwire fleet install` puts one), and any further
 * source file the operator named. All three go through one door: verified against this node's own
 * trusted keys, kept only when newer, and reduced to what this node may hold before it is written.
 *
 * Then the node repairs itself: whenever the fleet tables in its configuration file differ from the
 * projection, the file is rewritten, and the agent reloads if the tables it runs have changed. A
 * member that keeps the full bundle also repairs its brokers: a broker that answers with an older
 * edition is handed the newer one.
 */
export class FleetFollower {
  private opened: OpenedBundle | null = null;
  private readonly seen = new Map<string, string>();
  private readonly lanes = new Map<string, FleetLane>();
  private readonly answers = new Map<string, LaneAnswer>();
  private readonly questions = new UnansweredQuestions();
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly files = new Map<string, PolledJsonFile<unknown>>();
  private readonly reconciler: FleetConfigReconciler<NodeConfig>;

  constructor(
    private readonly nodeId: string,
    private readonly settings: NodeFleet | undefined,
    private readonly running: NodeConfig,
    private readonly configPath: string | undefined,
    reload: SelfReload | undefined,
  ) {
    this.reconciler = new FleetConfigReconciler(configPath, { configured: settings !== undefined, reload });
    for (const path of settings === undefined ? [] : [settings.copy, ...settings.sources])
      this.files.set(path, new PolledJsonFile(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES }));
  }

  attach(id: string, lane: FleetLane): void {
    this.lanes.set(id, lane);
  }

  start(): void {
    this.reconciler.start();
    if (this.settings === undefined) return;
    this.poll();
    this.timer = backgroundInterval(() => this.poll(), this.settings.pollMs);
  }

  stop(): void {
    this.reconciler.stop();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A broker that just connected may keep an older edition, or a newer one: ask it. */
  laneChanged(id: string): void {
    if (this.settings !== undefined && this.lanes.get(id)?.connected) void this.syncLane(id);
  }

  offered(id: string, serial: number): void {
    if (this.settings !== undefined && serial > (this.opened?.serial ?? 0)) void this.syncLane(id);
  }

  snapshot(): FleetNodeStatus {
    return {
      copy: this.opened === null ? 'none' : this.opened.manifest === null ? 'own' : 'full',
      serial: this.opened?.serial ?? null,
      issuedAt: this.opened?.issuedAt ?? null,
      signer: this.opened?.signer ?? null,
      config: this.reconciler.config,
      detail: this.reconciler.detail,
      checkedAt: this.reconciler.checkedAt,
      lanes: [...this.answers.values()].sort((left, right) => left.lane.localeCompare(right.lane)),
    };
  }

  private poll(): void {
    const settings = this.settings;
    if (settings === undefined || this.reconciler.reloading) return;
    this.readSource(settings.copy, true);
    for (const source of settings.sources) this.readSource(source, false);
    void this.checkConfig();
    this.retryUnanswered(settings.pollMs);
  }

  /**
   * Sync and publication are otherwise asked only when a lane connects or a broker offers a newer
   * edition, so a question that timed out would stay unanswered, and `not answered` stay in the
   * status, until the lane next reconnected. A refusal is an answer and is not asked again.
   */
  private retryUnanswered(pollMs: number): void {
    for (const id of this.questions.due(pollMs)) void this.syncLane(id);
  }

  /** A file is re-verified only when its bytes change; an unchanged copy costs one read per poll. */
  private readSource(path: string, isCopy: boolean): void {
    const reading = this.files.get(path)?.read();
    if (reading === undefined) return;
    if (reading.state !== 'read') {
      if (isCopy) this.restoreCopy(reading.state === 'missing' ? 'missing' : `unreadable: ${reading.detail}`);
      return;
    }
    if (this.seen.get(path) === reading.text) return;
    this.seen.set(path, reading.text);
    const adopted = this.adopt(reading.value, isCopy ? `the kept copy ${path}` : `source ${path}`, isCopy);
    if (isCopy && !adopted) this.restoreCopy('not the edition this node keeps');
  }

  /**
   * The copy on disk is this node's to repair: deleted, damaged or rolled back to an older edition,
   * it is written again from the edition held in memory. Without this a lost copy would return only
   * with the next edition, and a restart before then would leave the node keeping nothing.
   */
  private restoreCopy(reason: string): void {
    const settings = this.settings;
    const opened = this.opened;
    if (settings === undefined) return;
    if (opened === null) {
      if (reason !== 'missing') this.reconciler.explain(`the kept copy at ${settings.copy} is ${reason}`);
      return;
    }
    // Called only when the disk no longer holds this edition, so the bytes last seen are no guide:
    // after a deletion they are exactly the bytes that have to be written back.
    const text = `${JSON.stringify(opened.bundle, null, 2)}\n`;
    writeFileAtomic(settings.copy, text);
    this.seen.set(settings.copy, text);
    wireLogger.info('[wire] kept fleet bundle restored on disk', {
      path: settings.copy,
      reason,
      serial: opened.serial,
    });
  }

  private adopt(value: unknown, source: string, fromCopy: boolean): boolean {
    const settings = this.settings;
    if (settings === undefined) return false;
    const opening = openBundle(value, settings.trust, { requireFull: false });
    if (!opening.ok) {
      wireLogger.error('[wire] fleet bundle refused', { source, detail: opening.detail });
      if (this.opened === null) this.reconciler.explain(`${source} refused: ${opening.detail}`);
      return false;
    }
    const offered = opening.opened;
    if (this.opened !== null && offered.serial < this.opened.serial) return false;
    const reduced = reduceBundle(offered, this.nodeId);
    if (reduced === null) {
      wireLogger.error('[wire] fleet bundle names no part for this node', { source, serial: offered.serial });
      if (this.opened === null)
        this.reconciler.explain(`edition ${offered.serial} from ${source} has no part for ${this.nodeId}`);
      return false;
    }
    if (this.opened !== null && offered.serial === this.opened.serial) {
      const equal = sameEdition(reduced, this.opened.bundle);
      if (!equal)
        wireLogger.error('[wire] fleet bundle refused', {
          source,
          detail: `edition ${offered.serial} conflicts with the kept signed edition`,
        });
      return equal;
    }
    const kept = openBundle(reduced, settings.trust, { requireFull: false });
    if (!kept.ok) return false;
    if (!fromCopy || reduced !== offered.bundle) {
      const text = `${JSON.stringify(reduced, null, 2)}\n`;
      writeFileAtomic(settings.copy, text);
      this.seen.set(settings.copy, text);
    }
    this.opened = kept.opened;
    wireLogger.info('[wire] fleet bundle kept', {
      source,
      serial: kept.opened.serial,
      signer: kept.opened.signer,
      copy: kept.opened.manifest === null ? 'own' : 'full',
    });
    void this.checkConfig();
    this.relay();
    return true;
  }

  /** This node's tables of the kept edition, projected onto its own configuration. */
  private readonly source: EditionSource<NodeConfig, OpenedBundle> = {
    kept: () => this.opened,
    projection: (opened) => {
      const tables = tablesFor(opened, this.nodeId);
      if (tables === null) return { unknown: `edition ${opened.serial} says nothing about ${this.nodeId}` };
      return {
        running: this.running,
        project: (config) => applyNodeTables(config, tables),
        tablesOf: nodeTablesOf,
        parse: schemaParse(NodeConfigSchema),
        process: 'agent',
        reloadKey: this.configPath ?? this.nodeId,
        rewritten: '[wire] configuration rewritten from the fleet bundle',
      };
    },
  };

  private checkConfig(): Promise<void> {
    return this.reconciler.follow(this.source);
  }

  private async syncLane(id: string): Promise<void> {
    const lane = this.lanes.get(id);
    if (lane === undefined || !lane.connected) return;
    if (this.questions.isOpen(id)) {
      this.questions.defer(id);
      return;
    }
    const { answer: ack } = await this.questions.track(id, () => lane.syncFleet(this.opened?.serial ?? null));
    this.askAgainIfChanged(id);
    if (ack === null) {
      this.answers.set(id, {
        lane: id,
        serial: this.answers.get(id)?.serial ?? null,
        syncedAt: nowIso(),
        detail: SYNC_NOT_ANSWERED,
      });
      return;
    }
    this.answers.set(id, { lane: id, serial: ack.serial, syncedAt: nowIso(), detail: null });
    if (ack.bundle !== null) this.adopt(ack.bundle, `broker lane ${id}`, false);
    else if (this.holdsFull() && (ack.serial ?? 0) < (this.opened?.serial ?? 0)) await this.publishTo(id);
  }

  /** A broker's offer or a lane change that came while a question was open is not lost: ask again. */
  private askAgainIfChanged(id: string): void {
    if (this.questions.takeDeferred(id)) void this.syncLane(id);
  }

  private holdsFull(): boolean {
    return this.opened?.manifest != null && this.opened.bundle.full !== null;
  }

  /** Hand the full edition to every connected broker known to keep an older one. */
  private relay(): void {
    if (!this.holdsFull()) return;
    const serial = this.opened?.serial ?? 0;
    for (const [id, lane] of this.lanes) {
      const answered = this.answers.get(id);
      if (lane.connected && answered !== undefined && (answered.serial ?? 0) < serial)
        void this.publishTo(id);
    }
  }

  private async publishTo(id: string): Promise<void> {
    const lane = this.lanes.get(id);
    const opened = this.opened;
    if (lane === undefined || opened === null || opened.bundle.full === null) return;
    if (this.questions.isOpen(id)) {
      this.questions.defer(id);
      return;
    }
    const { answer: ack } = await this.questions.track(id, () => lane.publishFleet(opened.bundle));
    this.askAgainIfChanged(id);
    const previous = this.answers.get(id)?.serial ?? null;
    this.answers.set(id, {
      lane: id,
      serial: ack?.accepted ? ack.serial : (ack?.serial ?? previous),
      syncedAt: nowIso(),
      detail: ack === null ? PUBLICATION_NOT_ANSWERED : ack.accepted ? null : ack.detail,
    });
    if (ack?.accepted)
      wireLogger.info('[wire] fleet bundle handed to a broker that kept an older one', {
        lane: id,
        serial: opened.serial,
      });
  }
}
