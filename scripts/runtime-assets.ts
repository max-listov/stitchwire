import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DARWIN_ARCHITECTURES = ['arm64', 'x64'] as const;

/** The installed layout, relative to its root: the runtime in `bin/`, native modules in `native/`.
 *  Packaging binds the entry to these paths and installation writes them; neither spells them twice. */
export const RUNTIME_ENTRY_PATH = 'bin/stitchwire';
export function nativeAssetPath(arch: string): string {
  return `native/darwin-${arch}.node`;
}

/** Release sidecars are versioned with their runtime, including retained rollback artifacts. */
export function nativeSidecar(binary: string, arch: string): string {
  return `${binary}.darwin-${arch}.node`;
}

/** Preserve Stitchkit's supported bin/ + native/ layout in each isolated installation. */
export function installRuntimeAssets(source: string, binary: string): void {
  mkdirSync(dirname(binary), { recursive: true });
  copyFileSync(source, binary);
  for (const arch of DARWIN_ARCHITECTURES) {
    const asset = nativeSidecar(source, arch);
    // Historical rollback releases did not have native assets. Current builds require both.
    if (!existsSync(asset)) continue;
    // The binary sits in the root's `bin/`, so the root is one level up from it.
    const target = join(dirname(binary), '..', nativeAssetPath(arch));
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(asset, target);
  }
}
