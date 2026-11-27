import { expect, test } from 'bun:test';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import { eventSequence } from '../packages/local-client/src/event-sequence.ts';
import { readEventItem } from '../packages/local-client/src/readers.ts';

const bootId = crypto.randomUUID();
const nextBootId = crypto.randomUUID();
const base = {
  v: LOCAL_API_VERSION,
  subscriptionId: crypto.randomUUID(),
  topic: 'example.events',
  producer: 'worker',
  bootId,
};
const event = (seq: number, boot = bootId) => ({
  ...base,
  bootId: boot,
  seq,
  observedAt: null,
  cursor: null,
  encoding: 'base64',
  data: 'e30=',
  bytes: 2,
});
const gap = (fromSeq: number, toSeq: number, reason = 'overflow') => ({ ...base, fromSeq, toSeq, reason });
const transition = { ...gap(500, 500, 'boot-change'), nextBootId };

test('live, resumed, empty-broker and successor feeds have explicit bounded floors', () => {
  const cases = [
    { resume: undefined, frames: [event(40), event(41), gap(42, 45), event(46)] },
    { resume: { bootId, afterSeq: 8 }, frames: [event(9), event(10)] },
    { resume: { bootId, afterSeq: 8 }, frames: [gap(9, 19, 'retention'), event(20)] },
    { resume: { bootId, afterSeq: 8 }, frames: [gap(8, 8, 'resume'), event(9)] },
    { resume: { bootId, afterSeq: 8 }, frames: [transition, event(90, nextBootId), event(91, nextBootId)] },
    { resume: undefined, frames: [event(0), transition, gapForSuccessor(), event(7, nextBootId)] },
    { resume: undefined, frames: [event(0), transition, event(0, nextBootId)] },
    { resume: undefined, frames: [event(0), gap(0, 0, 'resume'), event(1), gap(0, 0, 'resume'), event(2)] },
    { resume: undefined, frames: [event(40), transition, event(41), event(0, nextBootId)] },
    {
      resume: undefined,
      frames: [event(0), transition, { ...transition, bootId: nextBootId, nextBootId: crypto.randomUUID() }],
    },
  ];
  for (const { resume, frames } of cases) {
    const validate = eventSequence(base.topic, resume);
    for (const frame of frames) expect<unknown>(validate(readEventItem(frame)).frame).toEqual(frame);
  }
});
function gapForSuccessor() {
  return { ...gap(4, 6, 'latest-wins'), bootId: nextBootId };
}

test('duplicate, skipped, foreign identity and unnamed boot transitions fail closed', () => {
  for (const frames of [
    [event(10), event(10)],
    [event(10), event(12)],
    [event(10), event(0, nextBootId)],
    [event(10), gap(12, 14)],
    [event(10), { ...event(11), producer: 'other' }],
    [event(10), { ...event(11), subscriptionId: crypto.randomUUID() }],
    [event(10), { ...event(11), topic: 'other' }],
    [event(10), { ...transition, bootId: crypto.randomUUID() }],
    [event(10), { ...gap(11, 12), nextBootId }],
    [event(10), { ...transition, nextBootId: bootId }],
    [event(10), { ...gap(11, 12, 'boot-change') }],
    [event(10), gap(12, 11)],
  ]) {
    const validate = eventSequence(base.topic);
    expect(() => {
      for (const frame of frames) validate(readEventItem(frame));
    }).toThrow();
  }
  const validate = eventSequence(base.topic, { bootId, afterSeq: 10 });
  expect(() => validate(readEventItem(event(10)))).toThrow();
});
