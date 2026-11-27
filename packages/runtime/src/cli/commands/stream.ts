import { flagValue } from '../configuration.ts';
import { localClient } from '../door.ts';
import { fail, out, readAllStdin } from '../io.ts';
import { refusalLine } from '../render.ts';

/** `stitchwire stream <node> <profile>`: read a declared stream profile of a node. */
export async function runStream(argv: string[], json: boolean): Promise<number> {
  const rest = argv.slice(1);
  const sep = rest.indexOf('--');
  const head = sep < 0 ? rest : rest.slice(0, sep);
  const args = sep < 0 ? [] : rest.slice(sep + 1);
  const target = head.filter((entry) => !entry.startsWith('--'))[0];
  const profile = head.filter((entry) => !entry.startsWith('--'))[1];
  if (target === undefined || profile === undefined) {
    fail(
      'usage: stitchwire stream <node> <profile> [--timeout ms] [--cursor <opaque>] [--stdin] [-- <args...>]',
    );
  }
  const timeout = flagValue(head, '--timeout');
  const cursor = flagValue(head, '--cursor');
  // The door accepts stdin and stream profiles declare it; `--stdin` hands it to a producer that
  // takes an opening request, the same flag `call` has.
  const stdin = head.includes('--stdin') ? await readAllStdin() : null;
  let exitCode = 0;
  using wire = localClient();
  for await (const item of wire.stream({
    to: target,
    profile,
    args,
    stdin,
    cursor: cursor ?? null,
    ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
  })) {
    if (json) {
      await out(`${JSON.stringify(item.frame)}\n`);
    } else if (item.kind === 'chunk') {
      // stderr of the remote producer stays stderr here: a pipe must receive the payload only.
      if (item.frame.channel === 'stderr') process.stderr.write(item.data);
      else await out(item.data);
    } else if (item.kind === 'error') {
      console.error(`stream failed (${refusalLine(item.frame)})`);
    } else {
      console.error(
        `[wire] stream ended: ${item.frame.reason}${item.frame.cursor == null ? '' : ` (cursor ${item.frame.cursor})`}`,
      );
    }
    if (item.kind === 'error') exitCode = 1;
    else if (item.kind === 'end') exitCode = item.frame.code;
  }
  return exitCode;
}
