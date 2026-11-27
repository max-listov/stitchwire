import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type InstallStand, installStand } from './install-stand.ts';

/**
 * The installer downloads over https, takes plain http only from this machine, and follows no redirect
 * off https. A loopback https server with its own certificate stands in for a release origin; curl
 * trusts that certificate through `CURL_CA_BUNDLE` and nothing else changes.
 */
describe('contrib/install.sh transport', () => {
  const s: InstallStand = installStand();
  let tls: ReturnType<typeof Bun.serve> | null = null;
  let caBundle = '';

  beforeAll(() => {
    const key = join(s.work, 'key.pem');
    caBundle = join(s.work, 'cert.pem');
    writeFileSync(join(s.work, 'cert.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=127.0.0.1\n');
    const made = Bun.spawnSync(
      [
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        caBundle,
        '-days',
        '1',
        '-config',
        join(s.work, 'cert.cnf'),
        '-addext',
        'subjectAltName=IP:127.0.0.1',
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    if (made.exitCode !== 0) throw new Error(`openssl req: ${made.stderr.toString()}`);
    tls = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      tls: { cert: Bun.file(caBundle), key: Bun.file(key) },
      fetch(req) {
        const path = new URL(req.url).pathname;
        // `/to-http/<file>` answers with a redirect to the same file on the plain loopback server.
        if (path.startsWith('/to-http/'))
          return Response.redirect(
            `http://127.0.0.1:${s.server.port}/${path.slice('/to-http/'.length)}`,
            302,
          );
        const body = s.published.files[path];
        return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
      },
    });
  });
  afterAll(() => {
    tls?.stop(true);
    s.close();
  });

  test('plain http outside loopback is refused before any request', async () => {
    for (const base of [
      'http://example.invalid',
      'http://127.0.0.1.example.invalid',
      'http://localhost.example.invalid',
      'ftp://127.0.0.1',
    ]) {
      const prefix = join(s.work, 'refused');
      const refused = await s.run(prefix, { STITCHWIRE_RELEASE_BASE: base });
      expect({ base, exitCode: refused.exitCode }).toEqual({ base, exitCode: 1 });
      expect(refused.stderr).toMatch(/plain http:\/\/ is refused outside loopback|must be an https:\/\/ URL/);
      expect(existsSync(prefix)).toBe(false);
    }
    const credentials = await s.run(join(s.work, 'refused'), {
      STITCHWIRE_RELEASE_BASE: `http://user@127.0.0.1:${s.server.port}`,
    });
    expect(credentials.stderr).toContain('must not carry credentials');
    expect(s.requests).toEqual([]);
  });

  test('https installs, and plain http works on loopback', async () => {
    const overTls = await s.run(join(s.work, 'tls-prefix'), {
      STITCHWIRE_RELEASE_BASE: `https://127.0.0.1:${tls?.port}`,
      CURL_CA_BUNDLE: caBundle,
    });
    expect({ exitCode: overTls.exitCode, stderr: overTls.stderr }).toEqual({ exitCode: 0, stderr: '' });
    for (const host of ['127.0.0.1', 'localhost']) {
      const local = await s.run(join(s.work, `${host}-prefix`), {
        STITCHWIRE_RELEASE_BASE: `http://${host}:${s.server.port}`,
      });
      expect({ host, exitCode: local.exitCode }).toEqual({ host, exitCode: 0 });
    }
  });

  test('a redirect from https to http is not followed', async () => {
    const prefix = join(s.work, 'redirect-prefix');
    const refused = await s.run(prefix, {
      STITCHWIRE_RELEASE_BASE: `https://127.0.0.1:${tls?.port}/to-http`,
      CURL_CA_BUNDLE: caBundle,
    });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain('cannot fetch');
    expect(refused.stderr).toMatch(/Protocol "?http"? disabled|not supported|disabled/i);
    // The plain server was never reached: the redirect stopped at curl.
    expect(s.requests).toEqual([]);
    expect(existsSync(prefix)).toBe(false);
  });
});
