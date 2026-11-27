import { expect, test } from 'bun:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandler } from 'stitchkit/server';
import { createHandlerTestClient } from 'stitchkit/testing';
import { createAudit } from '../packages/runtime/src/broker/audit.ts';
import {
  publicationTrace,
  PublicationTraceSchema,
  publicationRequestObserver,
} from '../packages/runtime/src/node/publication-trace.ts';
import { createEventDoorService } from '../packages/runtime/src/node/event-local.ts';
import { eventDoorContract } from '../packages/contracts/src/door/streams.ts';
import { LocalEventPublishSchema } from '../packages/contracts/src/door/requests.ts';

test('publication evidence retains tuple and stages but never payload or cursor; journal is bounded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wire-trace-'));
  const path = join(directory, 'trace.jsonl');
  const audit = await createAudit(path, 256, { maxBytes: 1024, keep: 2 });
  const trace = publicationTrace(audit, 'worker');
  const request = LocalEventPublishSchema.parse({
    topic: 'generic.events',
    bootId: crypto.randomUUID(),
    seq: 7,
    data: 'PRIVATE-PAYLOAD-SENTINEL',
    cursor: 'PRIVATE-CURSOR-SENTINEL',
  });
  for (let index = 0; index < 12; index++)
    trace(request, 'lane-result', { lane: 'primary', elapsedMs: 12, outcome: 'accepted' });
  await audit.flush();
  const status = audit.status();
  expect(status.journal.rotations).toBeGreaterThan(0);
  expect(status.journal.generations).toBeLessThanOrEqual(2);
  expect(status.journal.bytes).toBeLessThanOrEqual(1024);
  expect(status.dropped + status.writeFailures).toBe(0);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await audit.close();
  const bytes = await readFile(path, 'utf8');
  expect(bytes).not.toContain('PRIVATE-');
  // Records are framed by the journal now: `{ schemaVersion, epoch, sequence, event }`. The event
  // is what this project writes; the frame is what makes the file ordered and resumable.
  const parsed = PublicationTraceSchema.strip().parse(
    JSON.parse(bytes.trim().split('\n')[0] ?? 'null').event,
  );
  expect(parsed).toMatchObject({
    producer: 'worker',
    topic: request.topic,
    bootId: request.bootId,
    seq: 7,
    phase: 'lane-result',
  });
});

test('request observer is absent without tracing and snapshots only bounded tuple metadata', async () => {
  expect(
    publicationRequestObserver(
      undefined,
      { topic: 'example.feed', bootId: crypto.randomUUID(), seq: 1 },
      'primary',
    ),
  ).toBeUndefined();
  const directory = await mkdtemp(join(tmpdir(), 'wire-phase-bound-'));
  const path = join(directory, 'audit.jsonl');
  const audit = await createAudit(path, 1, { maxBytes: 1024, keep: 1 });
  const request = { topic: 'example.feed', bootId: crypto.randomUUID(), seq: 1, data: 'PAYLOAD-SENTINEL' };
  const observer = publicationRequestObserver(publicationTrace(audit, 'worker'), request, 'primary');
  request.seq = 99;
  const phase = {
    requestId: crypto.randomUUID(),
    event: 'event:publish',
    phase: 'engine-handoff',
    elapsedMs: 0,
  } satisfies import('stitchkit').RealtimeRequestPhaseEvent;
  observer?.(phase);
  observer?.(phase);
  expect(audit.status().queued).toBe(1);
  expect(audit.status().dropped).toBe(1);
  await audit.flush();
  await audit.close();
  const bytes = await readFile(path, 'utf8');
  expect(bytes).not.toContain('PAYLOAD-SENTINEL');
  expect(JSON.parse(bytes).event).toMatchObject({
    seq: 1,
    requestId: phase.requestId,
    phase: 'engine-handoff',
    outcome: 'pending',
  });
});

test('door trace reports response readiness, not receipt, and records departure as observed', async () => {
  const phases: Array<{ phase: string; outcome?: string; callerAborted?: boolean }> = [];
  const service = createEventDoorService(
    {
      publishEvent: async () => ({
        ok: true,
        failure: 'none',
        refusal: 'none',
        retryAfterMs: null,
        transportCause: null,
        detail: '',
      }),
      subscribeEvents: async function* () {},
    },
    (_request, phase, fields) => phases.push({ phase, ...fields }),
  );
  // In-process through the framework's own test transport: the door is exercised as the declared
  // service it now is, with the real composed path, and without a socket. An earlier shape of this
  // test started a real unix server, which cost the suite twelve seconds and made neighbouring
  // timing-sensitive tests miss their windows — a test that destabilises its neighbours is not
  // paying for itself.
  const client = createHandlerTestClient({
    contract: eventDoorContract,
    handler: createHandler({ services: [service] }),
  });
  const ack = await client.publish({
    topic: 'generic.events',
    bootId: crypto.randomUUID(),
    seq: 0,
    data: '{}',
  });
  expect(ack.ok).toBe(true);
  // `callerAborted` records what the door had observed when the response was ready. Nobody left
  // here, so it is false. The previous shape asserted `true`, which was an artefact of invoking a
  // raw handler with the CLIENT's own signal rather than the one the door receives.
  expect(phases).toMatchObject([
    { phase: 'door-received' },
    { phase: 'door-response-ready', outcome: 'accepted', callerAborted: false },
  ]);
});
