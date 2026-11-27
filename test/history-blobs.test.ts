import { expect, test } from 'bun:test';
import { type HistoryGit, readHistoryBlobs } from '../scripts/history-blobs.ts';
const sha = 'a'.repeat(40),
  second = 'b'.repeat(40);
const listed = `${sha} first.txt\n${second} second.txt\n`;
const typed = `${sha} blob 3\n${second} blob 2\n`;
const dumped = `${sha} blob 3\none\n${second} blob 2\nxx\n`;
const result = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout: Buffer.from(stdout),
  stderr: Buffer.alloc(0),
});
const fake =
  (types = typed, bodies = dumped, codeAt?: string): HistoryGit =>
  async (_root, args) => {
    const phase = args[0] === 'rev-list' ? 'list' : args[1] === '--batch-check' ? 'types' : 'bodies';
    return result(phase === 'list' ? listed : phase === 'types' ? types : bodies, phase === codeAt ? 1 : 0);
  };

test('complete history protocol visits every measured blob; failed or partial replies never attest full coverage', async () => {
  const seen: string[] = [];
  expect(
    await readHistoryBlobs('/unused', (path, body) => seen.push(`${path}:${body}`), { run: fake() }),
  ).toEqual({
    blobs: 2,
    paths: ['first.txt', 'second.txt'],
  });
  expect(seen).toEqual(['first.txt:one', 'second.txt:xx']);
  for (const phase of ['list', 'types', 'bodies'])
    await expect(readHistoryBlobs('/unused', () => {}, { run: fake(typed, dumped, phase) })).rejects.toThrow(
      'failed',
    );
  for (const types of [
    '',
    `${sha} missing\n`,
    typed.replace(second, sha),
    typed.slice(0, -1),
    typed.replace('blob 3', 'unknown 3'),
  ])
    await expect(readHistoryBlobs('/unused', () => {}, { run: fake(types) })).rejects.toThrow();
  for (const body of [
    '',
    dumped.slice(0, -1),
    dumped.replace('blob 3', 'blob 4'),
    dumped.replace(second, sha),
    dumped + dumped,
    dumped.slice(0, dumped.lastIndexOf(second)),
  ])
    await expect(readHistoryBlobs('/unused', () => {}, { run: fake(typed, body) })).rejects.toThrow();
});
