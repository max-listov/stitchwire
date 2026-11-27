import { afterAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supervise } from '../packages/runtime/src/cli/supervise.ts';
import { until } from './support.ts';

const text = new TextDecoder();

/**
 * A running half of the wire runs the configuration file as it is now.
 *
 * An owner's installer that adds a descriptor path, and the fleet bundle that rewrites a table, both
 * change the file under a running process; neither should need someone to restart the service. And
 * the two ways a change must NOT restart anything hold as well: a file that does not load, and a
 * file rewritten with the bytes already running.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-config-reload-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('a changed file that loads is run in place; broken or identical bytes change nothing', async () => {
  const path = join(root, 'config.json');
  writeFileSync(path, JSON.stringify({ revision: 1 }));
  const started: number[] = [];
  const stopped: number[] = [];
  const load = (bytes: Uint8Array): { revision: number } => {
    const value = JSON.parse(text.decode(bytes));
    if (typeof value.revision !== 'number') throw new Error('revision is required');
    return value;
  };
  const running = await supervise({
    what: 'test',
    path,
    load,
    start: (config) => {
      started.push(config.revision);
      return { stop: async () => void stopped.push(config.revision) };
    },
    watchMs: 100,
  });

  writeFileSync(path, JSON.stringify({ revision: 2 }));
  expect(await until(() => started.includes(2), 3_000)).toBe(true);
  expect(stopped).toEqual([1]);
  expect(running.reloads).toBe(1);

  // The same bytes again, a file that does not parse, and one that parses but does not load.
  writeFileSync(path, JSON.stringify({ revision: 2 }));
  // Absence: each must change nothing over several watch periods, so the clock is the instrument.
  await Bun.sleep(400);
  writeFileSync(path, '{ not json');
  await Bun.sleep(400);
  writeFileSync(path, JSON.stringify({ revision: 'three' }));
  await Bun.sleep(400);
  expect(started).toEqual([1, 2]);
  expect(running.reloads).toBe(1);

  // An explicit request with nothing new on disk is not a restart either.
  writeFileSync(path, JSON.stringify({ revision: 2 }));
  await running.reload();
  expect(running.reloads).toBe(1);

  writeFileSync(path, JSON.stringify({ revision: 3 }));
  expect(await until(() => started.includes(3), 3_000)).toBe(true);
  await running.stop();
  expect(stopped).toEqual([1, 2, 3]);
});

test('a file that cannot be read is refused once, and the running configuration stays', async () => {
  const path = join(root, 'unreadable.json');
  writeFileSync(path, JSON.stringify({ revision: 1 }));
  const started: number[] = [];
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const running = await supervise({
      what: 'test',
      path,
      load: (bytes) => JSON.parse(text.decode(bytes)) as { revision: number },
      start: (config) => {
        started.push(config.revision);
        return { stop: async () => {} };
      },
      watchMs: 60_000,
    });
    // A directory where the file was: the reader refuses it before a byte is read.
    rmSync(path);
    mkdirSync(path);
    for (let pass = 0; pass < 3; pass++) await running.reload();
    const refusals = errors.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes('refused'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('Not a regular file');
    expect([started, running.reloads]).toEqual([[1], 0]);
    // Positive control: a readable new edition at the same path is run.
    rmSync(path, { recursive: true });
    writeFileSync(path, JSON.stringify({ revision: 2 }));
    await running.reload();
    expect([started, running.reloads]).toEqual([[1, 2], 1]);
    await running.stop();
  } finally {
    errors.mockRestore();
  }
});

test('a replacement during load hashes the same bytes it parsed instead of triggering a spurious reload', async () => {
  const path = join(root, 'concurrent-replace.json');
  writeFileSync(path, JSON.stringify({ revision: 1 }));
  const started: number[] = [];
  let replacedOnStart = false;
  let replacedOnReload = false;
  const running = await supervise({
    what: 'test',
    path,
    load: (bytes) => {
      const value = JSON.parse(text.decode(bytes)) as { revision: number };
      // Overwrite the file while `load` is running: a second read inside `load` would run the new
      // edition while `loaded` kept the old digest, causing a spurious reload on an unchanged file.
      if (value.revision === 1 && !replacedOnStart) {
        replacedOnStart = true;
        writeFileSync(path, JSON.stringify({ revision: 2 }));
      } else if (value.revision === 2 && !replacedOnReload) {
        replacedOnReload = true;
        writeFileSync(path, JSON.stringify({ revision: 3 }));
      }
      return value;
    },
    start: (config) => {
      started.push(config.revision);
      return { stop: async () => {} };
    },
    watchMs: 60_000,
  });
  // Initial start parsed revision 1 (from its single snapshot), NOT revision 2.
  expect([started, running.reloads]).toEqual([[1], 0]);
  // Next reload picks up revision 2 (written during initial load), then revision 3 (written during reload 1).
  await running.reload();
  expect([started, running.reloads]).toEqual([[1, 2], 1]);
  await running.reload();
  expect([started, running.reloads]).toEqual([[1, 2, 3], 2]);
  // Once the file stops changing, another reload does nothing.
  await running.reload();
  expect([started, running.reloads]).toEqual([[1, 2, 3], 2]);
  await running.stop();
});
