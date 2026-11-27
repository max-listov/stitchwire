import type { EventResume } from '../../contracts/src/protocol/event.ts';
import type { EventItem } from './readers.ts';
import { WireClientError } from './errors.ts';

/** One declared producer per topic. Constant state, no payload interpretation or recovery. */
export function eventSequence(topic: string, resume?: EventResume | null): (item: EventItem) => EventItem {
  let subscriptionId: string | undefined;
  let producer: string | undefined;
  let bootId = resume?.bootId;
  let successor: string | undefined;
  let nextSeq = resume ? resume.afterSeq + 1 : undefined;
  let initial = true;
  const invalid = (): never => {
    throw new WireClientError('invalid-response', 'Inconsistent Wire event sequence or identity', 'unknown');
  };
  return (item) => {
    const frame = item.frame;
    if (frame.topic !== topic) invalid();
    if (frame.subscriptionId === null) {
      if (!initial) invalid();
    } else {
      subscriptionId ??= frame.subscriptionId;
      if (subscriptionId !== frame.subscriptionId) invalid();
    }
    if (item.kind === 'error') return item;
    if (item.kind === 'subscription') {
      initial = false;
      return item;
    }
    const value = item.frame;
    producer ??= value.producer;
    if (producer !== value.producer) invalid();
    bootId ??= value.bootId;
    if (bootId !== value.bootId) {
      if (value.bootId !== successor) invalid();
      bootId = successor;
      successor = undefined;
      nextSeq = undefined;
    }
    if (item.kind === 'event') {
      if (nextSeq !== undefined && item.frame.seq !== nextSeq) invalid();
      nextSeq = item.frame.seq + 1;
    } else if (item.frame.reason === 'boot-change') {
      // The old range is broker high-water, not the subscriber's delivered position.
      // The successor may already be mid-epoch when this volatile lane attaches.
      if (successor !== undefined) invalid();
      successor = item.frame.nextBootId;
    } else if (item.frame.reason === 'resume' && nextSeq !== undefined && item.frame.toSeq < nextSeq) {
      // A reconnecting empty/behind lane cannot vouch for continuity. Do not advance or rewind.
    } else {
      if (nextSeq !== undefined && item.frame.fromSeq !== nextSeq) invalid();
      nextSeq = item.frame.toSeq + 1;
    }
    initial = false;
    return item;
  };
}
