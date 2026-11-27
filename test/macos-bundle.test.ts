import { describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildInfoPlist,
  buildFingerprint,
  DEFAULT_BUNDLE_ID,
  DEFAULT_EXECUTABLE,
  DEFAULT_LAUNCHER_SOURCE,
  planBundle,
  readBundleFingerprint,
} from '../scripts/macos/bundle-plan.ts';
import { runStrict } from '../scripts/macos/codesign.ts';
import {
  buildIcns,
  DEFAULT_BRAND_ICON,
  framedJpegIconSvg,
  resolveIconSource,
} from '../scripts/macos/icon.ts';
import {
  checkBuiltBundle,
  ensureSignedBundle,
  type InstalledBundle,
  installSignedBundle,
  writeInfoPlist,
} from '../scripts/macos-bundle.ts';
import {
  BundleRollbackFailed,
  exchangeBundles,
  installVerifiedBundle,
  RECOVERY_MARKER,
  replaceThroughStaging,
} from '../scripts/macos/bundle-swap.ts';

const ROOT = resolve(import.meta.dir, '..');
const PLIST_PATH = join(ROOT, 'contrib/launchd/com.stitchwire.agent.plist');
const isDarwin = process.platform === 'darwin';

const validDetails = {
  identifier: DEFAULT_BUNDLE_ID,
  authorities: ['Developer ID Application: Example (TEAM123456)'],
  teamIdentifier: 'TEAM123456',
  cdHash: '1111222233334444',
};

/** A launcher source and an installed bundle stub in a fresh directory; the bundle's signature is whatever `verify` says. */
function bundleStand() {
  const work = mkdtempSync(join(tmpdir(), 'stitchwire-ensure-'));
  const sourceFile = join(work, 'launcher.c');
  writeFileSync(sourceFile, 'int main(void) { return 0; }\n');
  const app = join(work, 'Stitchwire.app');
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents/MacOS', DEFAULT_EXECUTABLE), 'stub');
  const installs: string[] = [];
  const teams: Array<string | null | undefined> = [];
  const install = (
    options: { installedTeam?: string | null },
    plan: { fingerprint: string },
  ): InstalledBundle => {
    installs.push(plan.fingerprint);
    teams.push(options.installedTeam);
    return {
      installed: app,
      bundleId: DEFAULT_BUNDLE_ID,
      executablePath: join(app, 'Contents/MacOS', DEFAULT_EXECUTABLE),
      fingerprint: plan.fingerprint,
      cdHash: '9999888877776666',
      codesignSummary: 'Identifier=com.stitchwire.app | CDHash=9999888877776666',
    };
  };
  return {
    work,
    sourceFile,
    app,
    installs,
    teams,
    install,
    cleanup: () => rmSync(work, { recursive: true, force: true }),
  };
}

describe('macOS bundle build inputs, fingerprint and currency', () => {
  test('the fingerprint changes with the launcher source, version, compiler flags and icon, and only with them', () => {
    const s = bundleStand();
    try {
      const icon = join(s.work, 'icon.svg');
      writeFileSync(icon, '<svg xmlns="http://www.w3.org/2000/svg"/>');
      const base = { sourceFile: s.sourceFile, version: '1.0.0', iconPath: icon };
      const before = planBundle(base).fingerprint;
      expect(planBundle(base).fingerprint).toBe(before);
      expect(planBundle({ ...base, identity: 'another signer' }).fingerprint).toBe(before);
      expect(planBundle({ ...base, version: '1.0.1' }).fingerprint).not.toBe(before);
      expect(planBundle({ ...base, extraCFlags: ['-DEXTRA'] }).fingerprint).not.toBe(before);
      writeFileSync(icon, '<svg xmlns="http://www.w3.org/2000/svg" width="2"/>');
      expect(planBundle(base).fingerprint).not.toBe(before);
      writeFileSync(icon, '<svg xmlns="http://www.w3.org/2000/svg"/>');
      writeFileSync(s.sourceFile, 'int main(void) { return 1; }\n');
      expect(planBundle(base).fingerprint).not.toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test('the fingerprint of fixed inputs is pinned: the signing team is not part of it, so installed bundles stay current', () => {
    const s = bundleStand();
    try {
      const icon = join(s.work, 'icon.svg');
      writeFileSync(icon, '<svg xmlns="http://www.w3.org/2000/svg"/>');
      // The value every bundle built from these inputs records. A change here rebuilds — and re-asks
      // Local Network permission on — every installed Mac, so it is a decision, never a side effect.
      expect(planBundle({ sourceFile: s.sourceFile, version: '1.0.0', iconPath: icon }).fingerprint).toBe(
        '363b022ea07fc2a09ce04ee4cd6941bf8691bd0dcc0afcbe025b695d329c8ffd',
      );
    } finally {
      s.cleanup();
    }
  });

  test('a rebuild keeps the installed bundle’s team: ensure passes it on, and a built bundle of another team is refused', () => {
    const s = bundleStand();
    try {
      const options = { installDir: s.work, sourceFile: s.sourceFile, version: '1.0.0' };
      const plan = planBundle(options);
      const deps = { verify: () => validDetails, readFingerprint: () => 'stale', install: s.install };
      ensureSignedBundle(options, deps);
      ensureSignedBundle({ ...options, force: true }, deps);
      ensureSignedBundle(options, {
        ...deps,
        verify: () => {
          throw new Error('codesign --verify: invalid signature');
        },
      });
      expect(s.teams).toEqual([validDetails.teamIdentifier, validDetails.teamIdentifier, null]);

      const built = (teamIdentifier: string) => ({
        verify: () => ({ ...validDetails, teamIdentifier }),
        readFingerprint: () => plan.fingerprint,
      });
      expect(() => checkBuiltBundle(s.app, plan, 'TEAM123456', built('OTHER12345'))).toThrow(
        'the new bundle is signed by team OTHER12345, the installed one by team TEAM123456',
      );
      expect(() => checkBuiltBundle(s.app, plan, 'TEAM123456', built('TEAM123456'))).not.toThrow();
      expect(() => checkBuiltBundle(s.app, plan, null, built('OTHER12345'))).not.toThrow();
      expect(() =>
        checkBuiltBundle(s.app, plan, null, { ...built('TEAM123456'), readFingerprint: () => 'other' }),
      ).toThrow(`records fingerprint other, expected ${plan.fingerprint}`);
    } finally {
      s.cleanup();
    }
  });

  test('labelled, length-prefixed parts never collide when bytes move between neighbours', () => {
    expect(
      buildFingerprint([
        ['a', 'xy'],
        ['b', 'z'],
      ]),
    ).not.toBe(
      buildFingerprint([
        ['a', 'x'],
        ['b', 'yz'],
      ]),
    );
  });

  test('a changed launcher source under a still-valid old signature is rebuilt without --force', () => {
    const s = bundleStand();
    try {
      const options = { installDir: s.work, sourceFile: s.sourceFile, version: '1.0.0' };
      let recorded: string | null = planBundle(options).fingerprint;
      const deps = { verify: () => validDetails, readFingerprint: () => recorded, install: s.install };

      const current = ensureSignedBundle(options, deps);
      expect(current).toMatchObject({ state: 'current', cdHash: validDetails.cdHash, fingerprint: recorded });
      expect(s.installs).toHaveLength(0);

      writeFileSync(s.sourceFile, 'int main(void) { return 3; }\n');
      const changed = ensureSignedBundle(options, deps);
      expect(changed.state).toBe('installed');
      expect(changed.state === 'installed' && changed.reason).toContain(`installed fingerprint ${recorded}`);
      expect(s.installs).toEqual([planBundle(options).fingerprint]);

      // A bundle built before fingerprints existed records none and is rebuilt.
      recorded = null;
      const legacy = ensureSignedBundle(options, deps);
      expect(legacy.state === 'installed' && legacy.reason).toContain('installed fingerprint none');

      // A new version alone also rebuilds.
      recorded = planBundle(options).fingerprint;
      expect(ensureSignedBundle(options, deps).state).toBe('current');
      expect(ensureSignedBundle({ ...options, version: '1.0.1' }, deps).state).toBe('installed');
    } finally {
      s.cleanup();
    }
  });

  test('a rebuild names its reason: failed verification, missing executable or --force', () => {
    const s = bundleStand();
    try {
      const options = { installDir: s.work, sourceFile: s.sourceFile, version: '1.0.0' };
      const recorded = planBundle(options).fingerprint;
      const broken = ensureSignedBundle(options, {
        verify: () => {
          throw new Error('codesign --verify: a sealed resource is missing or invalid');
        },
        readFingerprint: () => recorded,
        install: s.install,
      });
      expect(broken.state === 'installed' && broken.reason).toBe(
        'installed bundle failed verification: codesign --verify: a sealed resource is missing or invalid',
      );

      const deps = { verify: () => validDetails, readFingerprint: () => recorded, install: s.install };
      const forced = ensureSignedBundle({ ...options, force: true }, deps);
      expect(forced.state === 'installed' && forced.reason).toBe('forced');

      rmSync(join(s.app, 'Contents/MacOS', DEFAULT_EXECUTABLE));
      const missing = ensureSignedBundle(options, deps);
      expect(missing.state === 'installed' && missing.reason).toContain('does not exist');
      expect(s.installs).toHaveLength(3);
    } finally {
      s.cleanup();
    }
  });

  test('Info.plist sets background agent identity, icon and Local Network scope only', () => {
    const plist = buildInfoPlist({ version: '1.2.3' });
    expect(plist).toMatchObject({
      CFBundleIdentifier: DEFAULT_BUNDLE_ID,
      CFBundleExecutable: DEFAULT_EXECUTABLE,
      CFBundleIconFile: 'AppIcon',
      CFBundleShortVersionString: '1.2.3',
      CFBundleVersion: '1.2.3',
      LSBackgroundOnly: true,
    });
    expect(typeof plist.NSLocalNetworkUsageDescription).toBe('string');
    expect(plist.NSAppleEventsUsageDescription).toBeUndefined();
    expect(plist.NSMicrophoneUsageDescription).toBeUndefined();
  });

  test('default brand mascot icon exists and frames into an Apple squircle SVG', () => {
    expect(existsSync(DEFAULT_BRAND_ICON)).toBe(true);
    const svg = framedJpegIconSvg(DEFAULT_BRAND_ICON);
    expect(svg).toContain('clipPath id="squircle"');
    expect(svg).toContain('data:image/jpeg;base64,');
    expect(resolveIconSource().bytes.toString()).toBe(svg);
    if (isDarwin) {
      const resources = mkdtempSync(join(tmpdir(), 'stitchwire-icns-test-'));
      try {
        buildIcns(resources, resolveIconSource());
        const icnsPath = join(resources, 'AppIcon.icns');
        expect(existsSync(icnsPath)).toBe(true);
        expect(readFileSync(icnsPath).subarray(0, 4).toString('ascii')).toBe('icns');
      } finally {
        rmSync(resources, { recursive: true, force: true });
      }
    }
  });

  test('com.stitchwire.agent.plist template runs through Stitchwire.app with Umask 63 and --config', () => {
    const xml = readFileSync(PLIST_PATH, 'utf8');
    expect(xml).toContain(
      '<string>/Users/USERNAME/Applications/Stitchwire.app/Contents/MacOS/stitchwire-launcher</string>',
    );
    expect(xml).toContain('<string>/Users/USERNAME/.bun/bin/bun</string>');
    expect(xml).toContain('<string>/Users/USERNAME/.local/bin/stitchwire</string>');
    expect(xml).toContain('<string>--config</string>');
    expect(xml).toContain('<key>Umask</key>');
    expect(xml).toContain('<integer>63</integer>');
    // A machine without a Developer ID is told how to run without the launcher.
    expect(xml.replace(/\s+/g, ' ')).toContain('delete the stitchwire-launcher line from ProgramArguments');
    if (isDarwin) {
      runStrict(['plutil', '-lint', PLIST_PATH], 'plutil -lint');
    }
  });

  test('the default launcher source is the contrib one', () => {
    expect(DEFAULT_LAUNCHER_SOURCE).toBe(join(ROOT, 'contrib/launchd/stitchwire-launcher.c'));
  });
});

describe('staging: each run owns only its candidate, and a failed rollback is kept for recovery', () => {
  test('a refused build removes its own candidate and leaves another run’s candidate in place', () => {
    const work = mkdtempSync(join(tmpdir(), 'stitchwire-staging-'));
    try {
      const sourceFile = join(work, 'launcher.c');
      writeFileSync(sourceFile, 'int main(void) { return 0; }\n');
      const stagingRoot = join(work, 'Stitchwire.app.install.noindex');
      const other = join(stagingRoot, 'candidate-other-run');
      mkdirSync(join(other, 'Candidate.app'), { recursive: true });
      expect(() =>
        installSignedBundle({ installDir: work, sourceFile, version: '1.0.0', identity: '-' }),
      ).toThrow(/fail-closed/);
      expect(readdirSync(stagingRoot)).toEqual(['candidate-other-run']);
      expect(existsSync(join(other, 'Candidate.app'))).toBe(true);

      // With no other candidate left, the run removes the staging root as well.
      rmSync(other, { recursive: true });
      expect(() =>
        installSignedBundle({ installDir: work, sourceFile, version: '1.0.0', identity: '-' }),
      ).toThrow(/fail-closed/);
      expect(existsSync(stagingRoot)).toBe(false);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('an AggregateError from the build is an ordinary failure: no recovery marker, and the next run proceeds', () => {
    const work = mkdtempSync(join(tmpdir(), 'stitchwire-aggregate-'));
    try {
      const installed = join(work, 'Installed.app');
      mkdirSync(installed);
      const foreign = new AggregateError(
        [new Error('icon'), new Error('codesign')],
        'two build steps failed',
      );
      expect(() =>
        replaceThroughStaging(
          installed,
          () => {
            throw foreign;
          },
          () => {},
        ),
      ).toThrow('two build steps failed');
      expect(existsSync(`${installed}.install.noindex`)).toBe(false);
      let built = false;
      expect(() =>
        replaceThroughStaging(
          installed,
          () => {
            built = true;
            throw new Error('stop after the build ran');
          },
          () => {},
        ),
      ).toThrow('stop after the build ran');
      expect(built).toBe(true);
      expect(new BundleRollbackFailed([], 'x')).toBeInstanceOf(AggregateError);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('a failed rollback keeps the candidate with a recovery marker, and the next run refuses to touch it', () => {
    const work = mkdtempSync(join(tmpdir(), 'stitchwire-recovery-'));
    try {
      const installed = join(work, 'Installed.app');
      mkdirSync(installed);
      writeFileSync(join(installed, 'version.txt'), 'old');
      let exchanges = 0;
      const exchange = (staged: string, target: string) => {
        exchanges += 1;
        if (exchanges === 2) throw new Error('rollback exchange failed');
        // A stand-in swap: the old bundle moves into the candidate, the new one into place.
        const hold = `${target}.hold`;
        mkdirSync(hold);
        writeFileSync(join(hold, 'version.txt'), readFileSync(join(target, 'version.txt')));
        writeFileSync(join(target, 'version.txt'), readFileSync(join(staged, 'version.txt')));
        writeFileSync(join(staged, 'version.txt'), readFileSync(join(hold, 'version.txt')));
        rmSync(hold, { recursive: true });
      };
      let verifications = 0;
      const verify = () => {
        verifications += 1;
        if (verifications === 2) throw new Error('post-swap verification failed');
      };
      const build = (staged: string) => {
        mkdirSync(staged);
        writeFileSync(join(staged, 'version.txt'), 'new');
      };
      expect(() => replaceThroughStaging(installed, build, verify, exchange)).toThrow(
        /rollback failed; the previous bundle is at/,
      );

      const stagingRoot = `${installed}.install.noindex`;
      const [kept] = readdirSync(stagingRoot);
      const keptDir = join(stagingRoot, kept ?? '');
      expect(readFileSync(join(keptDir, RECOVERY_MARKER), 'utf8')).toContain('post-swap verification failed');
      expect(readFileSync(join(keptDir, 'Candidate.app/version.txt'), 'utf8')).toBe('old');

      let rebuilt = false;
      expect(() =>
        replaceThroughStaging(
          installed,
          () => {
            rebuilt = true;
          },
          () => {},
          exchange,
        ),
      ).toThrow(/kept for recovery/);
      expect(rebuilt).toBe(false);
      expect(readdirSync(stagingRoot)).toEqual([kept ?? '']);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe.if(isDarwin)('atomic bundle swap and recorded fingerprint (macOS)', () => {
  test('atomic install rolls back and retains previous bundle if post-swap verification fails', () => {
    const work = mkdtempSync(join(tmpdir(), 'stitchwire-swap-'));
    try {
      const installed = join(work, 'Installed.app');
      const staged = join(work, 'Staged.app');
      mkdirSync(installed, { recursive: true });
      mkdirSync(staged, { recursive: true });
      writeFileSync(join(installed, 'version.txt'), 'old');
      writeFileSync(join(staged, 'version.txt'), 'new');

      let calls = 0;
      expect(() =>
        installVerifiedBundle(staged, installed, () => {
          calls += 1;
          if (calls === 2) throw new Error('corrupted post-swap signature');
        }),
      ).toThrow(/corrupted post-swap signature/);

      expect(readFileSync(join(installed, 'version.txt'), 'utf8')).toBe('old');
      expect(readFileSync(join(staged, 'version.txt'), 'utf8')).toBe('new');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('a refused exchange names the errno renameatx_np returned', () => {
    const work = mkdtempSync(join(tmpdir(), 'stitchwire-errno-'));
    try {
      expect(() => exchangeBundles(join(work, 'absent-a.app'), join(work, 'absent-b.app'))).toThrow(
        /renameatx_np: ENOENT/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('the Info.plist the build writes records the fingerprint the plan gives, and ensure reads it back', () => {
    const s = bundleStand();
    try {
      const options = { installDir: s.work, sourceFile: s.sourceFile, version: '1.0.0' };
      writeFileSync(
        join(s.app, 'Contents/Info.plist'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleVersion</key><string>0</string></dict></plist>\n',
      );
      expect(readBundleFingerprint(s.app)).toBeNull();
      writeInfoPlist(join(s.app, 'Contents'), planBundle(options));
      expect(readBundleFingerprint(s.app)).toBe(planBundle(options).fingerprint);
      const deps = { verify: () => validDetails, install: s.install };
      expect(ensureSignedBundle(options, deps).state).toBe('current');
      writeFileSync(s.sourceFile, 'int main(void) { return 4; }\n');
      expect(ensureSignedBundle(options, deps).state).toBe('installed');
      expect(() => readBundleFingerprint(join(s.work, 'Absent.app'))).toThrow(
        /couldn’t be opened|no such file/i,
      );
    } finally {
      s.cleanup();
    }
  });
});
