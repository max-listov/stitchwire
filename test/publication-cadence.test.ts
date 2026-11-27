import { expect, test } from 'bun:test';
import { PublicationCadence } from '../packages/runtime/src/broker/publication-cadence.ts';
import { TopicDeclarationSchema } from '../packages/contracts/src/protocol/topic.ts';
import { topicSilenceState, topicSilenceThreshold } from '../packages/runtime/src/topic-silence.ts';

test('cadence uses actual observed span, ages out and is bounded to sixty minute buckets', () => {
  const c = new PublicationCadence();
  const at = 1_800_000;
  expect(c.read(at)).toEqual({ count: 0, windowMs: 0 });
  c.record(at + 55_000);
  c.record(at + 56_000);
  c.record(at + 57_000);
  expect(c.read(at + 57_000)).toEqual({ count: 3, windowMs: 2_000 });
  expect(topicSilenceThreshold(c.read(at + 57_000))).toBe(60_000);
  expect(c.read(at + 57_000 + 120_000)).toEqual({ count: 3, windowMs: 2_000 });
  expect(topicSilenceThreshold({ count: 4, windowMs: 60_000 })).toBe(100_000);
  expect(topicSilenceThreshold({ count: 1, windowMs: 60_000 })).toBe(1_800_000);
  for (let i = 1; i <= 120; i++) c.record(at + i * 60_000);
  expect(c.read(at + 120 * 60_000).count).toBe(60);
  expect(c.read(at + 181 * 60_000)).toEqual({ count: 0, windowMs: 0 });
});

test('on-change bursts do not invent a periodic heartbeat; absent policy is explicit', () => {
  const observation = {
    publisherLive: true,
    sinceLastPublishMs: 560_337,
    cadence: { count: 3, windowMs: 74_804 },
  };
  expect(topicSilenceState({ ...observation, publicationMode: 'on-change' })).toBe('on-change');
  expect(topicSilenceState({ ...observation, publicationMode: 'periodic' })).toBe('silent');
  expect(topicSilenceState(observation)).toBe('unknown-policy');
  expect(topicSilenceState({ ...observation, publicationMode: 'unknown' })).toBe('unknown-policy');
  expect(topicSilenceState({ ...observation, publisherLive: false })).toBe('not-live');
  expect(topicSilenceState({ ...observation, publicationMode: 'periodic', sinceLastPublishMs: 50 })).toBe(
    'flowing',
  );
  expect(topicSilenceState({ ...observation, publicationMode: 'periodic', sinceLastPublishMs: null })).toBe(
    'silent',
  );
});

test('publication obligation is declared, never inferred from delivery mode or topic name', () => {
  const topic = { producer: 'worker', subscribers: ['reader'], delivery: 'ordered' };
  const modes: Array<'periodic' | 'on-change'> = ['periodic', 'on-change'];
  for (const publicationMode of modes) {
    const parsed = TopicDeclarationSchema.parse({ ...topic, publicationMode });
    expect(parsed.publicationMode).toBe(publicationMode);
  }
  const parsed = TopicDeclarationSchema.parse(topic);
  expect(parsed.publicationMode).toBeUndefined();
  expect(TopicDeclarationSchema.safeParse({ ...topic, publicationMode: 'guessed' }).success).toBe(false);
});
