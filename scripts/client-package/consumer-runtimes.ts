import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LOCAL_API_VERSION } from '../../packages/contracts/src/door/common.ts';
import { fixtures, run } from './run.ts';

/**
 * Fixtures that exercise the installed package and print one verdict line each, on Bun and on Node.
 * They share `_door.mjs`, which is copied beside them.
 */
const packedFixtures = [
  'client-consumer.mjs',
  'client-contracts-browser.mjs',
  'client-stream-lifetime.mjs',
  'client-composition.mjs',
  'client-service-diagnostics.mjs',
  'client-empty-service.mjs',
  'client-service-ingress.mjs',
  'client-large-service.mjs',
  'client-service-declaration.mjs',
  'client-event-sequence.mjs',
  'client-subscription-lifecycle.mjs',
];

/** Copy the fixtures beside the consumer; on Bun and on Node, a packed Door version that differs is refused. */
export async function proveDoorVersion(scratch: string): Promise<void> {
  for (const name of ['_door.mjs', 'client-version.mjs', 'client-backpressure.mjs', ...packedFixtures])
    await copyFile(join(fixtures, name), join(scratch, name));
  for (const runtime of ['bun', 'node']) {
    console.log((await run([runtime, 'client-version.mjs', String(LOCAL_API_VERSION)], scratch)).trim());
    await run([runtime, 'client-version.mjs', String(LOCAL_API_VERSION + 1)], scratch).then(
      () => {
        throw new Error('Packed SDK version check accepted a mismatched source contract');
      },
      (error: unknown) => {
        if (
          !(error instanceof Error) ||
          !error.message.includes('installed SDK Door version differs from source contract')
        )
          throw error;
        console.log(`${runtime}: packed Door mismatch refused`);
      },
    );
  }
}

/** Every packed fixture on Bun and on Node, the backpressure gate first. */
export async function proveRuntimes(scratch: string): Promise<void> {
  // Both runtimes must be exercised even when one adapter violates the bound.
  const backpressure = await Promise.allSettled([
    run(['bun', 'client-backpressure.mjs'], scratch),
    run(['node', 'client-backpressure.mjs'], scratch),
  ]);
  const failures: unknown[] = [];
  for (const outcome of backpressure) {
    if (outcome.status === 'fulfilled') console.log(outcome.value.trim());
    else failures.push(outcome.reason);
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Packed client backpressure gate failed');
  for (const name of packedFixtures)
    for (const runtime of ['bun', 'node']) console.log((await run([runtime, name], scratch)).trim());
}
