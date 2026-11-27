import { LOCAL_API_VERSION } from '../../../../contracts/src/door/common.ts';
import { behindBy } from '../../../../contracts/src/protocol/release.ts';
import { declarationChecks } from '../declaration-checks.ts';
import { localClient } from '../door.ts';
import { out } from '../io.ts';
import { renderNodes } from '../render.ts';
import { subscriptionChecks } from '../subscription-checks.ts';

/** `stitchwire nodes` and `stitchwire status`: what the local agent reports about itself and the fleet. */
export async function runStatus(cmd: 'nodes' | 'status', json: boolean): Promise<number> {
  using wire = localClient();
  const status = await wire.status();
  if (json) {
    await out(`${JSON.stringify(status)}\n`);
    return status.connected ? 0 : 1;
  }
  if (cmd === 'nodes') {
    renderNodes(status.nodes);
    return status.connected ? 0 : 1;
  }
  console.log(`node        ${status.nodeId}`);
  console.log(`brokers     ${status.lanes.length}`);
  for (const lane of status.lanes) {
    console.log(
      `  ${lane.id.padEnd(12)} ${lane.connected ? 'connected' : 'DOWN'}  ${lane.url}  ${lane.nodesVisible} node(s)`,
    );
    if (lane.lastFailure !== null)
      console.log(
        `  ${' '.repeat(12)} ${lane.lastFailure.reason}${
          lane.lastFailure.refused ? ' (refused, retrying)' : ''
        } since ${lane.lastFailure.at}`,
      );
  }
  console.log(`link        ${status.connected ? 'available' : 'DOWN'}`);
  console.log(`role        ${status.serves ? 'serving inbound calls' : 'caller only'}`);
  const allowLine =
    status.allow.map((a) => (a.present ? a.name : `${a.name} (NO ENDPOINT)`)).join(', ') ||
    '(nothing — this node executes nothing)';
  console.log(`allowed     ${allowLine}`);
  const streamLine =
    status.streams
      .map((profile) => (profile.present ? profile.name : `${profile.name} (NO BINARY)`))
      .join(', ') || '(nothing — this node produces no streams)';
  console.log(`streams     ${streamLine}`);
  console.log(`publishes   ${status.events.publish.join(', ') || '(none)'}`);
  console.log(`subscribes  ${status.events.subscribe.join(', ') || '(none)'}`);
  for (const check of subscriptionChecks(status)) console.log(`${check.code} ${check.detail}`);
  for (const check of declarationChecks(status)) console.log(`${check.code} ${check.detail}`);
  console.log(`event pubs  ${status.events.pendingPublishes} pending`);
  // Two numbers, deliberately separate: the agent's release and the door's own version. The wire has
  // no version of its own — the handshake matches on the release — so a disagreement here is a
  // half-finished rollout, and it reads that way at a glance.
  console.log(`version     agent ${status.version}, door v${LOCAL_API_VERSION}`);
  {
    const r = status.release;
    // Three states, three different sentences. "Up to date" is never printed for a node that
    // merely failed to ask: that is the one reading which looks healthiest exactly when nothing
    // has verified it.
    const standing =
      r.latest === null
        ? r.checkedAt === null
          ? 'nothing has tried to confirm the fleet release yet'
          : `NOT CONFIRMED — the last check failed at ${r.checkedAt}`
        : behindBy(r.current ?? '', r.latest) === null
          ? 'level with the fleet'
          : `${String(behindBy(r.current ?? '', r.latest)).toUpperCase()} BEHIND ${r.latest}`;
    console.log(`release     ${r.current ?? 'unknown'} — ${standing}`);
  }
  return status.connected ? 0 : 1;
}
