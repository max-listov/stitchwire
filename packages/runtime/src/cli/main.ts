#!/usr/bin/env bun
/**
 * stitchwire — one binary that is whichever half of the wire you point it at.
 *
 * `broker` routes, `agent` connects and serves, everything else is a thin client of the local
 * agent's Unix socket. Deliberately no second connection path for the CLI: if `call` dialled the
 * broker itself, a fleet would have two authentication surfaces and two places to look when one of
 * them stops working.
 */

import { RELEASE_VERSION } from '../release-version.ts';
import { runCall } from './commands/call.ts';
import { runConfigValidate, runKeygen } from './commands/config.ts';
import { runConfigInspect, runConfigUpdate } from './commands/config-update.ts';
import { runEvents } from './commands/events.ts';
import { runInit } from './commands/init.ts';
import { runPruneRollbacks } from './commands/rollbacks.ts';
import { runAgent, runBroker } from './commands/serve.ts';
import { runStatus } from './commands/status.ts';
import { runStream } from './commands/stream.ts';
import { runDoctor } from './doctor.ts';
import { runFleet } from './fleet.ts';
import { runEnroll } from './enroll.ts';
import { HELP } from './help.ts';

export async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const separator = argv.indexOf('--');
  const json = (separator < 0 ? argv : argv.slice(0, separator)).includes('--json');

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
    case '--version':
    case 'version':
      console.log(RELEASE_VERSION);
      return 0;
    case 'init':
      return runInit(argv);
    case 'prune-rollbacks':
      return runPruneRollbacks(argv);
    case 'keygen':
      return runKeygen();
    case 'config':
      return argv[1] === 'update'
        ? runConfigUpdate(argv)
        : argv[1] === 'inspect'
          ? runConfigInspect(argv)
          : runConfigValidate(argv);
    case 'broker':
      return runBroker(argv);
    case 'agent':
      return runAgent(argv);
    case 'fleet':
      return runFleet(argv.slice(1));
    case 'enroll':
      return runEnroll(argv.slice(1));
    case 'call':
      return runCall(argv, json);
    case 'stream':
      return runStream(argv, json);
    case 'events':
      return runEvents(argv, json);
    case 'doctor':
      return runDoctor(argv.slice(1));
    case 'nodes':
    case 'status':
      return runStatus(cmd, json);
    default:
      console.error(`unknown command '${cmd}'\n`);
      console.log(HELP);
      return 1;
  }
}

// `process.exitCode`, NOT `process.exit()`: the latter ends the process at once and does not let an
// asynchronous write into a pipe drain — which is how the tail of a large output is lost.
process.exitCode = await main();
