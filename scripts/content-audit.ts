import { readdir, lstat } from 'node:fs/promises';
import { relative, resolve, join } from 'node:path';
import { z } from 'zod';
import { CompleteReportSchema } from './content-report.ts';
import { readHistoryBlobs } from './history-blobs.ts';

/**
 * One rule: a literal that must not appear, and the exact names built on it that may.
 *
 * `except` exists for an owner prefix. An operator's handle names every repository they own, and
 * one or two of those are public — the library's own clone URL among them — while the rest are
 * private and must stay unnamed. A rule per private repository is a deny list that misses the next
 * repository someone creates; one rule on the prefix with its public names excepted misses nothing.
 * Each exception starts with its literal and covers only the WHOLE name: an occurrence followed by
 * more name characters is another repository and stays a finding.
 */
const ContentRuleSchema = z
  .object({
    label: z.string().regex(/^[a-z0-9-]{1,64}$/),
    literal: z.string().min(3).max(512),
    except: z.array(z.string().min(3).max(512)).min(1).max(64).optional(),
  })
  .strict()
  .refine(
    (rule) => (rule.except ?? []).every((name) => name.toLowerCase().startsWith(rule.literal.toLowerCase())),
    { message: 'every exception must start with the literal it excepts' },
  );
export const InventorySchema = z.array(ContentRuleSchema).max(1000);
export type ContentRule = z.infer<typeof ContentRuleSchema>;
export type Finding = { path: string; label: string; offset: number };

/**
 * Where an excepted name ends. Repository names are built from `[A-Za-z0-9._-]`, so a following
 * letter, digit, `_`, `-` or `.`+name character continues the name (`name-dev`, `name.next`);
 * a clone suffix `.git`, a `/`, a quote, a space or a sentence-ending `.` ends it.
 */
const nameEnds = /^(?:\.git)?(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/;

/** The offset of the first occurrence of the rule's literal that no exception covers, or -1. */
export function firstUnexceptedOffset(lower: string, rule: ContentRule): number {
  const literal = rule.literal.toLowerCase();
  const exceptions = (rule.except ?? []).map((name) => name.toLowerCase());
  for (let offset = lower.indexOf(literal); offset >= 0; offset = lower.indexOf(literal, offset + 1)) {
    const excepted = exceptions.some(
      (name) => lower.startsWith(name, offset) && nameEnds.test(lower.slice(offset + name.length)),
    );
    if (!excepted) return offset;
  }
  return -1;
}
const CURRENT_IDENTITY_DOCUMENTS: ReadonlySet<string> = new Set(['.passport.json']);
const HISTORICAL_IDENTITY_DOCUMENTS: ReadonlySet<string> = new Set(['.passport.json', '.repository.json']);

/**
 * The one place a match of an operator literal is not a leak: the repository's OWN name.
 *
 * `.passport.json` declares `identity.repositoryId`, and that value contains the operator handle
 * because a GitHub repository is `<owner>/<name>` — the string a clone URL announces to anyone who
 * can see the repository at all. Reading it as a leak means the declaration can never be published
 * with the tree that declares it.
 *
 * The exemption is deliberately as narrow as it can be made, because a blanket one for this file
 * would let every other label hide inside it — a `backlogRoots` naming a private repository would
 * go quiet, and that is the exact thing the inventory exists to catch:
 *
 *   - only inside the audited root's own `.passport.json`;
 *   - only the occurrence that IS the declared `repositoryId`;
 *   - and only when removing that one occurrence leaves no other occurrence of the literal in the
 *     file. A second one anywhere in it makes the finding significant again.
 */
export function declaredIdentityOnly(text: string, repositoryId: string, rule: ContentRule): boolean {
  const declaration = `"repositoryId": "${repositoryId}"`;
  const at = text.indexOf(declaration);
  if (at < 0 || text.indexOf(declaration, at + 1) >= 0) return false;
  const offset = at + declaration.indexOf(repositoryId);
  const remainder = text.slice(0, offset) + text.slice(offset + repositoryId.length);
  return firstUnexceptedOffset(remainder.toLowerCase(), rule) < 0;
}

/** Operator-specific inventory is supplied externally. Matched bytes are never returned. */
export function inspectContent(
  path: string,
  text: string,
  rules: ContentRule[],
  declaredRepositoryId?: string,
  identityDocuments: ReadonlySet<string> = CURRENT_IDENTITY_DOCUMENTS,
): Finding[] {
  const findings: Finding[] = [];
  const lower = text.toLowerCase();
  for (const rule of rules) {
    const offset = firstUnexceptedOffset(lower, rule);
    if (offset < 0) continue;
    if (
      identityDocuments.has(path) &&
      declaredRepositoryId !== undefined &&
      declaredIdentityOnly(text, declaredRepositoryId, rule)
    )
      continue;
    findings.push({ path, label: rule.label, offset });
  }
  return findings;
}

/**
 * Credentials, by the shapes that announce themselves.
 *
 * This is deliberately NOT an entropy scan. In this repository a 64-character hex run is a SHA256
 * as often as it is a token — manifests, checksum files, release records and research notes are
 * full of them by design — so entropy cannot separate the two and a scanner built on it reports
 * hundreds of digests and teaches everyone to skip its output. What CAN be separated is a value
 * introduced by a key that means "credential", and a handful of formats that carry their own
 * prefix.
 *
 * So this answers "are the named shapes present", never "is there no secret". `secretAudit: true`
 * means the named shapes were looked for, and nothing more; the difference is the whole reason the
 * flag exists rather than a claim of cleanliness.
 */
const SECRET_RULES: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'pem-private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'github-token', pattern: /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/ },
  { label: 'aws-access-key-id', pattern: /AKIA[0-9A-Z]{16}/ },
  { label: 'bearer-literal', pattern: /Bearer [A-Za-z0-9._-]{20,}/ },
  {
    label: 'credential-bearing-key',
    pattern:
      /["']?(?:token|password|secret|apiKey|api_key|authorization)["']?\s*[:=]\s*["']([A-Za-z0-9+/=_.-]{16,})["']/,
  },
];

/**
 * A value that cannot be a credential, stated as a measurement rather than a path whitelist.
 *
 * Test fixtures carry things like forty `p` characters, and a whitelist of the files they live in
 * would go stale the day one moves — and would hide a real secret that moved in beside it. Both
 * tests below are about the value itself, whatever file it sits in.
 *
 * The second one is deliberately NOT applied to `password` or `secret`, and the counterexample is
 * the reason: `correct-horse-battery-staple` is lowercase words joined by hyphens and is a real
 * credential. A machine-issued token drawn only from [a-z-] would be a defect in the issuer; a
 * human-chosen passphrase shaped that way is ordinary.
 */
function cannotBeACredential(key: string, value: string): boolean {
  // Almost no distinct characters: not a credential by construction.
  if (new Set(value).size < 8) return true;
  // Hyphenated lowercase words where a machine token belongs — a phrase, not an issued secret.
  const humanChosen = key === 'password' || key === 'secret';
  return !humanChosen && /^[a-z][a-z-]*$/.test(value);
}

export function inspectSecrets(path: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const rule of SECRET_RULES) {
    const global = new RegExp(rule.pattern.source, 'g');
    for (const hit of text.matchAll(global)) {
      const captured = hit[1];
      const key =
        /token|password|secret|apiKey|api_key|authorization/i.exec(hit[0])?.[0]?.toLowerCase() ?? '';
      if (captured !== undefined && cannotBeACredential(key, captured)) continue;
      findings.push({ path, label: rule.label, offset: hit.index });
      break;
    }
  }
  return findings;
}

/**
 * The audited tree's own declared name, or `undefined` when it does not declare one.
 *
 * Read from the tree being audited rather than passed in, so the exemption cannot be aimed at a
 * repository by whoever runs the command: it is a fact of the tree, not an argument.
 */
async function declaredRepositoryId(root: string): Promise<string | undefined> {
  try {
    const passport = await Bun.file(join(root, '.passport.json')).json();
    const id = passport?.identity?.repositoryId;
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

async function walkText(
  root: string,
  packed: boolean,
  visit: (local: string, body: string) => void,
): Promise<void> {
  await walkFiles(
    root,
    async (local, absolute) => {
      const file = Bun.file(absolute);
      visit(local, await file.text());
      if (!packed || !local.endsWith('.tgz')) return;
      const entries = await new Bun.Archive(await file.bytes()).files();
      if (!entries.has('package/package.json')) throw new Error(`package manifest missing in ${local}`);
      for (const [name, entry] of entries) visit(`${local}!/${name}`, await entry.text());
    },
    packed,
  );
}

export async function auditContent(root: string, rules: ContentRule[], packed = false): Promise<Finding[]> {
  const findings: Finding[] = [];
  const identity = await declaredRepositoryId(root);
  await walkText(root, packed, (local, body) => {
    findings.push(...inspectContent(local, local, rules));
    findings.push(...inspectContent(local, body, rules, identity));
  });
  return findings;
}

/**
 * What this walk does NOT enter, and why each one cannot hold the thing being looked for.
 *
 * A skip is not a defect; an UNNAMED skip is. The difference is whether there is an answer to "could
 * the subject of this rule live in there" — without one it is not a skip but a blind spot, and it
 * reports "clean" more narrowly than it sounds while saying nothing about it. `dist` sat here for
 * months with the answer "derived", which was true every day and false at the one moment that
 * mattered; the publisher now audits the candidate, which is what makes the entry below honest.
 *
 * The same blind spot appears from the opposite direction: a guard that walks one package of
 * several reports "clean" for the whole.
 */
const SKIPPED = new Map<string, string>([
  [
    '.git',
    'the history is not skipped, it is walked separately by readHistoryBlobs — reading it as files would read packed objects as text',
  ],
  [
    'node_modules',
    'third-party trees this project does not author and does not publish; a literal of ours cannot originate there',
  ],
  [
    'dist',
    'derived from the source this same walk covers — and audited directly, as the candidate, by publish-release before anything leaves',
  ],
  [
    '.DS_Store',
    'a Finder index of names, and every real file name in this tree is already inspected as a path by the walk itself',
  ],
]);

/**
 * One walk over the working tree, so a second reader cannot quietly cover a different set.
 *
 * A symlink stops the walk rather than being followed: what it points at is outside the tree being
 * judged, and silently reading it would make the answer about somewhere else.
 */
export async function walkFiles(
  root: string,
  visit: (local: string, absolute: string) => Promise<void>,
  includeDist = false,
): Promise<void> {
  async function descend(path: string): Promise<void> {
    for (const name of (await readdir(path)).sort()) {
      if (SKIPPED.has(name) && !(includeDist && name === 'dist')) continue;
      const absolute = join(path, name);
      const info = await lstat(absolute);
      const local = relative(root, absolute);
      if (info.isSymbolicLink()) throw new Error(`Source symlink requires explicit review: ${local}`);
      if (info.isDirectory()) await descend(absolute);
      else if (info.isFile()) await visit(local, absolute);
    }
  }
  await descend(root);
}

/**
 * The same inventory, against every blob any ref can still reach.
 *
 * The working tree is the wrong place to answer "could this be published". A literal removed by a
 * later commit is gone from the tree and present in the history any clone carries, so a tree that
 * audits clean says nothing about what a reader of the repository would find. This walk is the
 * only thing that can turn `historyReviewed` from a constant into a measurement.
 *
 * Blobs, not commits: a literal is in a file, and one blob is usually shared by many commits, so
 * scanning blobs asks each distinct byte-sequence exactly once. `--all`, not `HEAD`: a literal
 * living on a tag or an unmerged branch is in the repository a clone receives.
 *
 * Binary blobs are read like any other rather than skipped. A machine name compiled into an
 * artifact is published exactly as one in a source file, and skipping was a hole dressed as
 * prudence. Decoding cannot corrupt a match either: an invalid byte elsewhere becomes U+FFFD
 * without shifting the literal's own run, and the one non-ASCII rule in the live inventory is
 * matched by its own UTF-8 bytes.
 */
export async function auditHistory(
  root: string,
  rules: ContentRule[],
): Promise<{ findings: Array<Finding & { blob: string }>; blobs: number }> {
  const findings: Array<Finding & { blob: string }> = [];
  /**
   * The same exemption as the tree walk, for the same reason and by the same code.
   *
   * A past identity document declares the repository's own name exactly as today's does, so
   * reading one as a leak and the other as fine would make the audit answer differently depending
   * on which half of itself asked. The declared id is today's, deliberately: a blob that declared
   * some OTHER repository does not match and stays a finding, which is the conservative direction.
   * `.repository.json` is accepted only in history: it was the canonical name when those immutable
   * blobs were written. The working-tree walk accepts only `.passport.json`.
   */
  const identity = await declaredRepositoryId(root);
  const walked = await readHistoryBlobs(
    root,
    (path, body, sha, paths) => {
      // An identity exemption holds only when every historical path is an identity document.
      const context = paths.find((name) => !HISTORICAL_IDENTITY_DOCUMENTS.has(name)) ?? path;
      for (const finding of inspectContent(context, body, rules, identity, HISTORICAL_IDENTITY_DOCUMENTS)) {
        findings.push({ ...finding, blob: sha.slice(0, 12) });
      }
    },
    {
      visitPath: (path, sha) => {
        for (const finding of inspectContent(path, path, rules))
          findings.push({ ...finding, blob: sha.slice(0, 12) });
      },
    },
  );
  return { findings, blobs: walked.blobs };
}

/**
 * The same shapes over the working tree and, when asked, over every blob any ref can reach.
 *
 * `.env` is listed separately and by path alone: whether one was ever committed is a fact about
 * the repository, not about a line inside a file, and its content is exactly what must not be
 * printed to answer it.
 */
export async function auditSecrets(
  root: string,
  history: boolean,
  packed = false,
): Promise<{
  findings: Array<Finding & { where: 'tree' | 'history'; blob?: string }>;
  envFiles: string[];
  blobs: number;
}> {
  const findings: Array<Finding & { where: 'tree' | 'history'; blob?: string }> = [];
  await walkText(root, packed, (local, body) => {
    for (const finding of inspectSecrets(local, body)) findings.push({ ...finding, where: 'tree' });
  });

  const envFiles: string[] = [];
  let blobs = 0;
  if (history) {
    const walked = await readHistoryBlobs(root, (path, body, sha) => {
      for (const finding of inspectSecrets(path, body))
        findings.push({ ...finding, where: 'history', blob: sha.slice(0, 12) });
    });
    blobs = walked.blobs;
    envFiles.push(...walked.paths.filter((path) => /(^|\/)\.env($|\.)/.test(path)));
  }
  return { findings, envFiles: [...new Set(envFiles)].sort(), blobs };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--inventory');
  const named = index < 0 ? process.env.STITCHWIRE_CONTENT_INVENTORY : args[index + 1];
  const history = args.includes('--history');
  const secrets = args.includes('--secrets');
  if (index >= 0 && (named === undefined || named.startsWith('--')))
    throw new Error(
      'usage: content-audit [--inventory <external-json>] [--history] [--secrets] [--root <path>]',
    );
  /*
   * The literals a deployment must never publish are not this repository's to know — they are the
   * operator's, and they arrive from outside, by flag or by STITCHWIRE_CONTENT_INVENTORY. What this
   * file refuses is the third possibility: running with no inventory and SAYING NOTHING, which is
   * how a gate ends up green on a question nobody asked. With none named the shape rules still run
   * and `inventoryNamed: false` states, in the report, exactly which half was not checked.
   */
  // Defaults to this repository, which is what a publication gate asks about. `--root` exists
  // because the private companion holds the deployment material and has never been asked the same
  // questions — and a second copy of this walker living over there would be the same defect as a
  // second name for one thing.
  const chosen = args.indexOf('--root');
  const given = chosen < 0 ? undefined : args[chosen + 1];
  if (chosen >= 0 && (given === undefined || given.startsWith('--'))) throw new Error('--root needs a path');
  const root = given === undefined ? resolve(import.meta.dir, '..') : resolve(given);
  const rules = named === undefined ? [] : InventorySchema.parse(await Bun.file(named).json());
  const packed = args.includes('--packed');
  const findings = await auditContent(root, rules, packed);
  // `historyReviewed` stays false when the walk was not asked for. It is the difference between
  // "history is clean" and "nobody looked", and collapsing those is the failure this whole file
  // exists to avoid.
  const walked = history ? await auditHistory(root, rules) : undefined;
  const credentials = secrets ? await auditSecrets(root, history, packed) : undefined;
  const report = {
    kind: 'content-inventory',
    inventoryNamed: named !== undefined,
    rules: rules.length,
    findings,
    historyReviewed: walked !== undefined,
    history: walked === undefined ? null : walked,
    // True means the named shapes were looked for. It has never meant "no secret is present",
    // and the rules above say why that stronger claim is not available here.
    secretAudit: credentials !== undefined,
    secrets: credentials ?? null,
  };
  // A complete audit prints exactly the report its readers parse: a field renamed here and not
  // there fails this run, not a publication that trusted an exit code.
  if (named !== undefined && rules.length > 0 && walked !== undefined && credentials !== undefined)
    CompleteReportSchema.parse(report);
  console.log(JSON.stringify(report, null, 2));
  if (
    findings.length ||
    (walked?.findings.length ?? 0) > 0 ||
    (credentials?.findings.length ?? 0) > 0 ||
    (credentials?.envFiles.length ?? 0) > 0
  )
    process.exitCode = 1;
}
