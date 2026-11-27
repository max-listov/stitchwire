import { z } from 'zod';

/**
 * What one machine reports about the build it carries.
 *
 * Two distinctions carry this record, and collapsing either produces a confident lie in exactly the
 * case somebody went looking:
 *
 * - **"up to date" is not "we do not know."** A node that reached no broker has no opinion about the
 *   fleet's release. Drawn as current, it would look healthiest precisely when nothing verified it.
 * - **What was last LEARNED is not when it was last ASKED.** `checkedAt` and `ok` describe the
 *   attempt; `latest` describes the knowledge. A node that cannot connect still reports honestly
 *   that it does not know, stamped with a failed attempt.
 *
 * A node learns `latest` in exactly one way, and it is worth stating because it looks like a
 * tautology and is not: **being admitted proves the broker runs this version**, since a broker
 * admits nothing else. Refusal teaches it nothing at all — the handshake deliberately gives an
 * unauthenticated peer no error text — so a refused node says `latest: null`, which is the truth.
 */
export const ReleaseStandingSchema = z
  .object({
    /**
     * The build installed on that machine. Never null in a machine's own answer — it can hardly
     * fail to know what it is running — but null in an aggregate for a node that has never
     * introduced itself, which is a third state and must not be flattened into either of the
     * others.
     */
    current: z.string().max(64).nullable(),
    /** The newest release this machine managed to confirm. Null = it does not know. */
    latest: z.string().max(64).nullable(),
    /** When that release was published, when the artifact carries it. Always null here: ours does
     *  not, and inventing a timestamp would be worse than admitting the absence. */
    latestAt: z.string().max(64).nullable(),
    /** When a check was last ATTEMPTED — success or failure. */
    checkedAt: z.string().max(64).nullable(),
    /** Did that last attempt succeed? */
    ok: z.boolean(),
  })
  .strict();

/** How far a build is behind another. Null = level, ahead, or nothing to compare against. */
export const BehindBySchema = z.enum(['patch', 'minor', 'major']).nullable();
export type BehindBy = z.infer<typeof BehindBySchema>;

/** Strictly three numbers. Anything else is not a version this scheme can rank. */
export const SEMVER = /^\d+\.\d+\.\d+$/;

export const versionParts = (value: string): [number, number, number] => {
  const [major = 0, minor = 0, patch = 0] = value.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return [major, minor, patch];
};

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const l = a[index] ?? 0;
    const r = b[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * Classified once, by the side that owns the version scheme.
 *
 * Every consumer would otherwise reimplement this and they would disagree — one calling a node two
 * minors back "slightly behind" while another calls the same node current.
 *
 * **The breaking axis is the leftmost position that is not zero.** Below 1.0.0 that is the MINOR
 * position, which is what this project has lived under for its whole life. Reading the positions
 * literally instead would make `major` unreachable and file every breaking jump under `minor`:
 * 0.10 against 0.16 is six flag days reported as a moderate gap. The error would point in the
 * reassuring direction, which is the expensive direction — an operator reads the word and acts on it.
 *
 * A node AHEAD of the fleet is not behind. That is a development build, and colouring it as a
 * problem teaches people to ignore the colour.
 */
export function behindBy(current: string, latest: string | null): BehindBy {
  // A build this scheme cannot rank is not "not behind". `0.17.0-rc1` parsed loosely compares EQUAL
  // to `0.17.0` — so a node the broker had just refused for its version would have been reported as
  // level with the fleet, which is the reassuring answer and the false one. Unrankable means
  // unranked, and the caller must say "unknown" rather than "fine".
  if (latest === null || !SEMVER.test(current) || !SEMVER.test(latest)) return null;
  if (compareVersions(current, latest) >= 0) return null;
  const c = versionParts(current);
  const l = versionParts(latest);
  const axis = (l[0] ?? 0) > 0 ? 0 : (l[1] ?? 0) > 0 ? 1 : 2;
  const firstDiff = c[0] !== l[0] ? 0 : c[1] !== l[1] ? 1 : 2;
  // A difference at or above the breaking axis IS breaking, whatever position it sits in.
  if (firstDiff <= axis) return 'major';
  // Only a scheme with a real major has a middle class; below 1.0.0 there is breaking and there is
  // compatible, and calling a compatible bump "minor" would overstate it in the other direction.
  return firstDiff === 1 && axis === 0 ? 'minor' : 'patch';
}

/** Whether two builds can be ranked against each other at all. Distinguishing this from "level" is
 *  what stops an unrankable build being drawn as current. */
export function comparableVersions(current: string | null, latest: string | null): boolean {
  return current !== null && latest !== null && SEMVER.test(current) && SEMVER.test(latest);
}

/** How severe a classification is, so a node seen through two brokers reports the WORSE of them.
 *  Picking whichever lane was listed first understates the lag, and understating is the direction
 *  an operator acts on. */
export function worseBehind(left: BehindBy, right: BehindBy): BehindBy {
  const rank = (value: BehindBy): number =>
    value === 'major' ? 3 : value === 'minor' ? 2 : value === 'patch' ? 1 : 0;
  return rank(left) >= rank(right) ? left : right;
}

/** The newest release anyone in a set managed to confirm. Null when nobody knows. */
export function bestKnownRelease(seen: readonly (string | null)[]): string | null {
  let best: string | null = null;
  for (const value of seen) {
    if (value === null) continue;
    if (best === null || compareVersions(value, best) > 0) best = value;
  }
  return best;
}
