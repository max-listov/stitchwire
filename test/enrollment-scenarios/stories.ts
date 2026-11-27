import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileDigest } from '../../packages/runtime/src/enrollment/artifact.ts';
import { brokerObservation } from '../../packages/runtime/src/enrollment/observe.ts';
import { bindingCrashControls } from '../enrollment-controls/binding-crashes.ts';
import { bindingRefusalControls } from '../enrollment-controls/binding-refusals.ts';
import {
  brokerOnlyControl,
  invalidRemainingControl,
  removeBrokenOwnerControl,
} from '../enrollment-controls/binding-state.ts';
import { parallelBindingControls } from '../enrollment-controls/bindings.ts';
import { crashControls } from '../enrollment-controls/crash.ts';
import { foreignDoorControl } from '../enrollment-controls/door.ts';
import { foreignDropInConflictControl } from '../enrollment-controls/drop-in-conflict.ts';
import {
  externalSupervisorControl,
  foreignUnitControl,
  permissionControl,
  supervisorControl,
} from '../enrollment-controls/negative.ts';
import { localSelfCallControl, selfProofRefusals } from '../enrollment-controls/proof.ts';
import { remoteProofControls } from '../enrollment-controls/proof-route.ts';
import { systemdOf } from '../enrollment-controls/systemd.ts';
import { enrollmentEvents } from '../enrollment-events.ts';
import { refusalOf, runtimeOf } from '../enrollment-results.ts';
import {
  type Check,
  credentialStaysPrivate,
  type Enrolled,
  enrolled,
  madeReady,
  mainPidOf,
  type ScenarioEnv,
  serviceUnitOf,
} from './enrolled.ts';

/** A scenario owns its fleet from start to stop; whatever it meets, the fleet is taken down. */
async function story(
  env: ScenarioEnv,
  run: (context: Enrolled) => Promise<void>,
  options: Parameters<typeof enrolled>[1] = {},
): Promise<void> {
  const context = await enrolled(env, options);
  try {
    await run(context);
  } finally {
    await context.close();
  }
}

/** The second owner attached beside the first, and a live feed of its topic. */
async function secondOwner(context: Enrolled, env: ScenarioEnv) {
  const { stand, request, reader, worker } = context;
  const second = {
    ...request,
    requestId: crypto.randomUUID(),
    owner: { id: 'second', descriptors: stand.second.bindings },
  };
  env.check(
    (await stand.cli(second, 'apply')).result.status === 'ready',
    'a second owner attaches beside the first',
  );
  const events = await enrollmentEvents(reader, worker, stand.second.topic);
  context.feeds.push(events.feed);
  await events.deliver();
  return { second, events };
}

/** Plan, prepare, admit and apply, each read back; then the same apply again changes nothing. */
export function bootstrap(env: ScenarioEnv): Promise<void> {
  return story(env, async (context) => {
    const { stand, request, reader, worker, workerId } = context;
    const check: Check = env.check;
    const { systemd } = env;
    await selfProofRefusals(stand, request, check);
    const before = existsSync(stand.worker.config) ? readFileSync(stand.worker.config) : null;
    check((await stand.cli(request, 'plan')).result.status === 'planned', 'read-only plan');
    check(
      before === null ? !existsSync(stand.worker.config) : before.equals(readFileSync(stand.worker.config)),
      'plan leaves credentials unchanged',
    );
    const prepared = (await stand.cli(request, 'prepare')).result;
    check(prepared.status === 'prepared' && prepared.credentials.length === 1, 'prepare credential once');
    const credential = stand.config().brokers[0]?.token;
    const tokenSha256 = prepared.credentials[0]?.sha256;
    check(tokenSha256 !== undefined, 'credential digest available');
    const admission = { ...stand.admission, tokenSha256 };
    check(
      (await stand.cli(admission, 'apply')).result.status === 'admitted',
      'broker runtime admission read-back',
    );
    if (!systemd) {
      await stand.startWorker();
      await stand.awaitProofRoute();
    }
    const ready = (await stand.cli(request, 'apply')).result;
    check(
      ready.status === 'ready',
      `node ready: ${refusalOf(ready)?.code ?? 'ok'} at ${refusalOf(ready)?.phase ?? 'complete'}`,
    );
    const serviceUnit = serviceUnitOf(ready);
    if (systemd)
      check(
        runtimeOf(ready)?.installation?.service.scope === 'system',
        'ready result names the managing unit and scope',
      );
    check(
      stand.reached.some((entry) => entry.caller === workerId && entry.service === 'example.probe'),
      'observed target identity at service ingress',
    );
    const initialPid = systemd ? await mainPidOf(serviceUnit) : null;
    const snapshot = readFileSync(request.config);
    const receipt = readFileSync(`${request.config}.enrollment/owners.json`);
    const connection = async () =>
      (await brokerObservation(stand.url, request.expectedVersion)).nodes.find(
        (node) => node.nodeId === workerId,
      )?.since;
    const connectedSince = await connection();
    check(typeof connectedSince === 'string', 'broker observes the actual worker connection');
    check(
      (await stand.cli(request, 'status')).result.status === 'ready' &&
        snapshot.equals(readFileSync(request.config)) &&
        receipt.equals(readFileSync(`${request.config}.enrollment/owners.json`)),
      'status is read-only for config credential and owner receipt',
    );
    const observed = await worker.status();
    check(
      observed.services.declarations.descriptors[0]?.state === 'loaded' &&
        observed.events.declarations.descriptors[0]?.state === 'loaded' &&
        observed.events.declarations.lanes[0]?.accepted === 1,
      'both typed descriptors load and the broker acknowledges the topic',
    );
    const events = await enrollmentEvents(reader, worker, stand.first.topic);
    context.feeds.push(events.feed);
    await events.deliver();
    check(true, 'allowed subscriber receives a new event from the attached consumer');
    if (systemd) {
      check(Number(initialPid) > 0, 'systemd child is running');
      const argv = readFileSync(`/proc/${initialPid}/cmdline`, 'utf8').split('\0');
      check(
        argv.includes(systemdOf(request).artifact.destination) && argv.includes(request.config),
        'supervisor starts exact artifact and config',
      );
      const environment = readFileSync(`/proc/${initialPid}/environ`, 'utf8').split('\0');
      check(
        environment.includes(`STITCHWIRE_STATE_DIR=${dirname(request.agentSocket)}`) &&
          environment.includes(`STITCHWIRE_CONFIG_DIR=${dirname(request.config)}`),
        'child state bindings are authoritative',
      );
      check(
        runtimeOf(ready)?.installation?.sha256 === systemdOf(request).artifact.sha256,
        'installed artifact provenance',
      );
      check(
        await foreignDoorControl(stand, request, serviceUnit),
        'a matching live unit cannot certify a stable foreign listening door',
      );
    }
    check(
      (await stand.cli(request, 'apply')).result.status === 'ready',
      'apply converges after lost response',
    );
    check(
      snapshot.equals(readFileSync(request.config)) && (await connection()) === connectedSince,
      'repeat preserves config bytes and the broker connection without in-process reload',
    );
    if (systemd) check((await mainPidOf(serviceUnit)) === initialPid, 'repeat keeps the same MainPID');
    check(stand.config().brokers[0]?.token === credential, 'repeat keeps original credential');
    await credentialStaysPrivate(context, credential, serviceUnit, env);
  });
}

/** Only a call through a broker to another node proves the route; an ordinary self-call still works. */
export function proof(env: ScenarioEnv): Promise<void> {
  return story(env, async (context) => {
    const { stand, request, worker } = context;
    await madeReady(context, env);
    await selfProofRefusals(stand, request, env.check);
    await localSelfCallControl(stand, request, worker, env.check);
    await remoteProofControls(stand, request, worker, env.check);
  });
}

/** Two owners attach at once on one node; each is callable, and a refusal never reaches an owner. */
export function owners(env: ScenarioEnv): Promise<void> {
  return story(env, async (context) => {
    const { stand, request, reader, worker, workerId, invoke } = context;
    const check: Check = env.check;
    await madeReady(context, env);
    await parallelBindingControls(stand, request, check);
    check(
      (await invoke('owner.first')).outcome.status === 'response' &&
        (await invoke('owner.second')).outcome.status === 'response',
      'both owners remain callable',
    );
    const dispatches = stand.reached.length;
    const refusals = {
      operation: (await invoke('owner.first', 'write')).outcome,
      target: (await invoke('owner.first', 'read', 'unregistered')).outcome,
      caller: (
        await worker.invokeService({
          to: workerId,
          service: 'owner.first',
          revision: '1',
          operation: 'read',
          payload: '{}',
          timeoutMs: 1000,
        })
      ).outcome,
    };
    for (const [what, outcome] of Object.entries(refusals))
      check(
        outcome.status === 'failure' && outcome.code === 'denied' && outcome.delivery === 'not-dispatched',
        `a refused ${what} is denied and not dispatched`,
      );
    check(stand.reached.length === dispatches, 'refusals never reach the owner');
    const events = await enrollmentEvents(reader, worker, stand.second.topic);
    context.feeds.push(events.feed);
    await events.deliver();
    check(true, 'the second owner publishes to its subscriber');
  });
}

/** A binding change is judged on the complete remaining set, so it never costs another owner. */
export function bindingPolicy(env: ScenarioEnv): Promise<void> {
  return story(env, async (context) => {
    const { stand, request, worker } = context;
    await madeReady(context, env);
    const { events } = await secondOwner(context, env);
    await bindingRefusalControls(stand, request, env.check);
    await invalidRemainingControl(stand, request, worker, events.deliver, env.check);
  });
}

/** A broker that refuses a declaration is a named partial enrollment, never `ready`. */
export function brokerRefusal(env: ScenarioEnv): Promise<void> {
  return story(env, async (context) => {
    const { stand, request, worker } = context;
    await madeReady(context, env);
    const { events } = await secondOwner(context, env);
    await brokerOnlyControl(stand, request, worker, events.deliver, env.check);
  });
}

/** A conflict two foreign drop-in files hold between them costs an unrelated owner nothing. */
export function dropInConflict(env: ScenarioEnv): Promise<void> {
  return story(
    env,
    async (context) => {
      await madeReady(context, env);
      await foreignDropInConflictControl(context, env.check);
    },
    { defaultDropIns: true },
  );
}

/** One owner detaches and the other keeps serving; the last detach withdraws both declarations. */
export function detach(env: ScenarioEnv): Promise<void> {
  return story(env, async (context) => {
    const { stand, request, worker, invoke } = context;
    const check: Check = env.check;
    const { systemd } = env;
    const { ready, credential } = await madeReady(context, env);
    const serviceUnit = serviceUnitOf(ready);
    const initialPid = systemd ? await mainPidOf(serviceUnit) : null;
    const { second, events } = await secondOwner(context, env);
    const detached = { ...request, requestId: crypto.randomUUID() };
    check((await stand.cli(detached, 'detach')).result.status === 'detached', 'consumer detaches');
    check(
      (await stand.cli(detached, 'detach')).result.status === 'detached',
      'detach converges after lost response',
    );
    check((await invoke('owner.second')).outcome.status === 'response', 'independent owner survives detach');
    await events.deliver();
    check(true, 'the existing subscriber feed continues after another consumer detaches');
    const afterDetach = stand.reached.length;
    const revoked = (await invoke('owner.first')).outcome;
    check(
      revoked.status === 'failure' &&
        revoked.code === 'denied' &&
        revoked.delivery === 'not-dispatched' &&
        stand.reached.length === afterDetach,
      'detached service cannot dispatch',
    );
    if (systemd) check((await mainPidOf(serviceUnit)) === initialPid, 'detach preserves agent MainPID');
    check(stand.config().brokers[0]?.token === credential, 'detach preserves credential');
    await removeBrokenOwnerControl(stand, request, events.deliver, check);
    events.feed.close();
    check(
      (await stand.cli({ ...second, requestId: crypto.randomUUID() }, 'detach')).result.status === 'detached',
      'the last consumer detaches',
    );
    check(
      (await stand.cli({ ...second, requestId: crypto.randomUUID() }, 'status')).result.status === 'detached',
      'a detached owner reads back as detached',
    );
    const withdrawn = await worker.status();
    check(
      stand.config().services.descriptors.length === 0 &&
        stand.config().events.descriptors.length === 0 &&
        withdrawn.services.declarations.lanes[0]?.accepted === 0 &&
        withdrawn.events.declarations.lanes[0]?.accepted === 0,
      'both empty declarations are currently acknowledged',
    );
    check(
      !(
        await worker.publish({
          topic: stand.second.topic,
          bootId: crypto.randomUUID(),
          seq: 0,
          data: 'revoked',
        })
      ).ok,
      'the last detached topic cannot publish',
    );
    await credentialStaysPrivate(context, credential, serviceUnit, env);
  });
}

/** A binding change interrupted at every write boundary is resumed by the ordinary runtime. */
export function bindingCrashes(env: ScenarioEnv): Promise<void> {
  return story(env, async (context) => {
    const { stand, request } = context;
    const { ready, credential } = await madeReady(context, env);
    const recovered = await bindingCrashControls(stand, request, env.crashRunner, env.check);
    env.check(
      (await stand.cli({ ...recovered, requestId: crypto.randomUUID() }, 'detach')).result.status ===
        'detached',
      'recovered owner releases both binding kinds',
    );
    await credentialStaysPrivate(context, credential, serviceUnitOf(ready), env);
  });
}

/** A wrong credential, another version and a reused request are three different refusals. */
export function conflicts(env: ScenarioEnv): Promise<void> {
  return story(env, async (context) => {
    const { stand, request } = context;
    const check: Check = env.check;
    const { admission } = await madeReady(context, env);
    const wrong = (
      await stand.cli({ ...admission, requestId: crypto.randomUUID(), tokenSha256: 'f'.repeat(64) }, 'plan')
    ).result;
    check(refusalOf(wrong)?.code === 'credential-conflict', 'wrong credential is distinct');
    const mismatch = (
      await stand.cli({ ...request, requestId: crypto.randomUUID(), expectedVersion: '999.0.0' }, 'plan')
    ).result;
    check(refusalOf(mismatch)?.code === 'version-mismatch', 'runtime mismatch is distinct');
    const reused = (await stand.cli({ ...request, owner: { id: 'changed', descriptors: [] } }, 'apply'))
      .result;
    check(refusalOf(reused)?.code === 'request-conflict', 'request identity cannot be repurposed');
  });
}

/** What only a real systemd host can refuse: a corrupt artifact, another account, a foreign unit. */
export function systemdRefusals(env: ScenarioEnv): Promise<void> {
  return story(env, async (context) => {
    const { stand, request, binary } = context;
    const check: Check = env.check;
    const { admission } = await madeReady(context, env);
    // A fresh, absent destination must validate source bytes. An installed destination is
    // intentionally authoritative on resume, and an existing reservation checks identity first.
    const corruptSource = join(stand.root, 'corrupt-runtime');
    await Bun.write(
      corruptSource,
      Buffer.concat([readFileSync(binary), Buffer.from('\n// corrupt artifact control\n')]),
    );
    const badArtifact = (
      await stand.cli(
        {
          ...request,
          requestId: crypto.randomUUID(),
          config: join(stand.root, 'digest-control.json'),
          agentSocket: join(stand.root, 'digest-control.sock'),
          supervisor: {
            ...systemdOf(request),
            artifact: {
              source: corruptSource,
              destination: join(stand.root, 'digest-control/bin/stitchwire'),
              sha256: fileDigest(binary),
            },
          },
        },
        'plan',
      )
    ).result;
    check(
      refusalOf(badArtifact)?.code === 'artifact-mismatch' && refusalOf(badArtifact)?.phase === 'preflight',
      'artifact digest refusal',
    );
    check(
      [
        'digest-control.json',
        'digest-control.json.enrollment',
        'digest-control.sock',
        'digest-control',
      ].every((path) => !existsSync(join(stand.root, path))),
      'artifact digest refusal has no enrollment effects',
    );
    check(await permissionControl(binary, admission), 'missing admission authority is distinct');
    check(await supervisorControl(binary), 'supervisor refusal is distinct');
    check(await externalSupervisorControl(binary), 'external supervisor cannot be replaced or duplicated');
    check(await foreignUnitControl(binary), 'a unit enrollment did not write is neither overwritten nor run');
    await crashControls(binary, env.crashRunner, check);
  });
}
