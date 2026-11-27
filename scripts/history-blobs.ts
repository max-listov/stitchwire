import { runBounded } from './bounded-command.ts';
import { historicalPaths } from './history-paths.ts';

type GitResult = { exitCode: number | null; stdout: Uint8Array; stderr: Uint8Array };
export type HistoryGit = (root: string, args: string[], stdin?: Uint8Array) => Promise<GitResult>;
const git: HistoryGit = (root, args, stdin) =>
  runBounded('git', ['-C', root, ...args], {
    ...(stdin ? { stdin } : {}),
    maxOutputBytes: 1024 * 1024 * 1024,
  });
const shaPattern = '(?:[a-f0-9]{40}|[a-f0-9]{64})';
const headerPattern = new RegExp(`^(${shaPattern}) (blob|tree|commit|tag) (0|[1-9][0-9]*)$`);

function lines(bytes: Uint8Array): string[] {
  if (bytes.byteLength === 0) return [];
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n')) throw new Error('truncated Git response');
  return text.slice(0, -1).split('\n');
}

/** A complete protocol exchange, or no successful audit. Every requested object must answer once,
 * in order, with the measured type/size and a complete byte frame plus its trailing newline. */
export async function readHistoryBlobs(
  root: string,
  visit: (path: string, body: string, sha: string, paths: readonly string[]) => void,
  options: {
    /** How Git is asked; the default runs the real one. */
    run?: HistoryGit;
    /** Told every path of every tree, with the object it names, before the blobs are read. */
    visitPath?: (path: string, object: string) => void;
  } = {},
): Promise<{ blobs: number; paths: string[] }> {
  const { run = git, visitPath } = options;
  const checked = async (args: string[], stdin?: Uint8Array): Promise<Buffer> => {
    const result = await run(root, args, stdin);
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed (${result.exitCode})`);
    return Buffer.from(result.stdout);
  };
  const named = new Map<string, string>();
  for (const line of lines(await checked(['rev-list', '--all', '--objects']))) {
    if (!new RegExp(`^${shaPattern}(?: .*)?$`).test(line)) throw new Error('malformed Git object inventory');
    const space = line.indexOf(' ');
    const sha = space < 0 ? line : line.slice(0, space);
    const path = space < 0 ? '' : line.slice(space + 1);
    if (path || !named.has(sha)) named.set(sha, path || '(unnamed)');
  }
  if (named.size === 0) return { blobs: 0, paths: [] };
  const shas = [...named.keys()];
  const typed = lines(await checked(['cat-file', '--batch-check'], Buffer.from(`${shas.join('\n')}\n`)));
  if (typed.length !== shas.length) throw new Error('incomplete Git object type inventory');
  const objects: Array<{ sha: string; type: string; size: number }> = [];
  for (const [index, line] of typed.entries()) {
    const match = headerPattern.exec(line);
    if (!match?.[1] || match[1] !== shas[index]) throw new Error('Git object identity/type response differs');
    const size = Number(match[3]);
    if (!Number.isSafeInteger(size)) throw new Error('invalid Git object byte length');
    objects.push({ sha: match[1], type: match[2] ?? '', size });
  }
  if (objects.length === 0) return { blobs: 0, paths: [] };
  const out = await checked(
    ['cat-file', '--batch'],
    Buffer.from(`${objects.map((object) => object.sha).join('\n')}\n`),
  );
  const bodies: Array<{ sha: string; type: string; body: Buffer }> = [];
  let at = 0;
  for (const blob of objects) {
    const newline = out.indexOf(10, at);
    if (
      newline < 0 ||
      out.subarray(at, newline).toString('ascii') !== `${blob.sha} ${blob.type} ${blob.size}`
    )
      throw new Error('missing or mismatched Git blob header');
    const start = newline + 1,
      end = start + blob.size;
    if (end >= out.length || out[end] !== 10) throw new Error('truncated Git blob body');
    bodies.push({ sha: blob.sha, type: blob.type, body: out.subarray(start, end) });
    at = end + 1;
  }
  if (at !== out.length) throw new Error('unexpected Git blob frames');
  const paths = historicalPaths(bodies, (shas[0]?.length ?? 40) / 2);
  const allPaths = new Set<string>();
  for (const [sha, names] of paths)
    for (const path of names) {
      allPaths.add(path);
      visitPath?.(path, sha);
    }
  let blobs = 0;
  for (const object of bodies) {
    for (const path of paths.get(object.sha) ?? []) allPaths.add(path);
    if (object.type !== 'blob') continue;
    blobs += 1;
    const names = [...(paths.get(object.sha) ?? [named.get(object.sha) ?? '(unnamed)'])].sort();
    for (const path of names)
      if (!allPaths.has(path)) {
        allPaths.add(path);
        visitPath?.(path, object.sha);
      }
    visit(names[0] ?? '(unnamed)', object.body.toString(), object.sha, names);
  }
  return { blobs, paths: [...allPaths].sort() };
}
