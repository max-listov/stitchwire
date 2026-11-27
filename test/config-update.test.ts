import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolledJsonFile } from 'stitchkit/files';
import { runNativeCommand } from 'stitchkit/process';
import { z } from 'zod';
import { configIdentity } from '../packages/runtime/src/config/identity.ts';
import { anyJson } from '../packages/runtime/src/config/io.ts';
import { withConfigLock } from '../packages/runtime/src/config/transaction.ts';
import { updateConfig } from '../packages/runtime/src/config/update.ts';
import { readValue } from '../packages/runtime/src/enrollment/files.ts';

const cli = join(import.meta.dir, '../packages/runtime/src/cli/main.ts');
const hash = (text: string) => new Bun.CryptoHasher('sha256').update(text).digest('hex');
const node = {
  nodeId: 'worker',
  brokers: [{ id: 'primary', url: 'http://127.0.0.1:9999', token: 'x'.repeat(40) }],
};

async function run(args: string[]) {
  return runNativeCommand({
    executable: process.execPath,
    args: [cli, ...args],
    capture: true,
    timeoutMs: 5000,
    maxOutputBytes: 65536,
  });
}

test('init validates before publication, never overwrites, and arbitrates concurrent creators', async () => {
  const root = mkdtempSync('/tmp/wire-init-control-');
  try {
    for (const args of [
      ['node', '--id', 'BAD!', '--broker', 'http://127.0.0.1:9999'],
      ['node', '--id', 'worker', '--broker', 'bad-url'],
      ['broker', '--node', `worker=${'g'.repeat(64)}`],
      ['broker', '--node', `worker=${'a'.repeat(64)}`, '--port', '0'],
    ]) {
      const path = join(root, `${crypto.randomUUID()}.json`);
      expect((await run(['init', ...args, path])).exitCode).not.toBe(0);
      expect(existsSync(path)).toBe(false);
      expect(
        (await run(['init', 'node', '--id', 'worker', '--broker', 'http://127.0.0.1:9999', path])).exitCode,
      ).toBe(0);
      const before = readFileSync(path, 'utf8');
      expect(
        (await run(['init', 'node', '--id', 'another', '--broker', 'http://127.0.0.1:9999', path])).exitCode,
      ).not.toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(before);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    const path = join(root, 'concurrent.json');
    const results = await Promise.all(
      ['alpha', 'beta'].map((id) =>
        run(['init', 'node', '--id', id, '--broker', 'http://127.0.0.1:9999', path]),
      ),
    );
    expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
    const winner = results.findIndex((result) => result.exitCode === 0);
    expect(JSON.parse(readFileSync(path, 'utf8')).nodeId).toBe(['alpha', 'beta'][winner]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dangling aliases share lock identity before and after birth; stale config replacement refuses', async () => {
  const root = mkdtempSync('/tmp/wire-config-lock-');
  const path = join(root, 'node.json'),
    alias = join(root, 'alias.json');
  try {
    symlinkSync(path, alias);
    expect(configIdentity(path)).toBe(configIdentity(alias));
    writeFileSync(path, JSON.stringify(node));
    expect(configIdentity(path)).toBe(configIdentity(alias));
    const before = readFileSync(path, 'utf8');
    const request = {
      operation: 'replace' as const,
      expectedSha256: hash(before),
      value: { ...node, serves: false },
    };
    await withConfigLock(path, async () => {
      await expect(updateConfig('node', alias, request)).rejects.toThrow();
      expect(readFileSync(path, 'utf8')).toBe(before);
    });
    writeFileSync(path, JSON.stringify({ ...node, events: { descriptors: ['/tmp/owner-topic.json'] } }));
    await expect(updateConfig('node', path, request)).rejects.toThrow('changed since preparation');
    const current = readFileSync(path, 'utf8');
    await updateConfig('node', alias, {
      ...request,
      expectedSha256: hash(current),
      value: { ...JSON.parse(current), serves: false },
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).events.descriptors).toEqual(['/tmp/owner-topic.json']);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(configIdentity(path)).toBe(configIdentity(alias));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every JSON reader refuses special files and byte overflow, while regular symlinks work', async () => {
  const root = mkdtempSync('/tmp/wire-json-bound-');
  try {
    const path = join(root, 'data.json'),
      alias = join(root, 'alias.json'),
      fifo = join(root, 'fifo.json');
    writeFileSync(path, '{"ok":true}');
    symlinkSync(path, alias);
    for (const name of [path, alias]) {
      const file = new PolledJsonFile(name, anyJson, { limit: 32 });
      expect(file.read()).toMatchObject({ state: 'read', value: { ok: true } });
      expect(readValue(name, z.object({ ok: z.boolean() }), 32)).toEqual({ ok: true });
    }
    expect(Bun.spawnSync(['mkfifo', fifo]).exitCode).toBe(0);
    // A separate bounded process proves even the synchronous enrollment reader cannot wedge a CLI.
    const refused = await run(['enroll', 'plan', '--request', fifo]);
    expect(refused.exitCode).toBe(2);
    const file = new PolledJsonFile(fifo, anyJson, { limit: 32 });
    expect(file.read()).toMatchObject({
      state: 'unreadable',
      reason: 'not-regular',
      detail: expect.stringContaining('regular file'),
    });
    writeFileSync(path, ' '.repeat(33));
    expect(new PolledJsonFile(path, anyJson, { limit: 32 }).read()).toMatchObject({
      state: 'unreadable',
      reason: 'too-large',
    });
    expect(() => readValue(path, z.unknown(), 32)).toThrow('state-invalid');
    writeFileSync(path, Buffer.from([0xff]));
    expect(new PolledJsonFile(path, anyJson, { limit: 32 }).read()).toMatchObject({
      state: 'invalid',
      reason: 'encoding',
      detail: expect.stringContaining('Not strict UTF-8'),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('init uses exact private mode under a restrictive umask', async () => {
  const root = mkdtempSync('/tmp/wire-init-umask-');
  try {
    const path = join(root, 'node.json');
    const code = `process.umask(0o777); process.argv = ${JSON.stringify([process.execPath, cli, 'init', 'node', '--id', 'worker', '--broker', 'http://127.0.0.1:9999', path])}; await import(${JSON.stringify(cli)});`;
    const result = await runNativeCommand({
      executable: process.execPath,
      args: ['--eval', code],
      envPolicy: 'ambient',
      capture: true,
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    expect({ code: result.exitCode, error: new TextDecoder().decode(result.stderr) }).toEqual({
      code: 0,
      error: '',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).nodeId).toBe('worker');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('supervisor refuses a FIFO config promptly and recovers on the next regular edition', async () => {
  const root = mkdtempSync('/tmp/wire-supervise-fifo-');
  try {
    const path = join(root, 'node.json');
    writeFileSync(path, JSON.stringify(node));
    const supervisePath = join(import.meta.dir, '../packages/runtime/src/cli/supervise.ts');
    const ioPath = join(import.meta.dir, '../packages/runtime/src/config/io.ts');
    const code = `
      import {unlinkSync, writeFileSync} from 'node:fs';
      import {supervise} from ${JSON.stringify(supervisePath)};
      import {parseNodeConfigBytes} from ${JSON.stringify(ioPath)};
      const path = ${JSON.stringify(path)}; let starts=0;
      const running=await supervise({what:'fixture', path, load:parseNodeConfigBytes, start:()=>{starts++;return{stop:async()=>{}}}, watchMs:60000});
      unlinkSync(path); if(Bun.spawnSync(['mkfifo',path]).exitCode!==0)throw Error('mkfifo failed');
      await running.reload(); const refused={starts,reloads:running.reloads};
      unlinkSync(path); writeFileSync(path,${JSON.stringify(JSON.stringify({ ...node, serves: false }))});
      await running.reload(); console.log(JSON.stringify({refused,starts,reloads:running.reloads})); await running.stop();`;
    const result = await runNativeCommand({
      executable: process.execPath,
      args: ['--eval', code],
      envPolicy: 'ambient',
      capture: true,
      timeoutMs: 5000,
      maxOutputBytes: 65536,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(result.stdout))).toEqual({
      refused: { starts: 1, reloads: 0 },
      starts: 2,
      reloads: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI transactions validate stdin, expose receipts, refuse lock/CAS conflicts and preserve unrelated state', async () => {
  const root = mkdtempSync('/tmp/wire-update-cli-');
  try {
    const path = join(root, 'node.json');
    writeFileSync(path, JSON.stringify(node));
    const before = readFileSync(path, 'utf8');
    const request = { operation: 'replace', expectedSha256: hash(before), value: { ...node, serves: false } };
    const command = (value: unknown, check = false) =>
      runNativeCommand({
        executable: process.execPath,
        args: [cli, 'config', 'update', 'node', path, '--request', '-', ...(check ? ['--check'] : [])],
        stdin: Buffer.from(JSON.stringify(value)),
        envPolicy: 'ambient',
        capture: true,
        timeoutMs: 5000,
        maxOutputBytes: 65536,
      });
    await withConfigLock(path, async () => {
      expect((await command(request)).exitCode).not.toBe(0);
      expect(readFileSync(path, 'utf8')).toBe(before);
    });
    const checked = await command(request, true);
    expect(checked.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(checked.stdout))).toMatchObject({
      state: 'checked',
      beforeSha256: hash(before),
    });
    expect(readFileSync(path, 'utf8')).toBe(before);
    const written = await command(request);
    expect(written.exitCode).toBe(0);
    expect(JSON.parse(new TextDecoder().decode(written.stdout)).state).toBe('written');
    const after = readFileSync(path, 'utf8');
    expect(JSON.parse(after).serves).toBe(false);
    expect((await command(request)).exitCode).not.toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(after);
    expect((await command({ operation: 'unknown' })).exitCode).not.toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(after);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('roster compare refuses a concurrent admission and preserves other owner fields on success', async () => {
  const { BrokerConfigSchema } = await import('../packages/runtime/src/config/broker.ts');
  const root = mkdtempSync('/tmp/wire-roster-cas-');
  try {
    const path = join(root, 'broker.json');
    const initial = {
      nodes: [{ id: 'worker', tokenSha256s: ['a'.repeat(64)] }],
      serviceNamespaces: { worker: ['owner.'] },
      auditPath: join(root, 'audit.jsonl'),
    };
    writeFileSync(path, JSON.stringify(initial));
    const expected = BrokerConfigSchema.parse(initial).nodes;
    const current = {
      ...initial,
      nodes: [...initial.nodes, { id: 'newcomer', tokenSha256s: ['b'.repeat(64)] }],
    };
    writeFileSync(path, JSON.stringify(current));
    await expect(
      updateConfig('broker', path, { operation: 'roster', expectedNodes: expected, nodes: expected }),
    ).rejects.toThrow('roster changed since preparation');
    expect(JSON.parse(readFileSync(path, 'utf8')).nodes).toHaveLength(2);
    const fresh = BrokerConfigSchema.parse(current).nodes;
    await updateConfig('broker', path, {
      operation: 'roster',
      expectedNodes: fresh,
      nodes: fresh.map((entry) => ({ ...entry, note: 'kept' })),
    });
    const after = JSON.parse(readFileSync(path, 'utf8'));
    expect(after.serviceNamespaces).toEqual(initial.serviceNamespaces);
    expect(after.auditPath).toBe(initial.auditPath);
    expect(after.nodes).toHaveLength(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
