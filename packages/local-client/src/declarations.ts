import { constants, type Stats } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { writeFileAtomic } from 'stitchkit/files';
import {
  TOPIC_MAX_DESCRIPTOR_BYTES,
  type TopicDescriptorInput,
  TopicDescriptorSchema,
} from '../../contracts/src/protocol/topic.ts';
import {
  SERVICE_MAX_DECLARATION_BYTES,
  type ServiceDeclarationInput,
  ServiceDeclarationSchema,
} from '../../contracts/src/service/declaration.ts';
import { errnoOf } from './errno.ts';
import { WireClientError } from './errors.ts';
import {
  absolutePath,
  defaultEventDropInDir,
  defaultServiceDropInDir,
  type WireDropInPathOptions,
} from './paths.ts';

/** Which rule of the drop-in policy refused a directory or file, and in words. */
export interface DropInRefusal {
  rule: 'type' | 'owner' | 'mode';
  detail: string;
}

/**
 * The one acceptance rule for a drop-in directory and for each file in it, judged on the metadata
 * of the object itself (`lstat` of the directory, `fstat` of the opened file): it must be a real
 * directory or regular file — never a symlink —, owned by the agent's uid, and writable by nobody
 * else. The agent refuses what this refuses; this SDK writes only what it accepts. The writer
 * therefore must run as the same user as the agent. `uid` is the agent's: this process's, unless a
 * caller judges the set for an agent that runs as another user (enrollment, `config validate`).
 */
export function dropInRefusal(
  info: Pick<Stats, 'uid' | 'mode' | 'isDirectory' | 'isFile'>,
  kind: 'directory' | 'file',
  uid: number | undefined = process.getuid?.(),
): DropInRefusal | null {
  if (kind === 'directory' ? !info.isDirectory() : !info.isFile())
    return {
      rule: 'type',
      detail:
        kind === 'directory'
          ? 'drop-in path is not a directory (symlinks are refused)'
          : 'drop-in file is not a regular file (symlinks are refused)',
    };
  if (uid !== undefined && info.uid !== uid)
    return { rule: 'owner', detail: `drop-in ${kind} is owned by uid ${info.uid}, expected ${uid}` };
  if ((info.mode & 0o022) !== 0)
    return {
      rule: 'mode',
      detail: `drop-in ${kind} must not be group- or world-writable (mode ${(info.mode & 0o777).toString(8)})`,
    };
  return null;
}

const DROP_IN_STEM_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface DeclarationFileOptions extends WireDropInPathOptions {
  /** Absolute target drop-in directory, instead of the one beside `node.json`; a relative one is `invalid-request`. */
  dropInDir?: string;
}

export interface DeclarationWriteResult {
  path: string;
  changed: boolean;
}

export interface DeclarationRemoveResult {
  path: string;
  removed: boolean;
}

/**
 * A filesystem call that failed: `permission` only when the operating system denied access, any
 * other failure (no space, read-only filesystem, I/O error) is the local delivery medium failing,
 * `transport`, with the system error kept as the cause.
 */
export function filesystemFailure(message: string, cause: unknown): WireClientError {
  const code = errnoOf(cause);
  return new WireClientError(
    code === 'EACCES' || code === 'EPERM' ? 'permission' : 'transport',
    message,
    'not-sent',
    {
      cause,
    },
  );
}

function normalizeDropInFilename(name: string): string {
  const stem = name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
  if (
    !DROP_IN_STEM_PATTERN.test(stem) ||
    stem.includes('..') ||
    stem.endsWith('.') ||
    stem.endsWith('.json') ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes('\0')
  ) {
    throw new WireClientError(
      'invalid-request',
      `Invalid drop-in declaration name '${name}': expected lowercase slug [a-z0-9][a-z0-9._-]{0,63} without path separators`,
      'not-sent',
    );
  }
  return `${stem}.json`;
}

function assertOwnedPrivateDir(path: string, info: Stats): void {
  const refusal = dropInRefusal(info, 'directory');
  if (refusal !== null) throw new WireClientError('permission', `${refusal.detail}: ${path}`, 'not-sent');
}

/**
 * Ensure `dir` exists as a private directory owned by the current user.
 * Existing directories are verified fail-closed without mutating their mode; newly created segments
 * are explicitly tightened to `0o700` so they survive restrictive process umasks (including `0o777`).
 */
async function ensureDropInDir(dir: string): Promise<void> {
  try {
    const info = await lstat(dir);
    assertOwnedPrivateDir(dir, info);
    return;
  } catch (error) {
    if (error instanceof WireClientError) throw error;
    if (errnoOf(error) !== 'ENOENT')
      throw filesystemFailure(`Cannot inspect drop-in directory ${dir}`, error);
  }
  const missing: string[] = [];
  let cursor = dir;
  while (true) {
    try {
      await lstat(cursor);
      break;
    } catch (error) {
      if (errnoOf(error) !== 'ENOENT')
        throw filesystemFailure(`Cannot inspect ancestor directory ${cursor}`, error);
      missing.push(cursor);
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  for (const segment of missing.reverse()) {
    try {
      await mkdir(segment, { mode: 0o700 });
      await chmod(segment, 0o700);
    } catch (error) {
      if (errnoOf(error) !== 'EEXIST')
        throw filesystemFailure(`Cannot create drop-in directory ${segment}`, error);
      const existing = await lstat(segment).catch((cause) => {
        throw filesystemFailure(`Cannot inspect directory ${segment}`, cause);
      });
      if (!existing.isDirectory()) {
        throw new WireClientError('permission', `Path ${segment} is not a directory`, 'not-sent');
      }
    }
  }
  let finalInfo: Stats;
  try {
    finalInfo = await lstat(dir);
  } catch (cause) {
    throw filesystemFailure(`Cannot inspect drop-in directory ${dir}`, cause);
  }
  assertOwnedPrivateDir(dir, finalInfo);
}

/**
 * Inspect an existing drop-in target via `O_NOFOLLOW | O_NONBLOCK` without reading past `expectedBytes`.
 * Returns `true` only when the existing file passes the drop-in policy, is already mode `0o600`
 * and contains byte-identical content. A file of another type or owner is refused; one with a
 * wider mode is rewritten.
 */
async function matchesExistingPrivateFile(target: string, expected: Buffer): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const info = await handle.stat();
    const refusal = dropInRefusal(info, 'file');
    if (refusal !== null && refusal.rule !== 'mode')
      throw new WireClientError('permission', `${refusal.detail}: ${target}`, 'not-sent');
    if ((info.mode & 0o777) !== 0o600 || info.size !== expected.byteLength) {
      return false;
    }
    const buf = Buffer.allocUnsafe(expected.byteLength + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await handle.read(buf, filled, buf.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled === expected.byteLength && buf.subarray(0, filled).equals(expected);
  } catch (error) {
    if (error instanceof WireClientError) throw error;
    const code = errnoOf(error);
    if (code === 'ENOENT') return false;
    if (code === 'ELOOP' || code === 'EISDIR') {
      throw new WireClientError('permission', `Drop-in target ${target} is not a regular file`, 'not-sent', {
        cause: error,
      });
    }
    throw filesystemFailure(`Cannot inspect existing drop-in file ${target}`, error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeValidatedDropIn(
  dir: string,
  name: string,
  serialized: string,
  maxBytes: number,
): Promise<DeclarationWriteResult> {
  const expected = Buffer.from(serialized, 'utf8');
  if (expected.byteLength > maxBytes) {
    throw new WireClientError(
      'limit',
      `Declaration payload is ${expected.byteLength} bytes, above the ${maxBytes}-byte limit`,
      'not-sent',
    );
  }
  const filename = normalizeDropInFilename(name);
  await ensureDropInDir(dir);
  const target = join(dir, filename);
  if (await matchesExistingPrivateFile(target, expected)) {
    return { path: target, changed: false };
  }
  try {
    await writeFileAtomic(target, serialized, { mode: 0o600 });
  } catch (cause) {
    throw filesystemFailure(`Cannot write drop-in file ${target}`, cause);
  }
  return { path: target, changed: true };
}

async function removeDropIn(dir: string, name: string): Promise<DeclarationRemoveResult> {
  const filename = normalizeDropInFilename(name);
  const target = join(dir, filename);
  try {
    const dirInfo = await lstat(dir);
    assertOwnedPrivateDir(dir, dirInfo);
  } catch (error) {
    if (error instanceof WireClientError) throw error;
    if (errnoOf(error) === 'ENOENT') return { path: target, removed: false };
    throw filesystemFailure(`Cannot inspect drop-in directory ${dir}`, error);
  }
  try {
    const info = await lstat(target);
    if (info.isDirectory()) {
      throw new WireClientError('invalid-request', `Drop-in target ${target} is a directory`, 'not-sent');
    }
    await unlink(target);
    return { path: target, removed: true };
  } catch (error) {
    if (error instanceof WireClientError) throw error;
    if (errnoOf(error) === 'ENOENT') return { path: target, removed: false };
    throw filesystemFailure(`Cannot remove drop-in file ${target}`, error);
  }
}

/** The drop-in directory a call names, or the default one beside its `node.json`. */
function targetDir(options: DeclarationFileOptions, kind: 'services.d' | 'events.d'): string {
  try {
    if (options.dropInDir !== undefined) return absolutePath('dropInDir', options.dropInDir);
    return kind === 'services.d' ? defaultServiceDropInDir(options) : defaultEventDropInDir(options);
  } catch (cause) {
    if (!(cause instanceof RangeError)) throw cause;
    throw new WireClientError('invalid-request', cause.message, 'not-sent', { cause });
  }
}

/**
 * The owner's own value as JSON, after the schema accepted both the value and the bytes written for
 * it. Defaults are not materialised: the agent that reads the file applies its own.
 */
function serializeDeclaration(
  value: unknown,
  schema: { safeParse(value: unknown): { success: boolean; error?: unknown } },
  what: string,
): string {
  const checked = schema.safeParse(value);
  if (!checked.success)
    throw new WireClientError('invalid-request', `Invalid ${what}`, 'not-sent', { cause: checked.error });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const reread = schema.safeParse(JSON.parse(serialized));
  if (!reread.success)
    throw new WireClientError('invalid-request', `Invalid ${what}: it does not survive JSON`, 'not-sent', {
      cause: reread.error,
    });
  return serialized;
}

/**
 * Validate and atomically write a service declaration into the node agent's `services.d/` drop-in
 * directory, without touching `node.json` or restarting the agent. A written file is not yet a loaded
 * declaration: an agent that reads drop-in directories picks it up on its next poll and reports it
 * in `status().services.declarations.descriptors` (by path, with its state). An agent whose
 * `node.json` sets `services.dropInDir` reads only that directory: pass it as `dropInDir`. The writer
 * must run as the agent's user (`dropInRefusal`).
 */
export async function writeServiceDeclarationFile(
  name: string,
  declaration: ServiceDeclarationInput,
  options: DeclarationFileOptions = {},
): Promise<DeclarationWriteResult> {
  const serialized = serializeDeclaration(declaration, ServiceDeclarationSchema, 'service declaration');
  return writeValidatedDropIn(
    targetDir(options, 'services.d'),
    name,
    serialized,
    SERVICE_MAX_DECLARATION_BYTES,
  );
}

/** Idempotently remove a service declaration file from `services.d/`. */
export async function removeServiceDeclarationFile(
  name: string,
  options: DeclarationFileOptions = {},
): Promise<DeclarationRemoveResult> {
  return removeDropIn(targetDir(options, 'services.d'), name);
}

/**
 * Validate and atomically write a topic descriptor into the node agent's `events.d/` drop-in
 * directory, on the same terms as `writeServiceDeclarationFile`: the agent confirms it in
 * `status().events.declarations.descriptors`, `events.dropInDir` in `node.json` must be passed as
 * `dropInDir`, and the writer runs as the agent's user.
 */
export async function writeTopicDescriptorFile(
  name: string,
  descriptor: TopicDescriptorInput,
  options: DeclarationFileOptions = {},
): Promise<DeclarationWriteResult> {
  const serialized = serializeDeclaration(descriptor, TopicDescriptorSchema, 'topic descriptor');
  return writeValidatedDropIn(targetDir(options, 'events.d'), name, serialized, TOPIC_MAX_DESCRIPTOR_BYTES);
}

/** Idempotently remove a topic descriptor file from `events.d/`. */
export async function removeTopicDescriptorFile(
  name: string,
  options: DeclarationFileOptions = {},
): Promise<DeclarationRemoveResult> {
  return removeDropIn(targetDir(options, 'events.d'), name);
}
