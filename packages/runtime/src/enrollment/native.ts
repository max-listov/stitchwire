import { homedir } from 'node:os';
import { runNativeCommand } from 'stitchkit/process';

/**
 * A bounded native command with a declared environment. Its stdout is read by the caller and its
 * stderr by nobody: neither reaches an enrollment record or a terminal.
 */
export async function command(
  executable: string,
  args: string[],
): Promise<{ code: number | null; text: string }> {
  const result = await runNativeCommand({
    executable,
    args,
    timeoutMs: 15_000,
    maxOutputBytes: 64 * 1024,
    capture: true,
    envPolicy: 'declared-only',
    env: { PATH: '/usr/bin:/bin', HOME: homedir(), XDG_RUNTIME_DIR: `/run/user/${process.getuid?.() ?? 0}` },
  });
  return { code: result.exitCode, text: new TextDecoder().decode(result.stdout).trim() };
}
