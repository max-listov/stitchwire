import type { Server } from 'node:net';
import type { z } from 'zod';
import type { EventDeliveryAck } from '../packages/contracts/src/protocol/event.ts';
import {
  type BrokerHealth,
  BrokerHealthContractSchema,
} from '../packages/contracts/src/protocol/broker-health.ts';
import { type BrokerConfig, BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { temporaryFile } from './temporary.ts';

/**
 * What every test that stands up a wire shares: waiting on a condition, a port, a broker
 * configuration and a connected agent. One copy here; a test file does not keep its own.
 */

/** The ceiling of a wait. It bounds a hang and is never a speed claim (ADR 0012). */
/** How long a wait may last before it is a hang rather than a slow machine. */
export const HANG_CEILING_MS = 10_000;
/**
 * How long a freshly spawned Bun process (an agent, a broker, a crash runner) may take to reach its
 * first observable state. A loaded gate has measured such a start above twelve seconds, so the start
 * is bounded as a hang, not as a duration.
 */
export const PROCESS_START_CEILING_MS = 30_000;
const POLL_MS = 10;
/** One more turn of the event loop's timers after a wait, for an assertion that also forbids extras. */
const SETTLE_MS = 5;
/** The poll of a wait whose every check is a call through the broker: it stays inside the rate. */
export const CALL_POLL_MS = 100;

/**
 * Wait for a condition, with the clock only as a ceiling.
 *
 * Answers whether the condition held; the caller asserts it, so a failure points at the test line
 * that waited rather than at this helper. A check that itself calls through the broker passes
 * `CALL_POLL_MS`, so the wait does not spend the caller's admission rate on asking.
 */
export async function until(
  check: () => boolean | Promise<boolean>,
  budgetMs = HANG_CEILING_MS,
  pollMs = POLL_MS,
): Promise<boolean> {
  const deadline = performance.now() + budgetMs;
  for (;;) {
    if (await check()) return true;
    if (performance.now() >= deadline) return false;
    await Bun.sleep(pollMs);
  }
}

/**
 * Wait until `items` holds `count` entries, then give one more turn, so a delivery landing beside
 * the last one is caught by the exact assertion that follows instead of being raced past. That
 * assertion is the verdict: a count never reached shows there as the missing entries.
 */
export async function delivered(items: { readonly length: number }, count: number): Promise<void> {
  await until(() => items.length >= count);
  await settle();
}

/**
 * One more turn of the event loop's timers, for the assertion that something did NOT happen: the
 * event it would follow has already been waited for, and this lets a consequence queued beside it
 * land before the exact assertion that forbids it.
 */
export async function settle(): Promise<void> {
  await Bun.sleep(SETTLE_MS);
}

/**
 * Acknowledges the first `count` deliveries a test holds, as they arrive and one at a time (an
 * acknowledgement is what releases the next), then lets one more land so the caller's exact assertion
 * can forbid it. The count is what the test expects to be owed: the wait is on that, not on silence.
 */
export async function acknowledgeEach(
  held: ReadonlyArray<{ acknowledge: (ack: EventDeliveryAck) => void }>,
  count: number,
): Promise<void> {
  const accepted: EventDeliveryAck = { accepted: true, refusal: 'none', detail: '' };
  for (let index = 0; index < count; index += 1) {
    if (!(await until(() => held.length > index))) throw new Error(`delivery ${index + 1} never arrived`);
    held[index]?.acknowledge(accepted);
  }
  await settle();
}

/** One broker lane of a node's configuration, reconnecting fast enough for a test to wait on it. */
export function brokerLane(port: number, token: string) {
  return [
    {
      id: 'primary',
      url: `http://127.0.0.1:${port}`,
      token,
      reconnect: { minDelayMs: 100, maxDelayMs: 500 },
    },
  ];
}

/** Wait until every agent has a connected lane; throws if one never connects. */
export async function waitConnected(
  ...agents: ReadonlyArray<{ readonly connected: boolean }>
): Promise<void> {
  if (!(await until(() => agents.every((agent) => agent.connected))))
    throw new Error('agent never connected to the broker');
}

/**
 * A loopback port that was free a moment ago.
 *
 * The broker's configuration requires a concrete port (`port` is 1..65535) and its handle reports
 * the configured one, so a broker cannot bind port 0 and tell the test what it got. A server that
 * can binds port 0 itself (`listenLoopback`, or `Bun.serve({ port: 0 })` and its `port`) instead.
 */
export function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error('ephemeral probe did not bind a port');
  return port;
}

/** Bind a node server to an ephemeral loopback port and answer the port the kernel gave it. */
export async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('loopback listener has no TCP address');
  return address.port;
}

/** What a broker on this loopback port answers at `/health`, read through its published schema. */
export async function brokerHealth(port: number): Promise<BrokerHealth> {
  const response = await fetch(`http://127.0.0.1:${port}/health`);
  return BrokerHealthContractSchema.parse(await response.json());
}

type BrokerFields = Omit<z.input<typeof BrokerConfigSchema>, 'nodes'>;

/**
 * A broker configuration for a test: each node registered by its token, the audit trail in this
 * process's scratch directory (never the operator's state directory), and the test's own fields.
 */
export function brokerConfig(
  tokens: Readonly<Record<string, string>>,
  fields: BrokerFields = {},
): BrokerConfig {
  return BrokerConfigSchema.parse({
    auditPath: temporaryFile(`audit-${crypto.randomUUID()}.jsonl`),
    ...fields,
    nodes: Object.entries(tokens).map(([id, token]) => ({ id, tokenSha256s: [sha256(token)] })),
  });
}
