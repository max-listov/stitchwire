/**
 * What every release-smoke scenario shares: running the packed artifact as a process, writing its
 * configuration and asking its own door how it is. The artifact is a black box here: its command line
 * and its Unix socket are all that is used.
 */

import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { until } from '../../test/support.ts';
import { installRuntimeAssets } from '../runtime-assets.ts';

/**
 * The executor's `echo` command as every smoke pair grants it. The environment passthrough is a
 * separate field because a rollback binary whose configuration predates it is given the profile
 * without it.
 */
export const ECHO_PROFILE = {
  bin: '/bin/echo',
  callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
  stdin: { mode: 'text', maxBytes: 1048576 },
  timeoutMs: 900_000,
  concurrency: 128,
};
export const ECHO_ENV = { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] };

export const StatusProbeSchema = z.looseObject({ connected: z.boolean() });

/**
 * A result as answered by EITHER release's door. The rollback scenario runs the predecessor end to
 * end, and its door carries its own contract version — so parsing with the candidate's schema would
 * fail the harness on the one scenario where everything is working exactly as intended.
 */
export const EitherDoorResultSchema = z.looseObject({
  v: z.number(),
  code: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  failure: z.string(),
  detail: z.string(),
  refusal: z.string().optional(),
  retryAfterMs: z.number().nullable().optional(),
});
const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

export interface BinaryPair {
  candidate: string;
  rollback: string;
}

export interface Running {
  name: string;
  process: ReturnType<typeof Bun.spawn>;
}

export async function version(binary: string): Promise<string> {
  // Named `child`, not `process`: a local binding called `process` shadows the global one, and a
  // reader — or a grep for `process.kill` — cannot tell which of the two a line means.
  const child = Bun.spawn([binary, '--version'], { stdout: 'pipe', stderr: 'ignore' });
  const text = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) throw new Error('artifact version probe failed');
  return VersionSchema.parse(text.trim());
}

export function token(): string {
  return `${crypto.randomUUID().replaceAll('-', '')}${crypto.randomUUID().replaceAll('-', '')}`;
}

export function isolatedBinary(source: string, root: string, name: string): string {
  const target = join(root, name, 'bin/stitchwire');
  installRuntimeAssets(source, target);
  chmodSync(target, 0o555);
  return target;
}

export async function writeConfig(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
  chmodSync(path, 0o600);
}

/**
 * Every artifact here runs with auto-install DISABLED, and that flag is the whole point of this
 * harness being trustworthy.
 *
 * A standalone artifact is deployed with its native sidecars to a machine with no `node_modules` and
 * often no network. Bun, however, will happily resolve a missing peer at runtime from its own
 * install cache — so a binary that forgot to bundle its transport still starts on a developer's
 * laptop and crash-loops on the node. 0.10.0 shipped exactly that: the harness was green because the
 * machine running it could fetch what the artifact lacked.
 */
export function start(name: string, binary: string, args: string[], env = process.env): Running {
  return {
    name,
    process: Bun.spawn(['bun', '--no-install', binary, ...args], { stdout: 'ignore', stderr: 'ignore', env }),
  };
}

export async function stop(running: Running): Promise<void> {
  if (running.process.exitCode !== null) return;
  running.process.kill('SIGTERM');
  const exited = await Promise.race([
    running.process.exited.then(() => true),
    Bun.sleep(2_000).then(() => false),
  ]);
  if (!exited && running.process.exitCode === null) {
    running.process.kill('SIGKILL');
    await running.process.exited;
  }
}

export async function waitBroker(port: number): Promise<void> {
  const healthy = await until(
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        return false;
      }
    },
    undefined,
    40,
  );
  if (!healthy) throw new Error('ephemeral broker did not become healthy');
}

export async function localJson(socket: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`http://localhost/wire${path}`, {
    unix: socket,
    ...(body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (!response.ok) throw new Error(`local API ${path} returned HTTP ${response.status}`);
  return await response.json();
}

/** Whether a node's own door answers that its lane is up. A door that is not answering yet is not up. */
async function laneUp(socket: string): Promise<boolean> {
  try {
    return StatusProbeSchema.parse(await localJson(socket, '/status')).connected;
  } catch {
    return false;
  }
}

export async function waitAgent(socket: string): Promise<void> {
  if (!(await until(() => laneUp(socket), undefined, 40))) throw new Error('ephemeral agent did not connect');
}

/** Poll a node's own door for a while and report whether the lane ever came up. Reading the door
 *  rather than the broker is deliberate: it is the answer an operator gets on the machine itself. */
export function connectedWithin(socket: string, ms: number): Promise<boolean> {
  return until(() => laneUp(socket), ms, 100);
}
