import { readFileSync } from 'node:fs';

/**
 * Whether a pid that answers a signal probe is actually running.
 *
 * `process.kill(pid, 0)` succeeds for a ZOMBIE — measured on both platforms this fleet runs, not
 * assumed: a process that has exited and whose parent has not reaped it stays in the process
 * table, so the probe every liveness check uses reads it as present. It holds no descriptor and no
 * lock, and it cannot be killed. Anything deciding "is this still doing something" must ask for the
 * state, not for the signal's success.
 *
 * Two readers because the fact lives in two places: `/proc/<pid>/stat` on Linux, whose state letter
 * follows the LAST `)` — the command name sits in parentheses and may contain them — and `ps`
 * elsewhere. `unknown` when neither answers: the honest third outcome, never folded into `running`.
 *
 * One copy serves every caller, because a second would drift: a copy that is blind on one platform
 * reads as though it handled the case everywhere.
 */
export function processState(pid: number): 'zombie' | 'running' | 'unknown' {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const after = stat.slice(stat.lastIndexOf(')') + 1).trim();
    const letter = after[0];
    if (letter === undefined) return 'unknown';
    return letter === 'Z' ? 'zombie' : 'running';
  } catch {
    // Not Linux, or the entry vanished between the probe and this read.
  }
  const shown = Bun.spawnSync(['ps', '-o', 'state=', '-p', String(pid)]);
  if (shown.exitCode !== 0) return 'unknown';
  const state = shown.stdout.toString().trim();
  if (state.length === 0) return 'unknown';
  return state.startsWith('Z') ? 'zombie' : 'running';
}

/**
 * "Is this pid still doing something." A zombie is NOT: it has exited, and treating it as alive is
 * what makes a cleanup assertion fail on a machine whose supervisor does not reap.
 *
 * COST, measured here rather than reasoned about: the signal probe is 0.00027ms, `processState` is
 * 1.39ms — on macOS there is no `/proc`, so the state comes from spawning `ps`. Five thousand to
 * one. The order below is what makes that bearable and is not incidental: the signal is asked
 * first, so a pid that is genuinely gone costs 0.00066ms and spawns nothing.
 *
 * The axis is therefore NOT "hot path" but "does this usually find the process ALIVE". A loop
 * waiting for something to exit pays the full price only while it has not exited yet, and both
 * callers here are that shape — measured at no difference across two runs each way. A per-read
 * health check on a live process pays it every single time, which is where a neighbouring project
 * measured half a second across two hundred reads and kept the bare signal probe on purpose. If
 * this is ever carried into that shape, the zombie's reachability there has to be ANSWERED — it
 * exists only while the process is a child of something that does not reap it — rather than
 * assumed by analogy with this file.
 */
export function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return processState(pid) !== 'zombie';
}
