import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type JsonFileReading, readJsonOnce, writeFileAtomicSync } from 'stitchkit/files';
import { configIdentity } from '../config/identity.ts';
import { anyJson, MAX_CONFIG_FILE_BYTES } from '../config/io.ts';
import { withConfigLock } from '../config/transaction.ts';
import { isRecord, type Json } from '../json.ts';

/**
 * Files the fleet bundle touches: the kept copy, and the configuration projected from it.
 *
 * Every write lands whole or not at all. A configuration file half-written when the process dies
 * is a machine that does not start, and a copy half-written is a node that keeps nothing — both on
 * the path that exists to repair machines.
 */

/** The framework's replace — exclusive staging name, mode before visibility, fsync, rename, and no
 *  staging file left behind on failure — plus the directory a first write needs. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomicSync(path, text, { mode: 0o600 });
}

/** How an edition lands in one configuration file: its tables, and what makes two of them equal. */
export type ConfigProjection = {
  project: (config: Json) => Json;
  tablesOf: (config: Json) => unknown;
  same: (left: unknown, right: unknown) => boolean;
  /** Null when the projected file loads; otherwise why it does not. */
  validate: (config: Json) => string | null;
  /** The owner may receive another edition while the configuration lock is being acquired. */
  isCurrent?: () => boolean;
};

type ConfigApplication =
  | { state: 'aligned' }
  | { state: 'written'; backup: string }
  | { state: 'refused'; detail: string };

/**
 * Rewrite the fleet's tables in one configuration file, or say why not.
 *
 * Nothing is written when the tables already match, so applying is idempotent and a process that
 * reloads after a write finds nothing left to do. The projected file must pass the same schema the
 * process loads it with before it replaces the old one; the old one is kept beside it as
 * `<file>.before-bundle`, one generation, because the question after a bad edition is "what did it
 * replace", never "what did it replace five editions ago".
 */
export async function applyConfigFile(
  path: string,
  projection: ConfigProjection,
): Promise<ConfigApplication> {
  const target = configIdentity(path);
  // A file that already carries the edition needs no transaction: a configuration is replaced
  // atomically, so one reading is one whole edition of it. A poll that took the lock to write
  // nothing would answer `busy` to the writer behind it, and would race that writer to take over a
  // lock its dead holder left.
  if (projection.isCurrent?.() !== false && plannedWrite(target, projection).state === 'aligned')
    return { state: 'aligned' };
  return withConfigLock(target, () => {
    if (projection.isCurrent?.() === false)
      return { state: 'refused', detail: 'fleet edition changed before config publication' };
    const plan = plannedWrite(target, projection);
    if (plan.state !== 'write') return plan;
    const backup = `${target}.before-bundle`;
    writeFileAtomic(backup, plan.previous);
    writeFileAtomic(target, `${JSON.stringify(plan.projected, null, 2)}\n`);
    return { state: 'written', backup };
  });
}

/** What applying would do to the file as it reads now; nothing is written here. */
function plannedWrite(
  path: string,
  { project, tablesOf, same, validate }: ConfigProjection,
):
  | { state: 'aligned' }
  | { state: 'refused'; detail: string }
  | { state: 'write'; previous: string; projected: Json } {
  const reading: JsonFileReading<unknown> = readJsonOnce(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
  if (reading.state === 'missing') return { state: 'refused', detail: `no configuration at ${path}` };
  if (reading.state !== 'read') return { state: 'refused', detail: reading.detail };
  const current = reading.value;
  if (!isRecord(current)) return { state: 'refused', detail: `${path} is not a JSON object` };
  const projected = project(current);
  if (same(tablesOf(current), tablesOf(projected))) return { state: 'aligned' };
  const invalid = validate(projected);
  if (invalid !== null)
    return { state: 'refused', detail: `the projected configuration is invalid: ${invalid}` };
  return { state: 'write', previous: reading.text, projected };
}
