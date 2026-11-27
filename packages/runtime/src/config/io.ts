/** Loading the broker and node configuration files. */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type JsonValueSchema, parseJsonBytes, readJsonOnce } from 'stitchkit/files';
import type { z } from 'zod';
import { type BrokerConfig, BrokerConfigSchema } from './broker.ts';
import { type NodeConfig, NodeConfigSchema } from './node.ts';
import { paths } from './paths.ts';

/**
 * The ceiling of a JSON file an operator or the fleet writes for this runtime to read whole: a broker
 * or node configuration, a fleet manifest, bundle or kept copy, an administrative request. A contract
 * with a smaller ceiling of its own names that one instead. No reader relies on a framework default:
 * each caller names its ceiling explicitly.
 */
export const MAX_CONFIG_FILE_BYTES = 16 * 1024 * 1024;

/** Any JSON value, unvalidated: the caller checks its shape itself. */
export const anyJson: JsonValueSchema<unknown> = {
  safeParse: (data) => ({ success: true, data }),
};

/** The one way a config file is read: strict UTF-8 and the classification every other reader uses. */
function readConfigJson(path: string, what: string): unknown {
  const reading = readJsonOnce(path, anyJson, { limit: MAX_CONFIG_FILE_BYTES });
  if (reading.state === 'missing') throw new Error(`${what} config not found at ${path}`);
  if (reading.state !== 'read')
    throw new Error(`${what} config at ${path} is not valid UTF-8 JSON: ${reading.detail}`);
  return reading.value;
}

/** Fail loud and specific: a wrong field here is a machine that silently talks to nobody. */
function parseOrThrow<T>(schema: z.ZodType<T>, raw: unknown, path: string): T {
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
  throw new Error(`invalid config at ${path}:\n${issues}`, { cause: parsed.error });
}

function parseConfigJsonBytes(bytes: Uint8Array, path: string, what: string): unknown {
  try {
    return parseJsonBytes(bytes);
  } catch (error) {
    throw new Error(`${what} config at ${path} is not valid UTF-8 JSON: ${String(error)}`, { cause: error });
  }
}

export function parseBrokerConfigBytes(bytes: Uint8Array, path = paths.brokerConfig): BrokerConfig {
  return parseOrThrow(BrokerConfigSchema, parseConfigJsonBytes(bytes, path, 'broker'), path);
}

export function parseNodeConfigBytes(bytes: Uint8Array, path = paths.nodeConfig): NodeConfig {
  return parseOrThrow(NodeConfigSchema, parseConfigJsonBytes(bytes, path, 'node'), path);
}

export function loadBrokerConfig(path = paths.brokerConfig): BrokerConfig {
  return parseOrThrow(BrokerConfigSchema, readConfigJson(path, 'broker'), path);
}

export function loadNodeConfig(path = paths.nodeConfig): NodeConfig {
  return parseOrThrow(NodeConfigSchema, readConfigJson(path, 'node'), path);
}

export function ensureStateDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

/** The one SHA-256 of this runtime, lowercase hexadecimal, of a text or of bytes. */
export function sha256(value: string | Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex');
}
