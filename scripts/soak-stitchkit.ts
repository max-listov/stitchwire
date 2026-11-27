import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

/**
 * Which Stitchkit a soak measures. By default it is the repository's own. `--stitchkit <dir>` names
 * another installation, a project directory whose `node_modules` holds a different `stitchkit` and
 * the peers it needs (`socket.io`, `@socket.io/bun-engine`, `zod`), so one stand can be run on two
 * versions and the reports compared: the memory fix of a release is only shown by running another
 * version on the same traffic. The tree must still run on that version: the runtime imports
 * `streamNativeCommand`, which Stitchkit versions before 0.111.2 do not have.
 */

const repository = resolve(import.meta.dir, '..');
const PackageSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  exports: z.record(z.string(), z.unknown()),
});
const EntrySchema = z.looseObject({ import: z.string().optional(), default: z.string().optional() });

function readStitchkit(from: string): {
  directory: string;
  version: string;
  exports: Record<string, unknown>;
} {
  let directory = dirname(Bun.resolveSync('stitchkit', from));
  while (!existsSync(join(directory, 'package.json'))) {
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`no stitchkit package is installed under ${from}`);
    directory = parent;
  }
  const found = PackageSchema.parse(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')));
  if (found.name !== 'stitchkit') throw new Error(`${from} does not resolve the stitchkit package`);
  return { directory, version: found.version, exports: found.exports };
}

/** The version of the Stitchkit that `from` resolves, read from its own package. */
export function stitchkitVersion(from: string = repository): string {
  return readStitchkit(from).version;
}

/**
 * A tsconfig for `bun --tsconfig-override` that sends every import of `stitchkit` and of its entry
 * points to the installation under `from`. Bun applies `paths` when it loads the repository's own
 * files, which an import map would not reach, and the exports of the other installation are read
 * from its package, so an entry point the version added or dropped follows it.
 */
export function stitchkitOverride(from: string): string {
  const { directory, exports } = readStitchkit(from);
  const paths: Record<string, string[]> = {};
  for (const [subpath, target] of Object.entries(exports)) {
    const entry = EntrySchema.safeParse(target);
    const file = entry.success ? (entry.data.import ?? entry.data.default) : undefined;
    if (file === undefined) continue;
    paths[subpath === '.' ? 'stitchkit' : `stitchkit/${subpath.slice(2)}`] = [join(directory, file)];
  }
  return JSON.stringify({ compilerOptions: { paths } });
}
