import assert from 'node:assert/strict';
import type { WireClient } from '../packages/local-client/src/client.ts';
import type { EventItem } from '../packages/local-client/src/readers.ts';

/** One admitted feed, held across other owners' configuration changes; no reopen or retained proof. */
export async function enrollmentEvents(reader: WireClient, publisher: WireClient, topic: string) {
  const feed = reader.subscribe({ topic, lifecycle: true });
  let subscriptionId: string | undefined;
  // A ceiling for missing delivery, not a startup delay. Timeout permanently closes this feed.
  async function next(): Promise<EventItem> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const item = await Promise.race([
        feed.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            feed.close();
            reject(new Error('enrollment subscription timed out'));
          }, 10_000);
        }),
      ]);
      assert(!item.done, 'subscription ended');
      assert(item.value.kind !== 'error', `subscription refused: ${JSON.stringify(item.value)}`);
      return item.value;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    for (;;) {
      const item = await next();
      if (item.kind === 'subscription' && item.frame.subscriptionState === 'ready') {
        subscriptionId = item.frame.subscriptionId;
        break;
      }
    }
  } catch (error) {
    feed.close();
    throw error;
  }
  const bootId = crypto.randomUUID();
  let seq = 0;
  return {
    feed,
    async deliver() {
      const data = crypto.randomUUID();
      const published = await publisher.publish({ topic, bootId, seq, data });
      assert(published.ok, `event refused: ${JSON.stringify(published)}`);
      for (;;) {
        const item = await next();
        if (item.kind === 'subscription')
          assert(item.frame.subscriptionState === 'ready', 'the existing subscription was reopened');
        if (item.kind !== 'event') continue;
        assert.equal(item.frame.subscriptionId, subscriptionId);
        assert.equal(item.frame.topic, topic);
        assert.equal(item.frame.bootId, bootId);
        assert.equal(item.frame.seq, seq++);
        assert.equal(new TextDecoder().decode(item.data), data);
        return item;
      }
    },
  };
}
