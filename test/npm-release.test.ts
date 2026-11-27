import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { auditContent } from '../scripts/content-audit.ts';
import { registryHasArchive, waitForPublishedArchive } from '../scripts/npm-release.ts';

const name = '@stitchwire/client';
const version = '1.2.3';
const body = 'sample archive';
const pkg = { name, version, path: 'unused', bytes: body.length, digest: sha256(body) };
const tarball = 'https://registry.npmjs.org/@stitchwire/client/-/client-1.2.3.tgz';

test('anonymous registry checks distinguish absence, failed reads and changed published bytes', async () => {
  function registry(archive: string, url = tarball) {
    return async (request: string) =>
      request === tarball ? new Response(archive) : Response.json({ name, version, dist: { tarball: url } });
  }
  expect(await registryHasArchive(pkg, registry(body))).toBe(true);
  expect(await registryHasArchive(pkg, async () => new Response(null, { status: 404 }))).toBe(false);
  await expect(registryHasArchive(pkg, async () => new Response(null, { status: 503 }))).rejects.toThrow(
    '503',
  );
  await expect(registryHasArchive(pkg, registry('changed bytes'))).rejects.toThrow('different bytes');
  await expect(registryHasArchive(pkg, registry(body, 'https://example.org/archive'))).rejects.toThrow(
    'location',
  );
});

test('a successful publish survives delayed metadata and delayed tarball availability', async () => {
  let metadataReads = 0;
  let tarballReads = 0;
  const get = async (url: string) => {
    if (url === tarball)
      return ++tarballReads === 1 ? new Response(null, { status: 404 }) : new Response(body);
    if (++metadataReads <= 12) return new Response(null, { status: 404 });
    return Response.json({ name, version, dist: { tarball } });
  };
  await waitForPublishedArchive(pkg, { get, pause: async () => {} });
  expect(metadataReads).toBe(14);
  expect(tarballReads).toBe(2);
});

test('only visibility delays are retried, and an occupied version stays occupied', async () => {
  const meta = () => Response.json({ name, version, dist: { tarball } });
  const missingTarball = async (url: string) =>
    url === tarball ? new Response(null, { status: 404 }) : meta();
  await expect(registryHasArchive(pkg, missingTarball)).rejects.toThrow('registry HTTP 404');

  const controller = new AbortController();
  await expect(
    waitForPublishedArchive(pkg, {
      get: missingTarball,
      signal: controller.signal,
      pause: async () => controller.abort(),
    }),
  ).rejects.toThrow('visibility deadline');

  const noRetry = async () => {
    throw new Error('unexpected retry');
  };
  await expect(
    waitForPublishedArchive(pkg, {
      get: async (url) => (url === tarball ? new Response('wrong') : meta()),
      pause: noRetry,
    }),
  ).rejects.toThrow('different bytes');
  await expect(
    waitForPublishedArchive(pkg, {
      get: async () => new Response(null, { status: 503 }),
      pause: noRetry,
    }),
  ).rejects.toThrow('registry HTTP 503');
});

test('the release audit inspects package entries inside nested dist directories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wire-packed-audit-'));
  try {
    const file = join(directory, 'dist/package.tgz');
    const archive = new Bun.Archive(
      { 'package/package.json': '{}', 'package/dist/index.js': 'example-deny-marker' },
      { compress: 'gzip' },
    );
    await Bun.write(file, await archive.blob());
    const rules = [{ label: 'control', literal: 'example-deny-marker' }];
    expect(await auditContent(directory, rules, true)).toContainEqual({
      path: 'dist/package.tgz!/package/dist/index.js',
      label: 'control',
      offset: 0,
    });
    expect(await auditContent(directory, [{ label: 'control', literal: 'absent-marker' }], true)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
