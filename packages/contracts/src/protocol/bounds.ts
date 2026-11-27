export const MAX_STREAM_BYTES = 4 * 1024 * 1024;
export const MAX_FRAME_BYTES = 12 * 1024 * 1024;
export const MAX_ARG_COUNT = 64;
export const MAX_ARG_BYTES = 64 * 1024;
export const MAX_STDIN_BYTES = 1024 * 1024;
/** Commands may contain several bounded stages; streams retain their separate lifetime limit. */
export const MAX_COMMAND_TIMEOUT_MS = 3_600_000;
export const MAX_COMMAND_CANCELLATION_GRACE_MS = 900_000;
/** A stream bounds a total lifetime, and a call that sets no deadline of its own gets at most this. */
export const MAX_STREAM_TIMEOUT_MS = 900_000;
export const MAX_STREAM_CHUNK_BYTES = 32 * 1024;
export const MAX_STREAM_WINDOW_BYTES = 256 * 1024;
export const MAX_STREAM_TOTAL_BYTES = 256 * 1024 * 1024;
export const MAX_EVENT_BYTES = 256 * 1024;
/** Retention is a memory cost the broker pays for a topic nobody may be listening to, so the ceiling
 *  is the protocol's business and not a per-deployment opinion. Minutes and megabytes, not days. */
export const MAX_TOPIC_RETAIN_AGE_MS = 3_600_000;
export const MAX_TOPIC_RETAINED_BYTES = 32 * 1024 * 1024;
export const MAX_RETAINED_BYTES_TOTAL = 256 * 1024 * 1024;
export const MAX_TOPIC_NAME_BYTES = 128;
/** Nodes in one fleet: the roster a broker is configured with and every answer that lists it. */
export const MAX_NODES = 1024;
/**
 * Ceilings on the audit journal's own knobs.
 *
 * The journal is the one thing this process writes to disk without bound, so the size of a
 * generation and the number of them kept are capped here rather than left to a config that can ask
 * for anything: an operator may choose how much history to keep, never whether the journal has an
 * end.
 */
export const MAX_AUDIT_FILE_BYTES = 1024 * 1024 * 1024;
export const MAX_AUDIT_GENERATIONS = 64;

/** The door's own ceilings: the largest request body it takes, the largest answer a client reads and
 *  the largest frame of an NDJSON stream. */
export const DOOR_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const DOOR_MAX_RESPONSE_BYTES = 52 * 1024 * 1024;
export const DOOR_MAX_FRAME_BYTES = 512 * 1024;
