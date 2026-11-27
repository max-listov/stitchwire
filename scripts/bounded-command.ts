import { runNativeCommand } from 'stitchkit/process';

/**
 * One bounded path for every command a publication or an audit runs: the operator's own
 * authentication and configuration stay available, the output is captured and capped, a command
 * that hangs ends, and none of them outlives the script that started it.
 */
export function runBounded(
  executable: string,
  args: string[],
  options: { cwd?: string; stdin?: Uint8Array; timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<{ exitCode: number | null; stdout: Uint8Array; stderr: Uint8Array }> {
  return runNativeCommand({
    executable,
    args,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    envPolicy: 'ambient',
    ownerLoss: 'terminate',
    capture: true,
    timeoutMs: options.timeoutMs ?? 60_000,
    maxOutputBytes: options.maxOutputBytes ?? 4 * 1024 * 1024,
  });
}

/** The end of what a refused command said on stderr: the cause a refusal keeps. */
export function saidLast(stderr: Uint8Array, limit = 400): string {
  return new TextDecoder().decode(stderr).trim().slice(-limit);
}
