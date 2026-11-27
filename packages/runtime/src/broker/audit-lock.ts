import { hostname } from 'node:os';
import { readDiagnosticJournalLockDiagnosis } from 'stitchkit/application';
import { processState } from '../node/process-state.ts';
import { errnoOf } from '../../../local-client/src/errno.ts';

/** Report the framework's evidence without treating PID presence as owner identity. */
export function describeLock(path: string, lockPath: string, error: unknown): string {
  const diagnosis = readDiagnosticJournalLockDiagnosis(error);
  const removal = `Preserve ${lockPath} and verify the recorded process identity and all writers before an operator removes a proven abandoned lock.`;
  if (diagnosis === undefined) {
    return `journal ${path} is locked by ${lockPath}, and the refusal carried no diagnosis — nothing about the holder was established. ${removal}`;
  }
  const { attribution, liveness, identity, owner } = diagnosis;
  if (owner === null) {
    return `journal ${path} is locked by ${lockPath}, whose owner record could not be read — nothing about the holder was established. ${removal}`;
  }
  const recorded = `the record names pid ${owner.pid}, acquiredAt ${owner.acquiredAt}`;
  if (attribution === 'this-machine') {
    if (identity === 'matched' && liveness === 'alive') {
      return `journal ${path} is locked by this machine's confirmed live owner — ${recorded}; boot and process-start identity match. Do not remove ${lockPath} while this writer is active.`;
    }
    if (identity === 'unavailable') {
      return `journal ${path} is locked by this machine's record — ${recorded}; process identity is unavailable, so ownership and safe reclamation are unknown. ${removal}`;
    }
    return liveness === 'alive'
      ? `journal ${path} is locked by this machine's record — ${recorded}; a process with this PID answers a liveness probe, which alone does not confirm the recorded owner. ${removal}`
      : `journal ${path} is locked by this machine's record — ${recorded}; liveness is "${liveness}". This refusal does not establish a live owner. ${removal}`;
  }
  if (attribution === 'another-machine') {
    return `journal ${path} is locked by another machine's record — ${recorded} under host name "${owner.host}", machine ${owner.machine ?? 'unrecorded'}. Its process was not probed and cannot be from here; whether this is a stale lock is unknown. ${removal}`;
  }
  // A record may belong to a renamed local host. This probe only describes the
  // local process table; it never authorizes lock reclamation.
  return `journal ${path} is locked by a record this machine cannot attribute to anyone — ${recorded} under host name "${owner.host}". This host reports its name as "${hostname()}". ${describeLocalPid(owner.pid)} ${removal}`;
}

function describeLocalPid(pid: number): string {
  try {
    process.kill(pid, 0);
    return processState(pid) === 'zombie'
      ? `A process with pid ${pid} is a zombie its parent never reaped; it has exited and there is nothing to kill.`
      : `A process with pid ${pid} does exist on this machine, though nothing ties it to this lock.`;
  } catch (error) {
    const code = errnoOf(error);
    if (code === 'ESRCH')
      return `No process with pid ${pid} exists on this machine; the recorded machine's identity must still be established.`;
    if (code === 'EPERM')
      return `A process with pid ${pid} exists, but permission to probe it was denied; its ownership is unknown.`;
    return `Whether pid ${pid} still exists here could not be determined.`;
  }
}
