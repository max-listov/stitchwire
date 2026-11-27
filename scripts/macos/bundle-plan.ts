/**
 * What `Stitchwire.app` is built from — launcher source, compiler flags, Info.plist and icon — and the
 * fingerprint of exactly those inputs, which the bundle records in its Info.plist. Info.plist is sealed by
 * the code signature, so a verified bundle's fingerprint is the one it was built with.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type IconSource, resolveIconSource } from './icon.ts';

export const DEFAULT_BUNDLE_NAME = 'Stitchwire';
export const DEFAULT_BUNDLE_ID = 'com.stitchwire.app';
export const DEFAULT_EXECUTABLE = 'stitchwire-launcher';
export const DEFAULT_LOCAL_NETWORK_USAGE =
  'Stitchwire runs background agent connections and local-network checks on macOS.';
export const FINGERPRINT_KEY = 'StitchwireBuildFingerprint';

const ROOT = resolve(import.meta.dir, '../..');
export const DEFAULT_LAUNCHER_SOURCE = join(ROOT, 'contrib/launchd/stitchwire-launcher.c');
const CFLAGS = ['-O2', '-Wall', '-Wextra', '-Werror'];

export type BundleOptions = {
  bundleName?: string;
  bundleId?: string;
  executable?: string;
  version?: string;
  identity?: string | null;
  sourceFile?: string;
  iconPath?: string;
  extraCFlags?: string[];
  localNetworkUsageDescription?: string;
};

export type BundlePlan = {
  bundleName: string;
  bundleId: string;
  executable: string;
  sourceFile: string;
  launcherSource: Buffer;
  cflags: string[];
  infoPlist: Record<string, unknown>;
  icon: IconSource;
  fingerprint: string;
};

export function packageVersion(root = ROOT): string {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('package.json does not declare a string version');
  }
  return manifest.version;
}

export function buildInfoPlist(options: BundleOptions = {}): Record<string, unknown> {
  const bundleName = options.bundleName ?? DEFAULT_BUNDLE_NAME;
  const version = options.version ?? packageVersion();
  return {
    CFBundleIdentifier: options.bundleId ?? DEFAULT_BUNDLE_ID,
    CFBundleName: bundleName,
    CFBundleDisplayName: bundleName,
    CFBundleExecutable: options.executable ?? DEFAULT_EXECUTABLE,
    CFBundlePackageType: 'APPL',
    CFBundleShortVersionString: version,
    CFBundleVersion: version,
    CFBundleIconFile: 'AppIcon',
    NSHighResolutionCapable: true,
    LSBackgroundOnly: true,
    NSLocalNetworkUsageDescription: options.localNetworkUsageDescription ?? DEFAULT_LOCAL_NETWORK_USAGE,
  };
}

/** Each input is hashed with its label and length, so two different input sets never give one byte stream. */
export function buildFingerprint(parts: ReadonlyArray<readonly [string, string | Buffer]>): string {
  const hash = createHash('sha256');
  for (const [label, value] of parts) {
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    hash.update(`${label}\0${bytes.length}\0`);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function planBundle(options: BundleOptions = {}): BundlePlan {
  const sourceFile = options.sourceFile ?? DEFAULT_LAUNCHER_SOURCE;
  const launcherSource = readFileSync(sourceFile);
  const cflags = [...CFLAGS, ...(options.extraCFlags ?? [])];
  const infoPlist = buildInfoPlist(options);
  const icon = resolveIconSource(options.iconPath);
  const executable = options.executable ?? DEFAULT_EXECUTABLE;
  return {
    bundleName: options.bundleName ?? DEFAULT_BUNDLE_NAME,
    bundleId: options.bundleId ?? DEFAULT_BUNDLE_ID,
    executable,
    sourceFile,
    launcherSource,
    cflags,
    infoPlist,
    icon,
    fingerprint: buildFingerprint([
      ['launcher', launcherSource],
      ['cflags', JSON.stringify(cflags)],
      ['executable', executable],
      ['info-plist', JSON.stringify(infoPlist)],
      [`icon ${icon.format} ${icon.extension}`, icon.bytes],
    ]),
  };
}

/** The fingerprint a bundle records, or null for a bundle built before it recorded one. */
export function readBundleFingerprint(appPath: string): string | null {
  const plist = join(appPath, 'Contents/Info.plist');
  const result = Bun.spawnSync(['plutil', '-extract', FINGERPRINT_KEY, 'raw', '-o', '-', plist], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode === 0) return result.stdout.toString().trim();
  const detail = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  if (detail.includes('No value at that key path')) return null;
  throw new Error(`plutil -extract ${FINGERPRINT_KEY} ${plist}: ${detail || `exit ${result.exitCode}`}`);
}
