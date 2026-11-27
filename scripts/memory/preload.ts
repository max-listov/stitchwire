/**
 * Attach to the installed runtime without changing its bundle or opening an inspector port; the
 * build and attachment commands are in docs/architecture/diagnostics.md.
 *
 * Every five minutes: post-GC type/memory/CPU sample. SIGUSR2: one complete heap graph plus
 * a payload-free class summary. Remove the preload and restart to detach the probe.
 */
import { join } from 'node:path';
import { paths } from '../../packages/runtime/src/config/paths.ts';
import { attachMemoryProbe } from './probe.ts';

const directory = join(paths.stateDir, 'memory', `${process.pid}-${Date.now()}`);
const attached = attachMemoryProbe(directory, (phase, error) =>
  console.error(`[memory-probe] ${phase} failed`, error),
);
if (attached !== null) console.error('[memory-probe] ready', directory);
