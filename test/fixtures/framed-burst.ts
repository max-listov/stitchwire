/**
 * Emits many small COMPLETE framed lines in a single write.
 *
 * This is the ordinary shape of the first moments of a resumable feed — replaying what has accumulated
 * — and not abuse. No line is large; the batch is large, and the batch consists of ready lines that the
 * parser is about to take.
 */
const PAD = 'x'.repeat(280);
const lines: string[] = [];
for (let i = 0; i < 400; i += 1) {
  lines.push(JSON.stringify({ data: `${JSON.stringify({ seq: i, pad: PAD })}\n`, cursor: `c-${i}` }));
}
process.stdout.write(`${lines.join('\n')}\n`);
