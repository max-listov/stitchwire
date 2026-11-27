/**
 * A refusal that says only what it measured.
 *
 * A node once spent 1h46m in a restart loop — 127 attempts — because the journal's lock had been
 * recorded under the host name that machine carried earlier and it reported a different name by
 * the time it restarted. The framework of the day identified a machine BY that name, so the
 * machine was foreign to itself and would not reclaim its own dead owner. That half is fixed
 * upstream in stitchkit 0.73.0 and is pinned below. What was ours was the sentence printed on top
 * of the refusal — "another stitchwire broker or agent is running against this state" — asserted
 * while the recorded pid had not existed for hours.
 *
 * So the property pinned here is not "startup fails on a held lock" — that already held, and held
 * loudly. It is that each outcome is DISTINGUISHABLE in the text an operator reads: a holder that
 * answers, a lock belonging to a genuinely different machine, a lock nothing can attribute at all,
 * and a lock that could not be read. The last two have to say they established nothing.
 *
 * Since stitchkit 0.73.0 the framework decides attribution from a durable machine identity and
 * attaches its diagnosis to the refusal, so these assertions are about relaying it rather than
 * re-deriving it. The one case that still probes locally is `unattributable` — a lock written
 * before that identity existed, where the pid may be this machine's under an older name.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAudit } from '../packages/runtime/src/broker/audit.ts';
import { stillRunning } from '../packages/runtime/src/node/process-state.ts';
import { until } from './support.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stitchwire-lock-'));
  path = join(dir, 'audit.jsonl');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function plantLock(owner: unknown): void {
  writeFileSync(`${path}.lock`, typeof owner === 'string' ? owner : `${JSON.stringify(owner)}\n`);
}

async function refusal(): Promise<string> {
  const audit = await createAudit(path).then(
    (opened) => opened,
    (error: unknown) => error as Error,
  );
  if (audit instanceof Error) return audit.message;
  await audit.close();
  throw new Error('the journal opened despite a planted lock');
}

/** A pid that is genuinely reaped, rather than a number assumed to be free. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(['true']);
  await child.exited;
  return child.pid;
}

test('a lock recorded under another host name is named as unattributable, not as a live holder', async () => {
  const pid = await deadPid();
  plantLock({ pid, host: 'some-other-name.local', acquiredAt: '2026-09-02T03:03:26.754Z' });
  const message = await refusal();
  // The mismatch itself, in both directions, because that is what the operator has to see.
  expect(message).toContain('some-other-name.local');
  expect(message).toContain(hostname());
  expect(message).toContain(String(pid));
  // The measured half: this pid is gone, so the lock is abandoned if that name was this machine.
  expect(message).toContain('No process with pid');
  expect(message).toContain('Preserve');
  // And the sentence that started this: it must NOT be claimed here.
  expect(message).not.toContain('already in use by a live process');
});

test('a live pid under another host name is reported as present, not as gone', async () => {
  plantLock({ pid: process.pid, host: 'some-other-name.local', acquiredAt: '2026-09-02T03:03:26.754Z' });
  const message = await refusal();
  expect(message).toContain(`A process with pid ${process.pid} does exist on this machine`);
  expect(message).not.toContain('No process with pid');
});

test('an unreadable lock says nothing was established', async () => {
  plantLock('not json at all');
  const message = await refusal();
  expect(message).toContain('could not be read');
  expect(message).toContain('nothing about the holder was established');
  // Neither liveness nor absence may be asserted from a record that did not parse.
  expect(message).not.toContain('already in use by a live process');
  expect(message).not.toContain('No process with pid');
});

test('a matching process instance is reported as the confirmed live owner', async () => {
  const first = await createAudit(path);
  try {
    const message = await refusal();
    expect(message).toContain('locked by this machine');
    expect(message).toContain(`pid ${process.pid}`);
    expect(message).toContain('confirmed live owner');
    expect(message).toContain('boot and process-start identity match');
  } finally {
    await first.close();
  }
});

test('an old record naming a present PID does not prove continuous ownership', async () => {
  const record = { pid: process.pid, host: hostname(), acquiredAt: '2001-01-01T00:00:00.000Z' };
  plantLock(record);
  const message = await refusal();
  expect(message).toContain('alone does not confirm the recorded owner');
  expect(message).not.toContain('has held it since');
  expect(message).not.toContain('already in use by a live process');
  expect(JSON.parse(readFileSync(`${path}.lock`, 'utf8'))).toEqual(record);
});

test('a lock owned by a genuinely different machine is never probed against this process table', async () => {
  // Reachable only since 0.73.0: before it, "another machine" and "renamed host" were one
  // indistinguishable refusal. The bug this pins is the tempting one — a pid number from another
  // machine happens to match a live pid here, and a local probe reports presence. That would be an
  // invented fact about a process nothing here owns, in the message written to remove such facts.
  const held = await createAudit(path);
  const owner = JSON.parse(readFileSync(`${path}.lock`, 'utf8')) as Record<string, unknown>;
  await held.close();
  // Our own live pid under a foreign machine identity: a local probe WOULD find it.
  writeFileSync(
    `${path}.lock`,
    `${JSON.stringify({ ...owner, pid: process.pid, machine: 'a-different-machine-uuid' })}\n`,
  );
  const message = await refusal();
  expect(message).toContain('locked by another machine');
  expect(message).toContain('was not probed and cannot be from here');
  // The pid is live on this host, and the message must still not claim anything about it.
  expect(message).not.toContain('does exist on this machine');
  expect(message).not.toContain('already in use by a live process');
  expect(message).toContain('Preserve');
});

test('a renamed machine reclaims its own abandoned lock instead of refusing it', async () => {
  // The morning incident, and the half that is no longer ours: the lock carries a durable machine
  // identity, so a host name that changed between the crash and the restart no longer makes the
  // machine foreign to itself. Measured against the installed framework, not assumed from it.
  const held = await createAudit(path);
  const owner = JSON.parse(readFileSync(`${path}.lock`, 'utf8')) as Record<string, unknown>;
  await held.close();
  const child = Bun.spawn(['true']);
  await child.exited;
  writeFileSync(
    `${path}.lock`,
    `${JSON.stringify({ ...owner, pid: child.pid, host: 'the-name-it-had-that-morning.local' })}\n`,
  );
  const reopened = await createAudit(path);
  await reopened.close();
  // And the negative case: identity is what does it, not the dead pid. Strip the identity and the
  // same lock is refused again, which is every lock written before 0.73.0.
  writeFileSync(
    `${path}.lock`,
    `${JSON.stringify({ pid: child.pid, host: 'the-name-it-had-that-morning.local', acquiredAt: String(owner.acquiredAt) })}\n`,
  );
  expect(await refusal()).toContain('cannot attribute to anyone');
});

/** A pid that is in the table and has already exited: its parent never reaped it. */
async function zombiePid(): Promise<{ pid: number; release: () => void }> {
  // fork without wait — the child exits, the parent lives, the entry stays as state Z.
  const parent = Bun.spawn(
    [
      'python3',
      '-c',
      'import os,sys,time\npid=os.fork()\nif pid==0: os._exit(0)\nsys.stdout.write(str(pid));sys.stdout.flush()\ntime.sleep(30)',
    ],
    { stdout: 'pipe' },
  );
  const reader = parent.stdout.getReader();
  const { value } = await reader.read();
  const pid = Number(new TextDecoder().decode(value).trim());
  // Wait for the state, never for a duration. The pid is printed by the PARENT before the child
  // has necessarily exited, so a test that starts measuring here measures a running process and
  // proves nothing — which is exactly what a first cross-platform run of this looked like.
  const zombie = (): boolean =>
    Bun.spawnSync(['ps', '-o', 'state=', '-p', String(pid)])
      .stdout.toString()
      .trim()
      .startsWith('Z');
  if (!(await until(zombie)))
    throw new Error('the child never became a zombie, so this test measures nothing');
  return { pid, release: () => parent.kill() };
}

test('a zombie owner is named as one, not reported as a live process to hunt for', async () => {
  // `process.kill(pid, 0)` SUCCEEDS on a zombie — the probe every liveness check uses reads an
  // already-exited process as present. It holds no descriptor and no lock and cannot be killed, so
  // calling it live sends an operator to find something that is gone and kill something dead.
  const { pid, release } = await zombiePid();
  try {
    // The probe itself, pinned: if this ever starts throwing, the branch below is unreachable and
    // the test would pass while asserting nothing.
    expect(() => process.kill(pid, 0)).not.toThrow();

    plantLock({ pid, host: 'some-other-name.local', acquiredAt: '2026-09-02T03:03:26.754Z' });
    const message = await refusal();
    expect(message).toContain('is a zombie its parent never reaped');
    expect(message).toContain('there is nothing to kill');
    // The claim it replaces must be gone: a zombie is not a process that "does exist" to act on.
    expect(message).not.toContain('does exist on this machine');
  } finally {
    release();
  }
});

test('a genuinely running owner is still reported as present', async () => {
  // The negative control for the branch above: same code path, live pid, and the zombie wording
  // must not appear. Without this, a reader that called everything a zombie would pass.
  plantLock({ pid: process.pid, host: 'some-other-name.local', acquiredAt: '2026-09-02T03:03:26.754Z' });
  const message = await refusal();
  expect(message).toContain(`A process with pid ${process.pid} does exist on this machine`);
  expect(message).not.toContain('zombie');
});

test('a lock this machine owns whose holder is a zombie is reclaimed, not refused forever', async () => {
  // The owner's fix, pinned here because this consumer paid for the defect twice through two
  // different doors: a renamed host, then a parent that does not reap. Both produced the same
  // thing — a lock nothing could reclaim and a supervisor restarting against it forever — and the
  // second door needs no misconfiguration at all. If a future release of the framework loses this,
  // it should redden here rather than on a node at 3am.
  const { pid, release } = await zombiePid();
  try {
    const held = await createAudit(path);
    const owner = JSON.parse(readFileSync(`${path}.lock`, 'utf8')) as Record<string, unknown>;
    await held.close();
    writeFileSync(`${path}.lock`, `${JSON.stringify({ ...owner, pid })}\n`);
    const reopened = await createAudit(path);
    await reopened.close();
  } finally {
    release();
  }
});

test('stillRunning answers "is this doing something", which a zombie is not', async () => {
  // The predicate two cleanup assertions in this suite depend on. Asserted directly because a
  // mutation making it ignore the zombie state survived every other test here: the lock branch
  // reads `processState`, and nothing reached `stillRunning` itself.
  const { pid, release } = await zombiePid();
  try {
    // The signal probe says yes — that is the whole defect — and the predicate says no.
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(stillRunning(pid)).toBe(false);
    // The negative control: a process that really is running reads as running, so a predicate
    // that simply always answered false would not pass here.
    expect(stillRunning(process.pid)).toBe(true);
  } finally {
    release();
  }
});
