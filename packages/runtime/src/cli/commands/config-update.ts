import { parseJsonBytes, readJsonOnce } from 'stitchkit/files';
import { inspectConfig } from '../../config/inspect.ts';
import { anyJson, MAX_CONFIG_FILE_BYTES } from '../../config/io.ts';
import { ConfigUpdateSchema, updateConfig } from '../../config/update.ts';
import { fail, out, readStdinBytes, StdinLimitError } from '../io.ts';

export async function runConfigInspect(argv: string[]): Promise<number> {
  const [, , kind, path] = argv;
  if ((kind !== 'node' && kind !== 'broker') || !path || argv.length !== 4)
    fail('usage: config inspect <node|broker> <path>');
  await out(`${JSON.stringify(inspectConfig(kind, path))}\n`);
  return 0;
}

async function stdinJson(): Promise<unknown> {
  const bytes = await readStdinBytes(MAX_CONFIG_FILE_BYTES).catch((error: unknown) => {
    if (error instanceof StdinLimitError) fail('config update request exceeds byte limit');
    throw error;
  });
  return parseJsonBytes(bytes);
}

/** `config update <node|broker> <path> --request <json|-> [--check]`, no credentials in output. */
export async function runConfigUpdate(argv: string[]): Promise<number> {
  const [, , kind, path, flag, requestPath, check] = argv;
  if (
    (kind !== 'node' && kind !== 'broker') ||
    !path ||
    flag !== '--request' ||
    !requestPath ||
    (check !== undefined && check !== '--check') ||
    argv.length > 7
  )
    fail('usage: config update <node|broker> <path> --request <json|-> [--check]');
  const reading =
    requestPath === '-' ? null : readJsonOnce(requestPath, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
  if (reading !== null && reading.state !== 'read') fail(`config update request is ${reading.state}`);
  const request = ConfigUpdateSchema.parse(reading === null ? await stdinJson() : reading.value);
  await out(`${JSON.stringify(await updateConfig(kind, path, request, check === '--check'))}\n`);
  return 0;
}
