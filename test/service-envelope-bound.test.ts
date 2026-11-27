import { expect, test } from 'bun:test';
import {
  SERVICE_MAX_ENVELOPE_BYTES,
  SERVICE_MAX_RESPONSE_BYTES,
  ServiceIngressSchema,
  ServiceResultSchema,
} from '../packages/contracts/src/service/contracts.ts';
import { SERVICE_MAX_REQUEST_ENVELOPE_BYTES } from '../packages/contracts/src/service/request-bounds.ts';
import { MAX_RETRY_AFTER_MS } from '../packages/contracts/src/protocol/failure.ts';

test('strict maximal service envelopes fit their HTTP budgets without runtime serialization checks', () => {
  for (const character of ['a', '"', '\\', '\u0000', '\t', 'я', '🙂']) {
    const unit = JSON.stringify(character).slice(1, -1);
    const count = Math.floor((SERVICE_MAX_RESPONSE_BYTES - 2) / Buffer.byteLength(unit));
    const text = `"${unit.repeat(count)}"`;
    const payload = text + ' '.repeat(SERVICE_MAX_RESPONSE_BYTES - Buffer.byteLength(text));
    expect(Buffer.byteLength(payload)).toBe(SERVICE_MAX_RESPONSE_BYTES);
    const ingress = {
      v: 1,
      id: crypto.randomUUID(),
      caller: 'a'.repeat(32),
      service: 's'.repeat(128),
      revision: 'r'.repeat(64),
      operation: 'o'.repeat(64),
      payload,
    };
    const result = {
      id: crypto.randomUUID(),
      from: 'a'.repeat(32),
      outcome: { status: 'response', delivery: 'received', httpStatus: 599, payload },
    };
    expect(ServiceIngressSchema.safeParse(ingress).success).toBe(true);
    expect(ServiceResultSchema.safeParse(result).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(ingress))).toBeLessThan(SERVICE_MAX_REQUEST_ENVELOPE_BYTES);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(SERVICE_MAX_ENVELOPE_BYTES);
    expect(ServiceIngressSchema.safeParse({ ...ingress, payload: `${payload} ` }).success).toBe(false);
    expect(
      ServiceResultSchema.safeParse({ ...result, outcome: { ...result.outcome, payload: `${payload} ` } })
        .success,
    ).toBe(false);
    expect(ServiceIngressSchema.safeParse({ ...ingress, extra: 'x' }).success).toBe(false);
    expect(ServiceResultSchema.safeParse({ ...result, extra: 'x' }).success).toBe(false);
  }
  const failure = ServiceResultSchema.parse({
    id: crypto.randomUUID(),
    from: 'a'.repeat(32),
    outcome: {
      status: 'failure',
      code: 'capacity',
      delivery: 'not-dispatched',
      refusal: 'capacity',
      retryAfterMs: MAX_RETRY_AFTER_MS,
      transportCause: null,
      detail: '\u0000'.repeat(4096),
    },
  });
  expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThan(SERVICE_MAX_ENVELOPE_BYTES);
});
