import { expect, test } from 'bun:test';
import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_API_VERSION } from '../packages/contracts/src/door/common.ts';

function copiedVersionOffsets(source: string): number[] {
  // A narrow source-style guard for fixture fields, not a parser of transported frames.
  const fields = /(?:\bv|['"]v['"])\s*:\s*(\d+)\b/g;
  return [...source.matchAll(fields)]
    .filter((match) => Number(match[1]) === LOCAL_API_VERSION)
    .map((match) => match.index);
}

test('Door fixture guard rejects copied current version but permits canonical imports and foreign-version controls', () => {
  expect(copiedVersionOffsets(`const frame = { v: ${LOCAL_API_VERSION} };`)).toHaveLength(1);
  expect(copiedVersionOffsets(`const frame = { 'v': ${LOCAL_API_VERSION} };`)).toHaveLength(1);
  expect(copiedVersionOffsets('const frame = { v: LOCAL_API_VERSION };')).toEqual([]);
  expect(copiedVersionOffsets(`const frame = { v: ${LOCAL_API_VERSION - 1} };`)).toEqual([]);
  expect(copiedVersionOffsets(`const unrelated = { calls: ${LOCAL_API_VERSION} };`)).toEqual([]);
});

test('unit and packed client fixtures use the canonical Door version, not a copied current literal', () => {
  const root = join(import.meta.dir, '..');
  const files = [
    ...globSync('test/client-*.ts', { cwd: root }),
    ...globSync('test/fixtures/client-*.mjs', { cwd: root }),
  ];
  expect(files.length).toBeGreaterThan(10);
  for (const path of files)
    expect({
      path,
      copiedVersionOffsets: copiedVersionOffsets(readFileSync(join(root, path), 'utf8')),
    }).toEqual({ path, copiedVersionOffsets: [] });
});
