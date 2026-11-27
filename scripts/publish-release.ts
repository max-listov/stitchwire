#!/usr/bin/env bun
/**
 * Publish a certified candidate's release set, taking the file list from its `SHA256SUMS` rather than
 * from a hand. The candidate's rollback packet is a separate sealed set and is never an asset: the
 * upload list has no other input, so no repository setting can add it.
 *
 * The first publication of 0.36.1 uploaded three assets while `SHA256SUMS` listed four: the
 * rollback binary was left behind because the upload list was typed. A consumer doing exactly the
 * right thing — download everything, `shasum -c SHA256SUMS` — then gets `FAILED` on the missing
 * line, and `FAILED` reads the same whether a file is absent or a digest disagrees. The two are
 * repaired differently, and the report cannot tell them apart.
 *
 * So the manifest of sums IS the upload list. A file listed and missing stops the publication; a
 * file present and unlisted stops it too, because an asset nobody can verify is worse than absent.
 * Divergence is not detected here — it is made impossible.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { runBounded } from './bounded-command.ts';
import { publishedAssets, verifyCandidate } from './candidate-manifest.ts';
import { publishPackages, registryHasArchive, releasePackages } from './npm-release.ts';
import { assertPublishedSdkIdentity, publishedReleases } from './published-sdk.ts';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  return index < 0 || value === undefined || value.startsWith('--') ? undefined : value;
}

const inventory = argument('--inventory');
const candidate = argument('--candidate');
const tag = argument('--tag');
const title = argument('--title');
const notes = argument('--notes') ?? '';
const dryRun = process.argv.includes('--dry-run');
/**
 * Re-check a release that already exists, without creating anything.
 *
 * A verification that can only run in the same breath as the upload cannot be re-run when it is
 * the verification itself that was wrong — and the first time this one ran for real, it was: it
 * wrote its download into the candidate directory, which `create-candidate` makes read-only on
 * purpose, and reported "not downloadable from the published release" about five assets that had
 * landed intact. A gate whose refusal names the wrong subject is worse than no gate, so the
 * corrected one has to be runnable against the release that outlived the failure.
 */
const verifyOnly = process.argv.includes('--verify-only');
if (candidate === undefined || tag === undefined || title === undefined || inventory === undefined) {
  throw new Error(
    'usage: publish-release --candidate <dir> --tag <vX.Y.Z> --title <text> --inventory <operator-json> [--notes <text>] [--dry-run]',
  );
}
const packet = verifyCandidate(resolve(candidate));
const { listed, manifest, directory: dir } = packet.release;
const sumsPath = join(dir, 'SHA256SUMS');

/** Every command of a publication runs from the repository root and is read as text. */
async function run(
  executable: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<{ code: number | null; out: string; err: string }> {
  const result = await runBounded(executable, args, { cwd: resolve(import.meta.dir, '..'), timeoutMs });
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
  return { code: result.exitCode, out: text(result.stdout), err: text(result.stderr) };
}

async function git(...argv: string[]): Promise<{ code: number | null; out: string }> {
  const { code, out } = await run('git', argv);
  return { code, out: out.trim() };
}
/**
 * The artifact and the tag must describe ONE tree.
 *
 * Nothing forced that. The binary is built from the working tree, the tag is placed on a commit,
 * and between those two steps an edit is possible — after which the byte-for-byte verification a
 * consumer performs proves the artifact matches its own checksum and says nothing about the source
 * anyone can read. Rebuilding v0.36.4 from a fresh clone of its tag reproduced the shipped binary
 * exactly, so nothing shipped wrong; it was true by luck, not by construction.
 *
 * Two conditions make it true by construction, given that `verify:clean` already proves the build
 * is reproducible: the tree has no changes against HEAD, and the tag names HEAD.
 *
 * These two guard the CREATE, and only it: they exist so the artifact and the tag describe one
 * tree. `--verify-only` creates nothing and compares an existing release against a candidate
 * directory whose bytes are already fixed, so the local tree has no bearing on the answer. That is
 * the reason to skip them here, and it is not a licence to skip them on a publication.
 */
if (!verifyOnly) {
  const dirty = await git('status', '--porcelain');
  if (dirty.code !== 0) throw new Error('cannot inspect the working tree');
  if (dirty.out !== '')
    throw new Error(
      `the working tree has changes, so the artifact and ${tag} would describe different trees:
${dirty.out}`,
    );
  const head = await git('rev-parse', 'HEAD');
  const tagged = await git('rev-parse', `${tag}^{commit}`);
  if (tagged.code !== 0) throw new Error(`${tag} does not exist — tag the commit before publishing it`);
  if (head.out !== tagged.out)
    throw new Error(
      `${tag} points at ${tagged.out.slice(0, 12)} but the tree is at ${head.out.slice(0, 12)}`,
    );
}

/**
 * The repository is read from the checkout, never written down here.
 *
 * Three `gh` invocations named `owner/repo` as a literal, which is the operator's identity sitting
 * in a source file that is treated as publishable. It is also simply wrong as engineering: a fork
 * or a rename would have published to someone else's releases while the script insisted it was
 * right.
 */
const originUrl = await git('remote', 'get-url', 'origin');
if (originUrl.code !== 0) throw new Error('no origin remote — cannot tell which repository to publish to');
const parsedSlug = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(originUrl.out)?.[1];
if (parsedSlug === undefined)
  throw new Error(`cannot read owner/repo out of the origin remote: ${originUrl.out}`);
// Narrowed once, here: a `string | undefined` read inside a function declared below is not narrowed
// by the throw above, because the checker cannot know when that function runs.
const slug: string = parsedSlug;

/**
 * The content audit runs HERE, and publication is the only place it can be made unavoidable.
 *
 * It existed as a script and belonged to no gate — so it had never been run. Its first run found
 * seven hits: four real (a consumer's project name in two tests, a fleet machine name, the
 * operator's identity written into three `gh` invocations) and three on the ordinary English word
 * "monitoring", which is why a rule this blunt gets switched off by whoever meets it.
 *
 * It cannot live in `verify`: the rules name private things and live outside this repository,
 * which must build and test with no private companion. Publication is different — it is an
 * operator action, the operator holds the inventory, and it is the exact moment a leak becomes
 * permanent. So the flag is required, and there is no path where it is skipped silently.
 *
 * A written check nobody runs is not a check. It is a promise.
 */
const inventoryPath = inventory;
async function refuseOnFindings(what: string, extra: string[]): Promise<void> {
  const audit = await run(
    'bun',
    [resolve(import.meta.dir, 'content-audit.ts'), '--inventory', resolve(inventoryPath), ...extra],
    10 * 60_000,
  );
  if (audit.code !== 0) throw new Error(`content audit refused ${what}:\n${audit.out}${audit.err}`);
}

await refuseOnFindings('this tree', ['--secrets']);

/**
 * And the ARTIFACT, which the tree audit does not reach.
 *
 * The walker skips `dist/` as derived — correct for a daily gate and wrong at exactly this moment,
 * because these are the bytes that leave. A check that judges everything except the thing being
 * published is the shape a neighbouring project found in its own lint rule today: it excluded the
 * file it was written to police.
 *
 * Verified rather than assumed: a control token appended to a copy of the 1.6MB binary is FOUND —
 * the walker reads compiled artifacts as text and an ASCII run survives the decode — and the same
 * run is silent once the copy is removed. Credentials are asked for here too, because one compiled
 * into a release asset is the worst version of this.
 */
await refuseOnFindings('the release set about to be published', ['--root', dir, '--secrets', '--packed']);

if (tag !== `v${manifest.candidate.version}`) throw new Error('tag and candidate version differ');

/**
 * Refuse to ship a second artifact under a version that is already published.
 *
 * This is the defect a consumer found rather than a gate: `FailureSchema` gained an outcome, the
 * client bundles that schema, and its version stayed 0.5.1 — so two different tarballs carried one
 * number and nobody downstream could tell which they held. `check-client-package` could not see it:
 * it verifies the tarball against the local manifest, and both artifacts matched their own.
 *
 * The comparison that answers it is against what was PUBLISHED, so it belongs here and nowhere
 * earlier: same version, different digest is a contradiction, and the fix is a version, not a force.
 *
 * It guards the CREATE and is skipped by `--verify-only`, which publishes nothing and asks only
 * whether an existing release matches its candidate. Not a loosening: the first time this guard
 * could actually run it refused, and its refusal is a real finding kept below, not routed around.
 */
const catalog = await publishedReleases(slug);
if (!verifyOnly) await assertPublishedSdkIdentity(tag, listed, catalog, fetchPublishedDigest);

/**
 * The download lands in a scratch directory, NOT beside the artifact: the candidate directory is
 * mode 0555 by design, so writing there fails for a reason that has nothing to do with the
 * release, and the failure arrives wearing the release's name.
 *
 * Which is why this returns a reason rather than `undefined`. "Could not ask" and "the answer was
 * wrong" are different outcomes and are repaired differently; collapsing them sent an operator to
 * look at GitHub for a permission error on this disk.
 */
async function fetchPublishedDigest(
  tagName: string,
  asset: string,
): Promise<{ digest: string } | { problem: string }> {
  const scratch = mkdtempSync(join(tmpdir(), 'stitchwire-published-'));
  const tmp = join(scratch, asset);
  try {
    const get = await run('gh', [
      'release',
      'download',
      tagName,
      '--repo',
      slug,
      '--pattern',
      asset,
      '--output',
      tmp,
      '--clobber',
    ]);
    if (get.code !== 0)
      return { problem: `could not be downloaded: gh exited ${get.code}: ${get.err.trim().slice(-300)}` };
    return {
      digest: sha256(await Bun.file(tmp).bytes()),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const assets = publishedAssets(packet);
const expected = new Map(listed);
expected.set('SHA256SUMS', sha256(await Bun.file(sumsPath).bytes()));
const packages = manifest.schema === 3 ? await releasePackages(packet.release) : [];
if (!verifyOnly && packages.length !== 2) throw new Error('a new release must seal both npm packages');
const existing = catalog.find((release) => release.tag_name === tag);

async function checkUploaded(names: string[]): Promise<void> {
  for (const name of names) {
    if (!expected.has(name)) throw new Error(`unexpected release asset: ${name}`);
    const result = await fetchPublishedDigest(tag as string, name);
    if ('problem' in result) throw new Error(`${name}: ${result.problem}`);
    if (expected.get(name) !== result.digest) throw new Error(`uploaded ${name} differs from candidate`);
  }
}

async function changeRelease(args: string[]): Promise<void> {
  const result = await run('gh', ['release', ...args, '--repo', slug], 30 * 60_000);
  if (result.code !== 0)
    throw new Error(`gh release ${args[0]} exited ${result.code}: ${result.err.trim().slice(-400)}`);
}

if (dryRun) {
  await Promise.all(packages.map((pkg) => registryHasArchive(pkg)));
  console.log(JSON.stringify({ tag, verified: listed.size, assets: assets.map((path) => basename(path)) }));
} else {
  if (verifyOnly && existing?.draft !== false) throw new Error(`no published release for ${tag}`);
  if (existing && existing.draft === undefined) throw new Error('release catalog lacks draft state');
  const landed = existing?.assets.map((asset) => asset.name) ?? [];
  if (new Set(landed).size !== landed.length) throw new Error('duplicate release asset name');
  await checkUploaded(landed);
  const missing = assets.filter((path) => !landed.includes(basename(path)));
  if (!verifyOnly && (!existing || existing.draft)) {
    if (!existing)
      await changeRelease(['create', tag, '--draft', '--verify-tag', '--title', title, '--notes', notes]);
    if (missing.length) await changeRelease(['upload', tag, ...missing]);
    await checkUploaded(missing.map((path) => basename(path)));
  } else if (missing.length) {
    throw new Error(`published assets missing: ${missing.map((path) => basename(path)).join(', ')}`);
  }
  await publishPackages(packages, verifyOnly || existing?.draft === false);
  if (!verifyOnly && (!existing || existing.draft)) await changeRelease(['edit', tag, '--draft=false']);
  const final = (await publishedReleases(slug)).find((release) => release.tag_name === tag);
  if (
    final?.draft !== false ||
    final.assets.length !== expected.size ||
    new Set(final.assets.map((asset) => asset.name)).size !== expected.size ||
    final.assets.some((asset) => !expected.has(asset.name))
  )
    throw new Error('final release inventory differs');
  console.log(
    JSON.stringify({ tag, verifiedAfterPublish: expected.size, npm: packages.map((pkg) => pkg.name) }),
  );
}
