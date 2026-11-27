import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EnrollmentNodeRequestSchema } from '../packages/contracts/src/enrollment/request.ts';
import { requestedInstallation } from '../packages/runtime/src/enrollment/installation.ts';
import { AGENT_UNIT, exampleUnit, renderUnit } from '../packages/runtime/src/enrollment/unit.ts';

const example = (role: string) =>
  readFileSync(resolve(import.meta.dir, `../contrib/systemd/stitchwire-${role}.service`), 'utf8')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trimStart();

test('the product examples are the one rendered unit shape, comments aside', () => {
  expect(example('agent')).toBe(exampleUnit('agent'));
  expect(example('broker')).toBe(exampleUnit('broker'));
});

test('enrollment installs the same shape with absolute paths, the canonical name and quoted data', () => {
  const request = EnrollmentNodeRequestSchema.parse({
    v: 1,
    kind: 'node',
    requestId: crypto.randomUUID(),
    nodeId: 'worker',
    expectedVersion: '1.2.3',
    config: '/srv/stitchwire/config/node.json',
    brokers: [{ id: 'primary', url: 'https://broker.example' }],
    agentSocket: '/srv/stitchwire/state/agent.sock',
    supervisor: {
      kind: 'systemd',
      scope: 'system',
      bun: process.execPath,
      artifact: {
        source: '/tmp/stitchwire',
        destination: '/srv/stitchwire/bin/stitchwire',
        sha256: '0'.repeat(64),
      },
    },
    owner: { id: 'example', descriptors: [] },
  });
  const installation = requestedInstallation(request);
  if (installation === null) throw new Error('a systemd request has an installation');
  const { supervision, unitText: text } = installation;
  expect(supervision.unit).toBe(AGENT_UNIT);
  expect(text).toBe(
    renderUnit({
      role: 'agent',
      scope: 'system',
      bun: supervision.bun,
      runtime: '/srv/stitchwire/bin/stitchwire',
      config: '/srv/stitchwire/config/node.json',
      configDir: '/srv/stitchwire/config',
      stateDir: '/srv/stitchwire/state',
    }),
  );
  // Every directive but the scope's install target and the absolute paths is the example's.
  const directives = (unit: string) =>
    unit.split('\n').filter((line) => !/^(ExecStart|Environment|WantedBy)=/.test(line));
  expect(directives(text)).toEqual(directives(exampleUnit('agent')));
  expect(text).toContain(
    `ExecStart="${supervision.bun}" "/srv/stitchwire/bin/stitchwire" "agent" "--config" "/srv/stitchwire/config/node.json"`,
  );
  expect(text).toContain('WantedBy=multi-user.target');
  // Paths are data: a percent or dollar in a path is never a specifier or an environment reference.
  const odd = renderUnit({
    ...{ role: 'agent', scope: 'user' },
    bun: '/b%h/$HOME',
    runtime: '/r',
    config: '/c',
    configDir: '/d%',
    stateDir: '/s$',
  });
  expect(odd).toContain('ExecStart="/b%%h/$$HOME"');
  expect(odd).toContain('Environment="STITCHWIRE_CONFIG_DIR=/d%%" "STITCHWIRE_STATE_DIR=/s$"');
});

test('a unit name is a plain service name', () => {
  const supervisor = {
    kind: 'systemd',
    scope: 'system',
    bun: '/usr/bin/bun',
    artifact: { source: '/tmp/stitchwire', destination: '/usr/local/bin/stitchwire', sha256: '0'.repeat(64) },
  };
  for (const unit of ['stitchwire-check-1.service', 'a.b:c_d-e.service'])
    expect(EnrollmentNodeRequestSchema.shape.supervisor.safeParse({ ...supervisor, unit }).success).toBe(
      true,
    );
  for (const unit of ['../x.service', 'a/b.service', 'x@y.service', 'x.socket', '%h.service', '-x.service'])
    expect(EnrollmentNodeRequestSchema.shape.supervisor.safeParse({ ...supervisor, unit }).success).toBe(
      false,
    );
});
