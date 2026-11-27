/** Where the node's configuration file came from, and the mode it holds now. */

import { statSync } from 'node:fs';

import type { ConfigOrigin } from './agent-contract.ts';
export function configReport(origin: ConfigOrigin | undefined): { path: string; mode: string | null } | null {
  if (origin === undefined) return null;
  try {
    return { path: origin.path, mode: (statSync(origin.path).mode & 0o777).toString(8).padStart(3, '0') };
  } catch {
    // The file was moved or deleted after the agent read it — worth saying, not worth crashing over.
    return { path: origin.path, mode: null };
  }
}
