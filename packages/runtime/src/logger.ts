import { fstatSync } from 'node:fs';
import { createBoundedLogger, repeatLimited } from 'stitchkit/observability';

export interface StderrTarget {
  isTTY: boolean;
  journalStream: string | undefined;
  device: () => { dev: number; ino: number };
}

/**
 * Whether stderr lines carry their own time. journald and a terminal show time already; a file
 * (launchd's `StandardErrorPath`) does not, and a log without time cannot be read against anything
 * else that happened. systemd sets `JOURNAL_STREAM` to the `device:inode` of the journal stream, and a
 * child inherits the variable, so it counts only when it names the stderr this process writes to.
 */
export function stampsLines(target: StderrTarget): boolean {
  if (target.isTTY) return false;
  if (target.journalStream === undefined) return true;
  try {
    const { dev, ino } = target.device();
    return target.journalStream !== `${dev}:${ino}`;
  } catch {
    return true;
  }
}

const stamped = stampsLines({
  isTTY: process.stderr.isTTY === true,
  journalStream: process.env.JOURNAL_STREAM,
  device: () => fstatSync(2),
});

function write(message: string, data?: Record<string, unknown>): void {
  if (stamped) console.error(new Date().toISOString(), message, data);
  else console.error(message, data);
}

/** Runtime diagnostics use stderr; stdout remains the CLI result channel. */
export const wireLogger = createBoundedLogger({
  sensitiveUrlPatterns: [
    /https?:\/\/[^\s/@]+@/gi,
    /[?&](?:token|access_token|api_key|secret|password)=[^&#\s]*/gi,
  ],
  sink: repeatLimited({ info: write, warn: write, error: write, debug: write }),
});
