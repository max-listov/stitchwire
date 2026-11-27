import { readRegularFileSync } from 'stitchkit/files';
import { MAX_CONFIG_FILE_BYTES, sha256 } from '../config/io.ts';
import type { SelfReload } from '../fleet/reconcile.ts';
import { backgroundInterval } from '../interval.ts';

/**
 * Run one half of the wire, and restart it in place whenever its configuration file changes.
 *
 * Two writers change that file while the process runs: the fleet bundle rewrites its tables, and an
 * owner's installer adds a descriptor path. Neither restarts the service, so a new service file
 * would sit unread until the next unrelated restart. The file itself is the signal: every few
 * seconds its bytes are compared with the bytes the running process loaded, and a difference that
 * loads is run.
 *
 * The restart happens inside the same process rather than by exiting and trusting a service manager
 * to start it again: whether a supervisor restarts a clean exit is a property of each machine's unit
 * file, and a fleet whose repair depends on it repairs only the machines configured the lucky way.
 *
 * The new file is loaded BEFORE the running half stops. A file that does not load, or cannot be read
 * at all, is refused once, and the old configuration keeps running — a broken edit must never turn a
 * working machine into one that is not listening at all. Bytes equal to the running ones change
 * nothing.
 */

const CONFIG_WATCH_MS = 5_000;

/** One snapshot of the file, hashed and parsed from the same bytes so a concurrent replace cannot skew `loaded`. */
function snapshot(path: string): { bytes: Uint8Array; digest: string } {
  const bytes = readRegularFileSync(path, { limit: MAX_CONFIG_FILE_BYTES });
  return { bytes, digest: sha256(bytes) };
}

interface Supervised<H> {
  readonly current: H;
  readonly reloads: number;
  /** Run the file as it is now, if it differs from what is running and loads. */
  reload(): Promise<void>;
  stop(): Promise<void>;
}

export async function supervise<C, H extends { stop(): Promise<unknown> }>(input: {
  what: string;
  path: string;
  load: (bytes: Uint8Array, path: string) => C;
  start: (config: C, reload: SelfReload) => Promise<H> | H;
  announce?: (config: C, handle: H) => void;
  watchMs?: number;
}): Promise<Supervised<H>> {
  const { what, path, load, start, announce } = input;
  const initial = snapshot(path);
  let loaded = initial.digest;
  /** The edition last refused, so a file that stays broken is reported once, not every poll. */
  let refused: string | null = null;
  let stopping = false;
  let reloads = 0;
  let queue: Promise<void> = Promise.resolve();

  const reload: SelfReload = () => {
    // The queue never stays rejected: one failed pass must not make every later reload, and the
    // interval that drives them, reject or skip for the rest of the process's life.
    queue = queue
      .then(async () => {
        if (stopping) return;
        let now: string | undefined;
        let next: C;
        try {
          const current = snapshot(path);
          now = current.digest;
          if (now === loaded) return;
          next = load(current.bytes, path);
        } catch (error) {
          // An unreadable file has no bytes to name its edition by; the reason names it instead.
          const seen = now ?? `unreadable: ${String(error)}`;
          if (refused !== seen)
            console.error(`[wire] ${what} reload refused, the running configuration stays: ${String(error)}`);
          refused = seen;
          return;
        }
        try {
          await handle.stop();
        } catch (error) {
          // A half-stopped half is replaced anyway; a start that then fails exits below.
          console.error(`[wire] ${what} did not stop cleanly before a reload: ${String(error)}`);
        }
        try {
          handle = await start(next, reload);
        } catch (error) {
          console.error(`[wire] ${what} did not start again after a reload: ${String(error)}`);
          process.exit(1);
        }
        loaded = now;
        refused = null;
        reloads += 1;
        announce?.(next, handle);
        console.error(`[wire] ${what} reloaded from ${path}`);
      })
      .catch((error: unknown) => {
        console.error(`[wire] ${what} reload failed: ${String(error)}`);
      });
    return queue;
  };

  const config = load(initial.bytes, path);
  let handle = await start(config, reload);
  announce?.(config, handle);
  const timer = backgroundInterval(reload, input.watchMs ?? CONFIG_WATCH_MS);

  return {
    get current() {
      return handle;
    },
    get reloads() {
      return reloads;
    },
    reload,
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      await queue;
      await handle.stop();
    },
  };
}

/** `stitchwire broker` and `stitchwire agent`: supervised until signalled. */
export async function superviseReloads<C, H extends { stop(): Promise<unknown> }>(input: {
  what: string;
  path: string;
  load: (bytes: Uint8Array, path: string) => C;
  start: (config: C, reload: SelfReload) => Promise<H>;
  announce: (config: C, handle: H) => void;
}): Promise<number> {
  const running = await supervise(input);
  const shutdown = (): void => {
    void running.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await new Promise(() => {});
  return 0;
}
