import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_BUNDLE_ID, DEFAULT_EXECUTABLE, planBundle } from '../scripts/macos/bundle-plan.ts';
import {
  assertCodesignDetails,
  developerIdRequirement,
  listDeveloperIds,
  parseCodesignDetails,
  resolveSigningIdentity,
  runStrict,
  verifySignedBundle,
} from '../scripts/macos/codesign.ts';
import { buildSignedBundle, writeInfoPlist } from '../scripts/macos-bundle.ts';

const isDarwin = process.platform === 'darwin';

describe('Developer ID discovery, fail-closed signing and verification inputs', () => {
  const A = {
    sha1: 'A'.repeat(40),
    name: 'Developer ID Application: First Corp (TEAMAAAAAA)',
    team: 'TEAMAAAAAA',
  };
  const B = {
    sha1: 'B'.repeat(40),
    name: 'Developer ID Application: Second Corp (TEAMBBBBBB)',
    team: 'TEAMBBBBBB',
  };

  test('listDeveloperIds lists every Developer ID Application identity with its team and ignores other kinds', () => {
    const sample = [
      '  1) DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD "Apple Development: Example (TEAMDDDDDD)"',
      `  2) ${A.sha1} "${A.name}"`,
      '  3) CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC "Apple Distribution: Example (TEAMAAAAAA)"',
      `  4) ${B.sha1} "${B.name}"`,
      '     4 valid identities found',
    ].join('\n');
    expect(listDeveloperIds(() => sample)).toEqual([A, B]);
    expect(listDeveloperIds(() => sample.split('\n')[0] ?? '')).toEqual([]);
  });

  test('with two teams in the keychain the installed bundle’s team is kept; without one the choice is refused', () => {
    expect(resolveSigningIdentity(undefined, 'Stitchwire', B.team, () => [A, B])).toBe(B.sha1);
    expect(resolveSigningIdentity(undefined, 'Stitchwire', A.team, () => [A, B])).toBe(A.sha1);
    expect(() => resolveSigningIdentity(undefined, 'Stitchwire', null, () => [A, B])).toThrow(
      `several Developer ID Application identities of different teams can sign Stitchwire: ${A.sha1} "${A.name}"; ${B.sha1} "${B.name}"; choose one with --identity <SHA-1>`,
    );
    expect(() => resolveSigningIdentity(undefined, 'Stitchwire', 'TEAMCCCCCC', () => [A, B])).toThrow(
      /signed by team TEAMCCCCCC, and no Developer ID Application identity of that team/,
    );
    // One team, however many of its certificates, is no choice at all: the first is taken.
    const renewed = { ...A, sha1: 'E'.repeat(40) };
    expect(resolveSigningIdentity(undefined, 'Stitchwire', null, () => [A, renewed])).toBe(A.sha1);
    expect(resolveSigningIdentity(undefined, 'Stitchwire', null, () => [B])).toBe(B.sha1);
    // An explicit identity is used as given, and the keychain is not asked.
    expect(
      resolveSigningIdentity(' Developer ID Application: Second Corp ', 'Stitchwire', null, () => {
        throw new Error('the keychain was asked');
      }),
    ).toBe('Developer ID Application: Second Corp');
  });

  test('resolveSigningIdentity and buildSignedBundle explicitly refuse ad-hoc ("-") and blank identities', () => {
    for (const rejected of [null, '', '   ', '-', ' - ']) {
      expect(() => resolveSigningIdentity(rejected, 'Stitchwire', null, () => [A])).toThrow(/fail-closed/);
    }
    expect(() => resolveSigningIdentity(undefined, 'Stitchwire', null, () => [])).toThrow(/fail-closed/);
    const work = mkdtempSync(join(tmpdir(), 'stitchwire-unsigned-'));
    try {
      const plan = planBundle({ version: '1.0.0' });
      for (const rejected of [null, '', '   ', '-']) {
        expect(() => buildSignedBundle(join(work, 'Stitchwire.app'), plan, rejected)).toThrow(/fail-closed/);
      }
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  test('parseCodesignDetails reads identity fields; assertCodesignDetails requires the identifier and a real team', () => {
    const valid = parseCodesignDetails(
      [
        'Executable=/Applications/Stitchwire.app/Contents/MacOS/stitchwire-launcher',
        'Identifier=com.stitchwire.app',
        'Format=app bundle with Mach-O thin (arm64)',
        'CDHash=deadbeef0123456789abcdef',
        'Authority=Developer ID Application: Example Corp (TEAM123456)',
        'Authority=Developer ID Certification Authority',
        'Authority=Apple Root CA',
        'TeamIdentifier=TEAM123456',
      ].join('\n'),
    );
    expect(valid).toEqual({
      identifier: 'com.stitchwire.app',
      authorities: [
        'Developer ID Application: Example Corp (TEAM123456)',
        'Developer ID Certification Authority',
        'Apple Root CA',
      ],
      teamIdentifier: 'TEAM123456',
      cdHash: 'deadbeef0123456789abcdef',
    });
    expect(assertCodesignDetails(valid, 'com.stitchwire.app')).toBe('TEAM123456');
    expect(() =>
      assertCodesignDetails({ ...valid, teamIdentifier: 'not set' }, 'com.stitchwire.app'),
    ).toThrow(/valid TeamIdentifier required/);
    expect(() => assertCodesignDetails(valid, 'com.other.app')).toThrow(
      /expected Identifier=com\.other\.app/,
    );
  });

  test('the requirement pins the Apple anchor, Developer ID intermediate and leaf, and the team; a malformed team is refused', () => {
    expect(developerIdRequirement('TEAM123456')).toBe(
      'anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "TEAM123456"',
    );
    for (const malformed of ['', 'team', 'TEAM12345" or anchor trusted', 'TEAM1234567']) {
      expect(() => developerIdRequirement(malformed)).toThrow(/malformed TeamIdentifier/);
    }
  });
});

/** A minimal bundle with the Stitchwire identifier, unsigned. */
function minimalBundle(work: string, name: string): string {
  const app = join(work, `${name}.app`);
  const source = join(work, `${name}.c`);
  writeFileSync(source, 'int main(void) { return 0; }\n');
  writeInfoPlist(join(app, 'Contents'), planBundle({ version: '1.0.0', sourceFile: source }));
  mkdirSync(join(app, 'Contents/MacOS'), { recursive: true });
  runStrict(['clang', source, '-o', join(app, 'Contents/MacOS', DEFAULT_EXECUTABLE)], 'clang');
  return app;
}

describe.if(isDarwin)('verifySignedBundle checks the Apple chain, not certificate names (macOS)', () => {
  test('a self-signed "Developer ID Application" certificate with a forged team is refused by the chain requirement', () => {
    const work = mkdtempSync(join(tmpdir(), 'stitchwire-forged-'));
    const keychain = join(work, 'forged.keychain-db');
    const searchList = () =>
      runStrict(['security', 'list-keychains', '-d', 'user'], 'security list-keychains');
    const before = searchList();
    try {
      writeFileSync(
        join(work, 'cert.cnf'),
        [
          '[req]',
          'distinguished_name=dn',
          'x509_extensions=ext',
          'prompt=no',
          '[dn]',
          'CN=Developer ID Application: Forged Signer (ABCDE12345)',
          'OU=ABCDE12345',
          '[ext]',
          'basicConstraints=critical,CA:false',
          'keyUsage=critical,digitalSignature',
          'extendedKeyUsage=critical,codeSigning',
          // The Developer ID leaf marker itself: only the Apple anchor can tell this certificate from a real one.
          '1.2.840.113635.100.6.1.13=ASN1:NULL',
          '',
        ].join('\n'),
      );
      const key = join(work, 'key.pem');
      const cert = join(work, 'cert.pem');
      runStrict(
        [
          'openssl',
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          key,
          '-out',
          cert,
          '-days',
          '1',
          '-config',
          join(work, 'cert.cnf'),
        ],
        'openssl req',
      );
      // A keychain file of its own: it is never added to the user's search list.
      runStrict(['security', 'create-keychain', '-p', 'forged', keychain], 'security create-keychain');
      runStrict(['security', 'unlock-keychain', '-p', 'forged', keychain], 'security unlock-keychain');
      runStrict(
        ['security', 'import', key, '-k', keychain, '-T', '/usr/bin/codesign'],
        'security import key',
      );
      runStrict(['security', 'import', cert, '-k', keychain], 'security import cert');
      runStrict(
        ['security', 'set-key-partition-list', '-S', 'apple-tool:,apple:', '-s', '-k', 'forged', keychain],
        'security set-key-partition-list',
      );
      const identities = runStrict(
        ['security', 'find-identity', '-p', 'codesigning', keychain],
        'security find-identity',
      );
      const forged = /([0-9A-F]{40}) "Developer ID Application: Forged Signer/.exec(identities)?.[1];
      expect(forged).toBeDefined();

      const app = minimalBundle(work, 'Forged');
      runStrict(
        [
          'codesign',
          '--force',
          '--keychain',
          keychain,
          '--sign',
          forged ?? '',
          '--team-identifier',
          'ABCDE12345',
          '--timestamp=none',
          app,
        ],
        'codesign forged',
      );
      // Everything a name-based check reads looks like Developer ID.
      const shown = parseCodesignDetails(
        Bun.spawnSync(['codesign', '-dvvv', app], { stderr: 'pipe' }).stderr.toString(),
      );
      expect(shown.authorities[0]).toBe('Developer ID Application: Forged Signer (ABCDE12345)');
      expect(shown.teamIdentifier).toBe('ABCDE12345');
      runStrict(['codesign', '--verify', '--strict', app], 'codesign --verify');

      expect(() => verifySignedBundle(app, DEFAULT_BUNDLE_ID)).toThrow(
        /Developer ID Application chain\): .*failed to satisfy specified code requirement/,
      );
    } finally {
      Bun.spawnSync(['security', 'delete-keychain', keychain]);
      rmSync(work, { recursive: true, force: true });
    }
    expect(searchList()).toBe(before);
  });

  test('an ad-hoc signature that claims a team is refused by the chain requirement', () => {
    const work = mkdtempSync(join(tmpdir(), 'stitchwire-adhoc-'));
    try {
      const app = minimalBundle(work, 'AdHoc');
      runStrict(
        ['codesign', '--force', '--sign', '-', '--team-identifier', 'ABCDE12345', app],
        'codesign ad-hoc',
      );
      expect(() => verifySignedBundle(app, DEFAULT_BUNDLE_ID)).toThrow(
        /failed to satisfy specified code requirement/,
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
