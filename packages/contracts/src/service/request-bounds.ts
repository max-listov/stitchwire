import { jsonEnvelopeBytes } from '../protocol/json-bounds.ts';

/** Small implicit operations stay small; larger documents require explicit owner opt-in. */
export const SERVICE_DEFAULT_REQUEST_BYTES = 65_536;
/** Bounded document transport, not an upload or durable file-transfer protocol. */
export const SERVICE_MAX_REQUEST_BYTES = 1_048_576;

export const SERVICE_MAX_REQUEST_ENVELOPE_BYTES = jsonEnvelopeBytes(SERVICE_MAX_REQUEST_BYTES);
