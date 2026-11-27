import { readdir, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { installedDependencyGraph } from './dependency-graph.ts';

const root = resolve(import.meta.dir, '..');
const dependencies = new Map<
  string,
  { name: string; version: string; license: string; noticeFiles: string[] }
>();
const notices: string[] = [];
for (const { directory, manifest } of await installedDependencyGraph(root)) {
  const key = `${manifest.name}@${manifest.version}`;
  if (dependencies.has(key)) continue;
  const files = (await readdir(directory))
    .filter((name) => /^(?:[a-z]+-)?(?:licen[sc]e|copying|notice)(?:[._-]|$)/i.test(name))
    .sort();
  const license =
    typeof manifest.license === 'string'
      ? manifest.license
      : (manifest.license?.type ?? manifest.licenses?.map((item) => item.type).join(' OR ') ?? 'UNDECLARED');
  dependencies.set(key, { name: manifest.name, version: manifest.version, license, noticeFiles: files });
  for (const file of files) {
    const content = Bun.file(join(directory, file));
    if (content.size > 524288) throw new Error('Dependency notice exceeds review bound');
    notices.push(`--- ${key}: ${file} ---\n${await content.text()}`);
  }
}
if (!dependencies.size) throw new Error('No installed dependency metadata found');
const packages = [...dependencies.values()].sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
const review = packages
  .filter((pkg) => pkg.license === 'UNDECLARED' || !pkg.noticeFiles.length)
  .map((pkg) => `${pkg.name}@${pkg.version}`);
await mkdir(join(root, 'dist'), { recursive: true });
await Bun.write(
  join(root, 'dist/dependency-inventory.json'),
  `${JSON.stringify({ scope: 'installed dependency graph including build/test tools; not a minimal bundled SBOM', packages, review, legalApproval: false }, null, 2)}\n`,
);
await Bun.write(join(root, 'dist/THIRD_PARTY_NOTICES.txt'), `${notices.join('\n\n')}\n`);
console.log(
  JSON.stringify({
    installedPackages: packages.length,
    notices: notices.length,
    requiresReview: review,
    legalApproval: false,
  }),
);
