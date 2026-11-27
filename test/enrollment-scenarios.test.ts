import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { Check } from './enrollment-scenarios/enrolled.ts';
import { SCENARIO_CEILING_MS, scenarios } from './enrollment-scenarios/registry.ts';

/** The registry against the source entry; `check:enrollment` runs the same list against an artifact. */
const check: Check = (condition, label) => assert(condition, label);
const crashRunner = join(import.meta.dir, 'fixtures/enrollment-crash.ts');

for (const scenario of scenarios) {
  if (scenario.host !== 'any') continue;
  test(scenario.name, () => scenario.run({ crashRunner, systemd: false, check }), SCENARIO_CEILING_MS);
}
