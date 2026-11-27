import { createInterface } from 'node:readline';
import { z } from 'zod';
import { createMemoryProbe } from '../../scripts/memory/probe.ts';

const directory = z.string().min(1).parse(Bun.argv[2]);
const probe = createMemoryProbe(directory);
class ProbeRetained {
  payload = 'fixture-private-payload';
}
let kept: { fixturePrivateProperty: ProbeRetained[] } | null = null;
process.on('SIGUSR2', () => {
  const summary = probe.snapshot();
  console.log(
    JSON.stringify({ snapshot: summary.snapshot, count: kept?.fixturePrivateProperty.length ?? 0 }),
  );
});
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'retain')
    kept = { fixturePrivateProperty: Array.from({ length: 4000 }, () => new ProbeRetained()) };
  else if (line === 'release') kept = null;
  else throw new Error('unknown fixture command');
  console.log('ready');
});
console.log('ready');
