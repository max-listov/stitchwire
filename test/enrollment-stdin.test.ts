import { expect, test } from 'bun:test';
import { runNativeCommand } from 'stitchkit/process';
import { EnrollmentResultSchema } from '../packages/contracts/src/enrollment/result.ts';
import { enrollmentEntry, enrollmentStand } from './enrollment-stand.ts';
import { refusalOf } from './enrollment-results.ts';

async function plan(stdin: Uint8Array) {
  const run = await runNativeCommand({
    executable: process.execPath,
    args: [enrollmentEntry, 'enroll', 'plan', '--request', '-'],
    stdin,
    maxStdinBytes: 4 * 1024 * 1024,
    capture: true,
    maxOutputBytes: 1024 * 1024,
    timeoutMs: 20_000,
  });
  return {
    code: run.exitCode,
    result: EnrollmentResultSchema.parse(JSON.parse(new TextDecoder().decode(run.stdout))),
  };
}

test('a request on stdin is the same request; oversized or undecodable stdin is invalid-request', async () => {
  const stand = await enrollmentStand();
  try {
    const { tokenSha256: _digest, ...admission } = stand.admission;
    const planned = await plan(Buffer.from(JSON.stringify(admission)));
    expect([planned.code, planned.result.status, planned.result.operation]).toEqual([0, 'planned', 'plan']);
    for (const bytes of [
      Buffer.alloc(2 * 1024 * 1024, 0x20),
      Buffer.from([0xff, 0xfe]),
      Buffer.from(JSON.stringify({ ...admission, v: 2 })),
    ]) {
      const refused = await plan(bytes);
      expect([refused.code, refusalOf(refused.result)?.code]).toEqual([2, 'invalid-request']);
    }
  } finally {
    await stand.stop();
  }
}, 30_000);
