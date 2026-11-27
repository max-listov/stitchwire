import { expect, spyOn, test } from 'bun:test';
import { laneCodec } from '../packages/runtime/src/transport/lane-codec.ts';
import {
  LaneVolumeMeter,
  laneVolumeRows,
  LaneVolumeSchema,
  MAX_LANE_VOLUME_BATCH_ROWS,
  type LaneVolume,
  type LaneVolumeRow,
} from '../packages/runtime/src/transport/lane-volume.ts';

function frame(event: string, value: unknown) {
  return new laneCodec.Encoder().encode({ type: 2, nsp: '/', data: [event, value] })[0];
}

test('quiet connections flush on schedule, with no new traffic required', () => {
  const clock = spyOn(Date, 'now').mockReturnValue(100000);
  try {
    const rows: LaneVolumeRow[] = [];
    const meter = new LaneVolumeMeter((batch) => rows.push(...laneVolumeRows(batch)));
    meter.record('connection', 'reader', 'out', frame('value', {}));
    meter.flushDue();
    expect(rows).toHaveLength(0);
    clock.mockReturnValue(159999);
    meter.flushDue();
    expect(rows).toHaveLength(0);
    clock.mockReturnValue(160000);
    meter.flushDue();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.frames).toBe(1);
  } finally {
    clock.mockRestore();
  }
});

test('compact batches preserve every route and exact timestamps, stay bounded and contain no packet bodies', () => {
  const clock = spyOn(Date, 'now').mockReturnValue(100000);
  const batches: LaneVolume[] = [];
  try {
    const meter = new LaneVolumeMeter((batch) => batches.push(LaneVolumeSchema.parse(batch)));
    for (let i = 0; i < 140; i++)
      meter.record(
        'connection',
        'worker',
        'out',
        frame('event:event', { topic: `example.${i}`, body: 'private-body' }),
      );
    clock.mockReturnValue(101234);
    meter.record(
      'connection',
      'worker',
      'out',
      frame('event:event', { topic: 'example.0', body: 'private-body' }),
    );
    meter.flush();
    expect(batches).toHaveLength(3);
    // Journal timestamps belong to the writer envelope, not to the metric payload schema.
    expect(LaneVolumeSchema.safeParse({ ...batches[0], ts: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
    expect(batches.every((batch) => batch.rows.length <= MAX_LANE_VOLUME_BATCH_ROWS)).toBe(true);
    const rows = batches.flatMap(laneVolumeRows);
    expect(rows).toHaveLength(140);
    expect(new Set(rows.map((row) => row.topic)).size).toBe(140);
    expect(rows.reduce((n, row) => n + row.frames, 0)).toBe(141);
    expect(rows.find((row) => row.topic === 'example.0')).toMatchObject({
      frames: 2,
      startedAt: '1970-01-01T00:01:40.000Z',
      endedAt: '1970-01-01T00:01:41.234Z',
    });
    expect(JSON.stringify(batches)).not.toContain('private-body');
    expect(
      LaneVolumeSchema.safeParse({ kind: 'lane-volume', connection: 'c', nodeId: 'n', rows: [] }).success,
    ).toBe(false);
    expect(LaneVolumeSchema.safeParse({ ...batches[0], rows: Array(65).fill(rows[0]) }).success).toBe(false);
  } finally {
    clock.mockRestore();
  }
});

test('group bound flushes without losing counters and equal IDs on different connections stay separate', () => {
  const rows: LaneVolumeRow[] = [];
  const meter = new LaneVolumeMeter((batch) => rows.push(...laneVolumeRows(batch)));
  for (let i = 0; i < 1050; i++)
    meter.record('connection', 'worker', 'in', frame('event:event', { topic: `example.${i}` }));
  expect(rows).toHaveLength(1024);
  meter.flush();
  expect(rows.reduce((count, row) => count + row.frames, 0)).toBe(1050);
  for (const service of ['example.first', 'example.second']) {
    meter.record(service, 'worker', 'in', frame('service:call', { id: 'same-id', service }));
  }
  for (const service of ['example.first', 'example.second']) {
    meter.record(service, 'worker', 'out', frame('service:result', { id: 'same-id' }));
  }
  meter.flush();
  const responses = rows.filter((row) => row.event === 'service:result');
  expect(responses).toHaveLength(2);
  for (const row of responses) expect(row.service).toBe(row.connection);
});
