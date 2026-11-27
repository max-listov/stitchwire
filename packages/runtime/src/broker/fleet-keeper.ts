import { PolledJsonFile } from 'stitchkit/files';
import type {
  FleetPublish,
  FleetPublishAck,
  FleetSync,
  FleetSyncAck,
} from '../../../contracts/src/fleet/bundle.ts';
import type { FleetEditionStatus } from '../../../contracts/src/fleet/status.ts';
import { schemaParse } from '../../../contracts/src/protocol/schema-parse.ts';
import { type BrokerConfig, BrokerConfigSchema, type BrokerFleet } from '../config/broker.ts';
import { anyJson, MAX_CONFIG_FILE_BYTES } from '../config/io.ts';
import { type OpenedBundle, openBundle, reduceBundle, sameEdition } from '../fleet/bundle.ts';
import { writeFileAtomic } from '../fleet/copy.ts';
import { applyBrokerTables, brokerTablesOf } from '../fleet/projection.ts';
import { type EditionSource, FleetConfigReconciler, type SelfReload } from '../fleet/reconcile.ts';
import { backgroundInterval } from '../interval.ts';
import { wireLogger } from '../logger.ts';
import type { AuditEvent } from './audit-schema.ts';

/**
 * The broker's half of the fleet bundle: keep the newest edition, give each node the part it may
 * hold, and run the tables it projects for this broker's own roster.
 *
 * A broker accepts only a COMPLETE bundle — full part and every slice — because it is what every
 * node asks: it must be able to answer a `full` member and an `own` member alike. Who sends it does
 * not matter; the signature does. That is what lets any node that keeps the full bundle repair a
 * broker that lost its copy, and no node change what the fleet declared.
 */
export class FleetKeeper {
  private opened: OpenedBundle | null = null;
  private seen: string | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly file: PolledJsonFile<unknown> | undefined;
  private readonly reconciler: FleetConfigReconciler<BrokerConfig>;

  constructor(
    private readonly settings: BrokerFleet | undefined,
    private readonly running: BrokerConfig,
    private readonly configPath: string | undefined,
    reload: SelfReload | undefined,
    private readonly record: (event: AuditEvent) => void,
    private readonly offer: (serial: number) => void,
  ) {
    this.file =
      settings === undefined
        ? undefined
        : new PolledJsonFile(settings.copy, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
    this.reconciler = new FleetConfigReconciler(configPath, { configured: settings !== undefined, reload });
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

  sync(nodeId: string, request: FleetSync): FleetSyncAck {
    const opened = this.opened;
    if (opened === null) return { serial: null, bundle: null };
    const behind = request.serial === null || request.serial < opened.serial;
    return { serial: opened.serial, bundle: behind ? reduceBundle(opened, nodeId) : null };
  }

  publish(nodeId: string, request: FleetPublish): FleetPublishAck {
    const settings = this.settings;
    const answer = (accepted: boolean, detail: string, signer: string | null = null): FleetPublishAck => {
      this.record({
        kind: 'fleet-bundle',
        from: nodeId,
        serial: request.bundle.serial,
        signer,
        accepted,
        detail,
      });
      return { accepted, serial: this.opened?.serial ?? null, detail };
    };
    if (settings === undefined)
      return answer(false, 'this broker keeps no fleet bundle: no fleet trust is configured');
    const opening = openBundle(request.bundle, settings.trust, { requireFull: true });
    if (!opening.ok) return answer(false, opening.detail);
    const offered = opening.opened;
    const kept = this.opened?.serial ?? null;
    if (kept !== null && offered.serial < kept)
      return answer(
        false,
        `edition ${offered.serial} is older than the kept edition ${kept}`,
        offered.signer,
      );
    if (kept === offered.serial) {
      if (this.opened === null || !sameEdition(offered.bundle, this.opened.bundle))
        return answer(false, `edition ${kept} conflicts with the kept signed edition`, offered.signer);
      return answer(true, 'already kept', offered.signer);
    }
    const text = `${JSON.stringify(offered.bundle, null, 2)}\n`;
    writeFileAtomic(settings.copy, text);
    this.seen = text;
    this.opened = offered;
    const ack = answer(true, `kept edition ${offered.serial}`, offered.signer);
    this.offer(offered.serial);
    // After the acknowledgement has left: a reload here would close the socket that is waiting for it.
    setTimeout(() => void this.checkConfig(), 100);
    return ack;
  }

  health(): FleetEditionStatus {
    return {
      serial: this.opened?.serial ?? null,
      issuedAt: this.opened?.issuedAt ?? null,
      signer: this.opened?.signer ?? null,
      config: this.reconciler.config,
      detail: this.reconciler.detail,
      checkedAt: this.reconciler.checkedAt,
    };
  }

  private poll(): void {
    const settings = this.settings;
    if (settings === undefined || this.reconciler.reloading) return;
    const reading = this.file?.read();
    if (reading === undefined) return;
    if (reading.state === 'read' && reading.text !== this.seen) {
      this.seen = reading.text;
      const opening = openBundle(reading.value, settings.trust, { requireFull: true });
      if (!opening.ok) {
        wireLogger.error('[wire] kept fleet bundle refused', { path: settings.copy, detail: opening.detail });
        if (this.opened === null)
          this.reconciler.explain(`the kept copy ${settings.copy} is refused: ${opening.detail}`);
      } else if (
        this.opened !== null &&
        opening.opened.serial === this.opened.serial &&
        !sameEdition(opening.opened.bundle, this.opened.bundle)
      ) {
        wireLogger.error('[wire] kept fleet bundle refused', {
          path: settings.copy,
          detail: `edition ${this.opened.serial} conflicts with the kept signed edition`,
        });
      } else if (this.opened === null || opening.opened.serial > this.opened.serial) {
        this.opened = opening.opened;
        this.offer(opening.opened.serial);
      }
    } else if (reading.state !== 'read' && reading.state !== 'missing' && this.opened === null) {
      this.reconciler.explain(`the kept copy ${settings.copy} is unreadable: ${reading.detail}`);
    }
    void this.checkConfig();
  }

  /** The manifest of the kept edition, projected onto this broker's own configuration. */
  private readonly source: EditionSource<BrokerConfig, OpenedBundle> = {
    kept: () => this.opened,
    projection: (opened) => {
      const manifest = opened.manifest;
      if (manifest === null) return null;
      return {
        running: this.running,
        project: (config) => applyBrokerTables(config, manifest),
        tablesOf: brokerTablesOf,
        parse: schemaParse(BrokerConfigSchema),
        process: 'broker',
        reloadKey: this.configPath ?? 'broker',
        rewritten: '[wire] broker configuration rewritten from the fleet bundle',
      };
    },
  };

  private checkConfig(): Promise<void> {
    return this.reconciler.follow(this.source);
  }
}
