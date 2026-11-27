import type { z } from 'zod';
import { behindBy } from '../../../contracts/src/protocol/release.ts';
import type { PresenceSchema } from '../../../contracts/src/protocol/presence.ts';
import { RELEASE_VERSION } from '../release-version.ts';
import type { Registry } from './registry.ts';

/**
 * How the broker answers "what is the fleet running" — one projection, three readers.
 *
 * They read `registry` and `stranded` and return a shape, so they stand apart from the socket
 * wiring and `/health`'s answer reads on its own.
 */
export const presence = (
  registry: Registry,
  stranded: ReadonlyMap<string, { version: string; at: string }>,
): Array<z.infer<typeof PresenceSchema>> =>
  registry.presence().map((entry) => {
    const strandedEntry = stranded.get(entry.nodeId);
    const version = entry.online ? entry.version : (strandedEntry?.version ?? entry.version);
    return {
      ...entry,
      version,
      behind: version === null ? null : behindBy(version, RELEASE_VERSION),
      // When we learned it: the admission for a live node, the refusal for a stranded one. A
      // build with no age attached is a verdict a reader cannot weigh — and a node upgraded and
      // repointed elsewhere would otherwise be reported behind forever.
      versionSeenAt: entry.online ? entry.since : (strandedEntry?.at ?? null),
    };
  });

/**
 * Every machine's build, in one answer, with the reference the broker itself defines.
 *
 * `latest` is this broker's own release and not a poll of anything: a broker admits exactly one
 * version, so what it runs IS what the fleet must run. Classifying `behind` here rather than at
 * each machine is the same rule the shape's author gave — a machine that computed its own
 * distance from its own idea of the newest release would understate it precisely when it is cut
 * off, which is the reassuring direction and the costly one.
 *
 * A stranded node appears with the build it brought and `ok: false`: it asked, it was answered,
 * and the answer was no. That is a different fact from a node nobody has heard from, which is
 * absent from `stranded` and appears only through the roster as offline.
 */
export const fleetStanding = (
  registry: Registry,
  stranded: ReadonlyMap<string, { version: string; at: string }>,
): {
  latest: string;
  latestAt: string | null;
  machines: Array<{
    nodeId: string;
    online: boolean;
    release: {
      current: string | null;
      latest: string | null;
      latestAt: string | null;
      checkedAt: string | null;
      ok: boolean;
    };
    behind: 'patch' | 'minor' | 'major' | null;
  }>;
} => {
  const machines = presence(registry, stranded).map((entry) => {
    return {
      nodeId: entry.nodeId,
      online: entry.online,
      release: {
        // A build nobody has ever reported is not a build we can name.
        current: entry.version,
        // Confirmed only by being admitted. A refused node learned nothing, and a node that never
        // appeared learned nothing either — both say null rather than the fleet's version.
        latest: entry.online ? RELEASE_VERSION : null,
        latestAt: null,
        // Published for both states: an admitted node must not report `ok: true, checkedAt: null`
        // — "the last attempt succeeded, and there was no attempt".
        checkedAt: entry.versionSeenAt,
        ok: entry.online,
      },
      behind: entry.behind,
    };
  });
  return { latest: RELEASE_VERSION, latestAt: null, machines };
};
