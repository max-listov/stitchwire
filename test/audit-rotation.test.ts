/**
 * The journal has an end.
 *
 * The version without this filled a 150 GB volume to zero and was recovered by hand with
 * `tail -c 20M` — history destroyed because there was no mechanism to bound it. So what is pinned
 * here is not "rotation happens" but the three ways rotation is usually wrong: an already oversized
 * file that nothing ever rolls, generations that accumulate instead of being dropped, and a line
 * torn in half at the boundary.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Audit, createAudit } from '../packages/runtime/src/broker/audit.ts';
import { AuditRotationSchema, BrokerConfigSchema } from '../packages/runtime/src/config/broker.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { until } from './support.ts';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stitchwire-journal-'));
  path = join(dir, 'audit.jsonl');
});

/** Every journal a test opens is closed before its directory goes: an open descriptor left to the
 *  garbage collector is an error on Bun 1.4, reported against whichever test happens to run next. */
const opened: Audit[] = [];
async function open(...args: Parameters<typeof createAudit>): Promise<Audit> {
  const audit = await createAudit(...args);
  opened.push(audit);
  return audit;
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((audit) => audit.close()));
  rmSync(dir, { recursive: true, force: true });
});

function connect(nodeId: string) {
  return { kind: 'connect', nodeId, serves: true, version: '0.0.0' } as const;
}

function generations(): number[] {
  const sizes: number[] = [];
  for (let index = 1; index <= 64; index += 1) {
    // Asked while the writer is renaming `.N` to `.N+1`, so a generation can vanish between the
    // question and the answer. `existsSync` then `statSync` is two questions about a moving file,
    // and the gap between them made the full suite fail on a race inside the probe rather than on
    // the thing it measures. One syscall that may answer "gone" says the same and cannot race.
    const entry = statSync(`${path}.${index}`, { throwIfNoEntry: false });
    if (entry === undefined) break;
    sizes.push(entry.size);
  }
  return sizes;
}

// A killed rotation can leave no active file or a hole while generations are renamed.
// Enumerate surviving files after exit instead of assuming a completed rotation layout.
function survivingJournalFiles(): string[] {
  return readdirSync(dir)
    .filter((name) => /^audit\.jsonl(?:\.[1-9]\d*)?$/.test(name))
    .sort((a, b) => Number(b.split('.')[2] ?? 0) - Number(a.split('.')[2] ?? 0))
    .map((name) => join(dir, name));
}

test('crash inspection includes surviving generations when the active file was renamed', async () => {
  const audit = await createAudit(path);
  audit.write(connect('before-crash'));
  await audit.flush();
  // A crash leaves the file behind; a restart opens the journal again. Closing first is what makes
  // this a RESTART rather than two live writers — the lock refuses the second one, correctly.
  await audit.close();
  renameSync(path, `${path}.1`);
  expect(survivingJournalFiles()).toEqual([`${path}.1`]);
  expect(JSON.parse(readFileSync(`${path}.1`, 'utf8')).event.nodeId).toBe('before-crash');
  const restarted = await open(path);
  restarted.write(connect('after-restart'));
  await restarted.flush();
  expect(survivingJournalFiles()).toEqual([`${path}.1`, path]);
});

test('the active file never passes the ceiling, and what it held becomes a generation', async () => {
  const audit = await open(path, 4_096, { maxBytes: 4 * 1024, keep: 3 });
  for (let index = 0; index < 200; index += 1) audit.write(connect(`node-${index}`));
  await audit.flush();

  expect(statSync(path).size).toBeLessThanOrEqual(4 * 1024);
  expect(generations().length).toBeGreaterThan(0);
  for (const size of generations()) expect(size).toBeLessThanOrEqual(4 * 1024);
});

test('generations shift down and the oldest is dropped, so the total is bounded', async () => {
  const keep = 2;
  const maxBytes = 2 * 1024;
  const audit = await open(path, 4_096, { maxBytes, keep });
  for (let index = 0; index < 500; index += 1) audit.write(connect(`node-${index}`));
  await audit.flush();

  expect(generations().length).toBe(keep);
  expect(existsSync(`${path}.${keep + 1}`)).toBe(false);
  const total = statSync(path).size + generations().reduce((sum, size) => sum + size, 0);
  expect(total).toBeLessThanOrEqual(maxBytes * (keep + 1));

  // The newest generation is the one that was active most recently, which is what makes reading
  // `.1` first the right way to walk backwards through history.
  const newest = readFileSync(`${path}.1`, 'utf8').trim().split('\n');
  const oldest = readFileSync(`${path}.2`, 'utf8').trim().split('\n');
  const seqOf = (line: string): number => Number(JSON.parse(line).event.nodeId.split('-')[1]);
  expect(seqOf(newest[0] as string)).toBeGreaterThan(seqOf(oldest.at(-1) as string));
});

test('a journal that is already over the ceiling rolls on its first write', async () => {
  // The 969 MB file in miniature. A writer that counted only its own bytes would leave this
  // growing forever, which is precisely the state the fleet was found in.
  writeFileSync(path, `${'x'.repeat(50_000)}\n`, { mode: 0o600 });
  const audit = await open(path, 4_096, { maxBytes: 8 * 1024, keep: 2 });
  audit.write(connect('first-after-restart'));
  await audit.flush();

  expect(statSync(`${path}.1`).size).toBe(50_001);
  const active = readFileSync(path, 'utf8').trim().split('\n');
  expect(active).toHaveLength(1);
  expect(JSON.parse(active[0] as string).event.nodeId).toBe('first-after-restart');
});

test('a record that cannot fit the file ceiling is refused and counted, never silently lost', async () => {
  // The previous writer put such a record on disk WHOLE, past the ceiling, reasoning that a
  // journal which dropped records to respect a size would be lying about what happened. The
  // reasoning was right about silence and wrong about the remedy: the record is now refused, and
  // the refusal is a number an operator can read. Losing it quietly was never the alternative.
  //
  // Only reachable with a file ceiling this small. Production runs 64 MB against audit records of
  // a few hundred bytes, so this is the shape of the guarantee, not a case the fleet meets.
  const audit = await open(path, 4_096, { maxBytes: 1024, keep: 1 });
  audit.write({ kind: 'disconnect', nodeId: 'n', broker: 'test:0', reason: 'y'.repeat(4_000) });
  await audit.flush();

  expect(audit.status().dropped).toBe(1);
  expect(audit.status().lastFailure).toContain('oversized');
  // The journal stays usable: the refusal is one record's, not the writer's.
  audit.write(connect('after-refusal'));
  await audit.flush();
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0] as string).event.nodeId).toBe('after-refusal');
});

test('status reports the file, not just the writer', async () => {
  const audit = await open(path, 4_096, { maxBytes: 4 * 1024, keep: 3 });
  for (let index = 0; index < 200; index += 1) audit.write(connect(`node-${index}`));
  await audit.flush();

  const { journal } = audit.status();
  expect(journal.path).toBe(path);
  expect(journal.maxBytes).toBe(4 * 1024);
  expect(journal.keep).toBe(3);
  expect(journal.rotations).toBeGreaterThan(0);
  expect(journal.generations).toBe(generations().length);
  expect(journal.bytes).toBe(statSync(path).size);
});

test('a journal inherited with a wider mode is tightened at startup', async () => {
  writeFileSync(path, '{"kind":"connect"}\n', { mode: 0o644 });
  expect(statSync(path).mode & 0o777).toBe(0o644);
  await open(path, 4_096, { maxBytes: 4 * 1024, keep: 1 });
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('killing the writer mid-rotation leaves no torn line in any generation', async () => {
  // The acceptance criterion cannot be proven by a clean shutdown, so this runs a real process,
  // kills it while it is writing across rotation boundaries, and then reads what survived.
  const script = join(dir, 'writer.ts');
  writeFileSync(
    script,
    `import { createAudit } from ${JSON.stringify(join(import.meta.dir, '..', 'packages', 'runtime', 'src', 'broker', 'audit.ts'))};
const audit = await createAudit(${JSON.stringify(path)}, 65_536, { maxBytes: 4 * 1024, keep: 8 });
for (let index = 0; index < 200_000; index += 1) {
  audit.write({ kind: 'connect', nodeId: 'n' + index, serves: true, version: '0.0.0' });
  if (index % 200 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
}
await audit.flush();
`,
  );
  const child = Bun.spawn(['bun', script], { stdout: 'ignore', stderr: 'ignore' });
  // Killed once the writer has DEMONSTRABLY rotated, not once a timer says it probably has. A fixed
  // sleep made this test fail under load roughly one run in three: the assertion below needs more
  // than one generation to exist, and 700ms is a guess about how fast a machine happens to be.
  // Waiting on the fact rather than on the clock is the same rule this project just wrote down for
  // its own waits — a deadline is the ceiling, the sign is what you actually wait for.
  await until(() => generations().length >= 3);
  child.kill('SIGKILL');
  await child.exited;

  const files = survivingJournalFiles();
  expect(files.length).toBeGreaterThan(1); // it really did rotate before being killed
  const seen: number[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line === '') continue;
      const record = JSON.parse(line); // throws on a torn line, which is the assertion
      seen.push(Number(String(record.nodeId).slice(1)));
    }
  }
  // Contiguous from the oldest surviving generation to the last byte written: nothing torn,
  // nothing skipped, nothing written twice across a boundary.
  expect(seen.length).toBeGreaterThan(1);
  for (let index = 1; index < seen.length; index += 1) {
    expect(seen[index]).toBe((seen[index - 1] as number) + 1);
  }
});

test('the rotation knobs are bounded by the schema and default to a bounded journal', () => {
  const defaults = AuditRotationSchema.parse(undefined);
  expect(defaults.maxBytes).toBe(64 * 1024 * 1024);
  expect(defaults.keep).toBe(7);

  expect(AuditRotationSchema.safeParse({ maxBytes: 8 * 1024 * 1024 * 1024, keep: 2 }).success).toBe(false);
  expect(AuditRotationSchema.safeParse({ maxBytes: 1024, keep: 2 }).success).toBe(false);
  expect(AuditRotationSchema.safeParse({ maxBytes: 1024 * 1024, keep: 999 }).success).toBe(false);
  // No generation means nowhere to move a torn file after a crash: refused at load, not at recovery.
  expect(AuditRotationSchema.safeParse({ maxBytes: 1024 * 1024, keep: 0 }).success).toBe(false);

  // A broker config that says nothing about the journal still gets a ceiling: the incident
  // happened on a config that said nothing, and "you had to opt in" would repeat it.
  const config = BrokerConfigSchema.parse({ nodes: [{ id: 'a', tokenSha256s: [sha256('t'.repeat(40))] }] });
  expect(config.auditRotate).toEqual({ maxBytes: 64 * 1024 * 1024, keep: 7 });
});

test('a writer killed by SIGKILL leaves a lock the next process reclaims without a human', async () => {
  // The whole reason this replacement waited on the framework. A journal takes an exclusive lock so
  // two live writers cannot interleave records into one ordered file — correct, and fatal for an
  // unattended daemon if an abandoned lock also refuses. A broker that will not restart after an
  // OOM kill until somebody deletes a file is a worse outcome than the one the lock prevents.
  //
  // Proven with a real process and a real SIGKILL: nothing else leaves a lock the way abrupt death
  // does, and a lock written by this process would be reclaimed for the wrong reason — its owner
  // would be alive.
  const script = join(dir, 'killed-writer.ts');
  const lockPath = `${path}.lock`;
  writeFileSync(
    script,
    `import { createAudit } from ${JSON.stringify(join(import.meta.dir, '..', 'packages', 'runtime', 'src', 'broker', 'audit.ts'))};
const audit = await createAudit(${JSON.stringify(path)}, 4_096, { maxBytes: 64 * 1024, keep: 2 });
audit.write({ kind: 'connect', nodeId: 'before-the-kill', serves: true, version: '0.0.0' });
await audit.flush();
console.log('ready');
await new Promise(() => {});
`,
  );
  const child = Bun.spawn(['bun', script], { stdout: 'pipe', stderr: 'ignore' });
  const reader = child.stdout.getReader();
  const deadline = Date.now() + 10_000;
  let ready = false;
  while (!ready && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    ready = new TextDecoder().decode(chunk.value).includes('ready');
  }
  reader.releaseLock();
  expect(ready).toBe(true);
  child.kill('SIGKILL');
  await child.exited;

  // The lock outlives the process that took it: that is the state a restart actually meets.
  expect(existsSync(lockPath)).toBe(true);

  const restarted = await createAudit(path, 4_096, { maxBytes: 64 * 1024, keep: 2 });
  try {
    restarted.write({ kind: 'connect', nodeId: 'after-the-restart', serves: true, version: '0.0.0' });
    await restarted.flush();
    const nodes = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).event.nodeId);
    // Both halves survive: the record written before the kill, and the one written after.
    expect(nodes).toContain('before-the-kill');
    expect(nodes).toContain('after-the-restart');
  } finally {
    await restarted.close();
  }
});

/**
 * Every record is dated, and the date is not optional.
 *
 * Moving this writer onto the framework's journal in 0.36.0 silently dropped the `ts` the
 * hand-rolled one had stamped: `schemaVersion`, `epoch` and `sequence` order records but do not
 * date them. Nothing broke, no counter moved, and the file simply stopped answering "when" — which
 * is the question two journals on two machines are compared by. Found on 2026-09-01 while reading
 * the live journal for something else.
 */
test('a record cannot reach the journal without the time it happened', async () => {
  const before = Date.now();
  const audit = await createAudit(path);
  audit.write(connect('node-a'));
  audit.write({
    kind: 'call',
    id: 'call-1',
    from: 'node-a',
    to: 'node-b',
    command: 'read',
    argc: 0,
    argvBytes: 0,
    stdinBytes: 0,
    accepted: true,
    failure: 'none',
    refusal: 'none',
    transportCause: null,
    detail: '',
  });
  await audit.flush();
  await audit.close();

  const records = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { event: { kind: string; ts?: string } });
  expect(records).toHaveLength(2);
  for (const record of records) {
    // Present, parseable, and actually of this moment — a hardcoded or zero stamp would satisfy
    // "a string is there" while answering the question wrongly.
    const timestamp = record.event.ts;
    expect(typeof timestamp).toBe('string');
    if (timestamp === undefined) throw new Error('audit record has no timestamp');
    const at = Date.parse(timestamp);
    expect(Number.isNaN(at)).toBe(false);
    expect(at).toBeGreaterThanOrEqual(before - 1_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1_000);
  }
  expect(records.map((record) => record.event.kind)).toEqual(['connect', 'call']);
});
