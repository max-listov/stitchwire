import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PolledJsonFile, PolledJsonFiles } from 'stitchkit/files';
import { writeTopicDescriptorFile } from '../packages/client/src/index.ts';
import type { EnrollmentNodeRequest } from '../packages/contracts/src/enrollment/request.ts';
import type { FleetNodeTables } from '../packages/contracts/src/fleet/bundle.ts';
import { filesystemFailure } from '../packages/local-client/src/declarations.ts';
import { dropInOwner } from '../packages/runtime/src/config/drop-in.ts';
import { anyJson } from '../packages/runtime/src/config/io.ts';
import { checkOwner } from '../packages/runtime/src/enrollment/bindings.ts';
import { EnrollmentError } from '../packages/runtime/src/enrollment/failure.ts';
import { OwnersLedger } from '../packages/runtime/src/enrollment/owners.ts';
import { ServiceDeclarer } from '../packages/runtime/src/node/service-declarations.ts';
import { caseDirs, nodeConfig, privateFile, service } from './drop-in-fixture.ts';

const cases = caseDirs('wire-drop-in-set-');
afterAll(cases.remove);
const workDir = cases.next;

describe('force order inside the set', () => {
  test('explicit declarations first, then drop-in files by name: a newer a.json takes a service from an older b.json', async () => {
    const dir = workDir();
    const dropIn = join(dir, 'services.d');
    mkdirSync(dropIn, { mode: 0o700 });
    let served: string[] = [];
    const declarer = (descriptors: string[]) =>
      new ServiceDeclarer(
        'worker',
        { ...nodeConfig.services, descriptors },
        (policy) => {
          served = policy.bindings.map((binding) => binding.socketPath);
        },
        60_000,
        dropIn,
      );
    service(dir, join(dropIn, 'b.json'), 'owner.x', 'b.sock');
    const first = declarer([]);
    await first.refresh();
    expect(served).toEqual([join(dir, 'b.sock')]);
    service(dir, join(dropIn, 'a.json'), 'owner.x', 'a.sock');
    await first.refresh();
    // Age does not matter: a.json precedes b.json.
    expect(served).toEqual([join(dir, 'a.sock')]);
    expect(first.snapshot().refused).toEqual([
      {
        path: join(dropIn, 'b.json'),
        service: 'owner.x',
        detail: 'this service is already bound on this node',
      },
    ]);
    // An explicit declaration precedes every drop-in file.
    const explicit = service(dir, join(dir, 'explicit.json'), 'owner.x', 'explicit.sock');
    const second = declarer([explicit]);
    await second.refresh();
    expect(served).toEqual([join(dir, 'explicit.sock')]);
    expect(second.snapshot().refused.map((refused) => refused.path)).toEqual([
      join(dropIn, 'a.json'),
      join(dropIn, 'b.json'),
    ]);
  });
});

describe("the synchronous read keeps the asynchronous one's options", () => {
  test('sync and async reads both refuse a symlink under noFollow; without noFollow they follow', async () => {
    const dir = workDir();
    const target = privateFile(join(dir, 'target.json'), { a: 1 });
    const link = join(dir, 'link.json');
    symlinkSync(target, link);
    const guarded = new PolledJsonFile(link, anyJson, { limit: 1024, noFollow: true });
    expect(guarded.read()).toMatchObject({ state: 'unreadable', reason: 'symbolic-link' });
    const asyncSet = new PolledJsonFiles(anyJson, { limit: 1024, noFollow: true });
    expect(await asyncSet.refreshAsync([{ path: link }])).toMatchObject([
      { kind: 'changed', path: link, reading: { state: 'unreadable', reason: 'symbolic-link' } },
    ]);
    expect(new PolledJsonFile(link, anyJson, { limit: 1024 }).read().state).toBe('read');
  });
});

describe('enrollment judges the set the agent reads, drop-in files included', () => {
  const tables: FleetNodeTables = {
    services: { grants: [], namespaces: ['owner.'] },
    events: { publish: [], subscribe: [], namespaces: { publish: ['owner.'], subscribe: [] } },
  };
  const config = { services: nodeConfig.services, events: nodeConfig.events };
  function enroll(
    configPath: string,
    descriptors: EnrollmentNodeRequest['owner']['descriptors'],
    agentConfig?: string,
  ) {
    const request = { config: configPath, owner: { id: 'first', descriptors } } as EnrollmentNodeRequest;
    try {
      checkOwner(request, config, tables, OwnersLedger.read(configPath), false, agentConfig ?? configPath);
      return 'ready';
    } catch (error) {
      if (error instanceof EnrollmentError) return error.code;
      throw error;
    }
  }

  test('an explicit service or topic already held by a live drop-in is refused, not let win', () => {
    const dir = workDir();
    const nodePath = join(dir, 'node.json');
    mkdirSync(join(dir, 'services.d'), { mode: 0o700 });
    mkdirSync(join(dir, 'events.d'), { mode: 0o700 });
    service(dir, join(dir, 'services.d', 'live.json'), 'owner.live', 'live.sock');
    privateFile(join(dir, 'events.d', 'live.json'), {
      topics: { 'owner.events.live': { delivery: 'ordered' } },
    });

    const sameService = service(dir, join(dir, 'same-service.json'), 'owner.live', 'other.sock');
    const sameSocket = service(dir, join(dir, 'same-socket.json'), 'owner.other', 'live.sock');
    const otherService = service(dir, join(dir, 'other-service.json'), 'owner.other', 'other.sock');
    const sameTopic = privateFile(join(dir, 'same-topic.json'), {
      topics: { 'owner.events.live': { delivery: 'ordered' } },
    });
    const otherTopic = privateFile(join(dir, 'other-topic.json'), {
      topics: { 'owner.events.other': { delivery: 'ordered' } },
    });

    expect(enroll(nodePath, [{ kind: 'service', path: sameService }])).toBe('declaration-invalid');
    expect(enroll(nodePath, [{ kind: 'service', path: sameSocket }])).toBe('declaration-invalid');
    expect(enroll(nodePath, [{ kind: 'topic', path: sameTopic }])).toBe('declaration-invalid');
    // Negative controls: names nobody holds are ready.
    expect(enroll(nodePath, [{ kind: 'service', path: otherService }])).toBe('ready');
    expect(enroll(nodePath, [{ kind: 'topic', path: otherTopic }])).toBe('ready');
    // The same files beside a configuration of another name: it has no default drop-in directory.
    expect(enroll(join(dir, 'worker.json'), [{ kind: 'service', path: sameService }])).toBe('ready');
  });

  test('a conflict already inside the drop-in directory does not block an unrelated request', () => {
    const dir = workDir();
    const nodePath = join(dir, 'node.json');
    mkdirSync(join(dir, 'services.d'), { mode: 0o700 });
    service(dir, join(dir, 'services.d', 'a.json'), 'owner.dup', 'a.sock');
    service(dir, join(dir, 'services.d', 'b.json'), 'owner.dup', 'b.sock');
    const unrelated = service(dir, join(dir, 'unrelated.json'), 'owner.unrelated', 'u.sock');
    expect(enroll(nodePath, [{ kind: 'service', path: unrelated }])).toBe('ready');
    // Taking the service b.json already lost to a.json still takes it from a.json: refused.
    const taker = service(dir, join(dir, 'taker.json'), 'owner.dup', 't.sock');
    expect(enroll(nodePath, [{ kind: 'service', path: taker }])).toBe('declaration-invalid');
  });

  test("a judge running as another user reads the drop-in files as the agent's user, the owner of node.json", () => {
    const dir = workDir();
    const nodePath = privateFile(join(dir, 'node.json'), {});
    mkdirSync(join(dir, 'services.d'), { mode: 0o700 });
    service(dir, join(dir, 'services.d', 'live.json'), 'owner.live', 'live.sock');
    const taker = service(dir, join(dir, 'taker.json'), 'owner.live', 'other.sock');
    // As enrollment by root over an agent of this user: to its own uid every drop-in file is foreign.
    const own = process.getuid;
    const uid = own?.call(process);
    if (uid === undefined) throw new Error('this platform reports no uid');
    process.getuid = () => uid + 1;
    try {
      expect(dropInOwner(nodePath)).toBe(uid);
      expect(enroll(nodePath, [{ kind: 'service', path: taker }])).toBe('declaration-invalid');
    } finally {
      process.getuid = own;
    }
    // The agent's own user — root over root's own agent, a system unit without User= — judges alike.
    expect(enroll(nodePath, [{ kind: 'service', path: taker }])).toBe('declaration-invalid');
    // A configuration not written yet is born to the process that judges it.
    expect(dropInOwner(join(dir, 'absent', 'node.json'))).toBe(uid);
  });

  test('a node.json reached through a link of another name is judged beside the spelling the agent runs', () => {
    const dir = workDir();
    const file = privateFile(join(dir, 'worker.json'), {});
    const linked = join(dir, 'linked');
    mkdirSync(join(linked, 'services.d'), { recursive: true, mode: 0o700 });
    symlinkSync(file, join(linked, 'node.json'));
    service(dir, join(linked, 'services.d', 'live.json'), 'owner.live', 'live.sock');
    const taker = service(dir, join(dir, 'taker.json'), 'owner.live', 'other.sock');
    const descriptors = [{ kind: 'service' as const, path: taker }];
    // The agent was started as `linked/node.json`: its drop-in directory is beside that spelling.
    expect(enroll(file, descriptors, join(linked, 'node.json'))).toBe('declaration-invalid');
    // Judged beside the file itself, the drop-in directory is not seen at all.
    expect(enroll(file, descriptors)).toBe('ready');
  });
});

describe('config validate service --node judges the drop-in set', () => {
  const main = join(import.meta.dir, '../packages/runtime/src/cli/main.ts');
  async function run(...args: string[]) {
    const child = Bun.spawn(['bun', main, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, code };
  }

  test('a service a drop-in already serves is refused; a drop-in file the agent would not read is named', async () => {
    const dir = workDir();
    const nodePath = join(dir, 'node.json');
    writeFileSync(nodePath, JSON.stringify(nodeConfig), { mode: 0o600 });
    mkdirSync(join(dir, 'services.d'), { mode: 0o700 });
    service(dir, join(dir, 'services.d', 'live.json'), 'owner.live', 'live.sock');

    const taker = service(dir, join(dir, 'taker.json'), 'owner.live', 'other.sock');
    const refused = await run('config', 'validate', 'service', taker, '--node', nodePath);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('this service is already bound on this node');

    const fresh = service(dir, join(dir, 'fresh.json'), 'owner.fresh', 'fresh.sock');
    const accepted = await run('config', 'validate', 'service', fresh, '--node', nodePath);
    expect(accepted.stderr).toBe('');
    expect(accepted.code).toBe(0);

    const loose = service(dir, join(dir, 'services.d', 'loose.json'), 'owner.loose', 'loose.sock');
    chmodSync(loose, 0o664);
    const unread = await run('config', 'validate', 'service', loose, '--node', nodePath);
    expect(unread.code).not.toBe(0);
    expect(unread.stderr).toContain('the node would not load this service declaration');
    expect(unread.stderr).toContain('group- or world-writable');
    // Without --node the schema alone accepts the same bytes.
    expect((await run('config', 'validate', 'service', loose)).code).toBe(0);
  });

  test("run as another user, it judges the drop-in files as the agent's user", async () => {
    const dir = workDir();
    const nodePath = join(dir, 'node.json');
    writeFileSync(nodePath, JSON.stringify(nodeConfig), { mode: 0o600 });
    mkdirSync(join(dir, 'services.d'), { mode: 0o700 });
    service(dir, join(dir, 'services.d', 'live.json'), 'owner.live', 'live.sock');
    const taker = service(dir, join(dir, 'taker.json'), 'owner.live', 'other.sock');
    const preload = join(import.meta.dir, 'fixtures/another-uid.ts');
    const child = Bun.spawn(
      ['bun', '--preload', preload, main, 'config', 'validate', 'service', taker, '--node', nodePath],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).not.toBe(0);
    expect(stderr).toContain('this service is already bound on this node');
  });

  test('a node.json whose drop-in directory depends on how its path is spelled is refused with the reason', async () => {
    const dir = workDir();
    const file = join(dir, 'worker.json');
    writeFileSync(file, JSON.stringify(nodeConfig), { mode: 0o600 });
    const linked = join(dir, 'linked');
    mkdirSync(linked, { mode: 0o700 });
    symlinkSync(file, join(linked, 'node.json'));
    const fresh = service(dir, join(dir, 'fresh.json'), 'owner.fresh', 'fresh.sock');
    const ambiguous = await run('config', 'validate', 'service', fresh, '--node', join(linked, 'node.json'));
    expect(ambiguous.code).not.toBe(0);
    expect(ambiguous.stderr).toContain('cannot tell which drop-in directory the node reads');
    // Controls: the file by its own name has no default directory, and an explicit one is unambiguous.
    expect((await run('config', 'validate', 'service', fresh, '--node', file)).code).toBe(0);
    const explicit = join(dir, 'explicit.json');
    writeFileSync(
      explicit,
      JSON.stringify({
        ...nodeConfig,
        services: { ...nodeConfig.services, dropInDir: join(dir, 'services.d') },
      }),
      { mode: 0o600 },
    );
    symlinkSync(explicit, join(linked, 'explicit-link.json'));
    const named = join(dir, 'named');
    mkdirSync(named, { mode: 0o700 });
    symlinkSync(explicit, join(named, 'node.json'));
    expect((await run('config', 'validate', 'service', fresh, '--node', join(named, 'node.json'))).code).toBe(
      0,
    );
  });
});

describe('the SDK writer', () => {
  test("writes the owner's value, not the schema's defaults", async () => {
    const dir = workDir();
    const written = await writeTopicDescriptorFile(
      'plain',
      { topics: { 'owner.events.plain': { delivery: 'ordered' } } },
      { dropInDir: join(dir, 'events.d') },
    );
    expect(JSON.parse(readFileSync(written.path, 'utf8'))).toEqual({
      topics: { 'owner.events.plain': { delivery: 'ordered' } },
    });
  });
  test('a filesystem failure is permission only when access was denied', async () => {
    const enospc = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    expect(filesystemFailure('write', enospc)).toMatchObject({
      code: 'transport',
      metadata: { cause: enospc },
    });
    expect(filesystemFailure('write', Object.assign(new Error('denied'), { code: 'EACCES' })).code).toBe(
      'permission',
    );
    const dir = workDir();
    // A real non-permission failure through the writer: a path component is a regular file (ENOTDIR).
    const file = privateFile(join(dir, 'plain-file'), {});
    await expect(
      writeTopicDescriptorFile('x', { topics: {} }, { dropInDir: join(file, 'events.d') }),
    ).rejects.toMatchObject({ code: 'transport' });
    // Negative control: a real denial stays permission.
    if (process.getuid?.() !== 0) {
      const locked = join(dir, 'locked');
      mkdirSync(locked, { mode: 0o500 });
      await expect(
        writeTopicDescriptorFile('x', { topics: {} }, { dropInDir: join(locked, 'events.d') }),
      ).rejects.toMatchObject({ code: 'permission' });
      chmodSync(locked, 0o700);
    }
  });
});
