import { expect, test } from 'bun:test';
import { MAX_DECLARED_TOPICS, TopicDescriptorSchema } from '../packages/contracts/src/protocol/topic.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planTopicDeclarations, TopicDeclarer } from '../packages/runtime/src/node/topic-declarations.ts';

const { topics: parsed } = TopicDescriptorSchema.parse({
  topics: { 'owner.sample': { delivery: 'ordered' } },
});
const topic = Object.values(parsed)[0];
if (topic === undefined) throw new Error('the sample topic parses');

test('one policy decides which declared topics a node announces, for the agent and for enrollment', () => {
  const first = {
    path: '/owner/first.json',
    topics: { 'owner.a': topic, 'other.x': topic, 'owner.fleet': topic },
  };
  const second = { path: '/owner/second.json', topics: { 'owner.a': topic, 'owner.b': topic } };
  const plan = planTopicDeclarations([first, second], ['owner.'], ['owner.fleet']);
  expect(Object.keys(plan.topics)).toEqual(['owner.a', 'owner.b']);
  expect(plan.refused).toEqual([
    { topic: 'other.x', detail: 'outside the namespaces this node may publish in (/owner/first.json)' },
    { topic: 'owner.fleet', detail: "declared by this node's configuration and again by /owner/first.json" },
    { topic: 'owner.a', detail: 'declared by /owner/first.json and again by /owner/second.json' },
  ]);
  // Without the fleet's own topics the same name is announced: the control that the seed matters.
  expect(Object.keys(planTopicDeclarations([first], ['owner.']).topics)).toEqual(['owner.a', 'owner.fleet']);
});

test('the aggregate limit keeps the first names and refuses the rest by name', () => {
  const names = Array.from(
    { length: MAX_DECLARED_TOPICS + 2 },
    (_, index) => `owner.t${String(index).padStart(4, '0')}`,
  );
  const plan = planTopicDeclarations(
    [{ path: '/owner/many.json', topics: Object.fromEntries(names.map((name) => [name, topic])) }],
    ['owner.'],
  );
  expect(Object.keys(plan.topics)).toHaveLength(MAX_DECLARED_TOPICS);
  expect(plan.refused.map((refusal) => refusal.topic)).toEqual(names.slice(MAX_DECLARED_TOPICS));
  expect(plan.refused[0]?.detail).toContain(`${MAX_DECLARED_TOPICS}-topic limit`);
});

test('the agent reports for one file what enrollment refuses it for', async () => {
  // Enrollment refuses these three names as `declaration-invalid` (test/enrollment-controls/
  // binding-refusals.ts); the running agent reads the same files and must name the same refusals.
  const root = mkdtempSync(join(tmpdir(), 'wire-topic-policy-'));
  const write = (name: string, topics: string[]) => {
    const path = join(root, name);
    writeFileSync(
      path,
      JSON.stringify({ topics: Object.fromEntries(topics.map((topic) => [topic, { delivery: 'ordered' }])) }),
    );
    return path;
  };
  try {
    const first = write('first.json', ['owner.a']);
    const second = write('second.json', ['outside.x', 'owner.fleet', 'owner.a', 'owner.b']);
    const declarer = new TopicDeclarer('producer', {
      descriptors: [first, second],
      namespaces: { publish: ['owner.'] },
      publish: ['owner.fleet'],
    });
    await declarer.refresh();
    expect(declarer.snapshot().refused).toEqual(
      planTopicDeclarations(
        [
          { path: first, topics: { 'owner.a': topic } },
          {
            path: second,
            topics: { 'outside.x': topic, 'owner.fleet': topic, 'owner.a': topic, 'owner.b': topic },
          },
        ],
        ['owner.'],
        ['owner.fleet'],
      ).refused,
    );
    expect(declarer.snapshot().refused.map((refusal) => refusal.topic)).toEqual([
      'outside.x',
      'owner.a',
      'owner.fleet',
    ]);
    // Negative control: without the node's own topic the agent, too, announces that name.
    const unseeded = new TopicDeclarer('producer', {
      descriptors: [second],
      namespaces: { publish: ['owner.'] },
    });
    await unseeded.refresh();
    expect(unseeded.snapshot().refused.map((refusal) => refusal.topic)).toEqual(['outside.x']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
