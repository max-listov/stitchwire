#!/usr/bin/env bun

import { basename } from 'node:path';

const ForbiddenPathPatterns = [
  // Allow the documented launchd plist placeholder `/Users/USERNAME` as a whole path segment; refuse
  // any real or synthetic user home, including one that merely starts with the placeholder.
  { label: 'macOS user-home path', pattern: /\/Users\/(?!USERNAME(?=[/\s"'`<\\]|$))[^/\s"'`]+/g },
  { label: 'Linux user-home path', pattern: /\/home\/[^/\s"'`]+/g },
  { label: 'Linux root-home path', pattern: /\/root\/[^/\s"'`]+/g },
  { label: 'Windows user-home path', pattern: /[A-Za-z]:\\Users\\[^\\\s"'`]+/g },
];

const ForbiddenSecretPatterns = [
  { label: 'private-key header', pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----/g },
  { label: 'GitHub token shape', pattern: /gh[pousr]_[A-Za-z0-9_]{20,}/g },
  { label: 'AWS access-key shape', pattern: /AKIA[0-9A-Z]{16}/g },
];

export async function assertArtifactPrivacy(path: string, rollbackBinary = false): Promise<void> {
  const contents = await Bun.file(path).text();
  const patterns = rollbackBinary
    ? ForbiddenSecretPatterns
    : [...ForbiddenPathPatterns, ...ForbiddenSecretPatterns];
  const violations = patterns.flatMap(({ label, pattern }) =>
    [...contents.matchAll(pattern)].map((match) => `${label} at byte ${match.index ?? 0}`),
  );
  if (violations.length > 0) {
    throw new Error(`${basename(path)} failed artifact privacy: ${violations.join(', ')}`);
  }
}

if (import.meta.main) {
  const artifacts = process.argv.slice(2);
  if (artifacts.length === 0) {
    throw new Error('usage: bun scripts/artifact-privacy.ts <candidate> [--rollback-binary <rollback>]');
  }
  let scanned = 0;
  for (let index = 0; index < artifacts.length; index += 1) {
    const value = artifacts[index];
    if (value === undefined) continue;
    if (value === '--rollback-binary') {
      const rollback = artifacts[index + 1];
      if (rollback === undefined) throw new Error('--rollback-binary needs a path');
      await assertArtifactPrivacy(rollback, true);
      index += 1;
      scanned += 1;
      continue;
    }
    await assertArtifactPrivacy(value);
    scanned += 1;
  }
  console.log(`artifact privacy: ${scanned} file(s) green`);
}
