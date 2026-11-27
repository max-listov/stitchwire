import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { runNativeCommand } from 'stitchkit/process';
import { CappedOutput } from '../packages/runtime/src/node/capped-output.ts';

test('decoded binary output is capped in linear work with valid UTF-8 and truthful truncation', async () => {
  const cap = 4 * 1024 * 1024;
  const source = join(import.meta.dir, '../packages/runtime/src/node/capped-output.ts');
  const code = `const {CappedOutput}=await import(${JSON.stringify(source)}); const output=new CappedOutput(${cap}); output.push(new Uint8Array(${cap}).fill(255)); const {text,truncated}=output.read(); console.log(JSON.stringify({bytes:Buffer.byteLength(text),truncated,valid:text===Buffer.from(text).toString('utf8')}));`;
  const child = await runNativeCommand({
    executable: process.execPath,
    args: ['--eval', code],
    envPolicy: 'ambient',
    capture: true,
    timeoutMs: 5000,
    maxOutputBytes: 65536,
  });
  expect(child.exitCode).toBe(0);
  const summary = JSON.parse(new TextDecoder().decode(child.stdout));
  expect(summary.bytes).toBeLessThanOrEqual(cap);
  expect(summary.truncated).toBe(true);
  expect(summary.valid).toBe(true);
  const valid = new CappedOutput(5);
  valid.push(Buffer.from('🦎').subarray(0, 2));
  valid.push(Buffer.from('🦎').subarray(2));
  valid.push(Buffer.from('.'));
  expect(valid.read()).toEqual({ text: '🦎.', truncated: false });
  valid.push(Buffer.from('!'));
  expect(valid.read()).toEqual({ text: '🦎.', truncated: true });
  const partial = new CappedOutput(2);
  partial.push(Buffer.from([0xf0, 0x9f]));
  // Reading twice answers the same: a reader that looks first does not change what the next one sees.
  expect(partial.read()).toEqual({ text: '', truncated: true });
  expect(partial.read()).toEqual({ text: '', truncated: true });
});
