import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EnrollmentBrokersSchema } from '../packages/contracts/src/enrollment/request.ts';
import { brokerHealthUrl } from '../packages/contracts/src/protocol/broker-health.ts';
import { laneUrlRefusal } from '../packages/contracts/src/protocol/lane-url.ts';
import { readBrokerHealth } from '../packages/local-client/src/broker-health.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { brokerHealth } from './doctor-fixture.ts';

const root = mkdtempSync(join(tmpdir(), 'wire-lane-tls-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const main = join(import.meta.dir, '../packages/runtime/src/cli/main.ts');
const token = 'x'.repeat(40);
const node = (url: string) =>
  NodeConfigSchema.safeParse({ nodeId: 'worker', brokers: [{ id: 'primary', url, token }] });

const accepted = [
  'https://broker.example.test:8443',
  'wss://broker.example.test:8443/edge',
  'http://127.0.0.1:8790',
  'http://127.5.6.7:8790',
  'http://127.1:8790',
  'ws://127.0.0.1:8790',
  'http://localhost:8790',
  'http://[::1]:8790',
  // A path is part of a broker's address; nothing else after the host is.
  'wss://broker.example.test/edge/v1',
];
const refused = [
  'http://broker.example.test:8443',
  'ws://broker.example.test:8443',
  'http://10.0.0.1:8790',
  'http://128.0.0.1:8790',
  'http://localhost.example.test:8790',
  'http://[::ffff:127.0.0.1]:8790',
  'http://0.0.0.0:8790',
  'ftp://broker.example.test',
  'http://localhost.:8790',
  '',
  'not a url',
  'wss://user:secret@broker.example.test',
  'wss://:secret@broker.example.test',
  'wss://broker.example.test/?token=secret',
  'wss://broker.example.test/?',
  'wss://broker.example.test/#secret',
  'wss://broker.example.test/#',
];

async function run(...args: string[]) {
  const child = Bun.spawn(['bun', main, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe('a broker lane is TLS except to this machine', () => {
  test('https:/wss: anywhere, http:/ws: only to 127.0.0.0/8, ::1 and localhost', () => {
    for (const url of accepted) expect({ url, ok: node(url).success }).toEqual({ url, ok: true });
    for (const url of refused) expect({ url, ok: node(url).success }).toEqual({ url, ok: false });
    expect(laneUrlRefusal('http://broker.example.test:8443')).toContain('requires https: or wss:');
    // The reason never repeats the URL: a lane URL may carry credentials.
    expect(laneUrlRefusal('http://user:secret@broker.example.test')).not.toContain('secret');
  });

  test('node.json, enrollment and readBrokerHealth reach one verdict on every lane, and parsing never throws', async () => {
    const health = brokerHealth();
    for (const url of [...accepted, ...refused]) {
      const expected = accepted.includes(url);
      const enrollment = EnrollmentBrokersSchema.safeParse([{ id: 'primary', url }]).success;
      let fetched = false;
      const sdk = await readBrokerHealth(url, {
        fetch: async () => {
          fetched = true;
          return Response.json(health);
        },
      }).then(
        () => true,
        (error: unknown) => {
          expect({ url, code: Reflect.get(Object(error), 'code') }).toEqual({ url, code: 'invalid-request' });
          return false;
        },
      );
      expect({ url, node: node(url).success, enrollment, sdk, fetched }).toEqual({
        url,
        node: expected,
        enrollment: expected,
        sdk: expected,
        fetched: expected,
      });
    }
    // A refusal names the rule and never repeats the URL.
    for (const url of refused)
      expect({ url, reason: laneUrlRefusal(url) }).not.toMatchObject({
        reason: expect.stringContaining('secret'),
      });
    expect(() => brokerHealthUrl('wss://user:secret@broker.example.test')).toThrow('carries no credentials');
    expect(() => brokerHealthUrl('wss://user:secret@broker.example.test')).not.toThrow('secret');
  });

  test('doctor --broker refuses by the same rule and says why, without the URL', async () => {
    const refusal = await run('doctor', '--json', '--broker', 'wss://user:secret@broker.example.test');
    expect(refusal.code).toBe(3);
    expect(refusal.stdout).toContain('carries no credentials');
    expect(refusal.stdout).not.toContain('secret');
  });

  test('doctor --config names the first refused field of node.json, never its value', async () => {
    const marker = 'tokenmarker'.padEnd(40, 'x');
    const invalid = join(root, 'invalid.json');
    writeFileSync(
      invalid,
      JSON.stringify({
        nodeId: 'worker',
        brokers: [{ id: 'primary', url: 'http://urlmarker.example.test:8443', token: marker }],
      }),
      { mode: 0o600 },
    );
    const doctor = await run('doctor', '--json', '--config', invalid);
    expect(doctor.code).toBe(3);
    expect(doctor.stdout).toContain('brokers.0.url');
    expect(doctor.stdout).toContain('requires https: or wss:');
    expect(doctor.stdout).not.toContain('tokenmarker');
    expect(doctor.stdout).not.toContain('urlmarker');
  });

  test('the agent refuses a plain remote lane when it loads its configuration, and init refuses to write one', async () => {
    const plain = join(root, 'plain.json');
    const config = NodeConfigSchema.parse({
      nodeId: 'worker',
      brokers: [{ id: 'primary', url: 'https://b.example.test', token }],
    });
    writeFileSync(
      plain,
      JSON.stringify({
        ...config,
        brokers: [{ id: 'primary', url: 'http://broker.example.test:8443', token }],
      }),
      { mode: 0o600 },
    );
    const validated = await run('config', 'validate', 'node', plain);
    expect(validated.code).not.toBe(0);
    expect(validated.stderr).toContain('requires https: or wss:');
    // Negative control: the same file with a TLS lane is valid.
    const tls = join(root, 'tls.json');
    writeFileSync(tls, JSON.stringify(config), { mode: 0o600 });
    expect((await run('config', 'validate', 'node', tls)).code).toBe(0);

    const written = join(root, 'init.json');
    const init = await run(
      'init',
      'node',
      '--id',
      'worker',
      '--broker',
      'http://broker.example.test:8443',
      written,
    );
    expect(init.code).not.toBe(0);
    expect(await Bun.file(written).exists()).toBe(false);
  });
});
