import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervise } from '../packages/runtime/src/cli/supervise.ts';
import { until } from './support.ts';

/**
 * A half that throws while stopping must not poison the reload queue: the failure is logged, the new
 * configuration still starts, and a later reload still works instead of rejecting for good.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-supervise-stop-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('a stop that throws is logged and the reload continues, then the queue keeps serving', async () => {
  const path = join(root, 'config.json');
  writeFileSync(path, '1');
  const started: number[] = [];
  const running = await supervise({
    what: 'test',
    path,
    load: (bytes) => Number(new TextDecoder().decode(bytes)),
    start: (revision) => {
      started.push(revision);
      return {
        stop: async () => {
          if (revision === 1) throw new Error('stop failed');
        },
      };
    },
    watchMs: 60_000,
  });

  writeFileSync(path, '2');
  await running.reload();
  expect(started).toEqual([1, 2]);
  expect(running.reloads).toBe(1);

  writeFileSync(path, '3');
  await running.reload();
  expect(await until(() => started.includes(3), 3_000)).toBe(true);
  expect(running.reloads).toBe(2);
  await running.stop();
});
