import { z } from 'zod';
import type { Socket } from 'socket.io';
import { MAX_STREAM_TIMEOUT_MS } from '../../../contracts/src/protocol/bounds.ts';
import { laneFrameFacts, type LaneFrameFacts } from './lane-codec.ts';

const LaneVolumeRowSchema = z.object({
  connection: z.string(),
  nodeId: z.string(),
  direction: z.enum(['in', 'out']),
  event: z.string(),
  service: z.string().nullable(),
  topic: z.string().nullable(),
  frames: z.number().int().nonnegative(),
  compressedFrames: z.number().int().nonnegative(),
  encodedBytes: z.number().int().nonnegative(),
  decodedBytes: z.number().int().nonnegative(),
  startedAt: z.string(),
  endedAt: z.string(),
});
export type LaneVolumeRow = z.infer<typeof LaneVolumeRowSchema>;
export const MAX_LANE_VOLUME_BATCH_ROWS = 64;
export const LaneVolumeSchema = z.object({
  kind: z.literal('lane-volume'),
  connection: z.string(),
  nodeId: z.string(),
  rows: z
    .array(LaneVolumeRowSchema.omit({ connection: true, nodeId: true }))
    .min(1)
    .max(MAX_LANE_VOLUME_BATCH_ROWS),
});
export type LaneVolume = z.infer<typeof LaneVolumeSchema>;
export function laneVolumeRows(volume: LaneVolume): LaneVolumeRow[] {
  return volume.rows.map((row) => ({ connection: volume.connection, nodeId: volume.nodeId, ...row }));
}
type PendingRow = Omit<LaneVolumeRow, 'startedAt' | 'endedAt'> & { startedAt: number; endedAt: number };
type Route = { service: string; expires: number };
const MAX_GROUPS = 1024;
const MAX_ROUTES = 4096;
/** Packet counts are written to the journal at most once a minute. */
const LANE_VOLUME_FLUSH_MS = 60_000;
/** A call's later frames name only its id; its service is remembered for as long as the longest
 *  stream can live, plus one flush window so the last rows of a stream are still attributed. */
const ROUTE_TTL_MS = MAX_STREAM_TIMEOUT_MS + LANE_VOLUME_FLUSH_MS;

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 128 ? value : null;
}

/** Bounded, periodic packet accounting. Payload content never enters the journal. */
export class LaneVolumeMeter {
  private readonly groups = new Map<string, PendingRow>();
  private readonly routes = new Map<string, Route>();
  private flushedAt = Date.now();
  constructor(private readonly write: (volume: LaneVolume) => void) {}

  flushDue(): void {
    if (Date.now() - this.flushedAt >= LANE_VOLUME_FLUSH_MS) this.flush();
  }

  record(connection: string, nodeId: string, direction: 'in' | 'out', frame: unknown): void {
    const facts = laneFrameFacts(frame);
    if (facts !== undefined) this.recordFacts(connection, nodeId, direction, facts);
  }

  private recordFacts(
    connection: string,
    nodeId: string,
    direction: 'in' | 'out',
    facts: LaneFrameFacts,
  ): void {
    const now = Date.now();
    if (now - this.flushedAt >= LANE_VOLUME_FLUSH_MS) this.flush();
    const data = facts.packet.data;
    const event =
      facts.packet.type === 2 && Array.isArray(data) ? text(data[0]) : `socket:${facts.packet.type}`;
    if (event === null) return;
    const payload: unknown = Array.isArray(data) ? data[1] : undefined;
    const routePayload: unknown = field(payload, 'open') ?? payload;
    const id = text(field(routePayload, 'id')) ?? text(field(routePayload, 'streamId'));
    const routeKey = id === null ? null : JSON.stringify([connection, id]);
    let service = text(field(routePayload, 'service'));
    if (service === null) service = text(field(field(routePayload, 'source'), 'service'));
    if (routeKey !== null && service !== null) {
      if (this.routes.size >= MAX_ROUTES) {
        const oldest = this.routes.keys().next().value;
        if (oldest !== undefined) this.routes.delete(oldest);
      }
      this.routes.set(routeKey, { service, expires: now + ROUTE_TTL_MS });
    }
    if (routeKey !== null && service === null) {
      const route = this.routes.get(routeKey);
      if (route !== undefined && route.expires > now) service = route.service;
    }
    const topic = text(field(payload, 'topic'));
    const key = JSON.stringify([connection, nodeId, direction, event, service, topic]);
    if (!this.groups.has(key) && this.groups.size >= MAX_GROUPS) this.flush();
    const row =
      this.groups.get(key) ??
      ({
        connection,
        nodeId,
        direction,
        event,
        service,
        topic,
        frames: 0,
        compressedFrames: 0,
        encodedBytes: 0,
        decodedBytes: 0,
        startedAt: now,
        endedAt: now,
      } satisfies PendingRow);
    row.frames += 1;
    row.compressedFrames += Number(facts.compressed);
    row.encodedBytes += facts.encodedBytes;
    row.decodedBytes += facts.decodedBytes;
    row.endedAt = now;
    this.groups.set(key, row);
  }

  flush(): void {
    const batches = new Map<string, LaneVolume>();
    for (const row of this.groups.values()) {
      const key = JSON.stringify([row.connection, row.nodeId]);
      let batch = batches.get(key);
      if (batch === undefined) {
        batch = { kind: 'lane-volume', connection: row.connection, nodeId: row.nodeId, rows: [] };
        batches.set(key, batch);
      }
      const { connection: _connection, nodeId: _nodeId, startedAt, endedAt, ...counts } = row;
      batch.rows.push({
        ...counts,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
      });
      if (batch.rows.length === MAX_LANE_VOLUME_BATCH_ROWS) {
        this.write(batch);
        batches.delete(key);
      }
    }
    for (const batch of batches.values()) this.write(batch);
    this.groups.clear();
    this.flushedAt = Date.now();
    for (const [id, route] of this.routes) if (route.expires <= this.flushedAt) this.routes.delete(id);
  }
}

export function observeLaneVolume(
  connection: string,
  nodeId: string,
  conn: Socket['conn'],
  meter: LaneVolumeMeter,
): () => void {
  // Socket.IO's decoder consumes `data` before this listener; `packet` precedes decoding.
  const incoming = (data: unknown) => meter.record(connection, nodeId, 'in', data);
  const outgoing = (packet: { type: string; data?: unknown }) => {
    if (packet.type === 'message') meter.record(connection, nodeId, 'out', packet.data);
  };
  conn.on('data', incoming);
  conn.on('packetCreate', outgoing);
  return () => {
    conn.off('data', incoming);
    conn.off('packetCreate', outgoing);
    meter.flush();
  };
}
