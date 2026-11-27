import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_LAUNCHER_SOURCE } from '../scripts/macos/bundle-plan.ts';
import { runStrict } from '../scripts/macos/codesign.ts';

const isDarwin = process.platform === 'darwin';

/** Wait for a condition; the test's own timeout is the only ceiling. */
async function until(condition: () => boolean): Promise<void> {
  while (!condition()) await Bun.sleep(20);
}

function lines(path: string): string[] {
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
}

describe.if(isDarwin)('stitchwire-launcher C supervisor (macOS)', () => {
  let work = '';
  let strictLauncher = '';
  let testLauncher = '';

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'stitchwire-launcher-test-'));
    strictLauncher = join(work, 'stitchwire-launcher-strict');
    testLauncher = join(work, 'stitchwire-launcher-test');
    const flags = ['-O2', '-Wall', '-Wextra', '-Werror'];
    runStrict(['clang', ...flags, DEFAULT_LAUNCHER_SOURCE, '-o', strictLauncher], 'compile strict launcher');
    runStrict(
      [
        'clang',
        ...flags,
        '-DSTITCHWIRE_LAUNCHER_ALLOW_NON_LAUNCHD=1',
        DEFAULT_LAUNCHER_SOURCE,
        '-o',
        testLauncher,
      ],
      'compile test launcher',
    );
  });

  afterAll(() => {
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test('strict build refuses direct shell invocation when ppid != 1 (fail-closed negative control)', () => {
    const marker = join(work, 'should-not-exist');
    const proc = Bun.spawnSync([strictLauncher, '/usr/bin/touch', marker], { stderr: 'pipe' });
    expect(proc.exitCode).toBe(125);
    expect(proc.stderr.toString()).toContain('must be launched directly by launchd');
    expect(existsSync(marker)).toBe(false);
  });

  test('returns exit code 2 without target program', () => {
    const proc = Bun.spawnSync([testLauncher], { stderr: 'pipe' });
    expect(proc.exitCode).toBe(2);
  });

  test('preserves arguments, environment and child exit code', () => {
    const proc = Bun.spawnSync(
      [testLauncher, '/bin/sh', '-c', 'printf "%s:%s" "$SW_PROBE" "$1"; exit 7', '--', 'ok-arg'],
      { env: { ...process.env, SW_PROBE: 'hello' }, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(proc.exitCode).toBe(7);
    expect(proc.stdout.toString()).toBe('hello:ok-arg');
  });

  test('returns 127 when target executable does not exist', () => {
    const proc = Bun.spawnSync([testLauncher, '/nonexistent/stitchwire-launcher-target'], { stderr: 'pipe' });
    expect(proc.exitCode).toBe(127);
    expect(proc.stderr.toString()).toContain('cannot start');
  });

  test('forwards SIGTERM to child and exits with child status', async () => {
    const marker = join(work, 'sigterm-marker');
    const child = Bun.spawn(
      [
        testLauncher,
        '/bin/sh',
        '-c',
        `trap 'echo caught > "${marker}"; exit 9' TERM; echo ready; while true; do sleep 0.1; done`,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    await child.stdout.getReader().read();
    child.kill('SIGTERM');
    expect(await child.exited).toBe(9);
    expect(readFileSync(marker, 'utf8').trim()).toBe('caught');
  });

  test('forwards SIGUSR1, SIGUSR2, SIGWINCH, SIGINFO and SIGHUP to the child and stays alive', async () => {
    const received = join(work, 'received');
    const names = ['USR1', 'USR2', 'WINCH', 'INFO', 'HUP'] as const;
    const traps = names.map((name) => `trap 'echo ${name} >> "$1"' ${name}`).join('; ');
    const child = Bun.spawn(
      [
        testLauncher,
        '/bin/sh',
        '-c',
        `${traps}; echo ready; while true; do sleep 0.05; done`,
        'sh',
        received,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    await child.stdout.getReader().read();
    for (const [index, name] of names.entries()) {
      // Bun's kill() does not name SIGINFO; /bin/kill sends every signal the same way.
      runStrict(['/bin/kill', '-s', name, String(child.pid)], `kill -${name}`);
      await until(() => lines(received).length === index + 1);
    }
    expect(lines(received)).toEqual([...names]);
    expect(child.exitCode).toBeNull();
    child.kill('SIGTERM');
    await child.exited;
    expect(child.signalCode).toBe('SIGTERM');
  });

  test('a child killed by a signal ends the launcher by the same signal, not by exit code 128+N', () => {
    for (const signal of ['KILL', 'SEGV', 'USR2'] as const) {
      const proc = Bun.spawnSync([testLauncher, '/bin/sh', '-c', `kill -${signal} $$`]);
      // A process ended by a signal has no exit code at all.
      expect({ signal, signalCode: proc.signalCode, hasExitCode: typeof proc.exitCode === 'number' }).toEqual(
        {
          signal,
          signalCode: `SIG${signal}`,
          hasExitCode: false,
        },
      );
    }
  });

  test('a signal ignored by whoever started the launcher stays ignored for the child', () => {
    const proc = Bun.spawnSync(
      ['/bin/sh', '-c', `trap '' USR1; exec "${testLauncher}" /bin/sh -c 'kill -USR1 $$; echo survived'`],
      { stdout: 'pipe' },
    );
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString().trim()).toBe('survived');
  });
});
