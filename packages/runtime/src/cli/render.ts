/** Rendering results and rosters for a terminal. */

import type { LocalResult } from '../../../contracts/src/door/results.ts';
import { comparableVersions } from '../../../contracts/src/protocol/release.ts';
import type { StatusResult } from '../../../local-client/src/contracts.ts';
import { RELEASE_VERSION } from '../release-version.ts';

import { out } from './io.ts';
export function refusalLine(frame: {
  failure: string;
  refusal?: string;
  retryAfterMs?: number | null;
  transportCause?: string | null;
  detail: string;
}): string {
  const classified =
    frame.refusal === undefined || frame.refusal === 'none'
      ? frame.failure
      : `${frame.failure}/${frame.refusal}`;
  const retry = frame.retryAfterMs == null ? '' : ` — retry in ${frame.retryAfterMs}ms`;
  const cause = frame.transportCause == null ? '' : ` [${frame.transportCause}]`;
  return `${classified}${cause}: ${frame.detail}${retry}`;
}

/**
 * Print a result the way a caller expects a remote command to behave: its streams on our streams,
 * its exit code as ours. A transport failure is named as such and never disguised as the command
 * having failed — that distinction is the reason `failure` exists on the wire at all.
 */
export async function reportResult(result: LocalResult, json: boolean): Promise<number> {
  if (json) {
    await out(`${JSON.stringify(result)}\n`);
    return result.failure === 'none' ? result.code : 1;
  }
  if (result.failure !== 'none') {
    // The class is printed beside the code because "denied" alone sends a human to the config file
    // even when the node was merely busy, which is the exact confusion this field exists to end.
    console.error(`call failed (${refusalLine(result)})`);
    if (result.stderr !== '') process.stderr.write(result.stderr);
    return 1;
  }
  if (result.stdout !== '') await out(result.stdout);
  if (result.stderr !== '') process.stderr.write(result.stderr);
  if (result.truncated) console.error('[wire] output was truncated at the stream cap');
  return result.code;
}

type Departure = NonNullable<StatusResult['nodes'][number]['departure']>;

/** How a node's last connection ended, in words; a kind this release does not know is not guessed. */
function departureText(departure: Departure): string {
  const at = departure.at.slice(0, 19);
  switch (departure.kind) {
    case 'announced':
      return `  left on its own at ${at}Z`;
    case 'broker-restart':
      return `  last seen before a broker restart at ${at}Z — this says nothing about the node`;
    case 'lost':
      return `  connection lost at ${at}Z (${departure.reason}) — asleep and dead look the same from here`;
    case 'unrecognized':
      return `  left at ${at}Z (${departure.reason}) in a way this release does not recognize`;
    default:
      return departure.kind satisfies never;
  }
}

export function renderNodes(nodes: StatusResult['nodes']): void {
  if (nodes.length === 0) {
    console.log('no nodes registered');
    return;
  }
  const width = Math.max(...nodes.map((n) => n.nodeId.length));
  for (const n of nodes) {
    const state = !n.online ? 'offline' : n.serves ? 'serving' : 'connected (caller only)';
    const extra = n.version === null ? '' : `  v${n.version}`;
    // A node left on an older artifact must not read like a node whose network died: one word for
    // two opposite repairs. Four different things, four different words — `behind: null` is not "we
    // know nothing", it also means "level" and "unrankable".
    const seen = n.versionSeenAt === null ? '' : ` as of ${n.versionSeenAt.slice(0, 19)}Z`;
    const lag =
      n.behind === 'unrecognized'
        ? `  BEHIND the fleet by a step this release does not recognize${seen}`
        : n.behind !== null
          ? `  ${n.behind.toUpperCase()} BEHIND the fleet${seen}`
          : n.online || n.version === null
            ? ''
            : comparableVersions(n.version, RELEASE_VERSION)
              ? ''
              : `  build not comparable with ${RELEASE_VERSION}${seen}`;
    // "offline" alone is the word that let a fleet monitor call a dead node healthy for 1h47m. On
    // an offline row the manner of leaving is the whole question, so it is printed rather than left
    // in the journal — and `lost` says what it is honestly unable to distinguish.
    const gone = n.online
      ? ''
      : n.departure === null
        ? // Not a gap in the record — the absence of one. Nothing watched this node leave, and the
          // horizon says whether that means it never did or that the watching started too late.
          // The bare word "offline" on this row is what a monitor read as a sleeping laptop.
          `  no departure recorded since ${n.observingSince.slice(0, 19)}Z — either it never left, or nothing was watching when it did`
        : departureText(n.departure);
    console.log(`  ${n.nodeId.padEnd(width)}  ${state}${extra}${lag}${gone}`);
  }
}
