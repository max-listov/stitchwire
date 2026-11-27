import { copyFile, mkdir, mkdtemp, lstat, rm } from 'node:fs/promises';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { errnoOf } from '../packages/local-client/src/errno.ts';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { dirname, join, resolve } from 'node:path';
import { DARWIN_ARCHITECTURES, nativeSidecar } from './runtime-assets.ts';

const root = resolve(import.meta.dir, '..');
const scratch = await mkdtemp(join(tmpdir(), 'wire-clean-proof-'));
/**
 * A hang guard, not a speed requirement. It was 180 s when the suite was smaller; on 2026-09-14 a
 * `verify` whose 445 tests all passed in 123 s was killed at 180 s while it was still building and
 * accepting the runtime, and the only trace was exit code 137. The guard is sized well above the
 * measured step, and a kill now says it was the guard. On 2026-11-17 a `verify` whose 813 tests all
 * passed was killed at 900 s on a machine shared with other gates (load average above 100 on 18
 * cores): the whole step took about 26 minutes there and about 9 on an idle machine. The guard
 * stays a hang bound above both.
 */
const STEP_HANG_GUARD_MS = 2_700_000;
async function run(argv: string[], cwd = scratch): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  let hung = false;
  const timer = setTimeout(() => {
    hung = true;
    child.kill('SIGKILL');
  }, STEP_HANG_GUARD_MS);
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  clearTimeout(timer);
  if (hung)
    throw new Error(
      `Clean gate ${argv.join(' ')} exceeded its ${STEP_HANG_GUARD_MS / 1000}s hang guard\n${stdout}\n${stderr}`,
    );
  if (code !== 0) throw new Error(`Clean gate ${argv.join(' ')} failed (${code})\n${stdout}\n${stderr}`);
  return `${stdout}\n${stderr}`;
}
try {
  // Compare two current builds, never a stale artifact left by an earlier review checkpoint.
  await run(['bun', 'run', 'build'], root);
  const listing = Bun.spawn(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, , code] = await Promise.all([
    new Response(listing.stdout).text(),
    new Response(listing.stderr).text(),
    listing.exited,
  ]);
  if (code !== 0) throw new Error('Cannot inventory local candidate');
  for (const file of new Set(output.split('\0').filter(Boolean))) {
    const source = resolve(root, file);
    if (!source.startsWith(`${root}/`)) throw new Error('Invalid candidate path');
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(source);
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') continue;
      throw error;
    }
    if (!info.isFile()) throw new Error('Candidate contains an unreviewed non-file');
    const destination = join(scratch, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
  await run(['bun', 'install', '--frozen-lockfile', '--ignore-scripts']);
  const verification = await run(['bun', 'run', 'verify']);
  const tests = /\n\s*(\d+) pass\n\s*(\d+) fail\n\s*(\d+) expect\(\) calls/.exec(verification);
  if (!tests || Number(tests[2]) !== 0) throw new Error('Missing successful full-test receipt');
  // Only the operator has the private inventory. Inspect the isolated build before its outputs
  // are removed, including the entries inside the exact packages users install.
  const inventory = process.env.STITCHWIRE_CONTENT_INVENTORY;
  const packedAudit = inventory
    ? z
        .object({
          inventoryNamed: z.literal(true),
          secretAudit: z.literal(true),
          rules: z.number().int().positive(),
          findings: z.array(z.never()).length(0),
          secrets: z.object({ findings: z.array(z.never()).length(0) }),
        })
        .parse(
          JSON.parse(
            await run([
              'bun',
              'scripts/content-audit.ts',
              '--root',
              'dist',
              '--inventory',
              inventory,
              '--secrets',
              '--packed',
            ]),
          ),
        )
    : null;
  const hash = async (path: string) => sha256(await Bun.file(path).bytes());
  const sourceHash = await hash(join(root, 'dist/stitchwire'));
  const cleanHash = await hash(join(scratch, 'dist/stitchwire'));
  const nativeSha256: Record<string, string> = {};
  for (const arch of DARWIN_ARCHITECTURES) {
    const source = await hash(nativeSidecar(join(root, 'dist/stitchwire'), arch));
    const clean = await hash(nativeSidecar(join(scratch, 'dist/stitchwire'), arch));
    if (source !== clean) throw new Error(`Independent ${arch} native assets differ`);
    nativeSha256[arch] = clean;
  }
  const receipt = {
    cleanInstall: true,
    fullVerify: true,
    packedAudit,
    runtimeSha256: cleanHash,
    originalRuntimeSha256: sourceHash,
    sameRuntimeBytes: cleanHash === sourceHash,
    nativeSha256,
    publicClearance: false,
    tests: Number(tests[1]),
    assertions: Number(tests[3]),
  };
  await mkdir(join(root, 'dist/checks'), { recursive: true });
  await Bun.write(join(root, 'dist/checks/clean-build.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify(receipt));
  if (cleanHash !== sourceHash) throw new Error('Independent runtime builds differ');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
