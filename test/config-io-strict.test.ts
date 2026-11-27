import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBrokerConfig, loadNodeConfig } from '../packages/runtime/src/config/io.ts';

/** Node and broker configuration are read by the one strict reader every other JSON file uses. */

const root = mkdtempSync(join(tmpdir(), 'wire-config-io-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('bytes that are not UTF-8 are refused, not decoded with replacements', () => {
  const path = join(root, 'latin1.json');
  writeFileSync(path, Buffer.concat([Buffer.from('{"nodeId":"'), Buffer.from([0xff]), Buffer.from('"}')]));
  expect(() => loadNodeConfig(path)).toThrow('not valid UTF-8 JSON');
  expect(() => loadBrokerConfig(path)).toThrow('not valid UTF-8 JSON');
});

test('a missing file and malformed JSON keep their own messages', () => {
  expect(() => loadNodeConfig(join(root, 'absent.json'))).toThrow('node config not found at');
  const path = join(root, 'broken.json');
  writeFileSync(path, '{ not json');
  expect(() => loadBrokerConfig(path)).toThrow('broker config at');
});
