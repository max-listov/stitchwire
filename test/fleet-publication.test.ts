import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBroker } from '../packages/runtime/src/broker/runtime.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { fleetSigner } from './signed-fleet.ts';
import { createAgent } from '../packages/runtime/src/node/multi-home-agent.ts';
import { relay } from './relay.ts';
import { brokerConfig, freePort, until, waitConnected } from './support.ts';

/**
 * A node that keeps the full bundle hands it to a broker that keeps none. A broker that refuses it
 * has answered, and the node does not hand it over again: the broker's journal holds one publication.
 * A broker whose answer is late has not answered within the window, and the node hands it over again.
 */

const root = mkdtempSync(join(tmpdir(), 'wire-fleet-publication-'));
const key = fleetSigner('signer');
const TOKEN = 'h'.repeat(40);
const POLL_MS = 200;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const publications = (auditPath: string): Array<{ accepted: boolean; detail: string }> =>
  readFileSync(auditPath, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"fleet-bundle"'))
    .map((line) => JSON.parse(line).event);

test('a broker that refuses a publication is not handed it again', async () => {
  const port = freePort();
  const auditPath = join(root, 'audit.jsonl');
  // The broker configures no fleet trust, so it keeps no bundle and refuses every publication.
  const broker = await startBroker(brokerConfig({ holder: TOKEN }, { port, auditPath }));
  const copy = join(root, 'bundle.json');
  writeFileSync(
    copy,
    JSON.stringify(
      key.edition(
        {
          version: 1,
          members: { holder: { copy: 'full' } },
          access: [],
        },
        3,
        '2026-10-20T00:00:00.000Z',
      ),
    ),
  );
  const holder = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'holder',
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${port}`, token: TOKEN }],
      fleet: { trust: key.trust, copy, pollMs: POLL_MS },
    }),
  );
  try {
    await waitConnected(holder);
    const refused = () => holder.status().then((status) => status.bundle.lanes[0]?.detail ?? '');
    expect(await until(async () => (await refused()).includes('keeps no fleet bundle'))).toBe(true);
    // The broker's journal is written after its answer: the refusal is read once it is recorded.
    expect(await until(() => publications(auditPath).length > 0)).toBe(true);
    expect(publications(auditPath)).toMatchObject([{ accepted: false }]);

    // Retries of an unanswered question come after six polls; fourteen polls cannot hide one.
    const polls = new Set<string>();
    expect(
      await until(
        async () => {
          const checkedAt = (await holder.status()).bundle.checkedAt;
          if (checkedAt !== null) polls.add(checkedAt);
          return polls.size >= 14;
        },
        undefined,
        50,
      ),
    ).toBe(true);
    expect(publications(auditPath)).toHaveLength(1);
  } finally {
    await holder.stop();
    await broker.stop();
  }
}, 60_000);

/** The lane waits five seconds for any acknowledgement; that window is part of the wait for `not answered`. */
const ACK_WINDOW_CEILING_MS = 30_000;

test('a publication whose answer comes late is asked about again, and the answer to that reaches the node', async () => {
  const port = freePort();
  const auditPath = join(root, 'late-audit.jsonl');
  const broker = await startBroker(
    brokerConfig(
      { holder: TOKEN },
      {
        port,
        auditPath,
        fleet: {
          trust: key.trust,
          copy: join(root, 'broker-copy.json'),
          pollMs: POLL_MS,
        },
      },
    ),
  );
  const path = await relay(port);
  const copy = join(root, 'late-bundle.json');
  const holder = createAgent(
    NodeConfigSchema.parse({
      nodeId: 'holder',
      brokers: [{ id: 'primary', url: `http://127.0.0.1:${path.port}`, token: TOKEN }],
      fleet: { trust: key.trust, copy, pollMs: POLL_MS },
    }),
  );
  const state = async () => (await holder.status()).bundle.lanes[0];
  try {
    await waitConnected(holder);
    expect(await until(async () => (await state())?.syncedAt !== undefined)).toBe(true);
    // What the broker sends back is kept at the relay: the broker takes the publication and answers it,
    // and the node sees no answer.
    path.hold();
    writeFileSync(
      copy,
      JSON.stringify(
        key.edition(
          {
            version: 1,
            members: { holder: { copy: 'full' } },
            access: [],
          },
          4,
          '2026-10-20T00:00:00.000Z',
        ),
      ),
    );
    expect(
      await until(async () => (await state())?.detail === 'publication not answered', ACK_WINDOW_CEILING_MS),
    ).toBe(true);
    const unansweredAt = (await state())?.syncedAt ?? '';
    path.release();
    // The node asks again, without a reconnect and without a new edition. The broker already keeps
    // this one, so its answer to the question says so and the node need not publish it twice. The
    // answer that was kept back belongs to a question the node has given up: it settles nothing.
    expect(
      await until(async () => {
        const answered = await state();
        return answered?.detail === null && answered.syncedAt > unansweredAt;
      }),
    ).toBe(true);
    expect((await state())?.serial).toBe(4);
    expect((await holder.status()).lanes[0]?.connected).toBe(true);
    expect(publications(auditPath)).toMatchObject([{ accepted: true }]);
  } finally {
    await holder.stop();
    path.close();
    await broker.stop();
  }
}, 60_000);
