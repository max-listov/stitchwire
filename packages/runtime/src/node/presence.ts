import type { Departure, Presence } from '../../../contracts/src/protocol/presence.ts';
import { worseBehind } from '../../../contracts/src/protocol/release.ts';

/**
 * Merge two brokers' views of how a node last left.
 *
 * Latest-wins is the wrong rule here, and quietly so. `broker-restart` records the BROKER going
 * away and says nothing about the node — so after any rollout it is the freshest departure on every
 * row, and latest-wins would bury the node's own departure under it within seconds. A record that
 * is about the node therefore outranks one that is not, however old; only between two records of
 * equal standing does the clock decide.
 */
function mergeDeparture(
  left: Departure | null | undefined,
  right: Departure | null | undefined,
): Departure | null {
  // Absent and null mean the same thing here — nothing is known about how this side last left —
  // and they must not be told apart by crashing on one of them. `undefined` reaches this from a
  // payload that carried no such field at all.
  if (left === undefined || left === null) return right ?? null;
  if (right === undefined || right === null) return left;
  const aboutNode = (d: Departure): boolean => d.kind !== 'broker-restart';
  if (aboutNode(left) !== aboutNode(right)) return aboutNode(left) ? left : right;
  return left.at >= right.at ? left : right;
}

/**
 * One node as two brokers see it.
 *
 * Reachability adds up — online anywhere is online — but the BUILD and the verdict about it are a
 * single observation and must be taken from one lane or the other, never mixed. Taking `version`
 * from the first row and `behind` from the second prints a line that contradicts itself: a node
 * named as running the fleet's current build and MAJOR BEHIND on the same line, when one broker
 * still holds a stranded record from before that node was upgraded and repointed elsewhere.
 *
 * Between two observations the more alarming one wins. Which lane is listed first is an accident of
 * configuration, and letting an accident choose errs in the reassuring direction — the one an
 * operator acts on.
 */
/**
 * Orders two instants as moments, so two spellings of one time are one time. Text that is no
 * instant is ordered as text: the merge then still does not depend on which lane is listed first.
 */
function instantOrder(left: string, right: string): number {
  const difference = Date.parse(left) - Date.parse(right);
  if (!Number.isNaN(difference)) return difference;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function mergePresence(left: Presence, right: Presence): Presence {
  const worst = worseBehind(left.behind, right.behind);
  const observation =
    left.behind === worst && (left.version !== null || right.version === null) ? left : right;
  return {
    nodeId: left.nodeId,
    online: left.online || right.online,
    serves: left.serves || right.serves,
    connections: left.connections + right.connections,
    since:
      left.since === null
        ? right.since
        : right.since === null || instantOrder(left.since, right.since) <= 0
          ? left.since
          : right.since,
    version: observation.version,
    behind: observation.behind,
    versionSeenAt: observation.versionSeenAt,
    departure: mergeDeparture(left.departure, right.departure),
    // The LATER of the two, and the direction matters. A broker watching since 08:00 that recorded
    // no departure vouches for that whole span; one that started at 10:00 vouches for nothing
    // before it. So the merged claim "nobody recorded a departure" holds only back to the point
    // where BOTH were watching, and taking the earlier horizon would extend one broker's silence
    // over hours the other cannot speak for — silence read as evidence.
    observingSince:
      instantOrder(left.observingSince, right.observingSince) >= 0
        ? left.observingSince
        : right.observingSince,
  };
}
