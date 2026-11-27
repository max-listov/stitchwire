import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const text = (path: string) => readFileSync(resolve(root, path), 'utf8');

/**
 * Hosted CI is optional and never a billing-dependent prerequisite, so the workflow runs only when
 * someone dispatches it, the distribution document says exactly that, and the README shows no badge
 * whose colour would depend on a run nobody was required to start.
 */
test('the hosted workflow is manual only, as the distribution document and the README say', () => {
  const workflow = Bun.YAML.parse(text('.github/workflows/verify.yml')) as { on: Record<string, unknown> };
  expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch']);
  expect(text('AGENTS.md')).toContain('Hosted GitHub Actions is optional, never a billing-dependent');
  expect(text('docs/architecture/distribution.md').replace(/\s+/g, ' ')).toContain(
    'optional manually dispatched hosted workflow',
  );
  expect(text('README.md')).not.toMatch(/actions\/workflows\/[^)"]*badge/);
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
