import { expect, test } from 'bun:test';
import { type DiagnosticCheck, doctorReport } from '../packages/runtime/src/cli/doctor-report.ts';
import { subscriptionChecks } from '../packages/runtime/src/cli/subscription-checks.ts';
import { status } from './doctor-fixture.ts';

test('subscription severity distinguishes headroom from hard exhaustion at unchanged bounds', () => {
  const cases: Array<{ used: number; level: DiagnosticCheck['level']; exit: number }> = [
    { used: 0, level: 'ok', exit: 0 },
    { used: 23, level: 'ok', exit: 0 },
    { used: 24, level: 'warn', exit: 1 },
    { used: 25, level: 'warn', exit: 1 },
    { used: 31, level: 'warn', exit: 1 },
    { used: 32, level: 'fail', exit: 2 },
    { used: 33, level: 'fail', exit: 2 },
  ];
  for (const item of cases) {
    const observed = status();
    observed.events.activeSubscriptions = item.used;
    const checks = subscriptionChecks(observed);
    expect(checks[0]?.level).toBe(item.level);
    expect(checks[0]?.detail).toContain(`${item.used}/32, free=${Math.max(0, 32 - item.used)}`);
    expect(checks[0]?.detail).toContain('headroom threshold=75% (24)');
    expect(checks[0]?.detail).toContain(item.used >= 32 ? ', exhausted,' : ', not exhausted,');
    expect(doctorReport('node', checks).exitCode).toBe(item.exit);
  }
});

test('invalid zero budget fails even without active subscriptions', () => {
  const observed = status();
  observed.admission.maxEventSubscriptions = 0;
  expect(subscriptionChecks(observed)[0]?.level).toBe('fail');
});
