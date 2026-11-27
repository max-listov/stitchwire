import { expect, test } from 'bun:test';
import { BrokerHealthContractSchema } from '../packages/contracts/src/protocol/broker-health.ts';
import { brokerChecks } from '../packages/runtime/src/cli/doctor-broker.ts';
import { doctorReport } from '../packages/runtime/src/cli/doctor-report.ts';
import { brokerHealth } from './doctor-fixture.ts';

test('broker evaluator preserves publication policy, refusal age, audit and measured churn', () => {
  const health = BrokerHealthContractSchema.parse(brokerHealth());
  expect(doctorReport('broker', brokerChecks(health)).exitCode).toBe(0);
  const topic = health.topics[0];
  if (!topic) throw Error('Missing fixture');
  topic.publicationMode = 'periodic';
  expect(doctorReport('broker', brokerChecks(health)).verdict).toBe('warn');
  topic.publicationMode = 'unknown';
  expect(doctorReport('broker', brokerChecks(health)).verdict).toBe('unknown');
  topic.publicationMode = 'on-change';
  topic.sinceLastRejectionMs = 10;
  expect(doctorReport('broker', brokerChecks(health)).verdict).toBe('warn');
  health.audit.dropped = 1;
  expect(doctorReport('broker', brokerChecks(health)).verdict).toBe('fail');
  expect(brokerChecks(health).find((check) => check.code === 'subscriptions.recent')?.detail).toContain(
    'measuredWindowMs=12345',
  );
  health.transport.eventLoopDelay = {
    state: 'measured',
    sampledAt: '2026-09-02T06:01:47.000Z',
    lastMs: 300,
    maxMs: 300,
    windowMs: 300_000,
  };
  health.audit.dropped = 0;
  expect(doctorReport('broker', brokerChecks(health)).verdict).toBe('warn');
});
