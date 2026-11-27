import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EventDeclareSchema } from '../packages/contracts/src/protocol/topic.ts';
import { TopicDeclarer } from '../packages/runtime/src/node/topic-declarations.ts';

test('aggregate topic overflow is visible locally and broker receives a bounded complete replacement', async () => {
  const root = mkdtempSync('/tmp/wire-topic-total-');
  const firstPath = join(root, 'first.json'),
    secondPath = join(root, 'second.json');
  const paths = [firstPath, secondPath];
  const topics = (prefix: string, count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`owner.${prefix}.${index}`, { delivery: 'ordered' }]),
    );
  const sent: string[][] = [];
  const declarer = new TopicDeclarer('worker', { descriptors: paths, namespaces: { publish: ['owner.'] } });
  declarer.attach('lane', {
    connected: true,
    declareTopics: async (request) => {
      const parsed = EventDeclareSchema.parse(request);
      const accepted = Object.keys(parsed.topics);
      sent.push(accepted);
      return { accepted, refused: [] };
    },
  });
  try {
    writeFileSync(firstPath, JSON.stringify({ topics: { 'owner.removed': { delivery: 'ordered' } } }));
    writeFileSync(secondPath, JSON.stringify({ topics: {} }));
    await declarer.refresh();
    writeFileSync(firstPath, JSON.stringify({ topics: topics('a', 129) }));
    writeFileSync(secondPath, JSON.stringify({ topics: topics('b', 129) }));
    await declarer.refresh();
    expect(sent.at(-1)).toHaveLength(256);
    expect(sent.at(-1)).not.toContain('owner.removed');
    expect(declarer.snapshot().refused).toHaveLength(2);
    expect(declarer.snapshot().refused[0]?.detail).toContain('aggregate');
    writeFileSync(secondPath, JSON.stringify({ topics: topics('b', 127) }));
    await declarer.refresh();
    expect(sent.at(-1)).toHaveLength(256);
    expect(declarer.snapshot().refused).toEqual([]);
    writeFileSync(secondPath, JSON.stringify({ topics: topics('b', 1) }));
    await declarer.refresh();
    expect(sent.at(-1)).toHaveLength(130);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
