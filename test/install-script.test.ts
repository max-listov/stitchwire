import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type InstallStand, installStand, isDarwin, release, resealed } from './install-stand.ts';

/** Files the installer leaves beside what it installs: staged copies or kept previous files. */
function leftovers(prefix: string): string[] {
  return ['bin', 'native']
    .map((dir) => join(prefix, dir))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => readdirSync(dir).filter((name) => /\.(install|prev)\.\d+$/.test(name)));
}

describe('contrib/install.sh standalone installer', () => {
  const s: InstallStand = installStand();
  afterAll(() => s.close());

  test('installs verified binary and macOS native sidecar and is idempotent on repeat', async () => {
    s.published = release('0.99.1');
    const prefix = join(s.work, 'prefix');
    mkdirSync(prefix, { recursive: true });

    const first = await s.run(prefix);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('ready: stitchwire 0.99.1');
    expect(s.installed(prefix)).toEqual({
      binary: s.published.binary,
      sidecar: isDarwin ? s.published.native : null,
    });
    expect(statSync(join(prefix, 'bin/stitchwire')).mode & 0o111).toBeGreaterThan(0);

    const second = await s.run(prefix);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain('unchanged');
    expect(s.requests).toEqual(['/manifest.json', '/SHA256SUMS', '/SHA256SUMS.sig']);
  });

  test('a manifest written on one line is read the same: the candidate, not the client', async () => {
    const prefix = join(s.work, 'minified-prefix');
    s.published = resealed(release('0.99.4'), (text) => JSON.stringify(JSON.parse(text)));
    expect(String(s.published.files['/manifest.json'])).not.toContain('\n');
    const result = await s.run(prefix);
    expect({ exitCode: result.exitCode, stderr: result.stderr }).toEqual({ exitCode: 0, stderr: '' });
    expect(s.installed(prefix).binary).toBe(s.published.binary);
    expect(s.requests).not.toContain('/stitchwire-client-0.99.4.tgz');
  });

  test('a candidate file that is a path, or another file of the release, is refused before any download', async () => {
    const prefix = join(s.work, 'names-prefix');
    const scratch = join(s.work, 'tmp');
    mkdirSync(scratch);
    for (const file of ['../escaped-file', 'sub/escaped-file', 'stitchwire-client-0.99.5.tgz']) {
      s.published = resealed(
        release('0.99.5'),
        (text) => text.replace('"file": "stitchwire-0.99.5"', `"file": "${file}"`),
        file.includes('escaped')
          ? { [file]: 'planted', [`${file}.darwin-${process.arch}.node`]: 'planted' }
          : {},
      );
      const refused = await s.run(prefix, { TMPDIR: scratch });
      expect({ file, exitCode: refused.exitCode }).toEqual({ file, exitCode: 1 });
      expect(refused.stderr).toContain('manifest.json candidate.file is not stitchwire-0.99.5');
      expect(s.requests).toEqual(['/manifest.json', '/SHA256SUMS', '/SHA256SUMS.sig']);
      // Nothing outside the installer's own temporary directory, and that one is gone.
      expect(readdirSync(scratch)).toEqual([]);
      expect(existsSync(prefix)).toBe(false);
    }
    s.published = resealed(release('0.99.5'), (text) =>
      text.replace('"version": "0.99.5"', '"version": "0.99.5-x"'),
    );
    const malformed = await s.run(prefix);
    expect(malformed.stderr).toContain('candidate.version of the form X.Y.Z');
  });

  test('a pinned STITCHWIRE_VERSION refuses a release of another version before any download', async () => {
    const prefix = join(s.work, 'pinned-prefix');
    s.published = release('0.99.6');
    const refused = await s.run(prefix, { STITCHWIRE_VERSION: 'v0.99.7' });
    expect({ exitCode: refused.exitCode, stderr: refused.stderr.trim() }).toEqual({
      exitCode: 1,
      stderr: 'stitchwire-install: error: the release names version 0.99.6, not the requested 0.99.7',
    });
    expect(s.requests).toEqual(['/manifest.json', '/SHA256SUMS', '/SHA256SUMS.sig']);
    expect(existsSync(prefix)).toBe(false);
    // Positive control: the same release under its own pin, with or without the leading v.
    for (const pin of ['0.99.6', 'v0.99.6']) {
      const pinned = await s.run(join(s.work, `pinned-${pin}`), { STITCHWIRE_VERSION: pin });
      expect({ pin, exitCode: pinned.exitCode }).toEqual({ pin, exitCode: 0 });
    }
  });

  test('a tampered update fails closed and leaves an existing installation byte for byte as it was', async () => {
    const prefix = join(s.work, 'existing');
    s.published = release('0.99.1');
    expect((await s.run(prefix)).exitCode).toBe(0);
    const before = s.installed(prefix);

    for (const tamper of isDarwin ? (['binary', 'sidecar'] as const) : (['binary'] as const)) {
      s.published = release('0.99.2', tamper);
      const failed = await s.run(prefix);
      expect({ tamper, exitCode: failed.exitCode }).toEqual({ tamper, exitCode: 1 });
      expect(failed.stderr).toContain('checksum mismatch');
      expect(failed.stderr).toContain('existing installation untouched');
      // The sidecar case downloads a good binary first; it must not have been put in place either.
      expect(s.installed(prefix)).toEqual(before);
    }

    s.published = release('0.99.2');
    expect((await s.run(prefix)).exitCode).toBe(0);
    expect(s.installed(prefix).binary).toBe(s.published.binary);
  });

  test('a binary that reports another version is refused from its staged copy; installed files are untouched', async () => {
    const prefix = join(s.work, 'version-prefix');
    s.published = release('0.99.1');
    expect((await s.run(prefix)).exitCode).toBe(0);
    const before = s.installed(prefix);
    s.published = release('0.99.6', null, '0.99.7');
    const refused = await s.run(prefix);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("the downloaded binary reported '0.99.7', expected '0.99.6'");
    expect(s.installed(prefix)).toEqual(before);
    expect(leftovers(prefix)).toEqual([]);

    const fresh = join(s.work, 'version-fresh');
    expect((await s.run(fresh)).exitCode).toBe(1);
    expect(s.installed(fresh)).toEqual({ binary: null, sidecar: null });
  });

  // Only macOS installs a pair, so only there can a run stop between its two replacements.
  test.if(isDarwin)(
    'a run stopped between replacing the binary and its sidecar puts the previous pair back',
    async () => {
      const realMv = Bun.which('mv');
      if (realMv === null) throw new Error('test needs mv on PATH');
      // `mv` for the sidecar's replacement fails, or the installer is sent TERM while it runs; every other
      // move, the restoring ones included, is the real one.
      const shim = s.shim(
        'mv-shim',
        'mv',
        `#!/bin/sh\nfor last in "$@"; do :; done\ncase "$last" in *.node) case "$*" in *.install.*)\n  if [ "$MV_SHIM" = term ]; then kill -TERM "$PPID"; exit 0; fi\n  exit 1;; esac;; esac\nexec ${realMv} "$@"\n`,
      );
      const path = `${shim}:${process.env.PATH ?? '/usr/bin:/bin'}`;
      for (const mode of ['fail', 'term']) {
        const prefix = join(s.work, `between-${mode}`);
        s.published = release('0.99.1');
        expect((await s.run(prefix)).exitCode).toBe(0);
        const before = s.installed(prefix);
        s.published = release('0.99.8');
        const stopped = await s.run(prefix, { PATH: path, MV_SHIM: mode });
        expect({ mode, exitCode: stopped.exitCode }).toEqual({ mode, exitCode: mode === 'term' ? 143 : 1 });
        expect(stopped.stderr).toContain('the previous installation was put back');
        expect(s.installed(prefix)).toEqual(before);
        expect(leftovers(prefix)).toEqual([]);

        // Without a previous installation, putting it back means removing what was moved in.
        const fresh = join(s.work, `between-${mode}-fresh`);
        expect((await s.run(fresh, { PATH: path, MV_SHIM: mode })).exitCode).not.toBe(0);
        expect(s.installed(fresh)).toEqual({ binary: null, sidecar: null });
        expect(leftovers(fresh)).toEqual([]);
      }
    },
  );

  test('a manifest that does not match SHA256SUMS is refused before any file is fetched', async () => {
    const prefix = join(s.work, 'manifest-prefix');
    s.published = release('0.99.1');
    expect((await s.run(prefix)).exitCode).toBe(0);
    const before = s.installed(prefix);
    s.published = release('0.99.3', 'manifest');
    const failed = await s.run(prefix);
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('manifest.json checksum mismatch');
    expect(s.requests).toEqual(['/manifest.json', '/SHA256SUMS', '/SHA256SUMS.sig']);
    expect(s.installed(prefix)).toEqual(before);
  });

  test('a replaced signature or checksum list stops an upgrade before fetching executable bytes', async () => {
    const prefix = join(s.work, 'signature-prefix');
    s.published = release('0.99.1');
    expect((await s.run(prefix)).exitCode).toBe(0);
    const before = s.installed(prefix);
    for (const file of ['/SHA256SUMS', '/SHA256SUMS.sig']) {
      s.published = release('0.99.2');
      const original = s.published.files[file];
      if (!original) throw new Error(`missing fixture: ${file}`);
      s.published.files[file] = Buffer.concat([original, Buffer.from('changed')]);
      const refused = await s.run(prefix);
      expect(refused.exitCode).toBe(1);
      expect(refused.stderr).toContain('invalid release checksum signature');
      expect(s.requests).toEqual(['/manifest.json', '/SHA256SUMS', '/SHA256SUMS.sig']);
      expect(s.installed(prefix)).toEqual(before);
    }
  });

  test('without sha256sum or shasum the installer names what is missing and downloads nothing', async () => {
    const path = s.toolsOnly('no-sha-tools', ['uname', 'curl', 'awk', 'mktemp', 'rm']);
    const prefix = join(s.work, 'no-sha-prefix');
    const failed = await s.run(prefix, { PATH: path });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('sha256sum or shasum is required');
    expect(s.requests).toEqual([]);
    expect(existsSync(prefix)).toBe(false);

    // Positive control: the same PATH plus one sha tool gets past the check.
    const withSha = s.toolsOnly('with-sha-tools', [
      'uname',
      'curl',
      'awk',
      'mktemp',
      'rm',
      isDarwin ? 'shasum' : 'sha256sum',
    ]);
    const passed = await s.run(prefix, { PATH: withSha });
    expect(passed.stderr).not.toContain('sha256sum or shasum is required');
    expect(s.requests).toContain('/manifest.json');
  });

  test('without Bun the installer says to install it and never installs it itself', async () => {
    const path = s.toolsOnly('no-bun-tools', [
      'uname',
      'curl',
      'awk',
      'mktemp',
      'rm',
      isDarwin ? 'shasum' : 'sha256sum',
    ]);
    const prefix = join(s.work, 'no-bun-prefix');
    const failed = await s.run(prefix, { PATH: path, STITCHWIRE_BUN: '' });
    expect(failed.exitCode).toBe(1);
    expect(failed.stderr).toContain('bun not found: install it first (https://bun.sh)');
    expect(s.requests).toEqual([]);
    expect(existsSync(join(s.work, '.bun'))).toBe(false);
  });
});
