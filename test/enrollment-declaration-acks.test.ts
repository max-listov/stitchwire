import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalStatus } from '../packages/contracts/src/door/status.ts';
import type {
  EnrollmentDescriptor,
  EnrollmentNodeRequest,
} from '../packages/contracts/src/enrollment/request.ts';
import type { EventDeclareAck } from '../packages/contracts/src/protocol/topic.ts';
import type { ServiceDeclareAck } from '../packages/contracts/src/service/declaration.ts';
import type { WireClient } from '../packages/local-client/src/client.ts';
import { sha256 } from '../packages/runtime/src/config/io.ts';
import { NodeConfigSchema } from '../packages/runtime/src/config/node.ts';
import { ownedDeclarations } from '../packages/runtime/src/enrollment/bindings.ts';
import { EnrollmentError } from '../packages/runtime/src/enrollment/failure.ts';
import { checkDeclarationAcks, serviceProof } from '../packages/runtime/src/enrollment/observe.ts';
import { ServiceDeclarer } from '../packages/runtime/src/node/service-declarations.ts';
import { TopicDeclarer } from '../packages/runtime/src/node/topic-declarations.ts';

// A short root: socket paths named in declarations are bounded by the Unix socket path limit.
const root = realpathSync(mkdtempSync('/tmp/wda-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const limits = { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 };
const reader = [{ caller: 'reader', scope: { kind: 'service-read' } }];
const request = { brokers: [{ id: 'primary', url: 'https://broker.example' }] } as EnrollmentNodeRequest;
const namespaces = { publish: ['owner.'], subscribe: [] };
let serial = 0;

function workDir(): string {
  const dir = join(root, `case-${serial++}`);
  mkdirSync(join(dir, 'services.d'), { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'events.d'), { recursive: true, mode: 0o700 });
  return dir;
}
function declaration(path: string, service: string, socket: string): string {
  const binding = {
    service,
    descriptorPath: join(path, '..', `${service}.descriptor.json`),
    socketPath: join(root, socket),
    endpointPath: '/wire',
    maxInflight: 4,
    limits,
  };
  writeFileSync(path, JSON.stringify({ binding, callers: reader }), { mode: 0o600 });
  return path;
}
function topics(path: string, ...names: string[]): string {
  const declared = Object.fromEntries(names.map((name) => [name, { delivery: 'ordered' }]));
  writeFileSync(path, JSON.stringify({ topics: declared }), { mode: 0o600 });
  return path;
}

type Answer<Ack> = (sent: Ack) => ServiceDeclareAck | EventDeclareAck | null;
const acceptAll = {
  services: (sent: { grants: unknown[] }): ServiceDeclareAck => ({
    accepted: sent.grants.length,
    refused: [],
  }),
  topics: (sent: { topics: Record<string, unknown> }): EventDeclareAck => ({
    accepted: Object.keys(sent.topics),
    refused: [],
  }),
};

/**
 * The status an agent reports after reading these explicit files and the drop-in directories of
 * `dir`, with each kind's lane answering as given, and what the owner of `bindings` holds in it.
 */
async function observed(
  dir: string,
  bindings: EnrollmentDescriptor[],
  answers: {
    services?: Answer<{ grants: unknown[] }>;
    topics?: Answer<{ topics: Record<string, unknown> }>;
  } = {},
) {
  const config = NodeConfigSchema.parse({
    nodeId: 'worker',
    brokers: [{ id: 'primary', url: 'http://127.0.0.1:9', token: 'x'.repeat(40) }],
    services: {
      bindings: [],
      grants: [],
      namespaces: ['owner.'],
      descriptors: bindings.filter(({ kind }) => kind === 'service').map(({ path }) => path),
      dropInDir: join(dir, 'services.d'),
    },
    events: {
      namespaces,
      descriptors: bindings.filter(({ kind }) => kind === 'topic').map(({ path }) => path),
      dropInDir: join(dir, 'events.d'),
    },
  });
  const services = new ServiceDeclarer('worker', config.services, () => {}, 60_000, join(dir, 'services.d'));
  services.attach('primary', {
    connected: true,
    declareServices: async (sent) =>
      (answers.services ?? acceptAll.services)(sent) as ServiceDeclareAck | null,
  });
  const events = new TopicDeclarer('worker', config.events, 60_000, join(dir, 'events.d'));
  events.attach('primary', {
    connected: true,
    declareTopics: async (sent) => (answers.topics ?? acceptAll.topics)(sent) as EventDeclareAck | null,
  });
  await Promise.all([services.refresh(), events.refresh()]);
  services.stop();
  events.stop();
  const status = {
    services: { namespaces: ['owner.'], declarations: services.snapshot() },
    events: { publish: [], namespaces, declarations: events.snapshot() },
  } as unknown as Pick<LocalStatus, 'services' | 'events'>;
  const owned = ownedDeclarations(config, join(dir, 'worker.json'), bindings, { namespaces, publish: [] });
  return { status, owned };
}

function verdict(observation: Awaited<ReturnType<typeof observed>>): string {
  try {
    checkDeclarationAcks(observation.status, request, observation.owned);
    return 'ok';
  } catch (error) {
    if (error instanceof EnrollmentError) return error.code;
    throw error;
  }
}

describe('after the write, only refusals of the owner request refuse it', () => {
  test('a conflict between two foreign drop-in files does not refuse an unrelated owner', async () => {
    const dir = workDir();
    declaration(join(dir, 'services.d', 'a.json'), 'owner.dup', 'a.sock');
    declaration(join(dir, 'services.d', 'b.json'), 'owner.dup', 'b.sock');
    const own = declaration(join(dir, 'own.json'), 'owner.mine', 'mine.sock');
    const observation = await observed(dir, [{ kind: 'service', path: own }]);
    // The agent did refuse b.json: the status shows a foreign local refusal.
    expect(observation.status.services.declarations.refused.map((entry) => entry.service)).toEqual([
      'owner.dup',
    ]);
    expect(verdict(observation)).toBe('ok');
  });

  test('a broker refusing a foreign grant is not the owner refusal, while the count is complete', async () => {
    const dir = workDir();
    declaration(join(dir, 'services.d', 'foreign.json'), 'owner.foreign', 'foreign.sock');
    const own = declaration(join(dir, 'own.json'), 'owner.mine', 'mine.sock');
    const refusing = (service: string) => (sent: { grants: unknown[] }) => ({
      accepted: sent.grants.length - 1,
      refused: [{ service, caller: 'reader', detail: 'refused by this broker' }],
    });
    expect(
      verdict(await observed(dir, [{ kind: 'service', path: own }], { services: refusing('owner.foreign') })),
    ).toBe('ok');
    expect(
      verdict(await observed(dir, [{ kind: 'service', path: own }], { services: refusing('owner.mine') })),
    ).toBe('declaration-refused');
  });

  test("the agent refusing the owner's own file refuses the request", async () => {
    const dir = workDir();
    const own = declaration(join(dir, 'own.json'), 'elsewhere.mine', 'mine.sock');
    expect(verdict(await observed(dir, [{ kind: 'service', path: own }]))).toBe('declaration-refused');
  });

  test('a lane still showing its answer to the earlier set is refused', async () => {
    const dir = workDir();
    declaration(join(dir, 'services.d', 'foreign.json'), 'owner.foreign', 'foreign.sock');
    const own = declaration(join(dir, 'own.json'), 'owner.mine', 'mine.sock');
    const bindings: EnrollmentDescriptor[] = [{ kind: 'service', path: own }];
    // The agent reads the owner's file; the lane's answer is still the one to the set without it.
    const earlier = await observed(dir, []);
    const current = await observed(dir, bindings);
    const lanes = earlier.status.services.declarations.lanes;
    expect(lanes[0]?.accepted).toBe(1);
    const status = {
      ...current.status,
      services: {
        ...current.status.services,
        declarations: { ...current.status.services.declarations, lanes },
      },
    };
    expect(verdict({ status, owned: current.owned })).toBe('declaration-refused');
    expect(verdict(current)).toBe('ok');
  });

  test('an empty set is refused while a lane has not answered it, and accepted once it has', async () => {
    const dir = workDir();
    const own = declaration(join(dir, 'gone.json'), 'owner.gone', 'gone.sock');
    const detached = (answer: Answer<{ grants: unknown[] }>) =>
      observed(dir, [], { services: answer }).then(({ status }) => ({
        status,
        owned: { paths: new Set([own]), topics: new Set<string>(), held: new Set<string>() },
      }));
    expect(verdict(await detached(() => null))).toBe('declaration-refused');
    expect(verdict(await detached(acceptAll.services))).toBe('ok');
  });

  test('topics: a foreign duplicate, even of the owner topic, is not the owner refusal', async () => {
    const dir = workDir();
    topics(join(dir, 'events.d', 'a.json'), 'owner.events.dup');
    topics(join(dir, 'events.d', 'b.json'), 'owner.events.dup', 'owner.events.mine');
    const own = topics(join(dir, 'own.json'), 'owner.events.mine');
    const observation = await observed(dir, [{ kind: 'topic', path: own }]);
    expect(observation.status.events.declarations.refused.map((entry) => entry.topic).sort()).toEqual([
      'owner.events.dup',
      'owner.events.mine',
    ]);
    expect(verdict(observation)).toBe('ok');
  });

  test('topics: a name of the owner the plan does not give it, or a broker refuses, refuses the request', async () => {
    const dir = workDir();
    topics(join(dir, 'events.d', 'foreign.json'), 'owner.events.foreign');
    const outside = topics(join(dir, 'outside.json'), 'elsewhere.events.mine');
    expect(verdict(await observed(dir, [{ kind: 'topic', path: outside }]))).toBe('declaration-refused');
    const own = topics(join(dir, 'own.json'), 'owner.events.mine');
    const refusing = (topic: string) => (sent: { topics: Record<string, unknown> }) => ({
      accepted: Object.keys(sent.topics).filter((name) => name !== topic),
      refused: [{ topic, detail: 'refused by this broker' }],
    });
    const bindings: EnrollmentDescriptor[] = [{ kind: 'topic', path: own }];
    expect(verdict(await observed(dir, bindings, { topics: refusing('owner.events.foreign') }))).toBe('ok');
    expect(verdict(await observed(dir, bindings, { topics: refusing('owner.events.mine') }))).toBe(
      'declaration-refused',
    );
  });
});

describe('the proof waits out a settling route and nothing else', () => {
  const dir = workDir();
  const descriptor = join(dir, 'probe.descriptor.json');
  writeFileSync(
    descriptor,
    JSON.stringify({
      service: 'example.probe',
      revision: '1',
      maxInflight: 4,
      operations: [{ id: 'read', path: '/read', effect: 'read', limits, response: { kind: 'unary' } }],
    }),
    { mode: 0o600 },
  );
  const payload = '{"ok":true}';
  const call = {
    to: 'observer',
    service: 'example.probe',
    revision: '1',
    operation: 'read',
    payload: '{}',
    timeoutMs: 1000,
  };
  const proven = {
    nodeId: 'worker',
    agentSocket: join(dir, 'agent.sock'),
    proof: { descriptor, call, responseSha256: sha256(payload) },
  } as EnrollmentNodeRequest;
  /** A client whose answers are these outcomes in turn, counting the calls it was asked. */
  function scripted(outcomes: unknown[]) {
    const asked = { calls: 0 };
    const client = {
      invokeService: async () => ({ outcome: outcomes[Math.min(asked.calls++, outcomes.length - 1)] }),
      close: () => {},
    } as unknown as Pick<WireClient, 'invokeService' | 'close'>;
    return { asked, connect: () => client };
  }
  const failure = (code: string) => ({ status: 'failure', code, delivery: 'not-dispatched', message: code });

  test('offline answers are waited out until the route answers', async () => {
    const { asked, connect } = scripted([
      failure('offline'),
      failure('offline'),
      failure('unavailable'),
      { status: 'response', httpStatus: 200, payload },
    ]);
    expect(await serviceProof(proven, connect)).toEqual({ httpStatus: 200 });
    expect(asked.calls).toBe(4);
  });

  test('a policy refusal is final at its first answer', async () => {
    const { asked, connect } = scripted([
      failure('denied'),
      { status: 'response', httpStatus: 200, payload },
    ]);
    await expect(serviceProof(proven, connect)).rejects.toMatchObject({ code: 'proof-failed' });
    expect(asked.calls).toBe(1);
  });
});
