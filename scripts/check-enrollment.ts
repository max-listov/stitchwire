/**
 * Standalone consumer acceptance of enrollment: every scenario of the registry against a built
 * artifact. `--systemd` runs them as a real, uniquely named Linux installation and adds the
 * scenarios only such a host can run. `bun test` runs the same registry against the source entry.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { flagValue } from '../packages/runtime/src/cli/configuration.ts';
import type { Check } from '../test/enrollment-scenarios/enrolled.ts';
import { scenarios } from '../test/enrollment-scenarios/registry.ts';
import { installRuntimeAssets } from './runtime-assets.ts';

const source = resolve(flagValue(process.argv, '--artifact') ?? 'dist/stitchwire');
const crashRunner = resolve(
  flagValue(process.argv, '--crash-runner') ?? join(import.meta.dir, '../test/fixtures/enrollment-crash.ts'),
);
const systemd = process.argv.includes('--systemd');
if (systemd && process.platform !== 'linux') throw new Error('systemd acceptance requires Linux');
const installation = mkdtempSync('/tmp/we-installed-');
const binary = join(installation, 'bin/stitchwire');
installRuntimeAssets(source, binary);

let checks = 0;
let scenario = '';
const check: Check = (condition, label) => {
  assert(condition, `${scenario}: ${label}`);
  checks++;
  console.log(JSON.stringify({ scenario, stage: label, checks, failures: 0 }));
};
const selected = scenarios.filter(({ host }) => host === 'any' || systemd);
try {
  for (const { name, run } of selected) {
    scenario = name;
    await run({ entry: binary, crashRunner, systemd, check });
  }
  console.log(
    JSON.stringify({
      status: 'passed',
      scenarios: selected.length,
      checks,
      failures: 0,
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      systemd,
    }),
  );
} finally {
  rmSync(installation, { recursive: true, force: true });
}
