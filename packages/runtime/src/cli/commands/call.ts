import { flagValue } from '../configuration.ts';
import { localClient } from '../door.ts';
import { fail, readAllStdin } from '../io.ts';
import { reportResult } from '../render.ts';

/** `stitchwire call <node> -- <argv...>`: run a declared command on a node through the local agent. */
export async function runCall(argv: string[], json: boolean): Promise<number> {
  const rest = argv.slice(1);
  const sep = rest.indexOf('--');
  if (sep < 0) fail('usage: stitchwire call <node> [--timeout ms] [--stdin] -- <argv...>');
  const target = rest[0];
  const command = rest.slice(sep + 1);
  if (target === undefined || target.startsWith('--')) fail('missing target node');
  if (command.length === 0) fail('nothing to run — put the command after --');
  const timeout = flagValue(rest.slice(0, sep), '--timeout');
  const stdin = rest.slice(0, sep).includes('--stdin') ? await readAllStdin() : null;

  using wire = localClient();
  const result = await wire.call({
    to: target,
    argv: command,
    stdin,
    ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }),
  });
  return await reportResult(result, json);
}
