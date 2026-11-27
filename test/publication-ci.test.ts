import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const text = (path: string) => readFileSync(resolve(root, path), 'utf8');

/**
 * Hosted certification is optional, so its workflow runs only when
 * someone dispatches it, the distribution document says exactly that, and the README shows no badge
 * whose colour would depend on a run nobody was required to start.
 */
test('hosted certification is manually dispatched and documented as optional', () => {
  const workflow = Bun.YAML.parse(text('.github/workflows/verify.yml')) as { on: Record<string, unknown> };
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(text('AGENTS.md')).toContain('Hosted certification is optional.');
  expect(text('docs/architecture/distribution.md').replace(/\s+/g, ' ')).toContain(
    'optional manually dispatched hosted workflow',
  );
  expect(text('README.md')).not.toMatch(/actions\/workflows\/[^)"]*badge/);
});

test('only the publishing job gets OIDC and it reads the sealed candidate selected for that tag', () => {
  type Step = { id?: string; uses?: string; run?: string; with?: Record<string, string> };
  type Job = {
    if?: string;
    needs?: string;
    environment?: string;
    permissions: Record<string, string>;
    steps: Step[];
    outputs?: Record<string, string>;
  };
  const workflow = Bun.YAML.parse(text('.github/workflows/release.yml')) as {
    on: Record<string, { inputs: Record<string, { required: boolean }> }>;
    jobs: { candidate: Job; publish: Job };
  };
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(workflow.on.workflow_dispatch?.inputs.manifest_sha256?.required).toBe(true);
  const { candidate, publish } = workflow.jobs;
  expect(candidate.if).toBe("startsWith(github.ref, 'refs/tags/v')");
  expect(candidate.permissions).toEqual({ contents: 'write' });
  expect(candidate.steps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(false);
  expect(candidate.outputs?.artifact_id).toMatch(/^\$\{\{ steps\.upload\.outputs\.artifact-id \}\}$/);
  expect(publish.needs).toBe('candidate');
  expect(publish.environment).toBe('npm-production');
  expect(publish.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  const download = publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'));
  expect(download?.with?.['artifact-ids']).toMatch(/^\$\{\{ needs\.candidate\.outputs\.artifact_id \}\}$/);
  expect(publish.steps.at(-1)?.run).toBe('bun scripts/npm-release.ts "$RUNNER_TEMP/release" --publish');
  expect(text('AGENTS.md').replace(/\s+/g, ' ')).toContain(
    'published only by the tagged trusted GitHub Actions release workflow',
  );
});

/**
 * On macOS `bun run verify` builds the app icon with `rsvg-convert`, which the hosted macOS images do
 * not carry; the job installs it before verifying, and only there.
 */
test('the hosted macOS job installs librsvg before it verifies', () => {
  const workflow = Bun.YAML.parse(text('.github/workflows/verify.yml')) as {
    jobs: { verify: { steps: Array<{ run?: string; if?: string }> } };
  };
  const steps = workflow.jobs.verify.steps;
  const librsvg = steps.findIndex((step) => step.run === 'brew install librsvg');
  expect(librsvg).toBeGreaterThanOrEqual(0);
  expect(steps[librsvg]?.if).toBe("runner.os == 'macOS'");
  expect(librsvg).toBeLessThan(steps.findIndex((step) => step.run === 'bun run verify'));
});
