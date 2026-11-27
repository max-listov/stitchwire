import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { releaseSetFiles } from './candidate-fixture.ts';

const INSTALL_SCRIPT = resolve(import.meta.dir, '..', 'contrib/install.sh');
export const isDarwin = process.platform === 'darwin';

export type Tamper = 'binary' | 'sidecar' | 'manifest' | null;
export type Release = {
  version: string;
  binary: string;
  native: string;
  /** Served path (`/name`) to bytes. */
  files: Record<string, Buffer>;
};

/**
 * One release as the server publishes it: the release set create-candidate seals, with a runtime that
 * answers `--version` (with `reports`, when it should lie) and a synthetic native module.
 */
export function release(version: string, tamper: Tamper = null, reports = version): Release {
  const binary = `#!/usr/bin/env bun\nif (Bun.argv.includes('--version')) console.log('${reports}');\n`;
  const native = `synthetic-darwin-native-sidecar-bytes-${version}`;
  const set = releaseSetFiles(version, (role) =>
    role === 'candidate' ? binary : role === 'candidate-native' ? native : `synthetic ${role}\n`,
  );
  const files: Record<string, Buffer> = {};
  for (const [name, bytes] of set) files[`/${name}`] = bytes;
  const tampered = (name: string, change: (text: string) => string) => {
    files[`/${name}`] = Buffer.from(change(String(files[`/${name}`])));
  };
  const candidate = `stitchwire-${version}`;
  if (tamper === 'binary') tampered(candidate, (text) => `${text}// tampered\n`);
  if (tamper === 'sidecar')
    tampered(`${candidate}.darwin-${process.arch}.node`, (text) => `${text}-tampered`);
  if (tamper === 'manifest')
    tampered('manifest.json', (text) => text.replace(version, `${version}-tampered`));
  return { version, binary, native, files };
}

/**
 * Re-seal a release's manifest after `change` rewrites it (as JSON text), so SHA256SUMS lists it
 * again; `extra` lines are appended to SHA256SUMS. This is a release whose origin wrote it this way.
 */
export function resealed(
  base: Release,
  change: (manifest: string) => string,
  extra: Record<string, string> = {},
): Release {
  const manifest = Buffer.from(change(String(base.files['/manifest.json'])));
  const sums = String(base.files['/SHA256SUMS'])
    .split('\n')
    .filter((line) => line !== '' && !line.endsWith('  manifest.json'));
  const files: Record<string, Buffer> = { ...base.files, '/manifest.json': manifest };
  for (const [name, text] of Object.entries(extra)) {
    sums.push(`${sha256(Buffer.from(text))}  ${name}`);
    // Served where an HTTP client normalises the name to, so a downloader that trusts it gets the bytes.
    files[new URL(name, 'http://release/').pathname] = Buffer.from(text);
  }
  sums.push(`${sha256(manifest)}  manifest.json`, '');
  files['/SHA256SUMS'] = Buffer.from(sums.join('\n'));
  return { ...base, files };
}

/** A scratch home and a loopback http server that publishes `published`, recording each request path. */
export function installStand() {
  const work = mkdtempSync(join(tmpdir(), 'stitchwire-install-sh-'));
  const requests: string[] = [];
  let published = release('0.99.1');
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req): Response {
      const path = new URL(req.url).pathname;
      requests.push(path);
      const body = published.files[path];
      return body === undefined ? new Response('not found', { status: 404 }) : new Response(body);
    },
  });
  const stand = {
    work,
    requests,
    server,
    get published(): Release {
      return published;
    },
    set published(value: Release) {
      published = value;
    },
    /** The macOS user's `curl … | bash` runs the system bash, so the script runs under /bin/bash. */
    async run(prefix: string, env: Record<string, string> = {}) {
      requests.length = 0;
      const child = Bun.spawn(['/bin/bash', INSTALL_SCRIPT], {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: work,
          STITCHWIRE_RELEASE_BASE: `http://127.0.0.1:${stand.server.port}`,
          STITCHWIRE_PREFIX: prefix,
          STITCHWIRE_BUN: process.execPath,
          ...env,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    },
    installed(prefix: string) {
      const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null);
      return {
        binary: read(join(prefix, 'bin/stitchwire')),
        sidecar: isDarwin ? read(join(prefix, `native/darwin-${process.arch}.node`)) : null,
      };
    },
    /** A PATH holding only the named tools, so a missing one is really missing. */
    toolsOnly(name: string, tools: string[]) {
      const dir = join(work, name);
      mkdirSync(dir);
      for (const tool of tools) {
        const found = Bun.which(tool);
        if (found === null) throw new Error(`test needs ${tool} on PATH`);
        symlinkSync(found, join(dir, tool));
      }
      return dir;
    },
    /** A directory with one executable script named `name`, to put first on PATH. */
    shim(dir: string, name: string, script: string) {
      const path = join(work, dir);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, name), script, { mode: 0o755 });
      return path;
    },
    close() {
      stand.server.stop(true);
      rmSync(work, { recursive: true, force: true });
    },
  };
  return stand;
}
export type InstallStand = ReturnType<typeof installStand>;
