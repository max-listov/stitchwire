import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { EnrollmentNodeRequest } from '../../packages/contracts/src/enrollment/request.ts';
import { withFixtureConfigLock } from '../enrollment-lock.ts';
import { openBundle, tablesFor } from '../../packages/runtime/src/fleet/bundle.ts';
import { nodeTablesOf, sameTables } from '../../packages/runtime/src/fleet/projection.ts';
import type { enrollmentStand } from '../enrollment-stand.ts';
import { refusalOf } from '../enrollment-results.ts';

type Stand = Awaited<ReturnType<typeof enrollmentStand>>;
type Check = (condition: unknown, label: string) => void;

/** Real artifact processes contend for the same resource as the live fleet reconciler. */
export async function parallelBindingControls(stand: Stand, request: EnrollmentNodeRequest, check: Check) {
  const reset = (await stand.cli({ ...request, requestId: crypto.randomUUID() }, 'detach')).result;
  check(
    reset.status === 'detached',
    `reset the first owner before concurrent new bindings (${reset.status}/${refusalOf(reset)?.code ?? 'ok'}@${refusalOf(reset)?.phase ?? 'done'})`,
  );
  const first = { ...request, requestId: crypto.randomUUID() };
  const second = {
    ...request,
    requestId: crypto.randomUUID(),
    owner: { id: 'second', descriptors: stand.second.bindings },
  };
  const identity = { brokers: stand.config().brokers, fleet: stand.config().fleet };
  const owners = readFileSync(`${request.config}.enrollment/owners.json`);
  await withFixtureConfigLock(request.config, async () => {
    const config = stand.config();
    stand.write(request.config, {
      ...config,
      services: { ...config.services, namespaces: [], grants: [] },
      events: { ...config.events, publish: [], subscribe: [], namespaces: { publish: [], subscribe: [] } },
    });
    const drifted = readFileSync(request.config);
    const [left, right, fleet] = await Promise.all([
      stand.cliOnce(first, 'apply'),
      stand.cliOnce(second, 'apply'),
      stand.fleetApply(),
    ]);
    check(
      refusalOf(left.result)?.code === 'busy' && refusalOf(right.result)?.code === 'busy',
      'both owners name a live config lock',
    );
    check(fleet.code !== 0 && fleet.text.includes('LOCK_TIMEOUT'), 'fleet CLI shares the enrollment lock');
    check(
      drifted.equals(readFileSync(request.config)) &&
        owners.equals(readFileSync(`${request.config}.enrollment/owners.json`)),
      'busy writers change neither bindings nor owner receipt',
    );
  });
  // Busy is observable and retryable, not a stale snapshot to publish later: the stand's CLI asks
  // again as an orchestrator does, and a writer that stays busy to the ceiling fails the control.
  async function attach(value: EnrollmentNodeRequest) {
    const observed = (await stand.cli(value, 'apply')).result;
    assert(refusalOf(observed)?.code !== 'busy', 'concurrent owner stayed busy');
    return observed;
  }
  async function reconcile() {
    const deadline = Date.now() + 25_000;
    for (;;) {
      const result = await stand.fleetApply();
      if (result.code === 0 || !result.text.includes('LOCK_TIMEOUT')) return result;
      assert(Date.now() < deadline, 'fleet stayed busy');
      await Bun.sleep(25);
    }
  }
  const [left, right, fleet] = await Promise.all([attach(first), attach(second), reconcile()]);
  check(
    left.status === 'ready' && right.status === 'ready' && fleet.code === 0,
    `concurrent CLI owners and fleet converge (first=${left.status}/${refusalOf(left)?.code ?? 'ok'}@${refusalOf(left)?.phase ?? 'done'}, second=${right.status}/${refusalOf(right)?.code ?? 'ok'}@${refusalOf(right)?.phase ?? 'done'}, fleet=${fleet.code})`,
  );
  const config = stand.config();
  check(
    sameTables(config.services.descriptors, [stand.first.declarationPath, stand.second.declarationPath]) &&
      sameTables(config.events.descriptors, [stand.first.topicPath, stand.second.topicPath]),
    'both kinds of both owners survive concurrent writes',
  );
  const opened = openBundle(stand.bundle, stand.trust, { requireFull: true });
  assert(opened.ok);
  check(
    sameTables(nodeTablesOf(config), tablesFor(opened.opened, request.nodeId)),
    'fleet tables equal the signed projection exactly',
  );
  check(
    sameTables({ brokers: config.brokers, fleet: config.fleet }, identity),
    'concurrent writers preserve credentials trust and transport identity',
  );
  return second;
}
