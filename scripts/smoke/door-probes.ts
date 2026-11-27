/**
 * What a release-smoke scenario asks of a running node through its door: a command, a stream, an
 * event and a resume, and the boot transition a restarting producer causes. Each probe throws when
 * the artifact answers anything else.
 */

import { z } from 'zod';
import { LOCAL_API_VERSION } from '../../packages/contracts/src/door/common.ts';
import {
  LocalEventDeliverySchema,
  LocalEventFrameSchema,
  LocalResultSchema,
  LocalStreamChunkSchema,
  LocalStreamEndSchema,
} from '../../packages/contracts/src/door/results.ts';
import { EventAckSchema } from '../../packages/contracts/src/protocol/event.ts';
import { until } from '../../test/support.ts';
import { EitherDoorResultSchema, localJson } from './harness.ts';

/** A door feed line, read only for the fields the probe prints. */
const FrameSchema = z.record(z.string(), z.unknown());

export async function rpc(socket: string, target: string, marker: string): Promise<void> {
  const result = EitherDoorResultSchema.parse(
    await localJson(socket, '/call', { to: target, argv: ['echo', marker], stdin: null, timeoutMs: 2_000 }),
  );
  if (result.failure !== 'none' || result.code !== 0 || result.stdout !== `${marker}\n`) {
    throw new Error('RPC probe failed');
  }
}

/** The all-new path additionally proves the new envelope really is on the wire, rather than the
 *  call merely succeeding the way it did before this release. */
export async function classifiedRpc(socket: string, target: string, marker: string): Promise<void> {
  await rpc(socket, target, marker);
  const refused = EitherDoorResultSchema.parse(
    await localJson(socket, '/call', {
      to: target,
      argv: ['not-in-allowlist'],
      stdin: null,
      timeoutMs: 2_000,
    }),
  );
  if (refused.failure !== 'denied' || refused.refusal !== 'policy') {
    throw new Error(`all-new refusal was not classified: ${refused.failure}/${refused.refusal}`);
  }
  // The door answers with the LOCAL contract version, deliberately not the wire's: a neighbour on
  // the socket is not a participant on the wire and must not move when the protocol does.
  const result = LocalResultSchema.parse(refused);
  if (result.v !== LOCAL_API_VERSION) throw new Error('the local door did not answer its own version');
}

export async function waitRpc(socket: string, target: string, marker: string): Promise<void> {
  const recovered = await until(
    async () => {
      try {
        await rpc(socket, target, marker);
        return true;
      } catch {
        return false;
      }
    },
    undefined,
    100,
  );
  if (!recovered) throw new Error('RPC did not recover after broker restart');
}

export async function stream(socket: string, target: string): Promise<void> {
  const response = await fetch('http://localhost/wire/stream', {
    unix: socket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: target, profile: 'fixed', args: [], stdin: null, cursor: null }),
  });
  if (!response.ok) throw new Error('stream conformance probe was refused');
  const lines = (await response.text()).trim().split('\n');
  const first = lines[0];
  const last = lines.at(-1);
  if (first === undefined || last === undefined) throw new Error('stream probe returned no frames');
  const chunk = LocalStreamChunkSchema.parse(JSON.parse(first));
  const end = LocalStreamEndSchema.parse(JSON.parse(last));
  if (Buffer.from(chunk.data, 'base64').toString() !== 'mixed-stream' || end.reason !== 'completed') {
    throw new Error('stream conformance payload or terminal was wrong');
  }
}

export async function event(publisherSocket: string, subscriberSocket: string): Promise<void> {
  const subscriptionResponse = fetch('http://localhost/wire/events/subscribe', {
    unix: subscriberSocket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'generic.release' }),
  });
  const bootId = crypto.randomUUID();
  const response = await subscriptionResponse;
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error('event subscription returned no body');
  // The door opens the response with a keep-alive blank line and repeats it while the topic is
  // quiet, so a reader that treats the first bytes as a frame is testing a contract nobody offers.
  const decoder = new TextDecoder();
  let line: string | undefined;
  const reading = (async () => {
    let buffered = '';
    while (line === undefined) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('event subscription returned no frame');
      buffered += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const candidate = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (candidate !== '') {
          line = candidate;
          break;
        }
      }
    }
  })();
  // The response headers are flushed before the broker registers the subscription, so they do not
  // say it is live. The probe publishes until the feed carries a frame; a publication made before
  // the subscription existed is simply not delivered, and the next one is.
  let seq = 0;
  const heard = await until(
    async () => {
      const ack = EventAckSchema.parse(
        await localJson(publisherSocket, '/events/publish', {
          topic: 'generic.release',
          bootId,
          seq: seq++,
          observedAt: null,
          cursor: 'provenance-only',
          data: 'mixed-event',
        }),
      );
      if (!ack.ok) throw new Error('event publish conformance probe was refused');
      return line !== undefined;
    },
    10_000,
    100,
  );
  try {
    if (!heard) throw new Error('event subscription delivered no frame');
    await reading;
  } finally {
    await reader.cancel();
  }
  if (line === undefined) throw new Error('event subscription returned no frame');
  const delivered = LocalEventFrameSchema.parse(JSON.parse(line));
  if (delivered.bootId !== bootId || Buffer.from(delivered.data, 'base64').toString() !== 'mixed-event') {
    throw new Error('event conformance payload was wrong');
  }
}

/**
 * The headline of 0.11.0, over a real wire rather than in a unit test: a subscriber that says where
 * it stopped is answered before anything else arrives.
 *
 * Both halves are asserted because either alone would be misleading. A retaining topic must hand
 * back the frames it still holds; a volatile one must name the loss with reason `resume` and do it
 * WITHOUT a further publish, since answering only when the topic next speaks is precisely the old
 * behaviour this release replaces.
 */
export async function resumeAfterAbsence(publisherSocket: string, subscriberSocket: string): Promise<void> {
  const bootId = crypto.randomUUID();
  for (const topic of ['generic.release', 'volatile.release']) {
    for (const seq of [0, 1, 2]) {
      const ack = EventAckSchema.parse(
        await localJson(publisherSocket, '/events/publish', {
          topic,
          bootId,
          seq,
          observedAt: null,
          cursor: null,
          data: `${topic}-${seq}`,
        }),
      );
      if (!ack.ok) throw new Error(`resume probe could not publish ${topic} ${seq}: ${ack.detail}`);
    }
  }

  const answer = async (topic: string, afterSeq: number): Promise<string[]> => {
    const response = await fetch('http://localhost/wire/events/subscribe', {
      unix: subscriberSocket,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic, resume: { bootId, afterSeq } }),
    });
    if (!response.ok) throw new Error(`resume subscribe on ${topic} returned HTTP ${response.status}`);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('resume subscription returned no body');
    const decoder = new TextDecoder();
    const seen: string[] = [];
    let buffered = '';
    const deadline = Date.now() + 2_000;
    try {
      while (Date.now() < deadline && seen.length < 2) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(400).then(() => null)]);
        if (chunk === null) break;
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        for (;;) {
          const newline = buffered.indexOf('\n');
          if (newline < 0) break;
          const line = buffered.slice(0, newline).trim();
          buffered = buffered.slice(newline + 1);
          if (line === '') continue;
          const frame = FrameSchema.parse(JSON.parse(line));
          if (frame.failure !== undefined) {
            throw new Error(`subscription on ${topic} was refused: ${String(frame.detail)}`);
          }
          seen.push(
            frame.reason === undefined ? `event:${String(frame.seq)}` : `gap:${String(frame.reason)}`,
          );
        }
      }
    } finally {
      await reader.cancel();
    }
    return seen;
  };

  const retained = await answer('generic.release', 0);
  if (retained.join(',') !== 'event:1,event:2') {
    throw new Error(`retaining topic did not replay the missed frames: ${retained.join(',') || 'nothing'}`);
  }
  const volatileAnswer = await answer('volatile.release', 0);
  if (volatileAnswer[0] !== 'gap:resume') {
    throw new Error(`volatile topic did not name the loss: ${volatileAnswer.join(',') || 'nothing'}`);
  }
}

export async function bootTransitionDoor(socket: string): Promise<void> {
  const response = await fetch('http://localhost/wire/events/subscribe', {
    unix: socket,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ topic: 'boot.release' }),
  });
  if (!response.ok || !response.body) throw new Error('boot subscription failed');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  const read = async () => {
    for (;;) {
      const end = buffer.indexOf('\n');
      if (end >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (line) return LocalEventDeliverySchema.parse(JSON.parse(line));
        continue;
      }
      const part = await Promise.race([reader.read(), Bun.sleep(2_000).then(() => null)]);
      if (!part || part.done) throw new Error('boot transition wedged the existing Unix subscription');
      buffer += decoder.decode(part.value, { stream: true });
    }
  };
  const publish = async (bootId: string, seq: number) =>
    EventAckSchema.parse(
      await localJson(socket, '/events/publish', {
        topic: 'boot.release',
        bootId,
        seq,
        data: '{}',
      }),
    );
  try {
    const old = crypto.randomUUID(),
      next = crypto.randomUUID();
    if (!(await publish(old, 9)).ok) throw new Error('boot baseline not accepted');
    const initial = await read();
    if (!('bootId' in initial) || initial.bootId !== old) throw new Error('old boot missing');
    if ((await publish(old, 10)).ok) throw new Error('local-ahead fixture did not refuse broker publish');
    const ahead = await read();
    if (!('seq' in ahead) || ahead.seq !== 10) throw new Error('local ahead frame missing');
    if (!(await publish(next, 0)).ok) throw new Error('replacement boot refused');
    const boundary = await read();
    if (!('reason' in boundary) || boundary.reason !== 'boot-change' || boundary.nextBootId !== next)
      throw new Error('named boot boundary missing');
    const frame = await read();
    if (!('seq' in frame) || frame.bootId !== next || frame.seq !== 0)
      throw new Error('replacement boot did not reach existing reader');
  } finally {
    await reader.cancel();
  }
}
