import { readJsonOnce } from 'stitchkit/files';
import type { FleetConfigState } from '../../../contracts/src/fleet/status.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import { anyJson, MAX_CONFIG_FILE_BYTES } from '../config/io.ts';
import { asJson, type Json } from '../json.ts';
import { wireLogger } from '../logger.ts';
import { applyConfigFile } from './copy.ts';
import { sameTables } from './projection.ts';

/**
 * Bring a process's configuration to the kept edition, and say whether the process must reload.
 *
 * Two questions, answered apart. The FILE is rewritten whenever its fleet tables differ from the
 * projection — a hand edit on disk that the running process never loaded is simply undone, and
 * nothing restarts. The PROCESS reloads only when the tables it is running differ from what the file
 * now says. Both comparisons are made on parsed configuration, so a default the schema fills in can
 * never read as a difference and restart a process in a loop.
 */
type Reconciliation =
  | { state: 'aligned'; wrote: boolean }
  | { state: 'reload'; wrote: boolean }
  | { state: 'drifted'; detail: string };

type ReconcileInput<T> = {
  path: string | undefined;
  running: T;
  project: (config: Json) => Json;
  tablesOf: (config: Json) => unknown;
  parse: (value: unknown) => { ok: true; value: T } | { ok: false; detail: string };
  /** The owner may receive another edition while the asynchronous lock is being acquired. */
  isCurrent?: () => boolean;
};

export async function reconcile<T>(input: ReconcileInput<T>): Promise<Reconciliation> {
  const { path, running, project, tablesOf, parse } = input;
  const runningTables = tablesOf(asJson(running));
  if (path === undefined) {
    const projected = parse(project(asJson(running)));
    if (!projected.ok)
      return { state: 'drifted', detail: `the projected configuration is invalid: ${projected.detail}` };
    return sameTables(runningTables, tablesOf(asJson(projected.value)))
      ? { state: 'aligned', wrote: false }
      : {
          state: 'drifted',
          detail: 'this process was started without a configuration file, so there is nothing to rewrite',
        };
  }
  const applied = await applyConfigFile(path, {
    project,
    tablesOf,
    same: sameTables,
    validate: (config) => {
      const parsed = parse(config);
      return parsed.ok ? null : parsed.detail;
    },
    ...(input.isCurrent === undefined ? {} : { isCurrent: input.isCurrent }),
  });
  if (applied.state === 'refused') return { state: 'drifted', detail: applied.detail };
  const confirmed = readJsonOnce(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
  if (confirmed.state !== 'read') return { state: 'drifted', detail: `${path} could not be read back` };
  const onDisk = parse(confirmed.value);
  if (!onDisk.ok) return { state: 'drifted', detail: `${path} does not load: ${onDisk.detail}` };
  const wrote = applied.state === 'written';
  return sameTables(runningTables, tablesOf(asJson(onDisk.value)))
    ? { state: 'aligned', wrote }
    : { state: 'reload', wrote };
}

/** The edition an owner keeps now, and how it projects onto that owner's configuration. */
export type EditionSource<T, Edition> = {
  kept(): Edition | null;
  /** Null or `unknown` when the edition says nothing this owner can run; `unknown` names why. */
  projection(edition: Edition):
    | (Omit<ReconcileInput<T>, 'path' | 'isCurrent'> & {
        /** What is restarted, for the person reading the status. */
        process: 'agent' | 'broker';
        /** Reloads are rationed per key; the file path, or the node's name without one. */
        reloadKey: string;
        /** The log line for a configuration file that was rewritten to match the edition. */
        rewritten: string;
      })
    | { unknown: string }
    | null;
};

/** One bound configuration path, reconciled on every poll. Reconciling parses the file and compares
 *  tables; at one poll every few seconds that costs nothing measurable, so no outcome is cached. */
export class FleetConfigReconciler<T> {
  private state: FleetConfigState;
  private why: string | null;
  private checked: string | null = null;
  private checking = false;
  private reloadRequested = false;
  /** An awaited config transaction must not request a reload after its owner has stopped. */
  private stopped = false;

  constructor(
    private readonly path: string | undefined,
    private readonly owner: { configured: boolean; reload?: SelfReload | undefined },
  ) {
    this.state = owner.configured ? 'unknown' : 'unconfigured';
    this.why = owner.configured ? 'no verified fleet bundle is kept yet' : null;
  }

  /** What the owner reports: whether its configuration is the kept edition's. */
  get config(): FleetConfigState {
    return this.state;
  }

  /** Why the configuration is not the kept edition's, or why no edition is kept. */
  get detail(): string | null {
    return this.why;
  }

  /** When the configuration was last held against an edition. */
  get checkedAt(): string | null {
    return this.checked;
  }

  /** The owner refused what it was offered while it keeps no edition: the status says why. */
  explain(detail: string): void {
    this.why = detail;
  }

  /** A requested reload is about to replace the process: until it settles the owner reads no source. */
  get reloading(): boolean {
    return this.reloadRequested;
  }

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
  }

  /**
   * Hold the configuration to the edition its owner keeps now: one reconciliation at a time, run
   * again when the owner received another edition while this one waited for the configuration lock,
   * and followed by a reload when the tables the process runs differ from the file.
   */
  async follow<Edition extends { serial: number }>(source: EditionSource<T, Edition>): Promise<void> {
    if (!this.owner.configured || this.reloadRequested || this.checking || this.stopped) return;
    this.checking = true;
    try {
      this.checked = nowIso();
      const edition = source.kept();
      const projection = edition === null ? null : source.projection(edition);
      if (edition === null || projection === null || 'unknown' in projection) {
        this.state = 'unknown';
        if (projection !== null && 'unknown' in projection) this.why = projection.unknown;
        return;
      }
      const { process, reloadKey, rewritten, ...input } = projection;
      const verdict = await this.verdict(
        { ...input, path: this.path, isCurrent: () => source.kept() === edition && !this.stopped },
        { serial: edition.serial, process, reloadKey, canReload: this.owner.reload !== undefined, rewritten },
      );
      if (this.stopped) return;
      if (source.kept() !== edition) {
        queueMicrotask(() => void this.follow(source));
        return;
      }
      this.state = verdict.config;
      this.why = verdict.detail;
      const reload = this.owner.reload;
      if (!verdict.reloadNow || reload === undefined) return;
      // Held until the supervisor settles the request (see `requestSelfReload`).
      this.reloadRequested = true;
      requestSelfReload(reload, () => {
        this.reloadRequested = false;
      });
    } finally {
      this.checking = false;
    }
  }

  /**
   * Reconcile, and say what the owner of this configuration should now report and do: the status
   * pair (`config`, `detail`), and whether the process should reload now. The same decision serves
   * the broker and the agent; `edition` carries what differs between them.
   */
  private async verdict(
    input: ReconcileInput<T>,
    edition: {
      serial: number;
      /** What is restarted, for the person reading the status. */
      process: 'agent' | 'broker';
      /** Reloads are rationed per key; the file path, or the node's name without one. */
      reloadKey: string;
      /** Whether the process can reload itself at all. */
      canReload: boolean;
      /** The log line for a configuration file that was rewritten to match the edition. */
      rewritten: string;
    },
  ): Promise<ConfigVerdict> {
    let outcome: Reconciliation;
    try {
      outcome = await reconcile(input);
    } catch (error) {
      outcome = {
        state: 'drifted',
        detail: `could not apply edition ${edition.serial}: ${String(error).slice(0, 300)}`,
      };
    }
    if (outcome.state === 'drifted') return { config: 'drifted', detail: outcome.detail, reloadNow: false };
    if (outcome.wrote) wireLogger.info(edition.rewritten, { path: this.path, serial: edition.serial });
    if (outcome.state === 'aligned') return { config: 'aligned', detail: null, reloadNow: false };
    if (!edition.canReload)
      return {
        config: 'drifted',
        detail: `the configuration file carries edition ${edition.serial}; restart the ${edition.process} to run it`,
        reloadNow: false,
      };
    if (!mayReloadNow(edition.reloadKey))
      return {
        config: 'drifted',
        detail: `edition ${edition.serial} is written; the reload waits out the interval between self-reloads`,
        reloadNow: false,
      };
    return { config: 'drifted', detail: `reloading to run edition ${edition.serial}`, reloadNow: true };
  }
}

/**
 * Asks the supervisor to restart the process from its configuration file. It settles when the
 * supervisor has dealt with the request: a process that was restarted is gone by then, one whose
 * request was declined (the file is refused, or already the one loaded) is still running and must go
 * on reading its sources.
 */
export type SelfReload = () => Promise<void>;

/**
 * Asks for a reload shortly after the status that announced it has been published, and calls
 * `settled` when the supervisor has dealt with the request. The caller holds a flag until then, so
 * one edition is asked for once; it is cleared afterwards because a declined request leaves the
 * process running, and a flag that stayed set would stop its polling and its questions for good.
 * A reload that fails is logged: it must not become an unhandled rejection in a timer.
 */
export function requestSelfReload(reload: SelfReload, settled: () => void): void {
  setTimeout(() => {
    reload()
      .catch((error: unknown) => {
        wireLogger.error('[wire] self-reload failed', { error: String(error).slice(0, 300) });
      })
      .finally(settled);
  }, 50);
}

export interface ConfigVerdict {
  config: 'aligned' | 'drifted';
  detail: string | null;
  reloadNow: boolean;
}

/**
 * How many reloads a process may ask for itself inside one window.
 *
 * Kept outside any instance on purpose: a reload replaces the instance that asked for it, and a
 * guard that restarted with it would guard nothing. Legitimate reloads come one per edition or one
 * per repair; only a configuration that keeps changing under the process — two writers fighting
 * over one file — asks for more, and the guard turns that fight into a bounded, reported one.
 */
const SELF_RELOAD_WINDOW_MS = 60_000;
const MAX_SELF_RELOADS_PER_WINDOW = 3;
const selfReloads = new Map<string, number[]>();

function mayReloadNow(key: string, now = Date.now()): boolean {
  const recent = (selfReloads.get(key) ?? []).filter((at) => now - at < SELF_RELOAD_WINDOW_MS);
  if (recent.length >= MAX_SELF_RELOADS_PER_WINDOW) {
    selfReloads.set(key, recent);
    return false;
  }
  selfReloads.set(key, [...recent, now]);
  return true;
}
