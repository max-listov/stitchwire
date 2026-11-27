import { join, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { compareMemory, MemorySummarySchema } from './comparison.ts';
import { retainingPaths } from './graph.ts';

const args = parseArgs({
  allowPositionals: true,
  options: { 'minimum-hours': { type: 'string', default: '24' }, type: { type: 'string' } },
});
const files = z.array(z.string()).length(2).parse(args.positionals);
const minimum = z.coerce.number().min(0).parse(args.values['minimum-hours']);
async function read(path: string) {
  const summary = MemorySummarySchema.parse(await Bun.file(path).json());
  if (basename(summary.snapshot) !== summary.snapshot) throw new Error('snapshot must be beside its summary');
  const text = await Bun.file(join(dirname(path), summary.snapshot)).text();
  if (new Bun.CryptoHasher('sha256').update(text).digest('hex') !== summary.sha256)
    throw new Error('snapshot SHA256 does not match its summary');
  return { summary, text };
}
const [firstPath, lastPath] = files;
if (firstPath === undefined || lastPath === undefined) throw new Error('two summary paths are required');
const first = await read(firstPath);
const last = await read(lastPath);
const result = compareMemory(first.summary, last.summary, minimum);
console.log(
  JSON.stringify({
    ...result,
    types: result.types.slice(0, 30),
    retainingPaths:
      args.values.type === undefined ? undefined : retainingPaths(JSON.parse(last.text), args.values.type),
    qualification: 'Descriptive comparison only; growth does not establish its cause or a permanent ceiling.',
  }),
);
