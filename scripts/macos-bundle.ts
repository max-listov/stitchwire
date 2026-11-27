#!/usr/bin/env bun
/**
 * Build, sign and atomically install the macOS background launcher bundle (`Stitchwire.app`).
 *
 * The bundle wraps Stitchwire LaunchAgents with a thin compiled supervisor (`stitchwire-launcher`)
 * signed with a Developer ID Application certificate (fail-closed, no ad-hoc fallback). An installed
 * bundle is current only when its signature verifies and its recorded build fingerprint equals the one
 * the present inputs give, so a changed launcher, version or icon is rebuilt without `--force`.
 * Staging happens inside `*.install.noindex` so Spotlight and LaunchServices never register
 * intermediate candidates; the swap itself, with rollback on verification failure, is
 * `macos/bundle-swap.ts`.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  type BundleOptions,
  type BundlePlan,
  FINGERPRINT_KEY,
  planBundle,
  readBundleFingerprint,
} from './macos/bundle-plan.ts';
import {
  type CodesignDetails,
  formatCodesignSummary,
  resolveSigningIdentity,
  runStrict,
  teamChangeRefusal,
  verifySignedBundle,
} from './macos/codesign.ts';
import { buildIcns } from './macos/icon.ts';
import { errorText, replaceThroughStaging } from './macos/bundle-swap.ts';

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

export type InstallOptions = BundleOptions & {
  installDir?: string;
  force?: boolean;
  /** The team the installed bundle is signed by, or null without a verified one; a rebuild keeps it. */
  installedTeam?: string | null;
};

export type InstalledBundle = {
  installed: string;
  bundleId: string;
  executablePath: string;
  fingerprint: string;
  cdHash: string | null;
  codesignSummary: string;
};

export type BundleInstallResult = InstalledBundle &
  ({ state: 'current' } | { state: 'installed'; reason: string });

/** Write `Contents/Info.plist`: the planned keys and the build fingerprint they and the other inputs give. */
export function writeInfoPlist(contents: string, plan: BundlePlan): void {
  mkdirSync(contents, { recursive: true });
  const jsonPath = join(contents, 'Info.json');
  writeFileSync(jsonPath, JSON.stringify({ ...plan.infoPlist, [FINGERPRINT_KEY]: plan.fingerprint }));
  try {
    runStrict(['plutil', '-convert', 'xml1', jsonPath, '-o', join(contents, 'Info.plist')], 'plutil');
  } finally {
    rmSync(jsonPath, { force: true });
  }
}

/** Compile the launcher, write Info.plist with the build fingerprint, build the icon and sign `destinationApp`. */
export function buildSignedBundle(
  destinationApp: string,
  plan: BundlePlan,
  identity?: string | null,
  installedTeam: string | null = null,
): CodesignDetails {
  const signer = resolveSigningIdentity(identity, plan.bundleName, installedTeam);
  const contents = join(destinationApp, 'Contents');
  const macosDir = join(contents, 'MacOS');
  const resourcesDir = join(contents, 'Resources');
  mkdirSync(macosDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  // Compile the exact source bytes the fingerprint was taken from, not whatever the file holds now.
  const source = join(dirname(destinationApp), `${plan.executable}.c`);
  writeFileSync(source, plan.launcherSource);
  try {
    runStrict(
      ['clang', ...plan.cflags, source, '-o', join(macosDir, plan.executable)],
      `clang ${plan.sourceFile}`,
    );
  } finally {
    rmSync(source, { force: true });
  }

  writeInfoPlist(contents, plan);
  buildIcns(resourcesDir, plan.icon);
  runStrict(['codesign', '--force', '--sign', signer, '--timestamp=none', destinationApp], 'codesign');
  return verifySignedBundle(destinationApp, plan.bundleId);
}

function installedPaths(
  options: InstallOptions,
  plan: BundlePlan,
): { installed: string; executablePath: string } {
  const installed = join(options.installDir ?? join(homedir(), 'Applications'), `${plan.bundleName}.app`);
  return { installed, executablePath: join(installed, 'Contents/MacOS', plan.executable) };
}

/**
 * What a built bundle must be before it replaces the installed one, and again after the swap: signed
 * by Developer ID, recording the planned fingerprint, and signed by the installed bundle's team.
 */
export function checkBuiltBundle(
  path: string,
  plan: BundlePlan,
  installedTeam: string | null,
  deps: {
    verify?: (appPath: string, expectedBundleId: string) => CodesignDetails;
    readFingerprint?: (appPath: string) => string | null;
  } = {},
): void {
  const details = (deps.verify ?? verifySignedBundle)(path, plan.bundleId);
  const refusal = teamChangeRefusal(details, installedTeam);
  if (refusal !== null) throw new Error(`refusing to install ${path}: ${refusal}`);
  const recorded = (deps.readFingerprint ?? readBundleFingerprint)(path);
  if (recorded !== plan.fingerprint) {
    throw new Error(
      `bundle at ${path} records fingerprint ${recorded ?? 'none'}, expected ${plan.fingerprint}`,
    );
  }
}

export function installSignedBundle(
  options: InstallOptions = {},
  plan = planBundle(options),
): InstalledBundle {
  const { installed, executablePath } = installedPaths(options, plan);
  const installedTeam = options.installedTeam ?? null;
  mkdirSync(dirname(installed), { recursive: true });
  replaceThroughStaging(
    installed,
    (staged) => {
      buildSignedBundle(staged, plan, options.identity, installedTeam);
    },
    (path) => checkBuiltBundle(path, plan, installedTeam),
  );

  runStrict([LSREGISTER, '-f', installed], 'lsregister -f');
  const details = verifySignedBundle(installed, plan.bundleId);
  return {
    installed,
    bundleId: plan.bundleId,
    executablePath,
    fingerprint: plan.fingerprint,
    cdHash: details.cdHash,
    codesignSummary: formatCodesignSummary(details),
  };
}

/**
 * Ensure the bundle at `<installDir>/<bundleName>.app` is the one the present inputs build: a verified Developer
 * ID signature and the same build fingerprint give `state: 'current'` with nothing changed; anything else rebuilds
 * and replaces atomically, and the result says why. `force` rebuilds a current bundle too.
 */
export function ensureSignedBundle(
  options: InstallOptions = {},
  deps: {
    verify?: (appPath: string, expectedBundleId: string) => CodesignDetails;
    readFingerprint?: (appPath: string) => string | null;
    install?: (options: InstallOptions, plan: BundlePlan) => InstalledBundle;
  } = {},
): BundleInstallResult {
  const plan = planBundle(options);
  const { installed, executablePath } = installedPaths(options, plan);
  const verify = deps.verify ?? verifySignedBundle;
  const readFingerprint = deps.readFingerprint ?? readBundleFingerprint;
  const install = deps.install ?? installSignedBundle;

  // The installed bundle is read first, `--force` included: the team it is signed by is the one a
  // rebuild must keep, whatever the reason for the rebuild.
  const present = existsSync(executablePath);
  let details: CodesignDetails | null = null;
  let unverified: string | null = null;
  if (present) {
    try {
      details = verify(installed, plan.bundleId);
    } catch (error) {
      unverified = errorText(error);
    }
  }
  const rebuild = (reason: string): BundleInstallResult => ({
    ...install({ ...options, installedTeam: details?.teamIdentifier ?? null }, plan),
    state: 'installed',
    reason,
  });
  if (options.force) return rebuild('forced');
  if (!present) return rebuild(`${executablePath} does not exist`);
  if (details === null) return rebuild(`installed bundle failed verification: ${unverified}`);
  const recorded = readFingerprint(installed);
  if (recorded !== plan.fingerprint) {
    return rebuild(
      `build inputs changed: installed fingerprint ${recorded ?? 'none'}, wanted ${plan.fingerprint}`,
    );
  }
  return {
    state: 'current',
    installed,
    bundleId: plan.bundleId,
    executablePath,
    fingerprint: plan.fingerprint,
    cdHash: details.cdHash,
    codesignSummary: formatCodesignSummary(details),
  };
}

if (import.meta.main) {
  if (process.platform !== 'darwin') {
    throw new Error('macos-bundle.ts can only build macOS .app bundles on darwin');
  }
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      'install-dir': { type: 'string' },
      'bundle-id': { type: 'string' },
      'bundle-name': { type: 'string' },
      identity: { type: 'string' },
      version: { type: 'string' },
      icon: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
  });
  const result = ensureSignedBundle({
    installDir: values['install-dir'],
    bundleId: values['bundle-id'],
    bundleName: values['bundle-name'],
    identity: values.identity,
    version: values.version,
    iconPath: values.icon,
    force: values.force,
  });
  console.log(JSON.stringify(result, null, 2));
}
