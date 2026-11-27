import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../../config/paths.ts';
import { flagValue } from '../configuration.ts';
import { fail } from '../io.ts';

/** `stitchwire prune-rollbacks`: drop all but the newest rollback roots. */
export function runPruneRollbacks(argv: string[]): number {
  // Every release leaves a copy of the binary and the configs behind. Keeping them is the whole
  // point; keeping ALL of them means ten copies of a 1.4 MB binary on every node after ten
  // releases, and no procedure that says when they go.
  const keepValue = flagValue(argv, '--keep');
  const keep = keepValue === undefined ? 2 : Number(keepValue);
  if (!Number.isInteger(keep) || keep < 1) fail('--keep expects a whole number of roots to keep, at least 1');
  const root = join(paths.stateDir, 'rollback');
  if (!existsSync(root)) {
    console.log(`no rollback roots under ${root}`);
    return 0;
  }
  const roots = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // Numbers compared as numbers: a plain sort puts v0.43.10 before v0.43.9 and would prune the
    // newest root. Timestamp-named roots from before version naming sort ahead of every version.
    .sort(new Intl.Collator('en', { numeric: true }).compare);
  const stale = roots.slice(0, Math.max(0, roots.length - keep));
  for (const name of stale) rmSync(join(root, name), { recursive: true, force: true });
  const kept = roots.slice(Math.max(0, roots.length - keep));
  console.log(`removed ${stale.length}, kept ${kept.length}: ${kept.join(', ') || '(none)'}`);
  if (stale.length > 0) console.log(`removed: ${stale.join(', ')}`);
  return 0;
}
