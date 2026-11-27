import { expect, test } from 'bun:test';
import { historicalPaths } from '../scripts/history-paths.ts';

const id = (letter: string) => letter.repeat(40);
const entry = (mode: string, name: string, sha: string) =>
  Buffer.concat([Buffer.from(`${mode} ${name}\0`), Buffer.from(sha, 'hex')]);
const tree = (sha: string, ...entries: Buffer[]) => ({ sha, type: 'tree', body: Buffer.concat(entries) });
const commit = (sha: string, root: string) => ({
  sha,
  type: 'commit',
  body: Buffer.from(`tree ${root}\n\nmessage\n`),
});

test('a subtree shared by commits is named at every path it ever had', () => {
  const blob = id('b');
  const shared = tree(id('d'), entry('100644', 'file.txt', blob));
  const first = tree(id('1'), entry('40000', 'dir', shared.sha));
  // The second commit keeps `dir` untouched and adds the same tree under another name.
  const second = tree(id('2'), entry('40000', 'dir', shared.sha), entry('40000', 'moved', shared.sha));
  const paths = historicalPaths(
    [commit(id('e'), first.sha), commit(id('f'), second.sha), shared, first, second],
    20,
  );
  expect([...(paths.get(blob) ?? [])].sort()).toEqual(['dir/file.txt', 'moved/file.txt']);
  // Negative control: a tree that contains itself is refused, not walked once and trusted.
  const cyclic = tree(id('c'), entry('40000', 'self', id('c')));
  expect(() => historicalPaths([commit(id('e'), cyclic.sha), cyclic], 20)).toThrow('cyclic');
});
