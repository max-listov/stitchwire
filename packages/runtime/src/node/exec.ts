import { ownEntry } from '../json.ts';
/**
 * Running what a remote node asked for — the only place in this project that starts a process.
 *
 * Two rules hold the whole security story of the receiving side:
 *  1. **argv, never a command line.** No shell is spawned anywhere on this path, so quoting,
 *     semicolons and `$` in an argument are data and cannot become syntax.
 *  2. **A name maps to an absolute binary, from local config.** The caller chooses *which allowed
 *     command*, never *which file on disk*. A daemon's PATH is nearly empty under launchd and
 *     systemd, so resolving at call time would hand that choice to whoever is calling.
 */

import { constants } from 'node:os';
import { dirname } from 'node:path';
import { NativeCommandError, type NativeCommandStopPolicy, runNativeCommand } from 'stitchkit/process';
import {
  policyRefusal,
  type Refused,
  requestRefusal,
  unclassifiedFailure,
} from '../../../contracts/src/protocol/failure.ts';
import { MAX_STDIN_BYTES } from '../../../contracts/src/protocol/bounds.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import type { Invocation, Result } from '../../../contracts/src/protocol/rpc.ts';
import type { CommandProfile } from '../config/profiles.ts';
import type { ExecutionAdmission } from './admission.ts';
import { validateCallerArgs } from './caller-args.ts';
import { CappedOutput } from './capped-output.ts';

/**
 * The environment of a child process.
 *
 * The key part is PATH. The agent lives under systemd (or launchd), where PATH is minimal: the
 * service sets only `HOME`, and the runtime's directory is absent. A child that inherited that PATH
 * failed any allowed command with a `#!/usr/bin/env bun` shebang before its first line of code:
 *
 *     /usr/bin/env: 'bun': No such file or directory
 *
 * A wrapper with an absolute path to the runtime can hide this; a shebang command cannot.
 *
 * It is fixed in the agent and not in the units on the machines: the agent knows what started it
 * (`process.execPath`) and that is enough. The fix travels with the binary, works the same under
 * systemd and launchd, and a new node gets it by upgrading, not by a hand-written line in someone
 * else's unit.
 *
 * The runtime's directory is PREPENDED to PATH, not substituted for it: the machine's own paths
 * stay, or a command that relies on `/usr/local/bin` would break in place of the one being fixed.
 */
export function childEnv(
  caller: string,
  profile: Pick<CommandProfile, 'env'>,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const runtimeDir = dirname(process.execPath);
  const inherited: Record<string, string> = {};
  for (const name of profile.env.inherit) {
    const value = source[name];
    if (value !== undefined) inherited[name] = value;
  }
  const basePath = profile.env.set.PATH ?? inherited.PATH ?? '';
  // Already on PATH — not duplicated: on a developer's Mac the runtime's directory is usually there,
  // and a second entry would only make the environment harder to read.
  const path = basePath.split(':').includes(runtimeDir)
    ? basePath
    : basePath === ''
      ? runtimeDir
      : `${runtimeDir}:${basePath}`;
  return {
    ...inherited,
    ...profile.env.set,
    PATH: path,
    // Who called: honest attribution for whatever decides to read it.
    STITCHWIRE_CALLER: caller,
  };
}

/** The fields every result from this node shares. `refusal`/`retryAfterMs` say "not a classified
 *  refusal" by default, so only a path that actually refuses has to think about them. */
function resultBase(invocation: Invocation) {
  return {
    id: invocation.id,
    ts: nowIso(),
    from: invocation.to,
    refusal: 'none' as const,
    retryAfterMs: null,
    transportCause: null,
  };
}

function refused(invocation: Invocation, refusal: Refused): Result {
  return {
    ...resultBase(invocation),
    code: 1,
    stdout: '',
    stderr: '',
    failure: refusal.failure,
    refusal: refusal.refusal,
    retryAfterMs: refusal.retryAfterMs,
    transportCause: refusal.transportCause,
    detail: refusal.detail,
    truncated: false,
  };
}

function prepare(
  invocation: Invocation,
  allow: Record<string, CommandProfile>,
): { profile: CommandProfile; command: string } | Result {
  const name = invocation.argv[0] ?? '';
  const profile = ownEntry(allow, name);
  if (profile === undefined) {
    const known = Object.keys(allow).sort().join(', ') || '(nothing)';
    return refused(
      invocation,
      policyRefusal(`'${name}' is not in this node's allowlist — allowed: ${known}`),
    );
  }
  const callerArgs = invocation.argv.slice(1);
  const callerArgsProblem = validateCallerArgs(callerArgs, profile.callerArgs);
  if (callerArgsProblem !== null)
    return refused(invocation, requestRefusal(`'${name}' ${callerArgsProblem}`));
  if (profile.stdin.mode === 'none' && invocation.stdin !== null) {
    return refused(invocation, requestRefusal(`'${name}' does not accept stdin`));
  }
  if (
    profile.stdin.mode === 'text' &&
    invocation.stdin !== null &&
    Buffer.byteLength(invocation.stdin) > profile.stdin.maxBytes
  ) {
    return refused(invocation, requestRefusal(`'${name}' stdin exceeds ${profile.stdin.maxBytes} bytes`));
  }
  if (invocation.timeoutMs > profile.timeoutMs) {
    return refused(
      invocation,
      requestRefusal(`'${name}' timeout exceeds profile maximum ${profile.timeoutMs}ms`),
    );
  }
  return { profile, command: name };
}

/** Pause before KILL for an ordinary stop; a cooperative profile declares its own grace. */
export const ORDINARY_STOP_GRACE_MS = 500;

function stopPolicy(profile: CommandProfile, force: AbortSignal | undefined): NativeCommandStopPolicy {
  return profile.cancellation === undefined
    ? { target: 'group', signal: 'SIGTERM', graceMs: ORDINARY_STOP_GRACE_MS, killOn: force }
    : { target: 'leader', signal: 'SIGTERM', graceMs: profile.cancellation.graceMs, killOn: force };
}

/**
 * Why a profile's executable could not start, for the caller's refusal: the executable and, when the
 * runtime reports one, the operating system's reason (`ENOENT … '/path'`), which the command error's
 * own message leaves out.
 */
export function startFailure(bin: string, error: unknown): string {
  const cause = error instanceof Error && error.cause !== undefined ? ` (${String(error.cause)})` : '';
  return `cannot start ${bin}: ${error instanceof Error ? error.message : String(error)}${cause}`;
}

/** The status a shell would report for a command that ended on a signal. */
export function exitStatus(exitCode: number | null, signal: string | null): number {
  if (exitCode !== null) return exitCode;
  const number = signal === null ? undefined : Reflect.get(constants.signals, signal);
  return typeof number === 'number' ? 128 + number : 1;
}

export async function execute(
  invocation: Invocation,
  allow: Record<string, CommandProfile>,
  admission: ExecutionAdmission,
  signal?: AbortSignal,
  /** Ends a cooperative grace at once (the agent is shutting down). */
  force?: AbortSignal,
): Promise<Result> {
  const prepared = prepare(invocation, allow);
  if ('failure' in prepared) return prepared;
  if (signal?.aborted === true)
    return refused(invocation, unclassifiedFailure('cancelled', 'the caller withdrew before execution'));
  const lease = admission.acquire(prepared.command);
  if (!lease.accepted) return refused(invocation, lease.refused);

  const { profile } = prepared;
  const stdout = new CappedOutput(profile.outputBytes);
  const stderr = new CappedOutput(profile.outputBytes);
  const stopping = [signal, force].filter((item): item is AbortSignal => item !== undefined);
  /*
   * A caller that withdrew stops the work, not just the waiting. Without this the plane leaked: the
   * command ran to its own deadline — up to an hour — doing work whose answer nobody would read. A
   * shutting-down agent aborts `force` as well, which ends any cooperative grace with KILL at once.
   * What a stopping command prints is dropped by Stitchkit: a withdrawn call is not listening
   * (ADR 0013), so its owner records its outcome where it can be read later.
   */
  const ended = stopping.length === 0 ? undefined : AbortSignal.any(stopping);
  try {
    const finished = await runNativeCommand({
      executable: profile.bin,
      args: [...profile.argv, ...invocation.argv.slice(1)],
      cwd: profile.cwd,
      envPolicy: 'declared-only',
      env: childEnv(invocation.from, profile),
      ...(invocation.stdin === null ? {} : { stdin: new TextEncoder().encode(invocation.stdin) }),
      maxStdinBytes: MAX_STDIN_BYTES,
      timeoutMs: invocation.timeoutMs,
      signal: ended,
      stop: stopPolicy(profile, force),
      onOutput: (bytes, channel) => (channel === 'stdout' ? stdout : stderr).push(bytes),
    });
    const base = resultBase(invocation);
    const code = exitStatus(finished.exitCode, finished.signal);
    const out = stdout.read();
    const err = stderr.read();
    const stdoutText = out.text;
    const stderrText = err.text;
    const truncated = out.truncated || err.truncated;
    // A profile that declares `output: json` is answered by the node, not by the caller's parser.
    // The node is the only side that can tell "this command produced nothing parseable" from "the
    // transport lost it"; from a string, the caller cannot. A truncated answer is never parseable
    // by definition, so it is reported as the truncation it is rather than as bad JSON.
    if (profile.output.mode === 'json' && code === 0 && !out.truncated) {
      try {
        JSON.parse(stdoutText);
      } catch (error) {
        return {
          ...base,
          code,
          stdout: stdoutText,
          stderr: stderrText,
          failure: 'exec',
          transportCause: null,
          detail: `command declares JSON output and produced none: ${String(error)}`,
          truncated,
        };
      }
    }
    return {
      ...base,
      code,
      stdout: stdoutText,
      stderr: stderrText,
      failure: 'none',
      transportCause: null,
      detail: '',
      truncated,
    };
  } catch (error) {
    const base = resultBase(invocation);
    const out = stdout.read();
    const err = stderr.read();
    const stopped = { ...base, code: 1, stdout: out.text, stderr: err.text, transportCause: null };
    const truncated = out.truncated || err.truncated;
    // The first cause wins: a deadline that expired while a withdrawal was already stopping the
    // command is still a withdrawal, and the other way round.
    if (error instanceof NativeCommandError && error.reason === 'deadline')
      return {
        ...stopped,
        failure: 'timeout',
        detail: `execution deadline reached after ${invocation.timeoutMs}ms`,
        truncated,
      };
    if (ended?.aborted === true)
      return { ...stopped, failure: 'cancelled', detail: 'the caller withdrew the call', truncated };
    return {
      ...base,
      code: 1,
      stdout: '',
      stderr: '',
      failure: 'exec',
      transportCause: null,
      detail:
        error instanceof NativeCommandError && error.code === 'COMMAND_UNAVAILABLE'
          ? startFailure(profile.bin, error)
          : String(error),
      truncated: false,
    };
  } finally {
    lease.release();
  }
}
