import { join, resolve } from 'node:path';

/** The checkout the packed client is built from, and the consumer fixtures it is exercised with. */
export const root = resolve(import.meta.dir, '../..');
export const fixtures = join(root, 'test/fixtures');

/** One child in `cwd`; killed after 60 s, so a hung install or fixture fails the check instead of hanging it. */
export async function run(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const deadline = setTimeout(() => child.kill(), 60_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(deadline);
  if (code !== 0) throw new Error(`${argv[0]} failed (${code})\n${stdout}\n${stderr}`);
  return stdout;
}
