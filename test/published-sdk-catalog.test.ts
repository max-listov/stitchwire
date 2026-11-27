import { expect, test } from 'bun:test';
import { assertPublishedSdkIdentity, releasesOf } from '../scripts/published-sdk.ts';
import { assertClientSupport } from '../scripts/client-support.ts';

test('SDK identity checks every catalog page and refuses unreadable history before create', async () => {
  const name = 'stitchwire-client-1.2.3.tgz',
    listed = new Map([[name, 'a'.repeat(64)]]);
  const releases = Array.from({ length: 141 }, (_, index) => ({
    tag_name: `v0.${index}.0`,
    assets: index === 140 ? [{ name }] : [],
  }));
  const pages = [releases.slice(0, 100), releases.slice(100)];
  let creates = 0;
  const publish = async (
    catalog: unknown,
    download: () => Promise<{ digest: string } | { problem: string }>,
  ) => {
    await assertPublishedSdkIdentity('v1.0.0', listed, releasesOf(catalog), download);
    creates++;
  };
  await expect(publish(pages, async () => ({ digest: 'b'.repeat(64) }))).rejects.toThrow('different bytes');
  expect(creates).toBe(0);
  await expect(publish(pages, async () => ({ problem: 'download failed' }))).rejects.toThrow(
    'download failed',
  );
  expect(creates).toBe(0);
  for (const invalid of [null, {}, [], [{ assets: [] }]])
    await expect(publish(invalid, async () => ({ digest: 'a'.repeat(64) }))).rejects.toThrow();
  expect(creates).toBe(0);
  await publish(pages, async () => ({ digest: 'a'.repeat(64) }));
  expect(creates).toBe(1);
  assertClientSupport('Node 22+ and Bun 1.4.4+; ESM only', { node: '>=22', bun: '>=1.4.4' });
  expect(() =>
    assertClientSupport('Node 22+ and Bun 1.3.14+; ESM only', { node: '>=22', bun: '>=1.4.4' }),
  ).toThrow('support floor');
});
