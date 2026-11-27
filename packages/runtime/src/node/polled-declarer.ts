import { waitForDirectory } from 'stitchkit/files';
import { type DropInScanResult, scanDropInFiles } from '../config/drop-in.ts';
import { backgroundInterval } from '../interval.ts';
import { wireLogger } from '../logger.ts';
import { UnansweredQuestions } from './unanswered.ts';

/**
 * How often bound declaration files and an existing drop-in directory are re-read. An owner's edit
 * reaches the brokers within this.
 */
export const DECLARATION_POLL_MS = 5_000;

/** A broker lane as a declarer sees it: it can be asked only while connected. */
export interface DeclaringLane {
  readonly connected: boolean;
}

/**
 * What topic and service declarers have in common: files polled for change, the complete current
 * request sent to every connected broker lane on each connect and whenever it changes, the broker's
 * answer per lane kept for the node's status, and a send nobody answered asked again later. A changed
 * request is sent at once, even beside an unanswered one; only the answer to the latest send per lane
 * is kept, so a late answer to an older request never replaces a newer one.
 *
 * A subclass says what the files mean (`refresh`), how a lane is asked (`ask`) and what an answer
 * is worth keeping (`report`).
 *
 * Nothing on disk is polled that cannot change on its own: explicit files and an existing drop-in
 * directory are re-read every `pollMs`; a drop-in directory that does not exist is only watched for
 * its appearance (`waitForDirectory` with `match: 'entry'`), so an idle node with neither holds no
 * timer at all.
 */
export abstract class PolledDeclarer<
  Lane extends DeclaringLane,
  Request,
  LaneResult extends { lane: string },
> {
  protected request: Request | null = null;
  protected fingerprint = '';
  protected readonly lanes = new Map<string, Lane>();
  private readonly results = new Map<string, LaneResult>();
  private readonly questions = new UnansweredQuestions();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Direct refresh is usable before start; a stopped instance must never resurrect its timer. */
  private lifecycle: 'idle' | 'running' | 'stopped' = 'idle';

  /** Active appearance watch for a missing drop-in directory; `undefined` when not watching. */
  private watchAbort: AbortController | undefined;
  private watchFailure: { cause: unknown } | undefined;
  /** The drop-in directory existed at the last scan, so its files are polled. */
  private dropInPresent = false;
  private watchFailureLogged = false;

  constructor(
    protected readonly pollMs: number,
    /** Bound files need polling; an empty set needs only its current withdrawal acknowledged. */
    private readonly bound: readonly string[],
    /** The drop-in directory read beside the bound files, or `undefined` for none. */
    private readonly dropInDir: string | undefined,
  ) {}

  /** Reads the files and, when the request they make changed, sends it to every connected lane. */
  abstract refresh(): Promise<void>;
  /** Puts the request to one lane; `null` when the lane gave no answer. */
  protected abstract ask(lane: string, connection: Lane, request: Request): Promise<LaneResult | null>;
  /** Called with each answer a lane gave. */
  protected abstract report(result: LaneResult): void;

  attach(id: string, lane: Lane): void {
    this.lanes.set(id, lane);
  }

  start(): void {
    this.lifecycle = 'running';
    void this.poll();
    this.syncTimer();
  }

  stop(): void {
    this.lifecycle = 'stopped';
    this.closeWatch();
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A lane that just connected is a broker that may know nothing: it hears the whole set again. */
  laneChanged(id: string): void {
    this.results.delete(id);
    if (this.lanes.get(id)?.connected) void this.sendTo(id);
    this.syncTimer();
  }

  /** The answers the lanes gave, in lane order. */
  protected laneResults(): LaneResult[] {
    return [...this.results.values()].sort((left, right) => left.lane.localeCompare(right.lane));
  }

  /**
   * The bound files and the drop-in directory's files, in force order. While running, the
   * appearance watch is armed before the directory is looked at and closed only once it is seen,
   * so an entry created at any moment is noticed by the watch or by this scan.
   */
  protected scanSources(maxTotal: number): DropInScanResult {
    if (this.lifecycle === 'running') this.armWatch();
    const scan = scanDropInFiles(this.bound, this.dropInDir, maxTotal);
    this.dropInPresent = this.dropInDir !== undefined && !scan.absent;
    if (this.dropInPresent) {
      this.closeWatch();
      this.watchFailure = undefined;
      this.watchFailureLogged = false;
    }
    return scan;
  }

  protected sendToAll(): Promise<unknown> {
    return Promise.all([...this.lanes.keys()].map((id) => this.sendTo(id)));
  }

  private armWatch(): void {
    if (this.dropInDir === undefined || this.watchAbort !== undefined) return;
    const abort = new AbortController();
    this.watchAbort = abort;
    void waitForDirectory(this.dropInDir, {
      match: 'entry',
      settleMs: this.pollMs,
      keepAlive: false,
      signal: abort.signal,
    }).then(
      () => {
        if (this.watchAbort !== abort) return;
        this.watchAbort = undefined;
        this.watchFailure = undefined;
        this.watchFailureLogged = false;
        void this.poll();
      },
      (cause: unknown) => {
        if (this.watchAbort !== abort) return;
        this.watchAbort = undefined;
        if (abort.signal.aborted || this.lifecycle !== 'running') return;
        this.watchFailure = { cause };
        if (!this.watchFailureLogged) {
          this.watchFailureLogged = true;
          wireLogger.error('[wire] cannot watch for the drop-in directory; polling for it instead', {
            path: this.dropInDir,
            cause: String(cause).slice(0, 200),
          });
        }
        this.syncTimer();
      },
    );
  }

  private closeWatch(): void {
    const abort = this.watchAbort;
    this.watchAbort = undefined;
    abort?.abort();
  }

  private async poll(): Promise<void> {
    if (this.lifecycle !== 'running') return;
    await this.refresh();
    for (const id of this.questions.due(this.pollMs)) void this.sendTo(id);
    this.syncTimer();
  }

  /** Connected lanes that have not answered the current request: what the next poll asks again. */
  get owing(): string[] {
    if (this.request === null) return [];
    return [...this.lanes].flatMap(([id, lane]) => (lane.connected && !this.results.has(id) ? [id] : []));
  }

  /**
   * Whether a poll is scheduled: bound files or an existing drop-in directory are re-read, a missing
   * one could not be watched, or a lane still owes an answer.
   */
  get polling(): boolean {
    return this.timer !== undefined;
  }

  /** Whether an appearance watch is currently armed for a missing drop-in directory. */
  get watchingForDropIn(): boolean {
    return this.watchAbort !== undefined;
  }

  private syncTimer(): void {
    const needsPoll =
      this.bound.length > 0 ||
      this.dropInPresent ||
      (this.watchFailure !== undefined && !this.dropInPresent) ||
      this.owing.length > 0;
    if (this.lifecycle === 'running' && needsPoll) {
      this.timer ??= backgroundInterval(() => void this.poll(), this.pollMs);
    } else {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async sendTo(id: string): Promise<void> {
    if (this.stopped()) return;
    const lane = this.lanes.get(id);
    const request = this.request;
    if (lane === undefined || request === null) return;
    // Status must not mistake a prior edition's positive answer for this pending request.
    this.results.delete(id);
    this.syncTimer();
    if (!lane.connected) return;
    const { answer: result, current } = await this.questions.track(id, () => this.ask(id, lane, request));
    if (result === null || !current || this.stopped()) return;
    this.results.set(id, result);
    this.report(result);
    this.syncTimer();
  }

  private stopped(): boolean {
    return this.lifecycle === 'stopped';
  }
}
