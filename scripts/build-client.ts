import { resolve } from 'node:path';
import { cp, mkdir, rm, copyFile } from 'node:fs/promises';

/**
 * The one directory npm can receive the client from.
 *
 * `packages/client/package.json` is `private: true`, so `npm publish` or `bun publish` run in the
 * source tree refuses before anything leaves. The publishable copy exists only here, written by the
 * build from the source manifest, and is what the client archive is packed from.
 */
export const CLIENT_PACKAGE_STAGE = 'dist/client-package';

type SourceManifest = Record<string, unknown> & { private?: unknown };

/** The source manifest without the fields that keep it out of a registry or only serve this workspace. */
export function publishableClientManifest(source: SourceManifest): Record<string, unknown> {
  if (source.private !== true) throw new Error('packages/client/package.json must stay private: true');
  const { private: _private, scripts: _scripts, devDependencies: _devDependencies, ...published } = source;
  return { ...published, publishConfig: { access: 'public' } };
}

/** Copy the built bundle, README and LICENSE beside the publishable manifest. */
export async function stageClientPackage(root: string): Promise<string> {
  const stage = resolve(root, CLIENT_PACKAGE_STAGE);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });
  await cp(resolve(root, 'packages/client/dist'), resolve(stage, 'dist'), { recursive: true });
  await copyFile(resolve(root, 'packages/client/README.md'), resolve(stage, 'README.md'));
  // A license scanner looks at the package root, which is where the packer takes it from.
  await copyFile(resolve(root, 'LICENSE'), resolve(stage, 'LICENSE'));
  const source = (await Bun.file(resolve(root, 'packages/client/package.json')).json()) as SourceManifest;
  await Bun.write(
    resolve(stage, 'package.json'),
    `${JSON.stringify(publishableClientManifest(source), null, 2)}\n`,
  );
  return stage;
}

async function buildClient(root: string): Promise<string[]> {
  const output = resolve(root, 'packages/client/dist');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  // Three entries, one shared chunk graph: `contracts` stays strictly browser-safe (zod only) and
  // `enrollment` never enters the main entry.
  const entries = ['index', 'contracts', 'enrollment'];
  const build = await Bun.build({
    entrypoints: entries.map((entry) => resolve(root, `packages/client/src/${entry}.ts`)),
    outdir: output,
    naming: { entry: '[name].js', chunk: 'chunk-[hash].js' },
    splitting: true,
    target: 'node',
    format: 'esm',
    external: ['zod', 'stitchkit'],
  });
  if (!build.success) throw new AggregateError(build.logs, 'Client bundle failed');
  const declarations = Bun.spawn(
    ['bun', 'x', '--no-install', 'tsc', '--project', 'packages/client/tsconfig.json', '--noEmit', 'false'],
    { cwd: root, stdout: 'inherit', stderr: 'inherit' },
  );
  if ((await declarations.exited) !== 0) throw new Error('Client declarations failed');
  // The entry declaration sits at `dist/types/client/src/index.d.ts` because the package entry reaches
  // the shared implementation and contracts, which forces `rootDir: ".."`. That path is our monorepo's
  // shape, not the consumer's business, so the published manifest points at a shim in the root of
  // `dist` and the layout underneath stays an implementation detail.
  for (const entry of entries)
    await Bun.write(resolve(output, `${entry}.d.ts`), `export * from './types/client/src/${entry}.js';\n`);
  const sizes: string[] = [];
  for (const artifact of build.outputs) {
    const source = await artifact.text();
    if (source.includes(root) || /from ["'](?:socket\.io|bun:)/.test(source))
      throw new Error('Client bundle contains a server/runtime dependency or source path');
    sizes.push(`${artifact.path.slice(output.length + 1)} ${Buffer.byteLength(source)} bytes`);
  }
  return sizes;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '..');
  const sizes = await buildClient(root);
  const stage = await stageClientPackage(root);
  console.log(
    `Client ESM: ${sizes.join(', ')}; declarations: packages/client/dist/types; publishable package: ${stage.slice(root.length + 1)}`,
  );
}
