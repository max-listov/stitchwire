import type { ScenarioEnv } from './enrolled.ts';
import {
  bindingCrashes,
  bindingPolicy,
  bootstrap,
  brokerRefusal,
  conflicts,
  detach,
  dropInConflict,
  owners,
  proof,
  systemdRefusals,
} from './stories.ts';

/**
 * One acceptance scenario of enrollment: a whole story on its own fleet. `host` says where it can
 * run: anywhere a stand runs, or only on a Linux host with systemd and root.
 */
export type Scenario = { name: string; host: 'any' | 'systemd'; run(env: ScenarioEnv): Promise<void> };

/**
 * A scenario is a multi-process story with real reloads, and one of them contains the product's own
 * twenty-second wait for a broker. This one ceiling covers every scenario under either driver. It
 * is a hang bound, never a duration that is asserted: a scenario takes 13 to 35 seconds on an idle
 * machine and more than twice that on one that shares its cores with other gates.
 */
export const SCENARIO_CEILING_MS = 120_000;

/**
 * Every acceptance scenario, once. Two drivers run this list: `bun test` against the source entry
 * and `check:enrollment` against a built artifact, which adds the systemd host when it is asked to.
 */
export const scenarios: readonly Scenario[] = [
  {
    name: 'a node is planned, prepared, admitted and made ready, and a repeat changes nothing',
    host: 'any',
    run: bootstrap,
  },
  {
    name: 'only a remote call proves the broker route, and an ordinary self-call still works',
    host: 'any',
    run: proof,
  },
  {
    name: 'two owners attach at once, each is callable, and a refusal never reaches an owner',
    host: 'any',
    run: owners,
  },
  {
    name: 'a binding change is judged on the complete remaining set and costs no other owner',
    host: 'any',
    run: bindingPolicy,
  },
  {
    name: 'a broker that refuses a declaration is a named partial enrollment, never ready',
    host: 'any',
    run: brokerRefusal,
  },
  {
    name: 'a conflict between two foreign drop-in files does not refuse an unrelated owner',
    host: 'any',
    run: dropInConflict,
  },
  {
    name: 'one owner detaches while the other serves, and the last detach withdraws everything',
    host: 'any',
    run: detach,
  },
  {
    name: 'a binding change interrupted at every write boundary is resumed',
    host: 'any',
    run: bindingCrashes,
  },
  {
    name: 'a wrong credential, another version and a reused request are different refusals',
    host: 'any',
    run: conflicts,
  },
  {
    name: 'a systemd host refuses a corrupt artifact, another account and a foreign unit',
    host: 'systemd',
    run: systemdRefusals,
  },
];
