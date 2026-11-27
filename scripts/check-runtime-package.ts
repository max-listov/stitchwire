#!/usr/bin/env bun
/**
 * Isolated installation gate for the publishable `stitchwire` npm runtime package.
 *
 * Installs the packed tarball into a clean temporary directory outside the repository, invokes the
 * installed `node_modules/.bin/stitchwire` symlink (matching `bun add -g stitchwire` / `bunx`),
 * proves `--version`, `init node`, `config validate`, and a live broker+agent connection whose
 * macOS journal lock records real native process identity (proving `../native/darwin-*.node`
 * resolves through the npm bin symlink).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import rootManifest from '../package.json' with { type: 'json' };
import { LocalStatusSchema } from '../packages/contracts/src/door/status.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { freePort, until } from '../test/support.ts';
import { assertArtifactPrivacy } from './artifact-privacy.ts';
import { githubRepository, packRuntimePackage } from './pack-runtime-package.ts';
import { DARWIN_ARCHITECTURES, nativeAssetPath } from './runtime-assets.ts';

const root = resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== '--archive')) {
  throw new Error('usage: check-runtime-package [--archive <tarball>]');
}

async function run(argv: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const child = Bun.spawn(argv, {
    cwd,
    env: env ?? (process.env as Record<string, string>),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  if (code !== 0) {
    throw new Error(`${argv.join(' ')} failed (${code})\n${stdout}\n${stderr}`);
  }
  return stdout;
}

const packed = args[1]
  ? { archive: resolve(args[1]), sha256: null, version: rootManifest.version }
  : await packRuntimePackage(root);

const scratch = await mkdtemp(join(tmpdir(), 'wire-runtime-pkg-proof-'));
const children: Array<ReturnType<typeof Bun.spawn>> = [];
try {
  await Bun.write(
    join(scratch, 'package.json'),
    JSON.stringify({ name: 'wire-runtime-package-proof', private: true, type: 'module' }),
  );
  await run(['bun', 'add', '--ignore-scripts', packed.archive], scratch);

  const installed = join(scratch, 'node_modules/stitchwire');
  const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  if (installedManifest.name !== 'stitchwire' || installedManifest.version !== packed.version) {
    throw new Error('Unexpected runtime package identity');
  }
  if (installedManifest.dependencies !== undefined) {
    throw new Error('Standalone runtime npm package must not declare external dependencies');
  }
  if (installedManifest.publishConfig?.access !== 'public') {
    throw new Error('Runtime package must declare public publishConfig');
  }
  for (const required of [
    'LICENSE',
    'README.md',
    'THIRD_PARTY_NOTICES.txt',
    'bin/stitchwire',
    ...DARWIN_ARCHITECTURES.map(nativeAssetPath),
  ]) {
    if (!existsSync(join(installed, required))) {
      throw new Error(`Runtime package is missing ${required}`);
    }
  }
  for (const file of await readdir(installed, { recursive: true })) {
    const full = join(installed, file);
    if (statSync(full).isFile()) await assertArtifactPrivacy(full);
  }
  const packedReadme = readFileSync(join(installed, 'README.md'), 'utf8');
  // Every repository link of a published README names the release tag, never a branch.
  const repository = githubRepository(rootManifest);
  const releaseRef = `/v${packed.version}/`;
  const relative = /(?:src|href)="(?!https?:|#)|\]\((?!https?:|#)/;
  if (relative.test(packedReadme)) {
    throw new Error('Runtime package README must rewrite repository-relative links for npmjs.org');
  }
  const repositoryLinks = [
    ...packedReadme.matchAll(
      new RegExp(`https://(?:raw\\.githubusercontent\\.com|github\\.com)/${repository}/[^)"\\s]*`, 'g'),
    ),
  ].map(([link]) => link);
  // The installer is the one deliberate branch link: it installs the latest release.
  const branchLinks = repositoryLinks.filter(
    (link) => !link.includes(releaseRef) && !link.endsWith('/main/contrib/install.sh'),
  );
  if (branchLinks.length > 0) {
    throw new Error(`Runtime package README links outside the release tag: ${branchLinks.join(', ')}`);
  }
  for (const asset of [
    'stitchwire-mark.jpg',
    'infographic-hero.jpg',
    'infographic-compare.jpg',
    'infographic-ecosystem.jpg',
  ]) {
    if (
      !packedReadme.includes(
        `https://raw.githubusercontent.com/${repository}${releaseRef}docs/assets/${asset}`,
      )
    ) {
      throw new Error(`Runtime package README is missing the tagged npm asset URL for ${asset}`);
    }
  }

  // Invoke through the package manager's bin symlink, never the raw target path.
  const bin = join(scratch, 'node_modules/.bin/stitchwire');
  const versionOut = (await run([bin, '--version'], scratch)).trim();
  if (versionOut !== packed.version) {
    throw new Error(`Installed bin --version reported ${versionOut}, expected ${packed.version}`);
  }

  const brokerDir = join(scratch, 'broker');
  const nodeDir = join(scratch, 'node');
  await mkdir(brokerDir, { mode: 0o700 });
  await mkdir(nodeDir, { mode: 0o700 });
  const port = freePort();
  const nodeConfig = join(nodeDir, 'node.json');
  const brokerConfig = join(brokerDir, 'broker.json');

  await run(
    [bin, 'init', 'node', '--id', 'probe', '--broker', `http://127.0.0.1:${port}`, nodeConfig],
    scratch,
  );
  if ((statSync(nodeConfig).mode & 0o777) !== 0o600) {
    throw new Error('init node did not create mode 0600 config');
  }
  const parsedNode = JSON.parse(readFileSync(nodeConfig, 'utf8')) as { brokers: Array<{ token: string }> };
  const token = parsedNode.brokers[0]?.token;
  if (!token) throw new Error('init node did not write a broker token');
  const digest = sha256(token);
  await run([bin, 'config', 'validate', 'node', nodeConfig], scratch);
  await run(
    [bin, 'init', 'broker', '--port', String(port), '--node', `probe=${digest}`, brokerConfig],
    scratch,
  );
  await run([bin, 'config', 'validate', 'broker', brokerConfig], scratch);

  const baseEnv = { PATH: process.env.PATH ?? '' };
  const broker = Bun.spawn([bin, 'broker', '--config', brokerConfig], {
    cwd: brokerDir,
    env: { ...baseEnv, STITCHWIRE_CONFIG_DIR: brokerDir, STITCHWIRE_STATE_DIR: brokerDir },
    stdout: 'ignore',
    stderr: 'pipe',
  });
  children.push(broker);
  await until(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, 10_000);

  const agentEnv = { ...baseEnv, STITCHWIRE_CONFIG_DIR: nodeDir, STITCHWIRE_STATE_DIR: nodeDir };
  const agent = Bun.spawn([bin, 'agent', '--config', nodeConfig], {
    cwd: nodeDir,
    env: agentEnv,
    stdout: 'ignore',
    stderr: 'pipe',
  });
  children.push(agent);

  await until(async () => {
    try {
      const out = await run([bin, 'status', '--json'], nodeDir, agentEnv);
      const status = LocalStatusSchema.parse(JSON.parse(out));
      return status.connected && status.version === packed.version;
    } catch {
      return false;
    }
  }, 10_000);

  // On macOS, verify the native sidecar actually loaded through the `.bin/stitchwire` symlink.
  let nativeLockVerified = false;
  if (process.platform === 'darwin') {
    const locks = (await readdir(nodeDir)).filter((name) => name.endsWith('.jsonl.lock'));
    if (locks.length === 0) throw new Error('Expected at least one journal lock file from agent');
    for (const name of locks) {
      const record = JSON.parse(readFileSync(join(nodeDir, name), 'utf8')) as {
        process?: { bootId?: unknown; startId?: unknown };
      };
      if (
        typeof record.process?.bootId !== 'string' ||
        !/^\d+$/.test(String(record.process?.startId ?? ''))
      ) {
        throw new Error(`Native process identity missing in ${name} when launched via .bin symlink`);
      }
    }
    nativeLockVerified = true;
  }

  console.log(
    JSON.stringify({
      archive: packed.archive,
      sha256: packed.sha256,
      version: packed.version,
      isolatedInstall: true,
      symlinkExecution: true,
      nativeLockVerified,
    }),
  );
} finally {
  for (const child of children) {
    child.kill();
    await child.exited;
  }
  await rm(scratch, { recursive: true, force: true });
}
