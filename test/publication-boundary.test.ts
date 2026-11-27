import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  auditContent,
  auditHistory,
  auditSecrets,
  InventorySchema,
  inspectContent,
  inspectSecrets,
} from '../scripts/content-audit.ts';
import {
  assertClientDocumentationCurrent,
  assertPublicationBoundaries,
} from '../scripts/publication-guard.ts';

test('content audit reports location and opaque label, never the matched material', () => {
  const sensitive = ['synthetic', 'confidential', 'reference'].join('-');
  const findings = inspectContent('example.txt', sensitive.toUpperCase(), [
    { label: 'operator-1', literal: sensitive },
  ]);
  expect(findings).toEqual([{ path: 'example.txt', label: 'operator-1', offset: 0 }]);
  expect(JSON.stringify(findings)).not.toContain(sensitive);
  expect(
    inspectContent('clean.txt', 'transport only', [{ label: 'operator-1', literal: sensitive }]),
  ).toEqual([]);
});

test('an owner rule excepts only the whole public names, never a longer repository built on them', () => {
  const rule = {
    label: 'owner',
    literal: 'example-owner',
    except: ['example-owner/public-name', 'example-owner/other-public'],
  };
  const found = (text: string) => inspectContent('doc.md', text, [rule]).map((finding) => finding.offset);
  for (const excepted of [
    'see github.com/example-owner/public-name.',
    'git+https://github.com/example-owner/public-name.git"',
    '(https://github.com/Example-Owner/Public-Name/blob/v1.0.0/README.md)',
    'example-owner/other-public and example-owner/public-name',
  ])
    expect(found(excepted)).toEqual([]);
  // A private sibling shares the public prefix; every one of them is a finding.
  for (const sibling of [
    'example-owner/public-name-dev',
    'example-owner/public-name_next',
    'example-owner/public-name.dev',
    'example-owner/public-names',
    'example-owner/private-thing',
    'https://github.com/example-owner',
  ])
    expect(found(sibling)).toEqual([sibling.indexOf('example-owner')]);
  // An excepted name first does not hide a private one later in the same file.
  expect(found('example-owner/public-name then example-owner/public-name-dev')).toEqual([31]);
  // An exception that does not extend its literal cannot be declared.
  expect(() =>
    InventorySchema.parse([{ label: 'owner', literal: 'example-owner', except: ['other/name'] }]),
  ).toThrow('must start with the literal');
});

test('the publication guard accepts this tree and refuses --publish', async () => {
  await assertPublicationBoundaries(resolve(import.meta.dir, '..'));
  const child = Bun.spawn(['bun', resolve(import.meta.dir, '../scripts/publication-guard.ts'), '--publish'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  expect(code).not.toBe(0);
  expect(stderr).toContain('publication-guard never publishes');
});

test('packed client documentation rejects release literals and accepts the public install recipe', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-publication-docs-'));
  const directory = join(root, 'packages', 'client');
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'README.md'),
      'Install with `bun add @stitchwire/client`; versions come from package metadata.\n',
    );
    await expect(assertClientDocumentationCurrent(root)).resolves.toBeUndefined();

    const staleArchive = ['stitchwire-client', '0.5.1'].join('-');
    writeFileSync(join(directory, 'README.md'), `bun add ./${staleArchive}.tgz\n`);
    await expect(assertClientDocumentationCurrent(root)).rejects.toThrow('versioned Stitchwire archive');

    writeFileSync(
      join(directory, 'README.md'),
      'bun add @stitchwire/client\nStitchkit 0.80.0 is required.\n',
    );
    await expect(assertClientDocumentationCurrent(root)).rejects.toThrow('package metadata');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The gate has to REFUSE, and a refusal nobody has ever seen is indistinguishable from a check
 * that matches nothing.
 *
 * This is the negative control for the whole audit. The unit test above proves the matcher; this
 * proves the two things the matcher cannot: that walking a tree actually reaches a planted literal
 * wherever it sits, and that finding one sets a non-zero exit — the part publication turns on.
 *
 * The tree here is synthetic and so is the inventory. The real rules name private material and
 * live outside this repository on purpose, which is exactly why a test cannot use them and why
 * this one must not need them.
 */
test('a planted literal fails the audit, and a clean tree does not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-audit-'));
  try {
    mkdirSync(join(root, 'nested'));
    writeFileSync(join(root, 'nested', 'doc.md'), 'header\nplanted-operator-literal: someone\ntail\n');
    writeFileSync(join(root, 'clean.md'), 'transport only\n');
    const rules = [{ label: 'planted', literal: 'planted-operator-literal:' }];

    const findings = await auditContent(root, rules);
    expect(findings).toEqual([{ path: 'nested/doc.md', label: 'planted', offset: 7 }]);
    // The matched material never leaves the audit, only where it is.
    expect(JSON.stringify(findings)).not.toContain('someone');

    // And the same walk over the same tree must be silent for a literal that is not there — a
    // check that reports a finding either way reports nothing at all.
    expect(await auditContent(root, [{ label: 'absent', literal: 'not-in-this-tree' }])).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the audit command exits non-zero exactly when it finds something', async () => {
  const script = resolve(import.meta.dir, '../scripts/content-audit.ts');
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-inventory-'));
  try {
    const run = async (literal: string): Promise<number> => {
      const inventory = join(root, `${literal.replace(/[^a-z0-9]/gi, '')}.json`);
      writeFileSync(inventory, JSON.stringify([{ label: 'probe', literal }]));
      const child = Bun.spawn(['bun', script, '--inventory', inventory], { stdout: 'pipe', stderr: 'pipe' });
      const [code] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return code;
    };
    // A literal this repository certainly contains, and one it certainly does not. The absent one
    // is assembled at runtime rather than written out: spelled literally it would sit in this very
    // file, the walk would reach it, and the test would fail by proving its own point.
    const absent = ['literal', 'absent', 'from', 'this', 'repository'].join('-');
    expect(await run('stitchwire')).not.toBe(0);
    expect(await run(absent)).toBe(0);

    // `--root` points the same walk at another tree, and a flag that silently answered about the
    // wrong one would be the worst kind of clean report. Both directions: the planted literal is
    // found under that root and NOT found under this repository's default root.
    const elsewhere = mkdtempSync(join(root, 'other-'));
    const planted = ['planted', 'only', 'over', 'there'].join('-');
    writeFileSync(join(elsewhere, 'note.md'), `${planted}\n`);
    const inventory = join(root, 'rooted.json');
    writeFileSync(inventory, JSON.stringify([{ label: 'probe', literal: planted }]));
    const audit = async (...extra: string[]): Promise<number> => {
      const child = Bun.spawn(['bun', script, '--inventory', inventory, ...extra], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return code;
    };
    expect(await audit('--root', elsewhere)).not.toBe(0);
    expect(await audit()).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The audit walked the working tree and reported `historyReviewed: false` as a constant. That is
 * honest — it is "nobody looked", not "clean" — but a repository is published with its history, so
 * the question it declines to ask is the one that decides publication.
 *
 * The control here is deliberately placed where the blindness is: a literal that a later commit
 * REMOVED. The tree walk must stay silent on it — that silence is the defect being fixed, and
 * asserting it is what proves the two walks are not the same walk — while the history walk must
 * find it in a blob no checkout contains.
 */
test('a literal a later commit removed is invisible to the tree and found in the history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-history-'));
  const git = (...args: string[]): void => {
    const done = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (done.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr.toString()}`);
  };
  try {
    git('init', '--quiet');
    git('config', 'user.email', 'audit@example.invalid');
    git('config', 'user.name', 'audit');
    const planted = ['planted', 'operator', 'literal'].join('-');
    writeFileSync(join(root, 'note.md'), `before\n${planted}: someone\nafter\n`);
    git('add', '.');
    git('commit', '--quiet', '-m', 'first');
    // The removal any ordinary cleanup performs, and which a tree audit then calls clean.
    writeFileSync(join(root, 'note.md'), 'before\nafter\n');
    git('commit', '--quiet', '-am', 'remove it');

    // A second literal that only ever existed on a tag, and a third that only ever existed inside
    // a BINARY blob. Both were invisible to earlier drafts of this walk and neither showed up as a
    // failure, because the fixture had one branch and no binaries — a mutation that survives is a
    // comment promising more than the test asserts.
    const tagged = ['planted', 'on', 'a', 'tag', 'only'].join('-');
    writeFileSync(join(root, 'note.md'), `before\n${tagged}: someone\nafter\n`);
    git('commit', '--quiet', '-am', 'tagged content');
    git('tag', 'archived');
    git('reset', '--quiet', '--hard', 'HEAD~1');

    const binary = ['planted', 'inside', 'a', 'binary'].join('-');
    writeFileSync(
      join(root, 'blob.bin'),
      Buffer.concat([Buffer.from([0x00, 0x01, 0xff, 0xfe]), Buffer.from(binary), Buffer.from([0x00, 0xff])]),
    );
    git('add', '.');
    git('commit', '--quiet', '-m', 'a binary artifact');
    rmSync(join(root, 'blob.bin'));
    git('commit', '--quiet', '-am', 'remove the artifact');

    const rules = [{ label: 'planted', literal: planted }];
    expect(await auditContent(root, rules)).toEqual([]);

    const walked = await auditHistory(root, rules);
    expect(walked.findings.map((f) => ({ path: f.path, label: f.label }))).toEqual([
      { path: 'note.md', label: 'planted' },
    ]);
    expect(walked.blobs).toBeGreaterThan(0);

    // Reachable only from a tag: `--all` sees it, `HEAD` cannot.
    expect(
      (await auditHistory(root, [{ label: 'tagged', literal: tagged }])).findings.map((f) => f.path),
    ).toEqual(['note.md']);

    // Inside a binary: skipping these was a hole dressed as prudence.
    expect(
      (await auditHistory(root, [{ label: 'binary', literal: binary }])).findings.map((f) => f.path),
    ).toEqual(['blob.bin']);
    // The matched material never leaves the audit here either — only where it is.
    expect(JSON.stringify(walked.findings)).not.toContain('someone');

    // And the same walk over the same history is silent for a literal that was never in it: a
    // check that reports a finding either way reports nothing at all.
    const absent = ['never', 'committed', 'anywhere', 'here'].join('-');
    expect((await auditHistory(root, [{ label: 'absent', literal: absent }])).findings).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * `secretAudit` was a constant `false`, and unlike `historyReviewed` it stays a narrow claim even
 * when true: it says the named shapes were looked for, never that no secret is present. In this
 * repository a 64-character hex run is a SHA256 as often as it is a token — manifests, checksum
 * files and release records are full of them by design — so entropy cannot separate the two, and a
 * scanner built on it would report hundreds of digests and teach everyone to skip its output.
 *
 * What is pinned here is the discriminator, because it is the only part that can quietly hide a
 * real secret: it must exempt a fixture and refuse to exempt a passphrase.
 */
test('the credential shapes are found, and the exemptions do not cover a real passphrase', () => {
  // Every sample is assembled at runtime. Spelled out, they would sit in this very file, the
  // audit's own tree walk would reach them, and the check would report its own test fixtures as
  // credentials — the same trap the inventory test above already carries a note about.
  const planted = [
    `${'-'.repeat(5)}BEGIN RSA PRIVATE ${'KEY'}${'-'.repeat(5)}`,
    `${'gh'}${'p'}_${'A'.repeat(30)}`,
    `${'AK'}${'IA'}${'B'.repeat(16)}`,
    `${'Bear'}er ${'C'.repeat(25)}`,
  ].join('\n');
  expect(
    inspectSecrets('planted.txt', planted)
      .map((f) => f.label)
      .sort(),
  ).toEqual(['aws-access-key-id', 'bearer-literal', 'github-token', 'pem-private-key']);

  // A real-looking issued token under a credential key is reported. The alphabet matters: an
  // earlier draft of this line used a three-character sequence repeated, which the first
  // discriminator correctly exempted — the fixture was wrong, not the rule.
  const issued = ['a1B2', 'c3D4', 'e5F6', 'g7H8', 'i9J0', 'k1L2'].join('');
  expect(inspectSecrets('config.json', `{"${'tok'}${'en'}": "${issued}"}`).map((f) => f.label)).toEqual([
    'credential-bearing-key',
  ]);

  // A fixture of one repeated character is not: it cannot be a credential by construction, and
  // this is a measurement of the value rather than a whitelist of the file it lives in. Both the
  // lowercase and the uppercase form are here on purpose — the lowercase one is also exempt under
  // the phrase rule below, so on its own it left the entropy rule asserted by nothing, and a
  // mutation removing that rule passed.
  expect(inspectSecrets('fixture.json', `{"token": "${'p'.repeat(40)}"}`)).toEqual([]);
  expect(inspectSecrets('fixture.json', `{"token": "${'P'.repeat(40)}"}`)).toEqual([]);
  expect(inspectSecrets('fixture.json', `{"password": "${'7'.repeat(40)}"}`)).toEqual([]);

  // Hyphenated lowercase words where a machine token belongs are a phrase, not an issued secret.
  expect(inspectSecrets('a.ts', `const token = 'service-runtime-fixture-name'`)).toEqual([]);

  // THE COUNTEREXAMPLE that scopes that exemption: the identical shape under `password` is a
  // passphrase, and exempting it would be the one way this check hides a real credential.
  const passphrase = ['correct', 'horse', 'battery', 'staple'].join('-');
  expect(inspectSecrets('b.ts', `const ${'pass'}${'word'} = '${passphrase}'`).map((f) => f.label)).toEqual([
    'credential-bearing-key',
  ]);

  // And a clean line stays silent, so a check that reports either way is ruled out.
  expect(inspectSecrets('clean.md', 'the transport carries no credentials')).toEqual([]);
});

test('a credential committed and later removed is invisible to the tree and found in the history', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-secrets-'));
  const git = (...args: string[]): void => {
    const done = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (done.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${done.stderr.toString()}`);
  };
  try {
    git('init', '--quiet');
    git('config', 'user.email', 'audit@example.invalid');
    git('config', 'user.name', 'audit');
    writeFileSync(join(root, 'deploy.sh'), `${'AK'}${'IA'}${'B'.repeat(16)}\n`);
    writeFileSync(join(root, '.env'), 'X=1\n');
    git('add', '-A', '-f');
    git('commit', '--quiet', '-m', 'first');
    rmSync(join(root, 'deploy.sh'));
    rmSync(join(root, '.env'));
    git('commit', '--quiet', '-am', 'removed');

    // The tree is clean and says nothing about the clone anyone receives.
    expect((await auditSecrets(root, false)).findings).toEqual([]);

    const walked = await auditSecrets(root, true);
    expect(walked.findings.map((f) => ({ where: f.where, label: f.label, path: f.path }))).toEqual([
      { where: 'history', label: 'aws-access-key-id', path: 'deploy.sh' },
    ]);
    // Whether a .env was ever committed is a fact about the repository, answered by path alone —
    // its content is exactly what must not be printed to answer it.
    expect(walked.envFiles).toEqual(['.env']);
    expect(JSON.stringify(walked)).not.toContain('AKIA');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The skip list is prose until something checks it.
 *
 * Each entry in the walker's skip list carries a written answer for why the thing being looked for
 * cannot be in there. Two of those answers have machinery behind them — the history is walked
 * separately, and `dist` is audited as the candidate at publish time — and the rest were argued.
 * An argued answer passes through nothing: the author is both the instrument and the acceptance.
 *
 * So the BEHAVIOUR is pinned instead: the same file, with the same literal, is invisible inside a
 * skipped directory and found outside it. That is what the entries are claiming, and it is the half
 * that can rot silently — a rename, a new skip added in passing, and the audit narrows without
 * saying so.
 */
test('the skip list skips exactly what it names, and nothing else', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stitchwire-skips-'));
  try {
    const planted = ['literal', 'in', 'a', 'skipped', 'place'].join('-');
    const rules = [{ label: 'planted', literal: planted }];

    // Outside any skip: found. Without this the test would pass on a walker that reads nothing.
    writeFileSync(join(root, 'visible.md'), `${planted}\n`);
    expect((await auditContent(root, rules)).map((f) => f.path)).toEqual(['visible.md']);

    // Inside each named skip: invisible, and the reason each is named is that the subject cannot
    // legitimately live there. `.git` is the one exception in kind — it is not ignored but walked
    // by `auditHistory`, which the test above already covers.
    for (const skipped of ['node_modules', 'dist', '.git']) {
      mkdirSync(join(root, skipped), { recursive: true });
      writeFileSync(join(root, skipped, 'hidden.md'), `${planted}\n`);
    }
    writeFileSync(join(root, '.DS_Store'), `${planted}\n`);
    expect((await auditContent(root, rules)).map((f) => f.path)).toEqual(['visible.md']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A repository's own name is not an operator address, and this is the ONLY relaxation.
 *
 * By construction `identity.repositoryId` equals `<owner>/<name>`, so the owner literal is always
 * present in it, and the publication audit read that as a leak — meaning the declaration could not
 * travel together with the tree that declares it. The relaxation is made as narrow as
 * possible, and the second half matters more than the first: a blanket exclusion for this file
 * would turn it into a place where anything from the inventory could be hidden.
 */
// Every sample is assembled at runtime. Written literally, the operator literal would sit in this very
// file, the audit walk would reach it — and the test would fail the publication while proving its own
// point. Excluding the file from the walk would be worse: a rule that does not apply to itself stops
// being a rule.
const OWNER = ['max', 'listov'].join('-');
const RULES = [{ label: 'operator-identity', literal: OWNER }];
const OWN = `${OWNER}/example`;
const OTHER = `${OWNER}/private-operations`;

test('a repository declaring its own name is not a finding, and one more occurrence is', () => {
  const declaration = (extra = '') =>
    JSON.stringify(
      {
        schemaVersion: 1,
        identity: { repositoryId: OWN, policy: 'own-private' },
        ...(extra ? { layout: { note: extra } } : {}),
      },
      null,
      2,
    );

  // Positive: the single occurrence is the declared identifier itself.
  expect(inspectContent('.passport.json', declaration(), RULES, OWN)).toEqual([]);

  // Negative: a second address of the same owner in the same file counts again.
  const smuggled = declaration(OTHER);
  expect(inspectContent('.passport.json', smuggled, RULES, OWN)).toHaveLength(1);

  // And bound to the ROOT: a nested declaration of someone else's repository inside the tree gets no
  // relaxation — otherwise it would be enough to drop your own `.passport.json` into a subdirectory.
  expect(inspectContent('vendor/thing/.passport.json', declaration(), RULES, OWN)).toHaveLength(1);

  // The relaxation is bound to the FILE: the same text anywhere else in the tree is a finding.
  expect(inspectContent('docs/notes.md', declaration(), RULES, OWN)).toHaveLength(1);

  // And to THIS tree: someone else's declared identifier exempts nothing.
  expect(inspectContent('.passport.json', declaration(), RULES, `${OWNER}/other`)).toHaveLength(1);

  // Without a declaration there is no relaxation at all.
  expect(inspectContent('.passport.json', declaration(), RULES)).toHaveLength(1);
});

test('the same exemption applies to history, so one rule cannot answer twice', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wire-identity-history-'));
  try {
    const run = (...argv: string[]) => Bun.spawnSync(['git', '-C', root, ...argv]);
    run('init', '-q');
    run('config', 'user.email', 'audit@example.invalid');
    run('config', 'user.name', 'audit');
    const declaration = JSON.stringify(
      { schemaVersion: 1, identity: { repositoryId: OWN, policy: 'own-private' } },
      null,
      2,
    );
    // Renamed identity documents remain valid evidence in immutable history, never in the tree.
    writeFileSync(join(root, '.repository.json'), `${declaration}\n`);
    run('add', '.repository.json');
    run('commit', '-qm', 'declare under the retired name');
    rmSync(join(root, '.repository.json'));
    writeFileSync(join(root, '.passport.json'), `${declaration}\n`);
    run('add', '-A');
    run('commit', '-qm', 'adopt passport');
    // The same file, but with an extra address of the same owner, and it is REPLACED by the next
    // commit: it is no longer in the tree, it remains in history — exactly what history is checked for.
    writeFileSync(
      join(root, '.passport.json'),
      `${declaration.replace('}\n}', `},\n  "note": "${OTHER}"\n}`)}\n`,
    );
    run('add', '.passport.json');
    run('commit', '-qm', 'smuggle');
    writeFileSync(join(root, '.passport.json'), `${declaration}\n`);
    run('add', '.passport.json');
    run('commit', '-qm', 'restore');

    const history = await auditHistory(root, RULES);
    // The declared declaration is not a finding, in the tree or in history; the smuggled address is a
    // finding, and the fact that it is already gone from the current tree does not save it.
    expect(await auditContent(root, RULES)).toEqual([]);
    expect(history.findings).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
