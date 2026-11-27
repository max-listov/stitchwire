/**
 * Fail-closed Developer ID Application code-signing discovery and strict bundle verification.
 */
export type CodesignDetails = {
  identifier: string | null;
  authorities: string[];
  teamIdentifier: string | null;
  cdHash: string | null;
};

export function runStrict(command: string[], label: string): string {
  const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    const detail = result.stderr.toString().trim() || result.stdout.toString().trim();
    throw new Error(`${label}: ${detail || `exit ${result.exitCode}`}`);
  }
  return result.stdout.toString();
}

/** A valid Developer ID Application signing identity in the keychain. */
export type SigningIdentity = { sha1: string; name: string; team: string };

/** Every valid Developer ID Application identity, in the order `security find-identity` lists them. */
export function listDeveloperIds(
  finder: () => string = () =>
    runStrict(['security', 'find-identity', '-v', '-p', 'codesigning'], 'security find-identity'),
): SigningIdentity[] {
  const identities: SigningIdentity[] = [];
  for (const match of finder().matchAll(
    /^\s*\d+\)\s+([0-9A-F]{40})\s+"(Developer ID Application: .*\(([A-Z0-9]{10})\))"/gm,
  )) {
    const [, sha1, name, team] = match;
    if (sha1 && name && team) identities.push({ sha1, name, team });
  }
  return identities;
}

function refuse(reason: string): never {
  throw new Error(`codesign refused (fail-closed): ${reason}`);
}

const listed = (identities: SigningIdentity[]) =>
  identities.map((identity) => `${identity.sha1} "${identity.name}"`).join('; ');

/**
 * The identity to sign with; never ad-hoc. An explicit one is used as given (blank or `-` refused).
 * Otherwise one is chosen from the keychain, and only when the choice cannot change who macOS thinks
 * the bundle is: the designated requirement names the team, so a rebuild keeps the team the installed
 * bundle is signed by, and with no installed team every candidate must belong to one team.
 */
export function resolveSigningIdentity(
  identity: string | null | undefined,
  bundleName: string,
  installedTeam: string | null = null,
  list: () => SigningIdentity[] = listDeveloperIds,
): string {
  if (identity !== undefined) {
    const trimmed = identity?.trim() ?? '';
    if (trimmed.length === 0 || trimmed === '-')
      refuse(`Developer ID Application identity required for ${bundleName} (ad-hoc signing is forbidden)`);
    return trimmed;
  }
  const identities = list();
  if (identities.length === 0)
    refuse(`Developer ID Application identity required for ${bundleName} (ad-hoc signing is forbidden)`);
  if (installedTeam !== null) {
    const same = identities.find((candidate) => candidate.team === installedTeam);
    if (same === undefined)
      refuse(
        `the installed ${bundleName} is signed by team ${installedTeam}, and no Developer ID Application identity of that team is in the keychain (found: ${listed(identities)}); install that team's identity, or remove the installed bundle to change teams on purpose`,
      );
    return same.sha1;
  }
  const teams = new Set(identities.map((candidate) => candidate.team));
  const [first] = identities;
  if (teams.size > 1 || first === undefined)
    refuse(
      `several Developer ID Application identities of different teams can sign ${bundleName}: ${listed(identities)}; choose one with --identity <SHA-1>`,
    );
  return first.sha1;
}

/** The team a signed bundle is required to keep, as a refusal reason, or null when it keeps it. */
export function teamChangeRefusal(details: CodesignDetails, installedTeam: string | null): string | null {
  if (installedTeam === null || details.teamIdentifier === installedTeam) return null;
  return `the new bundle is signed by team ${details.teamIdentifier ?? 'none'}, the installed one by team ${installedTeam}: macOS ties Local Network permission to the team, so it would ask again; sign with that team's identity, or remove the installed bundle to change teams on purpose`;
}

/** Parse `codesign -dvvv` stderr output into structured signing identity fields. */
export function parseCodesignDetails(stderr: string): CodesignDetails {
  let identifier: string | null = null;
  let teamIdentifier: string | null = null;
  let cdHash: string | null = null;
  const authorities: string[] = [];
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('Identifier=')) identifier = line.slice('Identifier='.length);
    else if (line.startsWith('Authority=')) authorities.push(line.slice('Authority='.length));
    else if (line.startsWith('TeamIdentifier=')) teamIdentifier = line.slice('TeamIdentifier='.length);
    else if (line.startsWith('CDHash=')) cdHash = line.slice('CDHash='.length);
  }
  return { identifier, authorities, teamIdentifier, cdHash };
}

export function formatCodesignSummary(details: CodesignDetails): string {
  const parts: string[] = [];
  if (details.identifier) parts.push(`Identifier=${details.identifier}`);
  for (const authority of details.authorities) parts.push(`Authority=${authority}`);
  if (details.teamIdentifier) parts.push(`TeamIdentifier=${details.teamIdentifier}`);
  if (details.cdHash) parts.push(`CDHash=${details.cdHash}`);
  return parts.join(' | ');
}

/** Apple-anchored Developer ID Application chain of `teamId`: Developer ID CA intermediate and leaf, team as leaf OU. */
export function developerIdRequirement(teamId: string): string {
  if (!/^[A-Z0-9]{10}$/.test(teamId))
    throw new Error(`codesign verification refused: malformed TeamIdentifier ${teamId}`);
  return [
    'anchor apple generic',
    'certificate 1[field.1.2.840.113635.100.6.2.6] exists',
    'certificate leaf[field.1.2.840.113635.100.6.1.13] exists',
    `certificate leaf[subject.OU] = "${teamId}"`,
  ].join(' and ');
}

/** Enforce the exact CFBundleIdentifier and a real TeamIdentifier, which it returns; `developerIdRequirement` checks the chain. */
export function assertCodesignDetails(details: CodesignDetails, expectedBundleId: string): string {
  if (details.identifier !== expectedBundleId) {
    throw new Error(
      `codesign verification refused: expected Identifier=${expectedBundleId}, got ${details.identifier ?? 'missing'}`,
    );
  }
  if (!details.teamIdentifier || details.teamIdentifier === 'not set') {
    throw new Error(
      `codesign verification refused: valid TeamIdentifier required (got ${details.teamIdentifier ?? 'missing'})`,
    );
  }
  return details.teamIdentifier;
}

/**
 * Verify the bundle's integrity and that its signer is an Apple-issued Developer ID Application certificate of the
 * team it names. Names in `Authority=` lines prove nothing: a self-signed certificate can carry any of them.
 */
export function verifySignedBundle(appPath: string, expectedBundleId: string): CodesignDetails {
  const inspect = Bun.spawnSync(['codesign', '-dvvv', appPath], { stdout: 'pipe', stderr: 'pipe' });
  if (inspect.exitCode !== 0) {
    const detail = inspect.stderr.toString().trim() || inspect.stdout.toString().trim();
    throw new Error(`codesign -dvvv: ${detail || `exit ${inspect.exitCode}`}`);
  }
  const details = parseCodesignDetails(inspect.stderr.toString());
  const teamId = assertCodesignDetails(details, expectedBundleId);
  runStrict(
    ['codesign', '--verify', '--strict', `-R=${developerIdRequirement(teamId)}`, appPath],
    'codesign --verify (Developer ID Application chain)',
  );
  return details;
}
