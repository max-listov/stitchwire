import { expect, test } from 'bun:test';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';

const node = {
  nodeId: 'worker',
  brokers: [{ id: 'primary', url: 'http://localhost', token: 't'.repeat(40) }],
};

test('command profiles contain only explicitly configured executables', () => {
  const config = NodeConfigSchema.parse({
    ...node,
    allow: {
      echo: {
        bin: '/bin/echo',
        callerArgs: { mode: 'append', maxCount: 64, maxBytes: 65536 },
        stdin: { mode: 'text', maxBytes: 1048576 },
        env: { inherit: ['HOME', 'LANG', 'LC_ALL', 'PATH', 'TERM', 'TMPDIR'] },
        timeoutMs: 900_000,
        concurrency: 128,
      },
      fixed: { bin: '/usr/bin/printf', argv: ['fixed'] },
    },
  });
  expect(config.allow.echo?.bin).toBe('/bin/echo');
  expect(config.allow.fixed?.bin).toBe('/usr/bin/printf');
  expect(config.allow.fixed?.argv).toEqual(['fixed']);
  expect(NodeConfigSchema.parse(node).allow).toEqual({});
});

test('command configuration cannot install a reader, socket adapter or fallback transport', () => {
  for (const profile of [
    { transport: 'example-file-read/v1' },
    { transport: 'example-unix-read/v1', operation: 'query', socketPath: '/tmp/example.sock' },
    { socketPath: '/tmp/example.sock', operation: 'query' },
    { path: '/tmp/example.json' },
  ]) {
    for (const extra of [{}, { bin: '/bin/echo' }]) {
      const parsed = NodeConfigSchema.safeParse({ ...node, allow: { read: { ...profile, ...extra } } });
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.some((issue) => issue.path[0] === 'allow')).toBe(true);
    }
  }
});

/**
 * A declared command must be a name a grant can name.
 *
 * The allowlist key was any non-empty string while `CommandGrantSchema` requires
 * `^[a-z0-9][a-z0-9._-]*$`. One value, two constraints, and the loose side let a node declare a
 * profile no broker could ever authorise — dead on arrival, surfacing only as a policy denial at
 * call time, with nothing saying the declaration itself was unnameable. A live broker journal
 * still carries `command: "/bin/cat"` from when a bare path was a legal name.
 */
test('a command name the broker could never grant is refused at declaration', () => {
  const profile = { bin: '/bin/echo' };
  for (const name of ['/bin/cat', '../escape', 'Upper', 'has space', 'trailing/', '-leading']) {
    const result = NodeConfigSchema.safeParse({ ...node, allow: { [name]: profile } });
    expect({ name, ok: result.success }).toEqual({ name, ok: false });
  }
  // And the shapes that must keep working, so the guard is not merely "refuses everything".
  for (const name of ['echo', 'node-surface-read', 'example.observation', 'a', 'x1_2-3']) {
    const result = NodeConfigSchema.safeParse({ ...node, allow: { [name]: profile } });
    expect({ name, ok: result.success }).toEqual({ name, ok: true });
  }
});
