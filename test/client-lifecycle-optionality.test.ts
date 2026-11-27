/**
 * Whoever did not ask for the lifecycle does not parse it, and this is checked in both directions.
 *
 * `EventItem` grew from three kinds to four in a PATCH release of the client: `subscription` was added.
 * The frames are opt-in — only a request with `lifecycle` produces them — so the union shifted even for
 * consumers who never enabled that capability and cannot receive such a frame in principle. A consumer
 * found this by comparing two `.d.ts` files side by side; in one of its four parsing sites the branch
 * "anything that is not an event and not a gap is a refusal" would have sent the new frame into a lane
 * refusal.
 *
 * Two tests below. The first is about types: five cases, two of which must WIDEN, because they cannot
 * be narrowed without lying about the runtime. The second is about the narrowing being correct by
 * construction, not by agreement with the server.
 */

import { expect, test } from 'bun:test';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';
import { createWireClient } from '../packages/client/src/index.ts';
import type { SubscribeRequest } from '../packages/client/src/index.ts';
import { WireClientError } from '../packages/local-client/src/errors.ts';
import { withDoor } from './client-fixture.ts';

const subscriptionId = crypto.randomUUID();
const topic = 'generic.events';
const admitted = {
  v: LOCAL_API_VERSION,
  subscriptionId,
  topic,
  subscriptionState: 'ready',
  lanes: ['primary'],
};

test('the feed item type follows the option that produces the frames — narrow only where provable', () => {
  using client = createWireClient({ socketPath: '/nonexistent/agent.sock' });
  // No subscription below is opened: TYPES are being checked, and `bun run typecheck` checks them,
  // because `test/` is within its scope. The assertions are written so that they can fail:
  // an assignment from `never` would pass for ANY answer, so the question is asked with a boolean type.

  // 1. The key is not named — the most common case and the one all of this exists for.
  const absent = client.subscribe({ topic });
  const absentHasNoLifecycle: Carries<typeof absent> = false;
  // 2. Literal `true` — it asked, so it parses.
  const asked = client.subscribe({ topic, lifecycle: true });
  const askedHasLifecycle: Carries<typeof asked> = true;
  // 3. Literal `false` — the same as absence.
  const declined = client.subscribe({ topic, lifecycle: false });
  const declinedHasNoLifecycle: Carries<typeof declined> = false;

  // 4. Negative control. A `boolean` of unknown value must NOT be narrowed: the type would lie about
  //    what can arrive, and a type that narrows wrongly is worse than one that does not narrow at all.
  const flag: boolean = Date.now() > 0;
  const unknownFlag = client.subscribe({ topic, lifecycle: flag });
  const unknownFlagWidens: Carries<typeof unknownFlag> = true;

  // 5. Second negative control: a whole request of the declared type — same reason.
  const request: SubscribeRequest = { topic };
  const whole = client.subscribe(request);
  const wholeRequestWidens: Carries<typeof whole> = true;

  expect([
    absentHasNoLifecycle,
    askedHasLifecycle,
    declinedHasNoLifecycle,
    unknownFlagWidens,
    wholeRequestWidens,
  ]).toEqual([false, true, false, true, true]);
});

/**
 * Whether this feed carries the `subscription` kind — a question the type must answer yes or no.
 *
 * The assertion is built by assigning a LITERAL to this type, not a value to a literal: `never`
 * is assignable to anything, so a check through `Extract<…> = null as never` would pass even
 * when the narrowing is broken. Here a wrong answer is a compile error.
 */
type Carries<F> = [Extract<WireFeedItem<F>, { kind: 'subscription' }>] extends [never] ? false : true;

type WireFeedItem<F> = F extends AsyncIterableIterator<infer T> ? T : never;

test('a lifecycle frame nobody asked for is refused, not delivered into code that has no branch for it', async () => {
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify(admitted)}\n`);
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      const feed = client.subscribe({ topic });
      const failure = await feed.next().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(WireClientError);
      expect((failure as WireClientError).code).toBe('invalid-response');
      expect((failure as WireClientError).message).toContain('did not request one');
    },
  );
});

test('the same frame is delivered normally to a feed that did ask — the refusal is about the request, not the frame', async () => {
  await withDoor(
    (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/x-ndjson' });
      response.end(`${JSON.stringify(admitted)}\n`);
    },
    async (socketPath) => {
      using client = createWireClient({ socketPath });
      const feed = client.subscribe({ topic, lifecycle: true });
      const first = await feed.next();
      expect(first.done).toBe(false);
      if (!first.done) {
        expect(first.value.kind).toBe('subscription');
        if (first.value.kind === 'subscription') expect(first.value.frame.subscriptionState).toBe('ready');
      }
    },
  );
});
