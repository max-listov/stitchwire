import { existsSync, statSync } from 'node:fs';
import { z } from 'zod';
import { doorPath } from '../../../contracts/src/door/paths.ts';
import { localContract } from '../../../contracts/src/door/local-contract.ts';
import { StatusResultSchema } from '../../../local-client/src/contracts.ts';
import { loadBrokerConfig, loadNodeConfig } from '../config/io.ts';
import type { NodeConfig } from '../config/node.ts';
import { paths } from '../config/paths.ts';
import { agentSocketPath } from './door.ts';
import { out } from './io.ts';
import { brokerChecks } from './doctor-broker.ts';
import { nodeChecks } from './doctor-node.ts';
import { DiagnosticReadError, readBrokerObservation, readDoctorObservation } from './doctor-read.ts';
import { doctorReport, type DiagnosticCheck } from './doctor-report.ts';
import { laneUrlRefusal } from '../../../contracts/src/protocol/lane-url.ts';

function journalChecks(): DiagnosticCheck[] {
  if (!existsSync(paths.brokerConfig)) return [];
  try {
    const broker = loadBrokerConfig();
    const bytes = statSync(broker.auditPath).size;
    return [
      {
        code: 'local.journal',
        level: bytes > broker.auditRotate.maxBytes ? 'fail' : 'ok',
        detail: `activeBytes=${bytes}, maxBytes=${broker.auditRotate.maxBytes}`,
      },
    ];
  } catch {
    return [
      {
        code: 'local.journal',
        level: 'unknown',
        detail: 'Configured local broker journal cannot be inspected',
      },
    ];
  }
}

/**
 * The configuration `--config` names. A file its schema refuses is named by the first issue's path
 * and message: never by its input, which may be a token or a URL with credentials.
 */
function selectedConfig(path: string): NodeConfig {
  try {
    return loadNodeConfig(path);
  } catch (error) {
    const issue =
      error instanceof Error && error.cause instanceof z.ZodError ? error.cause.issues[0] : undefined;
    if (issue === undefined) throw error;
    throw new DiagnosticReadError(
      'diagnostic.input',
      `Selected configuration is invalid at ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      { cause: error },
    );
  }
}

export async function runDoctor(argv: string[]): Promise<number> {
  const checks: DiagnosticCheck[] = [];
  let broker: string | undefined;
  let config: string | undefined;
  let json = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--json' && !json) json = true;
      else if (arg === '--broker' && broker === undefined) broker = z.string().min(1).parse(argv[++i]);
      else if (arg === '--config' && config === undefined) config = z.string().min(1).parse(argv[++i]);
      else throw new Error('Invalid option');
    }
    if (broker && config) throw new Error('Conflicting scope');
    if (broker) {
      const refusal = laneUrlRefusal(broker);
      if (refusal !== null)
        throw new DiagnosticReadError('diagnostic.input', `Refused broker endpoint: ${refusal}`);
      checks.push(...brokerChecks(await readBrokerObservation(broker)));
    } else {
      const socket = config ? selectedConfig(config).agentSocket : agentSocketPath();
      try {
        checks.push(
          ...nodeChecks(
            await readDoctorObservation(
              `http://localhost${doorPath(localContract, 'status')}`,
              StatusResultSchema,
              socket,
            ),
            config ?? paths.nodeConfig,
          ),
        );
      } finally {
        checks.push(...journalChecks());
      }
    }
  } catch (error) {
    checks.push({
      code: error instanceof DiagnosticReadError ? error.code : 'diagnostic.input',
      level: 'unknown',
      detail:
        error instanceof DiagnosticReadError
          ? error.message
          : 'Invalid diagnostic arguments, endpoint policy or selected configuration',
    });
  }
  const report = doctorReport(broker ? 'broker' : 'node', checks);
  if (argv.includes('--json')) await out(`${JSON.stringify(report)}\n`);
  else
    await out(
      [
        `doctor ${report.scope}: ${report.verdict}`,
        ...report.checks.map((check) => `${check.level.toUpperCase()} ${check.code}: ${check.detail}`),
        '',
      ].join('\n'),
    );
  return report.exitCode;
}
