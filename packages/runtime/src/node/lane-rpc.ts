import type { LocalCall } from '../../../contracts/src/door/requests.ts';
import { transportFailure, unclassifiedFailure } from '../../../contracts/src/protocol/failure.ts';
import { nowIso } from '../../../contracts/src/protocol/identity.ts';
import {
  type Admission,
  type Cancel,
  CancelSchema,
  type Invocation,
  InvocationSchema,
  type Result,
  ResultSchema,
  syntheticResult,
} from '../../../contracts/src/protocol/rpc.ts';
import { wireLogger } from '../logger.ts';
import type { ExecutionAdmission } from './admission.ts';
import { execute } from './exec.ts';
import type { LaneClient, LaneConfig } from './lane-contract.ts';

const LOCAL_GRACE_MS = 4_000;

/**
 * How long a shutting-down agent lets running commands finish after asking them to stop.
 *
 * A cooperative profile may grant its owner up to fifteen minutes, but the agent itself is stopped
 * on a much shorter clock (its application grace, then a forced exit). The grace timer lives in this
 * process: if the agent exits first, the timer dies with it and the owner's detached group runs on
 * with no bound at all, and a restarted agent can start a second copy beside it. So drain asks, waits
 * this long, then kills every group it still owns — while it is still alive to do so. Kept well
 * inside the application's shutdown grace.
 */
const SHUTDOWN_COMMAND_GRACE_MS = 5_000;

/** One running command: the caller's withdrawal, and the agent's own decision to stop waiting. */
export interface RunningCommand {
  withdrawal: AbortController;
  force: AbortController;
}

/** Owns incoming execution and outgoing RPC correlations for one lane. */
export class LaneRpc {
  private readonly pending = new Map<string, PendingCall>();
  private readonly running = new Map<string, RunningCommand>();
  private readonly runningTasks = new Set<Promise<void>>();
  /**
   * Commands whose lane ended while they ran. The broker has already failed the call as
   * `lane-lost-after-dispatch` and refuses its answer, so a result produced afterwards is not sent:
   * it would be queued for the lane's next connection and discarded there.
   */
  private readonly laneLost = new Set<string>();
  constructor(
    private readonly config: LaneConfig,
    private readonly client: LaneClient,
    private readonly admission: ExecutionAdmission,
  ) {
    client.on('rpc:result', (result) => {
      const call = this.pending.get(result.id);
      if (call === undefined) return;
      clearTimeout(call.timer);
      this.pending.delete(result.id);
      call.settle(result);
    });
    client.on('rpc:invoke', (invocation) => {
      const task = this.invoke(invocation);
      this.runningTasks.add(task);
      void task.then(
        () => this.runningTasks.delete(task),
        (error) => {
          this.runningTasks.delete(task);
          wireLogger.error('[wire] command execution failed', { lane: config.id, error });
        },
      );
    });
    client.on('rpc:cancel', (cancel) => this.running.get(cancel.id)?.withdrawal.abort());
  }
  private async invoke(invocation: Invocation): Promise<void> {
    const command: RunningCommand = { withdrawal: new AbortController(), force: new AbortController() };
    this.running.set(invocation.id, command);
    try {
      const result = await execute(
        invocation,
        this.config.allow,
        this.admission,
        command.withdrawal.signal,
        command.force.signal,
      );
      if (!this.laneLost.delete(invocation.id))
        this.client.emit('rpc:result', ResultSchema.parse(result), () => {});
    } finally {
      this.running.delete(invocation.id);
      this.laneLost.delete(invocation.id);
    }
  }
  call(request: LocalCall, signal?: AbortSignal): Promise<Result> {
    return callThroughLane(
      this.config,
      this.pending,
      {
        dispatch: (invocation, acknowledge) => this.client.emit('rpc:call', invocation, acknowledge),
        cancel: (cancel) => {
          this.client.emit('rpc:cancel', cancel);
        },
      },
      request,
      signal,
    );
  }
  disconnect(): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.settle(
        syntheticResult(
          id,
          transportFailure('lane-lost-after-dispatch', 'lost the broker connection while waiting'),
        ),
      );
    }
    this.pending.clear();
    // The broker failed every call it dispatched to this connection when the connection ended. A
    // command still running here would otherwise run to its own deadline with nobody waiting for it
    // (its effects landing after the caller was told the call was lost); it is stopped like a
    // withdrawn one, with the profile's own cancellation. `ServiceLane.disconnect` does the same.
    for (const [id, command] of this.running) {
      this.laneLost.add(id);
      command.withdrawal.abort();
    }
  }
  drain(): Promise<void> {
    return drainLaneRpc(this.pending, this.running, this.runningTasks);
  }
}

export interface PendingCall {
  settle: (result: Result) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Settle local waiters and stop remote work before a lane releases its lifecycle resources. */
export async function drainLaneRpc(
  pending: Map<string, PendingCall>,
  running: Map<string, RunningCommand>,
  runningTasks: ReadonlySet<Promise<void>>,
  graceMs = SHUTDOWN_COMMAND_GRACE_MS,
): Promise<void> {
  for (const [id, call] of pending) {
    clearTimeout(call.timer);
    call.settle(syntheticResult(id, unclassifiedFailure('cancelled', 'the local agent is shutting down')));
  }
  pending.clear();
  for (const command of running.values()) command.withdrawal.abort();
  const settled = Promise.allSettled([...runningTasks]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const graceOver = new Promise<'grace-over'>((resolve) => {
    timer = setTimeout(() => resolve('grace-over'), graceMs);
  });
  const first = await Promise.race([settled, graceOver]);
  clearTimeout(timer);
  if (first === 'grace-over') for (const command of running.values()) command.force.abort();
  await settled;
}

interface LaneRpcTransport {
  dispatch(invocation: Invocation, acknowledge: (admission: Admission) => void): boolean;
  cancel(cancel: Cancel): void;
}

/** One RPC correlation owner from lane dispatch through timeout, withdrawal or result. */
function callThroughLane(
  config: { nodeId: string; url: string; defaultTimeoutMs: number },
  pending: Map<string, PendingCall>,
  transport: LaneRpcTransport,
  request: LocalCall,
  signal?: AbortSignal,
): Promise<Result> {
  const id = crypto.randomUUID();
  const timeoutMs = request.timeoutMs ?? config.defaultTimeoutMs;
  const invocation = InvocationSchema.parse({
    id,
    ts: nowIso(),
    from: config.nodeId,
    to: request.to,
    argv: request.argv,
    stdin: request.stdin,
    timeoutMs,
  });
  return new Promise((resolve) => {
    let done = false;
    const settle = (result: Result): void => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', withdraw);
      resolve(result);
    };
    const timer = setTimeout(() => {
      pending.delete(id);
      settle(
        syntheticResult(
          id,
          unclassifiedFailure('timeout', `no answer from ${request.to} within ${timeoutMs}ms`),
        ),
      );
    }, timeoutMs + LOCAL_GRACE_MS);
    pending.set(id, { settle, timer });
    const withdraw = (): void => {
      const active = pending.get(id);
      if (active === undefined) return;
      clearTimeout(active.timer);
      pending.delete(id);
      transport.cancel(
        CancelSchema.parse({ id, from: config.nodeId, to: request.to, reason: 'caller withdrew' }),
      );
      settle(syntheticResult(id, unclassifiedFailure('cancelled', 'the caller withdrew the call')));
    };
    if (signal?.aborted === true) {
      withdraw();
      return;
    }
    signal?.addEventListener('abort', withdraw, { once: true });
    const handed = transport.dispatch(invocation, (admission) => {
      if (admission.accepted) return;
      const active = pending.get(id);
      if (active === undefined) return;
      clearTimeout(active.timer);
      pending.delete(id);
      settle(
        syntheticResult(id, {
          failure: admission.failure,
          refusal: admission.refusal,
          retryAfterMs: admission.retryAfterMs,
          transportCause: admission.transportCause ?? null,
          detail: admission.detail,
        }),
      );
    });
    if (!handed) {
      clearTimeout(timer);
      pending.delete(id);
      settle(syntheticResult(id, transportFailure('no-connected-lane', `not connected to ${config.url}`)));
    }
  });
}
