/**
 * A decoded UTF-8 byte may occupy six ASCII bytes as a JSON escape. The fixed allowance covers
 * routing fields, delimiters and the bounded metadata outside the payload strings. This is a budget
 * for the encoded body, never permission for a larger decoded payload.
 */
export function jsonEnvelopeBytes(payloadBytes: number): number {
  return 6 * payloadBytes + 4096;
}
