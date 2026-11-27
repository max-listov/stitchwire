import { createNativePackaging } from 'stitchkit/files/packaging';
import { DARWIN_ARCHITECTURES, nativeAssetPath, RUNTIME_ENTRY_PATH } from './runtime-assets.ts';

/** The archive stores versioned sidecars; installation restores these logical paths. */
export function createRuntimeNativePackaging() {
  const native = createNativePackaging({
    platform: 'darwin',
    architecture: [...DARWIN_ARCHITECTURES],
    delivery: 'companion',
    entryPath: RUNTIME_ENTRY_PATH,
    assetPath: Object.fromEntries(DARWIN_ARCHITECTURES.map((arch) => [arch, nativeAssetPath(arch)])),
  });
  if (native.state !== 'ready') throw new Error(`Runtime native packaging failed: ${native.code}`);
  return native;
}
