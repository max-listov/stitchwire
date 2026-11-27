import { type EventAck, rejectedEventAck } from '../../../contracts/src/protocol/event.ts';
import { unclassifiedFailure } from '../../../contracts/src/protocol/failure.ts';

/** Each lane owns a bounded PublishAdmission lifetime even after the caller settles. */
export function firstAcceptedPublish(
  lanes: readonly Promise<EventAck>[],
  signal?: AbortSignal,
): Promise<EventAck> {
  const unavailable = (): EventAck =>
    rejectedEventAck(unclassifiedFailure('transport', 'broker acknowledgement unavailable'));
  if (lanes.length === 0) return Promise.resolve(unavailable());
  return new Promise((resolve) => {
    let resolved = false;
    const finish = (ack: EventAck): void => {
      if (resolved) return;
      resolved = true;
      signal?.removeEventListener('abort', cancel);
      resolve(ack);
    };
    const cancel = (): void =>
      finish(
        rejectedEventAck(
          unclassifiedFailure(
            'cancelled',
            'caller withdrew after publish dispatch; broker delivery is unknown',
          ),
        ),
      );
    if (signal?.aborted === true) {
      cancel();
      return;
    }
    signal?.addEventListener('abort', cancel, { once: true });
    let remaining = lanes.length;
    const failures: EventAck[] = [];
    lanes.forEach((lane, index) => {
      const settled = (ack: EventAck): void => {
        remaining -= 1;
        if (ack.ok) {
          finish({
            ...ack,
            detail: `accepted by 1 of ${lanes.length} broker lanes; remaining outcomes independent`,
          });
        } else {
          failures[index] = ack;
          if (remaining === 0) finish(failures[0] ?? unavailable());
        }
      };
      void lane.then(settled, () => settled(unavailable()));
    });
  });
}
