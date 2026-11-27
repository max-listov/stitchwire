import { flagValue } from '../configuration.ts';
import { localClient } from '../door.ts';
import { fail, out, readAllStdin } from '../io.ts';
import { refusalLine } from '../render.ts';

/** `stitchwire events <subscribe|publish> <topic>`. */
export async function runEvents(argv: string[], json: boolean): Promise<number> {
  const action = argv[1];
  const topic = argv[2];
  if ((action !== 'subscribe' && action !== 'publish') || topic === undefined || topic.startsWith('--')) {
    fail('usage: stitchwire events <subscribe|publish> <topic> [--resume <bootId>:<seq>]');
  }
  if (action === 'publish') {
    const data = await readAllStdin();
    if (data === '') fail('nothing on stdin — an event needs a body');
    using wire = localClient();
    const result = await wire.publish({ topic, bootId: crypto.randomUUID(), seq: 0, data });
    if (json) await out(`${JSON.stringify(result)}\n`);
    else if (result.ok) console.error('[wire] event accepted');
    else console.error(`publish refused (${refusalLine(result)})`);
    return result.ok ? 0 : 1;
  }
  // The agent keeps its own cursor across reconnects; this flag is for a CONSUMER that restarted
  // and still knows where it stopped — the same thing a panel does after its own process dies.
  const resumeFlag = flagValue(argv, '--resume');
  let resume: { bootId: string; afterSeq: number } | null = null;
  if (resumeFlag !== undefined) {
    const at = resumeFlag.lastIndexOf(':');
    const bootId = at === -1 ? '' : resumeFlag.slice(0, at);
    const afterSeq = Number(resumeFlag.slice(at + 1));
    if (at === -1 || !Number.isInteger(afterSeq) || afterSeq < 0) {
      fail('--resume takes <bootId>:<seq>, for example 5f1c...-...:41');
    }
    resume = { bootId, afterSeq };
  }
  using wire = localClient();
  for await (const item of wire.subscribe({ topic, resume })) {
    if (json) await out(`${JSON.stringify(item.frame)}\n`);
    if (item.kind === 'error') {
      if (!json) console.error(`subscription failed (${refusalLine(item.frame)})`);
      return 1;
    }
    if (json) continue;
    if (item.kind === 'gap') {
      // A gap is stated, never implied: the consumer must know it did not see everything. The
      // reason is printed with it because the repair differs — `overflow` means this consumer is
      // too slow, `resume`/`retention` mean it was away and should resync from a snapshot.
      console.error(`[wire] gap ${item.frame.fromSeq}..${item.frame.toSeq} (${item.frame.reason})`);
      continue;
    }
    const text = new TextDecoder().decode(item.data);
    await out(`${item.frame.producer} #${item.frame.seq} ${text}\n`);
  }
  return 0;
}
