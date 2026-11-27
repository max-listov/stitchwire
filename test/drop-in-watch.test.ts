import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropInDirs } from '../packages/runtime/src/config/drop-in.ts';
import { wireLogger } from '../packages/runtime/src/logger.ts';
import { ServiceDeclarer } from '../packages/runtime/src/node/service-declarations.ts';
import { TopicDeclarer } from '../packages/runtime/src/node/topic-declarations.ts';
import { caseDirs, nodeConfig } from './drop-in-fixture.ts';
import { until } from './support.ts';

const cases = caseDirs('wire-drop-in-watch-');
afterAll(cases.remove);
const workDir = cases.next;

describe('a drop-in directory that does not exist costs no timer', () => {
  test('without services.d/ and events.d/ no poll is scheduled; the directory appearing starts its poll', async () => {
    const conf = workDir();
    const dirs = dropInDirs(nodeConfig, join(conf, 'node.json'));
    expect(dirs).toEqual({ services: join(conf, 'services.d'), events: join(conf, 'events.d') });
    const served: string[][] = [];
    // A minute between polls: anything noticed sooner was noticed by the watch, not by a timer.
    const services = new ServiceDeclarer(
      'worker',
      nodeConfig.services,
      (policy) => served.push(policy.bindings.map((binding) => binding.service)),
      60_000,
      dirs.services,
    );
    const topics = new TopicDeclarer('worker', nodeConfig.events, 60_000, dirs.events);
    services.start();
    topics.start();
    try {
      expect(services.polling).toBe(false);
      expect(topics.polling).toBe(false);
      expect(services.watchingForDropIn).toBe(true);
      expect(topics.watchingForDropIn).toBe(true);

      // Let the watch go live first (measured on macOS: none of 100 missed at 20 ms); the case of
      // a directory created before that is the settle scan's, below.
      await Bun.sleep(250);
      mkdirSync(join(conf, 'services.d'), { mode: 0o700 });
      expect(await until(() => services.polling, 5_000)).toBe(true);
      expect(services.watchingForDropIn).toBe(false);
      // The other directory is still missing: still only watched.
      expect(topics.polling).toBe(false);
      expect(topics.watchingForDropIn).toBe(true);
    } finally {
      services.stop();
      topics.stop();
    }
    expect(services.watchingForDropIn).toBe(false);
  });

  test('a directory created before the watch is live is found by the one settle scan, and no period follows', async () => {
    const conf = workDir();
    const topics = new TopicDeclarer('worker', nodeConfig.events, 300, join(conf, 'events.d'));
    topics.start();
    try {
      mkdirSync(join(conf, 'events.d'), { mode: 0o700 });
      expect(await until(() => topics.polling, 5_000)).toBe(true);
    } finally {
      topics.stop();
    }
    const idle = new TopicDeclarer('worker', nodeConfig.events, 100, join(workDir(), 'events.d'));
    idle.start();
    try {
      await Bun.sleep(400);
      expect(idle.polling).toBe(false);
      expect(idle.watchingForDropIn).toBe(true);
    } finally {
      idle.stop();
    }
  });

  test('controls: an existing directory is polled at once, none configured is neither polled nor watched', async () => {
    const conf = workDir();
    mkdirSync(join(conf, 'events.d'), { mode: 0o700 });
    const present = new TopicDeclarer(
      'worker',
      nodeConfig.events,
      60_000,
      dropInDirs(nodeConfig, join(conf, 'node.json')).events,
    );
    // Another configuration file name has no default drop-in directory at all.
    const none = new TopicDeclarer(
      'worker',
      nodeConfig.events,
      60_000,
      dropInDirs(nodeConfig, join(conf, 'worker.json')).events,
    );
    present.start();
    none.start();
    try {
      expect(present.polling).toBe(true);
      expect(present.watchingForDropIn).toBe(false);
      expect(none.polling).toBe(false);
      expect(none.watchingForDropIn).toBe(false);
    } finally {
      present.stop();
      none.stop();
    }
  });

  test('a removed directory stops its poll and is watched for again; a missing parent is watched from above', async () => {
    const conf = workDir();
    const dir = join(conf, 'deep', 'events.d');
    const topics = new TopicDeclarer('worker', nodeConfig.events, 50, dir);
    topics.start();
    try {
      expect(topics.watchingForDropIn).toBe(true);
      mkdirSync(join(conf, 'deep'), { mode: 0o700 });
      await Bun.sleep(100);
      expect(topics.watchingForDropIn).toBe(true);
      expect(topics.polling).toBe(false);
      mkdirSync(dir, { mode: 0o700 });
      expect(await until(() => topics.polling, 5_000)).toBe(true);
      expect(topics.watchingForDropIn).toBe(false);
      rmSync(dir, { recursive: true });
      expect(await until(() => !topics.polling, 5_000)).toBe(true);
      expect(topics.watchingForDropIn).toBe(true);
    } finally {
      topics.stop();
    }
  });

  test('a watched ancestor that is removed is heard from its parent, and the watch moves up', async () => {
    const conf = workDir();
    const deep = join(conf, 'deep');
    mkdirSync(deep, { mode: 0o700 });
    // A minute between polls and before the settle scan: only a watch can wake the declarer.
    const services = new ServiceDeclarer(
      'worker',
      nodeConfig.services,
      () => {},
      60_000,
      join(deep, 'services.d'),
    );
    services.start();
    try {
      expect(services.watchingForDropIn).toBe(true);
      // Let the watches go live first, as above.
      await Bun.sleep(250);
      rmSync(deep, { recursive: true });
      await Bun.sleep(100);
      expect(services.watchingForDropIn).toBe(true);
      expect(services.polling).toBe(false);
      mkdirSync(join(deep, 'services.d'), { recursive: true, mode: 0o700 });
      expect(await until(() => services.polling, 5_000)).toBe(true);
    } finally {
      services.stop();
    }
  });

  test('a regular file or broken symlink at the drop-in path wakes the watch and surfaces a refusal', async () => {
    for (const [label, create] of [
      ['regular-file', (path: string) => writeFileSync(path, 'not a dir')],
      ['broken-symlink', (path: string) => symlinkSync(join(path, '..', 'missing-target'), path)],
    ] as const) {
      const conf = workDir();
      const target = join(conf, 'services.d');
      const services = new ServiceDeclarer('worker', nodeConfig.services, () => {}, 60_000, target);
      services.start();
      try {
        expect(services.watchingForDropIn).toBe(true);
        expect(services.polling).toBe(false);
        await Bun.sleep(250);
        create(target);
        expect(
          await until(
            () =>
              services
                .snapshot()
                .descriptors.some((entry) => entry.path === target && entry.state === 'invalid'),
            5_000,
          ),
        ).toBe(true);
        expect(services.watchingForDropIn, label).toBe(false);
        expect(services.polling, label).toBe(true);
      } finally {
        services.stop();
      }
    }
  });

  // Search-only (0100) lets the scan see the directory missing while `fs.watch` of the parent is
  // refused for want of read access. Root needs no read access, so it cannot be made to fail this way.
  test.skipIf(process.getuid?.() === 0)(
    'a watch that cannot be armed falls back to the poll and is logged once',
    async () => {
      const conf = workDir();
      const locked = join(conf, 'locked');
      mkdirSync(locked, { mode: 0o700 });
      const logged = spyOn(wireLogger, 'error');
      const topics = new TopicDeclarer('worker', nodeConfig.events, 50, join(locked, 'events.d'));
      const polls = spyOn(topics, 'refresh');
      chmodSync(locked, 0o100);
      try {
        topics.start();
        expect(await until(() => !topics.watchingForDropIn && topics.polling, 5_000)).toBe(true);
        const refusals = () =>
          logged.mock.calls.filter(([message]) =>
            String(message).includes('cannot watch for the drop-in directory'),
          );
        // Several polls meet the failed watch again; the log names it once.
        expect(await until(() => polls.mock.calls.length >= 4, 5_000)).toBe(true);
        expect(refusals()).toHaveLength(1);
        expect(topics.polling).toBe(true);
        chmodSync(locked, 0o700);
        mkdirSync(join(locked, 'events.d'), { mode: 0o700 });
        expect(await until(() => !topics.watchingForDropIn && topics.polling, 5_000)).toBe(true);
      } finally {
        chmodSync(locked, 0o700);
        topics.stop();
        logged.mockRestore();
      }
    },
  );
});
