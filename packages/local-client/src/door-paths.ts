import { doorPath } from '../../contracts/src/door/paths.ts';
import { localContract } from '../../contracts/src/door/local-contract.ts';
import { serviceContract } from '../../contracts/src/service/service-contract.ts';
import { eventDoorContract, streamDoorContract } from '../../contracts/src/door/streams.ts';

/**
 * Every path this SDK can call, composed from the contracts that define them.
 *
 * The contracts live where both sides reach them, so there are no path literals here: a changed
 * prefix moves the client and the door together or not at all.
 */
export const DOOR = {
  call: doorPath(localContract, 'call'),
  status: doorPath(localContract, 'status'),
  peerObservation: doorPath(localContract, 'peerObservation'),
  stream: doorPath(streamDoorContract, 'stream'),
  publish: doorPath(eventDoorContract, 'publish'),
  subscribe: doorPath(eventDoorContract, 'subscribe'),
  invokeService: doorPath(serviceContract, 'invokeService'),
} as const;

export type DoorPath = (typeof DOOR)[keyof typeof DOOR];

/** The two answers that never end: a bounded stream and a live subscription. */
export const STREAMING_DOOR_PATHS: readonly string[] = [DOOR.stream, DOOR.subscribe];
