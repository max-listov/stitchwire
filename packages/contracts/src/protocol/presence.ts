import { z } from 'zod';
import { NodeIdSchema } from './identity.ts';
import { BehindBySchema } from './release.ts';

/**
 * What a node's disconnection MEANS, as far as the transport can honestly say.
 *
 * Deliberately three values, not two, and the third is the important one:
 *
 * - `announced` — the node said goodbye (`client namespace disconnect`): a stopped service, an
 *   orderly shutdown. Its absence is explained.
 * - `lost` — the link died (`ping timeout`, `transport close`). A sleeping laptop and a dead agent
 *   arrive here IDENTICALLY, and no field below will ever separate them: at the broker they are
 *   the same event. A consumer that needs the difference has to observe the node from inside it.
 *   Reading `lost` as "asleep, therefore fine" is exactly the rule this field exists to correct;
 *   the honest verdict on a long `lost` silence is "unknown", never "ok".
 * - `broker-restart` — the BROKER went away (`server shutting down`), not the node. This record
 *   says nothing whatsoever about the node's health.
 *
 * A consumer should NOT branch on `broker-restart` in a presence snapshot, because it cannot
 * arrive in one. The registry holding departures lives in the broker's memory and dies with the
 * process that records its own shutdown, so after a restart every row reads `null` instead. The
 * value is honest where these records survive, which is the audit journal. In a snapshot,
 * the question "has this broker forgotten" is answered by `observingSince`, not by this kind.
 *
 * An unrecognised reason classifies as `lost`, never as `announced` — an absence nobody can
 * explain is not an explained absence.
 */
export const DepartureKindSchema = z.enum(['announced', 'lost', 'broker-restart']);
export type DepartureKind = z.infer<typeof DepartureKindSchema>;

export const DepartureSchema = z
  .object({
    at: z.string().max(64),
    /** The transport's own words, kept beside our classification: the reading is ours, the fact is
     *  theirs, and a consumer that disagrees with the reading can still see what happened. */
    reason: z.string().max(256),
    kind: DepartureKindSchema,
  })
  .strict();
export type Departure = z.infer<typeof DepartureSchema>;

export const PresenceSchema = z
  .object({
    nodeId: NodeIdSchema,
    online: z.boolean(),
    /** A node that accepts inbound calls. A one-shot caller connects with `serves: false` and is
     *  never a routing target, so a stray CLI process cannot shadow the real agent. */
    serves: z.boolean(),
    /** Connections currently held by this node id (agent + any callers). */
    connections: z.number().int().min(0),
    since: z.string().max(64).nullable(),
    /** The build this node reported. For a node the broker REFUSED over its version, this is the
     *  build it brought — the only moment anyone learns it — rather than null. */
    version: z.string().max(64).nullable(),
    /**
     * How far that build is behind the fleet's, classified by the broker. Null means level with it,
     * ahead of it, or unrankable — never "probably fine".
     *
     * Required, not defaulted. A default would have saved two literals at the two sites that emit a
     * presence notice, and bought a silent acceptance of a future omission — against this project's
     * own rule that no wire field is optional for a peer's sake, because one fleet runs one version
     * and a missing field is our bug rather than someone else's age.
     */
    behind: BehindBySchema,
    /**
     * When the build above was observed — an admission, or the instant before a refusal.
     *
     * Without it a refused node's build is a claim with no age: a machine upgraded and repointed
     * elsewhere would be reported as behind forever, and nothing on the row would let a reader
     * judge how old that verdict is.
     */
    versionSeenAt: z.string().max(64).nullable(),
    /**
     * How this node's last connection ENDED, and when. Null only for a node this broker has never
     * seen leave.
     *
     * `online` answers "is it here". It was being read as "is its absence normal", which it cannot
     * answer — and a fleet monitor built on that reading called a node healthy for 1h47m while its
     * agent was in a restart loop, because its rule said a node that is not online is a laptop
     * asleep. The broker held the answer the whole time and threw it away: the transport reports
     * why a socket ended, and that reason reached the audit journal and nothing else.
     *
     * Measured across both brokers' journals, four reasons occur and they mean three different
     * things, which is what `kind` names.
     */
    departure: DepartureSchema.nullable(),
    /**
     * Since when the field above is worth anything — the moment the answering broker's registry
     * began, or, on a row merged from several, the latest such moment among them.
     *
     * `departure: null` is two facts wearing one value: the node never left, or this broker
     * restarted since and forgot. The broker has always known which, and kept it on `/health`
     * while the rows themselves travelled without it — so every consumer had to remember to go
     * and fetch it, and the reading taken when nobody did is the reassuring one. Right after a
     * rollout every row on the wire is null and every one of them means "forgotten".
     *
     * It rides the row rather than the response because a row outlives the response: two brokers'
     * views are merged into one presence, and by then the responses are gone.
     */
    observingSince: z.string().max(64),
  })
  .strict();
export type Presence = z.infer<typeof PresenceSchema>;
