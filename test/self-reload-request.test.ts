import { expect, test } from 'bun:test';
import { requestSelfReload } from '../packages/runtime/src/fleet/reconcile.ts';
import { until } from './support.ts';

/** A reload the supervisor fails must still settle the caller's flag and must not escape a timer. */
test('a failing reload is logged, settles the caller and raises no unhandled rejection', async () => {
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', record);
  try {
    let settled = false;
    requestSelfReload(
      () => Promise.reject(new Error('supervisor failed')),
      () => {
        settled = true;
      },
    );
    expect(await until(() => settled, 3_000)).toBe(true);
    await Bun.sleep(20);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', record);
  }
});
