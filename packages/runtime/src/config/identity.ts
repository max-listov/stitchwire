import { lstatSync, readlinkSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { errnoOf } from '../../../local-client/src/errno.ts';

/** All writers of a configuration share the same resource, including its symlink spelling. */
function canonicalPath(path: string, links: number): string {
  if (links > 40) throw new Error('too many symbolic links in configuration path');
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink())
        return canonicalPath(
          resolve(dirname(current), readlinkSync(current), ...parts.slice(index + 1)),
          links + 1,
        );
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return resolve(current, ...parts.slice(index + 1));
      throw error;
    }
  }
  return current;
}

/** Public callbacks accept only a path; Array.map's index is never a recursion budget. */
export function configIdentity(path: string): string {
  return canonicalPath(path, 0);
}

/**
 * The identity of a Unix socket path: its canonical directory and its own name. Bun/macOS cannot
 * realpath a live Unix socket, and the name inside its directory is what binds it.
 */
export function socketIdentity(path: string): string {
  return join(configIdentity(dirname(path)), basename(path));
}
