import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { z } from 'zod';
import {
  StallAuditWindow,
  StallAuditSchema,
  type StallAudit,
} from '../packages/runtime/src/broker/stall-audit.ts';
import { brokerConfig, brokerHealth, freePort, until } from './support.ts';

test('repeated smaller stalls remain visible across windows and quiet ticks flush', () => {
  const rows: StallAudit[] = [];
  const window = new StallAuditWindow('broker', (row) => rows.push(StallAuditSchema.parse(row)));
  const at = (ms: number) => new Date(ms).toISOString();
  window.observe(10000, 0, at(0));
  window.observe(2000, 100, at(100));
  expect(rows).toHaveLength(0);
  window.observe(1, 10000, at(10000));
  expect(rows[0]).toMatchObject({
    count: 2,
    delayMs: 10000,
    firstObservedAt: at(0),
    lastObservedAt: at(100),
  });
  window.observe(2000, 11000, at(11000));
  window.observe(1, 21000, at(21000));
  expect(rows[1]).toMatchObject({ count: 1, delayMs: 2000 });
  window.flush();
  expect(rows).toHaveLength(2);
});

test('storm is bounded, threshold inclusive, final shutdown aggregate retained', () => {
  const rows: StallAudit[] = [];
  const window = new StallAuditWindow('broker', (row) => rows.push(row));
  for (let i = 0; i < 1000; i++) window.observe(249, i, new Date(i).toISOString());
  expect(rows).toHaveLength(0);
  for (let i = 0; i < 1000; i++) window.observe(250, i * 100, new Date(i * 100).toISOString());
  expect(rows).toHaveLength(9);
  window.flush();
  expect(rows).toHaveLength(10);
  expect(rows.reduce((n, row) => n + row.count, 0)).toBe(1000);
  expect(rows.every((row) => row.delayMs === 250)).toBe(true);
  window.observe(0, 1e12, new Date(1e12).toISOString());
  expect(rows).toHaveLength(10);
});

test('managed broker shutdown writes a pending stall before closing its audit', async () => {
  const root = await mkdtemp('/tmp/wire-stall-shutdown-');
  const port = freePort();
  const broker = await startBroker(
    brokerConfig({ reader: 'r'.repeat(40) }, { port, auditPath: `${root}/audit.jsonl` }),
  );
  const delay = async () => (await brokerHealth(port)).transport.eventLoopDelay;
  try {
    // The stall is measured against the sampler's schedule, so it starts sampling first.
    expect(await until(async () => (await delay()).state === 'measured')).toBe(true);
    const stalledAt = new Date().toISOString();
    const stallEnd = performance.now() + 450;
    while (performance.now() < stallEnd) {
      /* deliberately stall this test runtime */
    }
    // The same sample that the health reports is the one the stall window holds.
    expect(await until(async () => ((await delay()).maxMs ?? 0) >= 250)).toBe(true);
    await broker.stop();
    const rows = (await readFile(`${root}/audit.jsonl`, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event);
    const stalls = rows
      .filter((row) => row.kind === 'event-loop-delay')
      .map((row) => StallAuditSchema.extend({ ts: z.iso.datetime() }).parse(row));
    // The row this test caused: the sampler is in the test's own process, so a slow tick of the
    // machine could add rows of its own, and only what was observed after the stall began is judged.
    const caused = stalls.filter((row) => row.lastObservedAt >= stalledAt);
    expect(caused.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...caused.map((row) => row.delayMs))).toBeGreaterThanOrEqual(250);
  } finally {
    await broker.stop();
    await rm(root, { recursive: true, force: true });
  }
});
