import { runNativeCommand } from 'stitchkit/process';
import { EnrollmentResultSchema } from '../packages/contracts/src/enrollment/result.ts';

/** A fleet poll can own the config lock before the injected cut is reached. Only that exact
 * refusal is a retryable test precondition; every other result remains the boundary's verdict. */
export async function runEnrollmentCrash(
  runner: string,
  file: string,
  operation: string,
  cut: string,
  busyCeilingMs = 5000,
) {
  const deadline = performance.now() + busyCeilingMs;
  for (;;) {
    const child = await runNativeCommand({
      executable: process.execPath,
      args: [runner, file, operation, cut],
      capture: true,
      maxOutputBytes: 65536,
      timeoutMs: 28_000,
    });
    if (child.exitCode === 73 || performance.now() >= deadline) return child;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(child.stdout));
    } catch {
      return child;
    }
    const parsed = EnrollmentResultSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.status !== 'failed' ||
      parsed.data.failure?.code !== 'busy' ||
      parsed.data.failure.phase !== 'configuration' ||
      parsed.data.failure.systemCode !== 'LOCK_TIMEOUT'
    )
      return child;
    await Bun.sleep(25);
  }
}
