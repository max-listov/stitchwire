#!/usr/bin/env bun
/**
 * Standalone JavaScript runtime plus architecture-specific Stitchkit native sidecars.
 *
 * Socket.IO is bundled rather than left external: it is the transport, not an optional feature, and
 * a node that discovers a missing peer dependency at connect time is a node that fails silently at
 * 3am on a machine with no source tree.
 */

import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectNativeArtifact } from 'stitchkit/files/packaging';
import { assertArtifactPrivacy } from './artifact-privacy.ts';
import { nativeSidecar, RUNTIME_ENTRY_PATH } from './runtime-assets.ts';
import { createRuntimeNativePackaging } from './runtime-native-packaging.ts';
import { assertSocketIoPresent } from './standalone-socket-io.ts';

const root = join(import.meta.dir, '..');
const native = createRuntimeNativePackaging();

const result = await Bun.build({
  entrypoints: [join(root, 'packages/runtime/src/cli/main.ts')],
  target: 'bun',
  naming: { entry: RUNTIME_ENTRY_PATH },
  splitting: false,
  plugins: [native.plugin],
  minify: false,
  // Optional stitchkit peers for surfaces this project does not use. Left external so the bundle
  // does not carry React or the MCP SDK for code that is never reached.
  external: [
    '@tanstack/react-query',
    'react-query-kit',
    'react',
    'ai',
    '@modelcontextprotocol/server',
    '@modelcontextprotocol/ext-apps',
    'srvx',
  ],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error('build failed');
}

const path = join(root, 'dist', 'stitchwire');
const [entry] = result.outputs;
if (result.outputs.length !== 1 || entry?.kind !== 'entry-point')
  throw new Error('Runtime build must emit exactly its JS entry');
const built = (await entry.text()).replaceAll(root, '<stitchwire-source>');
assertSocketIoPresent(built);
await Bun.write(path, built.startsWith('#!') ? built : `#!/usr/bin/env bun\n${built}`);
await chmod(path, 0o755);
// The plugin is only proven by what it left in the artifact: an unpackaged bundle starts, then
// loses the process identity the first time a call needs the native module.
const loader = inspectNativeArtifact(await Bun.file(path).bytes());
if (loader !== 'packaged') throw new Error(`Runtime bundle is not natively packaged (${loader})`);
await assertArtifactPrivacy(path);
for (const asset of native.assets) {
  // Stitchkit has already compared these bytes with the digest its package published.
  const target = nativeSidecar(path, asset.architecture);
  await Bun.write(target, asset.bytes);
  await assertArtifactPrivacy(target);
}
console.log(`✓ dist/stitchwire (${((await Bun.file(path).size) / 1024).toFixed(0)} KB)`);
