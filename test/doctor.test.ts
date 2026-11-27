import { expect } from 'bun:test';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalStatusSchema } from '../packages/contracts/src/door/status.ts';
import { OBSERVATION_DEADLINE_MS } from '../packages/runtime/src/cli/doctor-read.ts';
import { DoctorReportSchema } from '../packages/runtime/src/cli/doctor-report.ts';
import { withDoor } from './client-fixture.ts';
import { cli, doctorTest, status } from './doctor-fixture.ts';

doctorTest('missing endpoint cannot exit zero in either doctor renderer', 2, async () => {
  const root = await mkdtemp('/tmp/wire-doctor-regression-');
  const value = status();
  value.config = { path: join(root, 'config/node.json'), mode: '600' };
  value.allow.push({
    name: 'read',
    path: '/missing',
    present: false,
    cwd: null,
    cwdPresent: true,
    callerArgs: 'none',
    stdin: 'none',
    timeoutMs: 1000,
    outputBytes: 1024,
    concurrency: 1,
  });
  try {
    await withDoor(
      (_req, res) => res.end(JSON.stringify(value)),
      async (socket) => {
        expect((await cli(['--json'], socket, root)).code).toBe(2);
        expect((await cli([], socket, root)).code).toBe(2);
      },
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

doctorTest('doctor text and JSON use the same verdict for every local diagnostic failure', 18, async () => {
  const root = await mkdtemp('/tmp/wire-doctor-');
  const original = status();
  original.config = { path: join(root, 'config/node.json'), mode: '600' };
  let current = original;
  try {
    await withDoor(
      (_req, res) => res.end(JSON.stringify(current)),
      async (socket) => {
        const cases = [
          { name: 'healthy', value: original, exit: 0 },
          {
            name: 'missing command',
            value: {
              ...original,
              allow: [
                {
                  name: 'read',
                  path: '/missing',
                  present: false,
                  cwd: null,
                  cwdPresent: true,
                  callerArgs: 'none',
                  stdin: 'none',
                  timeoutMs: 1000,
                  outputBytes: 1024,
                  concurrency: 1,
                },
              ],
            },
            exit: 2,
          },
          {
            name: 'missing stream cwd',
            value: {
              ...original,
              streams: [
                {
                  name: 'watch',
                  path: '/present',
                  present: true,
                  cwd: '/missing',
                  cwdPresent: false,
                  format: 'raw',
                  stableCursor: false,
                  timeoutMs: 1000,
                  maxBytes: 1024,
                  concurrency: 1,
                },
              ],
            },
            exit: 2,
          },
          {
            name: 'subscription headroom',
            value: { ...original, events: { ...original.events, activeSubscriptions: 24 } },
            exit: 1,
          },
          {
            name: 'subscription exhaustion',
            value: { ...original, events: { ...original.events, activeSubscriptions: 32 } },
            exit: 2,
          },
          {
            name: 'partial lane',
            value: {
              ...original,
              lanes: [
                ...original.lanes,
                {
                  id: 'secondary',
                  url: 'https://other.invalid',
                  connected: false,
                  eventSubscriptions: { observedAt: new Date().toISOString(), activeSubscriptions: 0 },
                  serves: false,
                  nodesVisible: 0,
                  presence: 'ready',
                  lastFailure: {
                    at: '2026-09-01T02:37:00.000Z',
                    reason: 'websocket error',
                    refused: false,
                  },
                },
              ],
            },
            exit: 2,
          },
          {
            name: 'unsafe config',
            value: { ...original, config: { path: join(root, 'config/node.json'), mode: '644' } },
            exit: 2,
          },
          {
            name: 'degraded',
            value: { ...original, application: { ...original.application, health: 'degraded' } },
            exit: 1,
          },
          {
            name: 'lost audit',
            value: { ...original, publicationAudit: { ...original.publicationAudit, dropped: 1 } },
            exit: 2,
          },
        ];
        for (const item of cases) {
          current = LocalStatusSchema.parse(item.value);
          const json = await cli(['--json'], socket, root);
          const text = await cli([], socket, root);
          const report = DoctorReportSchema.parse(JSON.parse(json.stdout));
          expect({ name: item.name, code: json.code }).toEqual({ name: item.name, code: item.exit });
          expect(text.code).toBe(report.exitCode);
          for (const check of report.checks)
            expect(text.stdout).toContain(`${check.level.toUpperCase()} ${check.code}: ${check.detail}`);
        }
      },
    );
  } finally {
    await rm(root, { recursive: true });
  }
  // Nine cases, each rendered twice.
});

doctorTest('explicit config selects its socket; local journal errors remain visible', 2, async () => {
  const root = await mkdtemp('/tmp/wire-doctor-config-');
  const config = join(root, 'node.json');
  const observed = status();
  observed.config = { path: config, mode: '600' };
  try {
    await withDoor(
      (_req, res) => res.end(JSON.stringify(observed)),
      async (socket) => {
        await Bun.write(
          config,
          JSON.stringify({
            nodeId: 'reader',
            agentSocket: socket,
            brokers: [{ id: 'primary', url: 'https://example.invalid', token: 'synthetic'.repeat(8) }],
          }),
        );
        await chmod(config, 0o600);
        expect((await cli(['--config', config, '--json'], '/wrong/socket', root, root)).code).toBe(0);
        await Bun.write(join(root, 'broker.json'), '{invalid-private-credential');
        const result = await cli(['--config', config, '--json'], '/wrong/socket', root, root);
        expect(result.code).toBe(3);
        expect(result.stdout).not.toContain('invalid-private-credential');
        expect(result.stdout).toContain('local.journal');
      },
    );
  } finally {
    await rm(root, { recursive: true });
  }
});

doctorTest('invalid/missing/oversized observations are unknown, never empty success', 4, async () => {
  const root = await mkdtemp('/tmp/wire-doctor-input-');
  try {
    expect((await cli(['--json'], join(root, 'missing.sock'), root)).code).toBe(3);
    for (const body of ['{}', '{invalid', 'x'.repeat(8 * 1024 * 1024 + 1)]) {
      await withDoor(
        (_req, res) => res.end(body),
        async (socket) => {
          const result = await cli(['--json'], socket, root);
          expect(result.code).toBe(3);
          expect(DoctorReportSchema.parse(JSON.parse(result.stdout)).verdict).toBe('unknown');
        },
      );
    }
  } finally {
    await rm(root, { recursive: true });
  }
});

doctorTest(
  'deadline bounds a stalled response and releases the observation',
  1,
  async () => {
    const root = await mkdtemp('/tmp/wire-doctor-deadline-');
    try {
      await withDoor(
        (_req, res) => {
          res.writeHead(200);
          res.write('{');
        },
        async (socket) => {
          // The deadline is proven by its own diagnostic, not by a stopwatch around a process
          // spawn: wall time here is mostly process start, which load stretches without bound. A
          // doctor that ignored its deadline would stall until the spawn guard killed it and fail
          // in cli(); one that gave up for another reason would name another check.
          const result = await cli(['--json'], socket, root, undefined, OBSERVATION_DEADLINE_MS);
          expect(result.code).toBe(3);
          const report = DoctorReportSchema.parse(JSON.parse(result.stdout));
          expect(report.checks.map((check) => check.code)).toContain('observation.timeout');
        },
      );
    } finally {
      await rm(root, { recursive: true });
    }
  },
  OBSERVATION_DEADLINE_MS,
);
