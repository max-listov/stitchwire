import { MAX_ARG_BYTES, MAX_EVENT_BYTES, MAX_STDIN_BYTES } from '../protocol/bounds.ts';
import { jsonEnvelopeBytes } from '../protocol/json-bounds.ts';
import { SERVICE_MAX_REQUEST_ENVELOPE_BYTES } from '../service/request-bounds.ts';

export const LOCAL_CALL_ENVELOPE_BYTES = jsonEnvelopeBytes(MAX_STDIN_BYTES + MAX_ARG_BYTES);
export const LOCAL_STREAM_ENVELOPE_BYTES = Math.max(
  LOCAL_CALL_ENVELOPE_BYTES,
  SERVICE_MAX_REQUEST_ENVELOPE_BYTES,
);
export const LOCAL_PUBLISH_ENVELOPE_BYTES = jsonEnvelopeBytes(MAX_EVENT_BYTES);
export const LOCAL_SUBSCRIBE_ENVELOPE_BYTES = jsonEnvelopeBytes(0);
