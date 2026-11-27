/**
 * `benchmark:utf8-length` — what counting the UTF-8 bytes of a string costs on the traffic the
 * schemas meet, for each way of counting: `encode` (encode the whole string and read its length; it
 * allocates a copy as large as the string's UTF-8 — the previous product version), `encode-into`
 * (encode in slices into one reused buffer — the product's `utf8ByteLength`) and `count` (walk the
 * UTF-16 code units in script). The other two are spelled here so every version is measured from
 * this repository. Each runs in its own process: the resident peak only rises.
 *
 * `mixed` (the default) is the shape of what a broker, an agent and a client validate: mostly short
 * command output and topic names, some kilobytes of logs with non-ASCII text, a few large outputs
 * near the stream cap. `large` feeds only the multi-megabyte case, the one an allocation-free count
 * is meant for; a choice that pays off only there does not pay off in production.
 *
 * Usage: bun scripts/benchmark-utf8-length.ts [mixed|large] [rounds]
 */
import { z } from 'zod';
import { utf8ByteLength } from '../packages/contracts/src/protocol/payload.ts';
import { median } from './bench-stats.ts';

const workload = z.enum(['mixed', 'large']).parse(Bun.argv[2] ?? 'mixed');
const rounds = z.coerce
  .number()
  .int()
  .min(3)
  .max(200)
  .parse(Bun.argv[3] ?? 25);

const encoder = new TextEncoder();
const encode = (value: string): number => encoder.encode(value).byteLength;

/** Every candidate, by name. `encode-into` is the product's function. */
const candidates: Record<string, (value: string) => number> = {
  encode,
  'encode-into': utf8ByteLength,
  count: (value) => {
    let bytes = value.length;
    for (let index = 0; index < value.length; index++) {
      const unit = value.charCodeAt(index);
      if (unit < 0x80) continue;
      if (unit < 0x800) bytes += 1;
      else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < value.length) {
        const next = value.charCodeAt(index + 1);
        // A pair is two units and four bytes; a lone high surrogate is three, like U+FFFD.
        bytes += 2;
        if (next >= 0xdc00 && next <= 0xdfff) index++;
      } else bytes += 2;
    }
    return bytes;
  },
};

function text(units: number, alphabet: string): string {
  return alphabet.repeat(Math.ceil(units / alphabet.length)).slice(0, units);
}

const ascii = 'ok 200 GET /status 12ms node=worker ';
const logs = 'запуск задачи ✓ 完成 étape — ';
const emoji = 'deploy 🚀 done ✅ ';
/** One pass of the workload: the strings a run of the schemas would count, in their proportions. */
const strings: string[] =
  workload === 'large'
    ? [text(4 * 1024 * 1024, ascii), text(2 * 1024 * 1024, logs), text(1024 * 1024, emoji)]
    : [
        ...Array.from({ length: 700 }, (_, i) => text(40 + (i % 160), ascii)),
        ...Array.from({ length: 250 }, (_, i) => text(2048 + (i % 7) * 256, i % 2 === 0 ? logs : ascii)),
        ...Array.from({ length: 45 }, (_, i) => text(64 * 1024, i % 3 === 0 ? emoji : logs)),
        ...Array.from({ length: 5 }, () => text(1024 * 1024, ascii + logs)),
      ];
const totalUnits = strings.reduce((sum, value) => sum + value.length, 0);

const expected = strings.map(encode);
for (const [name, count] of Object.entries(candidates))
  strings.forEach((value, index) => {
    if (count(value) !== expected[index]) throw new Error(`${name} disagrees with encode on string ${index}`);
  });

/** One candidate in this process: the median pass and how far the resident peak rose while counting. */
function measure(name: string): { ms: number; peakGrowthMiB: number } {
  const count = candidates[name];
  if (count === undefined) throw new Error(`no candidate ${name}`);
  const times: number[] = [];
  Bun.gc(true);
  const before = process.resourceUsage().maxRSS;
  for (let round = 0; round < rounds; round++) {
    const start = Bun.nanoseconds();
    let sink = 0;
    for (const value of strings) sink += count(value);
    times.push((Bun.nanoseconds() - start) / 1e6);
    if (sink === 0) throw new Error('nothing counted');
  }
  // `maxRSS` is in kilobytes and only rises, so each candidate runs in a process of its own.
  return { ms: median(times), peakGrowthMiB: (process.resourceUsage().maxRSS - before) / 1024 };
}

const ResultSchema = z.object({ ms: z.number(), peakGrowthMiB: z.number() });
const only = Bun.argv[4];
if (only !== undefined) {
  console.log(JSON.stringify(measure(only)));
} else {
  const names = Object.keys(candidates);
  const results = new Map<string, z.infer<typeof ResultSchema>[]>(names.map((name) => [name, []]));
  // Three passes in rotated order, so a busy moment of a shared machine does not land on one candidate.
  for (let pass = 0; pass < 3; pass++)
    for (const name of [...names.slice(pass), ...names.slice(0, pass)]) {
      const child = Bun.spawnSync([process.execPath, import.meta.path, workload, String(rounds), name]);
      if (child.exitCode !== 0) throw new Error(`${name}: ${child.stderr.toString()}`);
      results.get(name)?.push(ResultSchema.parse(JSON.parse(child.stdout.toString())));
    }
  for (const [name, runs] of results) {
    const ms = median(runs.map((run) => run.ms));
    console.log(
      `${workload} ${name}: ${ms.toFixed(2)} ms per pass (median of 3 processes × ${rounds} passes), ` +
        `${((ms * 1e6) / totalUnits).toFixed(2)} ns per UTF-16 unit, ` +
        `resident peak +${median(runs.map((run) => run.peakGrowthMiB)).toFixed(1)} MiB`,
    );
  }
}
