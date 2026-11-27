import { type Dirent, lstatSync, readdirSync, realpathSync, type Stats, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  type JsonFileReading,
  type JsonValueSchema,
  type PolledJsonEntry,
  PolledJsonFiles,
  RegularFileError,
  type RegularFileReadOptions,
  readJsonOnce,
} from 'stitchkit/files';
import type { SchemaParse } from '../../../contracts/src/protocol/schema-parse.ts';
import { dropInRefusal } from '../../../local-client/src/declarations.ts';
import { errnoOf } from '../../../local-client/src/errno.ts';
import { dropInDirBeside } from '../../../local-client/src/paths.ts';
import { configIdentity } from './identity.ts';

export interface DropInEntry {
  path: string;
  /** True for a file found in the drop-in directory, false for a path `node.json` names. */
  dropIn: boolean;
  readOptions?: RegularFileReadOptions;
}

export interface DropInScanIssue {
  path: string;
  detail: string;
}

export interface DropInScanResult {
  entries: DropInEntry[];
  issue: DropInScanIssue | null;
  /** No drop-in directory exists (or none is configured): nothing in it to poll, only its appearance. */
  absent: boolean;
}

/**
 * Memoized per `agentUid` so consecutive polls hand `PolledJsonFiles` the exact same `accept`
 * function reference and keep its unchanged-identity shortcut active.
 */
const dropInReadOptionsCache = new Map<number | undefined, RegularFileReadOptions>();

/**
 * How a drop-in file is read for an agent of `agentUid` (this process's when `undefined`): never
 * through a symlink, and judged by the drop-in policy (`dropInRefusal`) on the handle it is read
 * from (`fstat`).
 */
function dropInReadOptions(agentUid: number | undefined): RegularFileReadOptions {
  const cached = dropInReadOptionsCache.get(agentUid);
  if (cached !== undefined) return cached;
  const options: RegularFileReadOptions = {
    noFollow: true,
    accept: (info) => {
      const refusal = dropInRefusal(info, 'file', agentUid);
      if (refusal !== null) throw new RegularFileError('rejected', refusal.detail);
      return true;
    },
  };
  dropInReadOptionsCache.set(agentUid, options);
  return options;
}

/**
 * The uid the agent started from `configPath` reads its drop-in files as: the owner of that
 * configuration, which only its agent reads (mode 0600). A judge that runs as another user —
 * enrollment or `config validate` under root — judges the set by this uid, never by its own, or
 * every drop-in file would look foreign to it and protect nothing. A configuration not written yet
 * is born to this process.
 */
export function dropInOwner(configPath: string): number | undefined {
  return statSync(configPath, { throwIfNoEntry: false })?.uid ?? process.getuid?.();
}

/**
 * The drop-in directories an agent started from `configPath` reads: the configured `dropInDir`,
 * none for `null`, and otherwise the default beside the configuration file (`dropInDirBeside`). The
 * agent, its stream admission, enrollment and `config validate` all take them from here.
 */
export function dropInDirs(
  config: { services: { dropInDir?: string | null }; events: { dropInDir?: string | null } },
  configPath: string | undefined,
): { services: string | undefined; events: string | undefined } {
  const resolveDir = (configured: string | null | undefined, kind: 'services.d' | 'events.d') =>
    configured === null
      ? undefined
      : (configured ?? (configPath === undefined ? undefined : dropInDirBeside(configPath, kind)));
  return {
    services: resolveDir(config.services.dropInDir, 'services.d'),
    events: resolveDir(config.events.dropInDir, 'events.d'),
  };
}

/** Comparison by UTF-16 code units, independent of locale: plain ASCII order for the names the SDK writes. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Canonical identity of a declaration path; a broken or cyclic symlink keeps its spelled path. */
export function declarationIdentity(path: string): string {
  try {
    return configIdentity(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The declaration files in force order: the explicit `node.json` paths as listed, then the `*.json`
 * files of `dropInDir` (`services.d/` or `events.d/`) by file name in code-unit order. Where two
 * files claim one service, socket or topic, the earlier one keeps it — so an explicit declaration
 * always precedes a drop-in, and among drop-ins `a.json` precedes `b.json`, whatever their age.
 *
 * A missing `dropInDir` (`ENOENT`) is normal: `absent`, no issue. A symlinked, foreign-owned or
 * group/world-writable `dropInDir` is refused fail-closed with one summary issue, visible in
 * `status()` and `stitchwire doctor`; its files are then not read at all. Dot-files are skipped, so
 * an atomic writer's staging file is never read. A drop-in symlink is never followed for
 * deduplication: it reaches the `O_NOFOLLOW` read and is reported `invalid` without aborting the
 * scan. The set holds at most `maxTotal` files, explicit ones first; the rest is one overflow issue.
 */
export function scanDropInFiles(
  explicitPaths: readonly string[],
  dropInDir: string | undefined,
  maxTotal: number,
  /** The agent's uid (`dropInOwner`); `undefined` for this process's, as the agent itself reads. */
  agentUid?: number,
): DropInScanResult {
  const entries: DropInEntry[] = explicitPaths.map((path) => ({ path, dropIn: false }));
  const refuse = (detail: string): DropInScanResult => ({
    entries,
    issue: { path: dropInDir ?? '', detail },
    absent: false,
  });
  if (dropInDir === undefined) return { entries, issue: null, absent: true };

  let info: Stats;
  try {
    info = lstatSync(dropInDir);
  } catch (error) {
    if (errnoOf(error) === 'ENOENT') return { entries, issue: null, absent: true };
    return refuse(`cannot inspect drop-in directory: ${String(error).slice(0, 200)}`);
  }
  const refusal = dropInRefusal(info, 'directory', agentUid);
  if (refusal !== null) return refuse(refusal.detail);

  let dirEntries: Dirent<string>[];
  let canonicalDir: string;
  try {
    dirEntries = readdirSync(dropInDir, { withFileTypes: true });
    canonicalDir = realpathSync(dropInDir);
  } catch (error) {
    return refuse(`cannot read drop-in directory: ${String(error).slice(0, 200)}`);
  }

  const seen = new Set(explicitPaths.map(declarationIdentity));
  const candidates = dirEntries
    .filter((entry) => !entry.isDirectory() && !entry.name.startsWith('.') && entry.name.endsWith('.json'))
    .sort((left, right) => compareCodeUnits(left.name, right.name));

  const readOptions = dropInReadOptions(agentUid);
  const dropIns: DropInEntry[] = [];
  for (const entry of candidates) {
    // Never dereference a drop-in symlink for dedupe: symlinks must reach O_NOFOLLOW and report invalid.
    if (!entry.isSymbolicLink()) {
      const identity = join(canonicalDir, entry.name);
      if (seen.has(identity)) continue;
      seen.add(identity);
    }
    dropIns.push({ path: join(dropInDir, entry.name), dropIn: true, readOptions });
  }

  const room = Math.max(0, maxTotal - entries.length);
  if (dropIns.length > room) {
    return {
      entries: [...entries, ...dropIns.slice(0, room)],
      issue: {
        path: dropInDir,
        detail: `drop-in directory exceeds the ${maxTotal}-file limit (${dropIns.length - room} extra file(s) ignored)`,
      },
      absent: false,
    };
  }
  return { entries: [...entries, ...dropIns], issue: null, absent: false };
}

export interface DeclarationFileReading<T> {
  path: string;
  dropIn: boolean;
  reading: JsonFileReading<T>;
}

const SCHEMA_PREFIX = 'Schema validation failed: ';

/** Adapts Wire's one-line `SchemaParse` to `stitchkit/files`'s `JsonValueSchema` so runtime, CLI and SDK share one verdict. */
export function declarationSchema<T>(parse: SchemaParse<T>): JsonValueSchema<T> {
  return {
    safeParse(value: unknown) {
      const parsed = parse(value);
      return parsed.ok ? { success: true, data: parsed.value } : { success: false, error: parsed.detail };
    },
  };
}

/** Human detail for an invalid/unreadable declaration reading, preserving `SchemaParse`'s exact one-line reason. */
export function declarationReadingDetail(reading: {
  readonly state: 'invalid' | 'unreadable';
  readonly reason?: string;
  readonly detail: string;
}): string {
  if (reading.state === 'invalid' && reading.reason === 'schema' && reading.detail.startsWith(SCHEMA_PREFIX))
    return reading.detail.slice(SCHEMA_PREFIX.length);
  return reading.detail;
}

/**
 * A scanned set of declaration files polled together via `stitchkit/files` `PolledJsonFiles`.
 * Preserves the caller's force order (explicit `node.json` descriptors, then drop-in files),
 * deduplicates repeated paths before `refreshAsync`, serializes concurrent refreshes without
 * blocking callers' downstream RPC sends, and returns `null` only when the ordered path list,
 * every file reading and `issueSignature` are unchanged since the previous poll.
 */
export class DeclarationFileSet<T> {
  private readonly files: PolledJsonFiles<T>;
  private readonly readings = new Map<string, JsonFileReading<T>>();
  private previousPaths: string[] | undefined;
  private previousIssue = '';
  private queue: Promise<void> = Promise.resolve();

  constructor(parse: SchemaParse<T>, limit: number) {
    this.files = new PolledJsonFiles(declarationSchema(parse), { limit });
  }

  readChanged(entries: readonly DropInEntry[], issueSignature = ''): Promise<JsonFileReading<T>[] | null> {
    const run = this.queue.then(() => this.readChangedExclusive(entries, issueSignature));
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readChangedExclusive(
    entries: readonly DropInEntry[],
    issueSignature: string,
  ): Promise<JsonFileReading<T>[] | null> {
    const unique = new Map<string, PolledJsonEntry>();
    for (const entry of entries) {
      if (!unique.has(entry.path)) {
        unique.set(
          entry.path,
          entry.readOptions === undefined
            ? { path: entry.path }
            : { path: entry.path, options: entry.readOptions },
        );
      }
    }
    const changes = await this.files.refreshAsync(unique.values());
    for (const change of changes) {
      if (change.kind === 'removed') this.readings.delete(change.path);
      else this.readings.set(change.path, change.reading);
    }
    const paths = entries.map((entry) => entry.path);
    const samePaths =
      this.previousPaths !== undefined &&
      paths.length === this.previousPaths.length &&
      paths.every((path, index) => path === this.previousPaths?.[index]);
    if (samePaths && changes.length === 0 && this.previousIssue === issueSignature) return null;
    this.previousPaths = paths;
    this.previousIssue = issueSignature;
    return paths.map((path) => this.readings.get(path) ?? { state: 'missing' });
  }
}

/**
 * One synchronous reading of the whole declaration set the agent would read — explicit paths and
 * drop-in files, in force order, each read the way the agent reads it, as the agent's user — for
 * callers that judge the set without running an agent: enrollment and `config validate`.
 */
export function readDeclarationSetSync<T>(
  explicitPaths: readonly string[],
  dropInDir: string | undefined,
  maxTotal: number,
  parse: SchemaParse<T>,
  maxBytes: number,
  /** The uid of the agent whose set this is (`dropInOwner`). */
  agentUid: number | undefined,
): { files: DeclarationFileReading<T>[]; issue: DropInScanIssue | null } {
  const scan = scanDropInFiles(explicitPaths, dropInDir, maxTotal, agentUid);
  const schema = declarationSchema(parse);
  return {
    files: scan.entries.map((entry) => ({
      path: entry.path,
      dropIn: entry.dropIn,
      reading: readJsonOnce(entry.path, schema, { limit: maxBytes, ...entry.readOptions }),
    })),
    issue: scan.issue,
  };
}
