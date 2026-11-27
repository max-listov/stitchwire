import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stampsLines } from '../packages/runtime/src/logger.ts';

const device = () => ({ dev: 16777232, ino: 4242 });

test('stderr lines carry time only where nothing else records it', () => {
  expect(stampsLines({ isTTY: true, journalStream: undefined, device })).toBe(false);
  expect(stampsLines({ isTTY: false, journalStream: undefined, device })).toBe(true);
  expect(stampsLines({ isTTY: false, journalStream: '16777232:4242', device })).toBe(false);
  // Inherited from a parent under systemd while this stderr goes to a file.
  expect(stampsLines({ isTTY: false, journalStream: '16777232:9999', device })).toBe(true);
  const unreadable = () => {
    throw new Error('EBADF');
  };
  expect(stampsLines({ isTTY: false, journalStream: '16777232:4242', device: unreadable })).toBe(true);
});

const LOGGER = resolve(import.meta.dir, '../packages/runtime/src/logger.ts');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

/** The agent's real sink, with stderr sent to a file the way launchd sends it. */
function logToFile(journalStream: (path: string) => string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), 'wire-log-time-'));
  try {
    const path = join(dir, 'agent.log');
    writeFileSync(path, '');
    const script = join(dir, 'write.ts');
    writeFileSync(
      script,
      `import { wireLogger } from ${JSON.stringify(LOGGER)};\nwireLogger.error('[wire] owner I/O failed', { service: 'a.b' });\n`,
    );
    const env: Record<string, string | undefined> = { ...process.env, JOURNAL_STREAM: journalStream(path) };
    const child = Bun.spawnSync([process.execPath, script], {
      env,
      stderr: Bun.file(path),
      stdout: 'ignore',
    });
    expect(child.exitCode).toBe(0);
    return readFileSync(path, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a file-backed agent log starts each record with its time', () => {
  const written = logToFile(() => undefined);
  expect(written).toMatch(ISO);
  expect(written).toContain('[wire] owner I/O failed');
});

test('a journald stream gets no second time', () => {
  const written = logToFile((path) => {
    const { dev, ino } = statSync(path);
    return `${dev}:${ino}`;
  });
  expect(written.startsWith('[wire] owner I/O failed')).toBe(true);
});
